import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { parseFeed } from "jsr:@mikaelporttila/rss@*"

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
)

type FeedRow = {
  id: number
  name: string
  feed_url: string
  category: string | null
  region: string | null
}

function cleanString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim()
  // RSS parser sometimes returns { type, value } objects (e.g. Google News, Atom feeds)
  if (typeof value === "object" && value !== null) {
    const v = (value as any).value ?? (value as any).text ?? (value as any).content
    return typeof v === "string" && v.trim() ? v.trim() : null
  }
  return null
}

function parseDate(value: unknown): string | null {
  const s = cleanString(value)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function pickLink(entry: any): string | null {
  const direct = cleanString(entry?.link)
  if (direct) return direct
  if (Array.isArray(entry?.links)) {
    for (const linkObj of entry.links) {
      const href = cleanString(linkObj?.href)
      if (href) return href
    }
  }
  return cleanString(entry?.id)
}

function pickSummary(entry: any): string | null {
  return (
    cleanString(entry?.description) ||
    cleanString(entry?.summary)     ||
    cleanString(entry?.content)     ||
    null
  )
}

function pickGuid(entry: any): string | null {
  return cleanString(entry?.id) || cleanString(entry?.guid) || null
}

/** Short SHA-256 fingerprint for content dedup */
async function contentHash(title: string, link: string): Promise<string> {
  const data = new TextEncoder().encode(`${title}|${link}`)
  const buf  = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32)
}

Deno.serve(async () => {
  const runStart = Date.now()

  try {
    // ── 1. Fetch all active feeds ─────────────────────────────────
    const { data: feeds, error: feedsError } = await supabase
      .from("feeds")
      .select("id, name, feed_url, category, region")
      .eq("is_active", true)   // ← was missing before

    if (feedsError) {
      return new Response(
        JSON.stringify({ success: false, error: feedsError.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }

    const results: any[] = []

    for (const feed of (feeds ?? []) as FeedRow[]) {
      const fetchStart = Date.now()

      try {
        // ── 2. Fetch the RSS/Atom XML ─────────────────────────────
        const res = await fetch(feed.feed_url, {
          headers: {
            "user-agent": "Mozilla/5.0 Feed Ingestor",
            "accept":
              "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
          },
        })

        const responseMs = Date.now() - fetchStart

        if (!res.ok) {
          await supabase.from("feed_fetch_logs").insert({
            feed_id: feed.id,
            http_status: res.status,
            success: false,
            error_message: `HTTP ${res.status}`,
            response_time_ms: responseMs,
            item_count: 0,
          })
          results.push({
            feed_id: feed.id, feed_name: feed.name,
            status: "fetch_failed", http_status: res.status,
          })
          continue
        }

        // ── 3. Parse feed ─────────────────────────────────────────
        const xml    = await res.text()
        const parsed = await parseFeed(xml)
        // Some RSS 2.0 feeds use `items`, Atom feeds use `entries` — handle both
        const entries: any[] = Array.isArray((parsed as any)?.entries)
          ? (parsed as any).entries
          : Array.isArray((parsed as any)?.items)
            ? (parsed as any).items
            : []

        // ── 4. Build raw_feed_items rows ──────────────────────────
        const items: any[] = []
        for (const entry of entries.slice(0, 25)) {
          const title = cleanString(entry?.title)
          const link  = pickLink(entry)
          if (!title || !link) continue

          items.push({
            feed_id:      feed.id,
            guid:         pickGuid(entry) || link,
            title,
            link,
            summary:      pickSummary(entry),
            author:       cleanString(entry?.author?.name ?? entry?.author),
            published_at: parseDate(
              entry?.published ?? entry?.updated ?? entry?.pubDate ?? entry?.date
            ),
            raw_xml:      entry,                              // full parsed entry as JSONB
            content_hash: await contentHash(title, link),    // for dedup
          })
        }

        if (items.length === 0) {
          await supabase.from("feed_fetch_logs").insert({
            feed_id: feed.id, http_status: res.status,
            success: true, response_time_ms: responseMs, item_count: 0,
          })
          results.push({ feed_id: feed.id, feed_name: feed.name, status: "no_items" })
          continue
        }

        // ── 5. Upsert to raw_feed_items ───────────────────────────
        // Conflict on (feed_id, link) — matches the existing unique index.
        // ignoreDuplicates: true = skip silently, never error on re-ingestion.
        const { error: upsertError } = await supabase
          .from("raw_feed_items")
          .upsert(items, { onConflict: "feed_id,link", ignoreDuplicates: true })

        const now = new Date().toISOString()

        // ── 6. Update feed timestamps ─────────────────────────────
        await supabase
          .from("feeds")
          .update({
            last_fetched_at: now,
            ...(upsertError ? {} : { last_success_at: now }),
          })
          .eq("id", feed.id)

        // ── 7. Log the fetch ──────────────────────────────────────
        await supabase.from("feed_fetch_logs").insert({
          feed_id:          feed.id,
          http_status:      res.status,
          success:          !upsertError,
          error_message:    upsertError?.message ?? null,
          response_time_ms: responseMs,
          item_count:       items.length,
        })

        if (upsertError) {
          results.push({
            feed_id: feed.id, feed_name: feed.name,
            status: "upsert_failed", error: upsertError.message,
          })
          continue
        }

        results.push({
          feed_id: feed.id, feed_name: feed.name,
          status: "ok", items_ingested: items.length,
        })

      } catch (err) {
        // Per-feed exception — log and keep going
        await supabase.from("feed_fetch_logs").insert({
          feed_id:          feed.id,
          success:          false,
          error_message:    err instanceof Error ? err.message : String(err),
          response_time_ms: Date.now() - fetchStart,
          item_count:       0,
        }).catch(() => {})

        results.push({
          feed_id: feed.id, feed_name: feed.name,
          status: "exception",
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return new Response(
      JSON.stringify({
        success:          true,
        feeds_processed:  feeds?.length ?? 0,
        duration_ms:      Date.now() - runStart,
        results,
      }),
      { headers: { "Content-Type": "application/json" } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
})
