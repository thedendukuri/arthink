import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
)

const BATCH_SIZE = 100

/** Extract the best image URL from a raw RSS entry JSONB object */
function extractImageUrl(rawXml: any): string | null {
  if (!rawXml || typeof rawXml !== "object") return null

  // 1. ET feeds: attachments array with mimeType image/*
  if (Array.isArray(rawXml.attachments)) {
    for (const att of rawXml.attachments) {
      if (att?.url && (att?.mimeType ?? "").startsWith("image/")) {
        return att.url
      }
    }
    for (const att of rawXml.attachments) {
      if (att?.url) return att.url
    }
  }

  // 2. The Hindu / standard media:content
  const mediaContent = rawXml["media:content"] ?? rawXml.mediaContent
  if (Array.isArray(mediaContent) && mediaContent[0]?.url) {
    return mediaContent[0].url
  }
  if (mediaContent?.url) return mediaContent.url

  // 3. Standard RSS <enclosure> tag
  const enclosure = rawXml.enclosure
  if (enclosure?.url && (enclosure?.type ?? "").startsWith("image/")) {
    return enclosure.url
  }

  // 4. media:thumbnail
  const mediaThumbnail = rawXml["media:thumbnail"] ?? rawXml.mediaThumbnail
  if (mediaThumbnail?.url) return mediaThumbnail.url
  if (Array.isArray(mediaThumbnail) && mediaThumbnail[0]?.url) return mediaThumbnail[0].url

  // 5. image field directly
  if (rawXml.image?.url) return rawXml.image.url
  if (typeof rawXml.image === "string") return rawXml.image

  return null
}

Deno.serve(async () => {
  const runStart = Date.now()

  try {
    // ── 1. Fetch unprocessed raw items (promoted_at IS NULL) ──────
    const { data: rawItems, error: fetchError } = await supabase
      .from("raw_feed_items")
      .select(`
        id, feed_id, title, link, summary, author, published_at, content_hash, raw_xml,
        feeds ( name, region, category )
      `)
      .is("promoted_at", null)
      .order("ingested_at", { ascending: true })
      .limit(BATCH_SIZE)

    if (fetchError) {
      return response({ success: false, error: fetchError.message }, 500)
    }

    if (!rawItems || rawItems.length === 0) {
      return response({ success: true, message: "nothing to process", duration_ms: Date.now() - runStart })
    }

    // ── 2. Check which canonical_urls already exist in articles ───
    const links = rawItems.map((r: any) => r.link).filter(Boolean) as string[]

    const { data: existing } = await supabase
      .from("articles")
      .select("id, canonical_url")
      .in("canonical_url", links)

    const existingByUrl = new Map<string, number>(
      (existing ?? []).map((a: any) => [a.canonical_url, a.id])
    )

    // ── 3. Split batch into new vs duplicate ──────────────────────
    const toInsert: any[] = []
    const toDuplicate: any[] = []

    for (const raw of rawItems as any[]) {
      if (!raw.link || !raw.title) {
        toDuplicate.push({ raw_id: raw.id, skip: true })
        continue
      }

      if (existingByUrl.has(raw.link)) {
        toDuplicate.push({
          canonical_article_id: existingByUrl.get(raw.link),
          duplicate_raw_item_id: raw.id,
          reason: "url_match",
          raw_id: raw.id,
        })
      } else {
        toInsert.push({
          canonical_url:     raw.link,
          title:             raw.title,
          summary:           raw.summary ?? null,
          source_name:       raw.feeds?.name ?? "Unknown",
          source_article_id: raw.id,
          author:            raw.author ?? null,
          published_at:      raw.published_at ?? null,
          image_url:         extractImageUrl(raw.raw_xml),
          region:            raw.feeds?.region ?? null,
          language:          "en",
          dedupe_key:        raw.content_hash ?? null,
        })
      }
    }

    // ── 4. Insert new articles ────────────────────────────────────
    let insertedCount = 0
    let insertErrors: string[] = []

    if (toInsert.length > 0) {
      const { data: inserted, error: insertError } = await supabase
        .from("articles")
        .insert(toInsert)
        .select("id, canonical_url")

      if (insertError) {
        const { error: upsertError } = await supabase
          .from("articles")
          .upsert(toInsert, { onConflict: "canonical_url", ignoreDuplicates: true })

        if (upsertError) insertErrors.push(upsertError.message)
      } else {
        insertedCount = inserted?.length ?? 0
        for (const a of (inserted ?? [])) {
          existingByUrl.set(a.canonical_url, a.id)
        }
      }
    }

    // ── 5. Insert article_duplicates ──────────────────────────────
    const duplicateRows = toDuplicate.filter(
      d => !d.skip && d.canonical_article_id && d.duplicate_raw_item_id
    )

    if (duplicateRows.length > 0) {
      await supabase
        .from("article_duplicates")
        .upsert(
          duplicateRows.map(d => ({
            canonical_article_id:  d.canonical_article_id,
            duplicate_raw_item_id: d.duplicate_raw_item_id,
            reason:                d.reason,
          })),
          { ignoreDuplicates: true }
        )
    }

    // ── 6. Mark all processed items as promoted ───────────────────
    const allProcessedIds = rawItems.map((r: any) => r.id)
    const { error: markError } = await supabase
      .from("raw_feed_items")
      .update({ promoted_at: new Date().toISOString() })
      .in("id", allProcessedIds)

    if (markError) {
      return response({ success: false, error: `Failed to mark promoted: ${markError.message}` }, 500)
    }

    return response({
      success:           true,
      batch_size:        rawItems.length,
      inserted:          insertedCount,
      duplicates_found:  duplicateRows.length,
      skipped_malformed: toDuplicate.filter(d => d.skip).length,
      insert_errors:     insertErrors,
      duration_ms:       Date.now() - runStart,
    })

  } catch (err) {
    return response({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }, 500)
  }
})

function response(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}
