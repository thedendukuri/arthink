# Options Trading Dashboard

A self-contained Excel dashboard plus a Python refresh script that pulls
options data into the workbook. Built around **free** market data (yfinance)
with the option to swap in paid APIs later.

## Files

- `options_dashboard.xlsx` — the dashboard. Open in Excel or LibreOffice.
- `schwab_refresh.py` — **Recommended.** Pulls real-time quotes + options chains
  from Schwab's Developer API (free with a Schwab brokerage account).
- `yfinance_refresh.py` — Fallback. Free, no signup, ~15-min delayed; useful
  while you're waiting for Schwab to approve your developer app.
- `.env.example` — template for Schwab API credentials.
- `README.md` — this file.

## Recommended path: Schwab Developer API (real-time, free with brokerage)

### One-time setup (1–3 days, mostly waiting for approval)

1. Go to <https://developer.schwab.com> and sign in with your Schwab brokerage
   credentials.
2. **Add a New App.** Name it anything (e.g., "Personal Dashboard"). Add the
   product **"Market Data Production"**. Set callback URL to
   `https://127.0.0.1:8182`. Submit.
3. **Wait for approval.** Schwab manually reviews individual-developer apps —
   typically 1–3 business days. While you wait, use `yfinance_refresh.py`.
4. Once approved, copy your **App Key** and **App Secret** from the dashboard.
5. In this folder, copy `.env.example` to `.env` and paste your key/secret in.
6. Install Python deps:
   ```bash
   pip install requests openpyxl pandas numpy python-dotenv --break-system-packages
   ```

### First run (interactive, ~30 seconds)

```bash
cd "/path/to/this/folder"
python schwab_refresh.py options_dashboard.xlsx
```

The script opens your browser to Schwab's authorization page. Log in, click
**Allow**, and your browser will redirect to a `https://127.0.0.1:8182/?code=...`
URL that shows a "site can't be reached" error (that's fine — there's no
local server). **Copy the full URL** from the address bar and paste it back
into the terminal. The script extracts the auth code, exchanges it for
tokens, saves them to `schwab_tokens.json`, and refreshes the workbook.

### Subsequent runs (non-interactive)

```bash
python schwab_refresh.py options_dashboard.xlsx
```

Tokens auto-refresh. Roughly once per week (when the 7-day refresh token
rotates), the script will prompt you to repeat the browser auth step.

## Fallback path: yfinance (free, no setup, delayed)

While your Schwab app is pending approval, or if you want a no-setup option:

```bash
pip install yfinance openpyxl pandas numpy --break-system-packages
python yfinance_refresh.py options_dashboard.xlsx
```

Yahoo's free feed is delayed ~15 minutes and yfinance is unofficial (it scrapes
Yahoo). For occasional checks it's fine; for active trading it's not.

## Configure the dashboard

Open `options_dashboard.xlsx`, read the README sheet inside, then on the
**Config** sheet set:
- Account size (B5) — your trading capital.
- Max risk per trade % (B6) — 1–5% is the standard discipline.

Edit your **Watchlist** (column A) — pre-filled with major indices and
liquid US single names. Add/remove freely. Save and close before running
refresh (Excel holds a write lock; the script can't share it).

## Free vs paid data — what to use

| Source | Cost | Real-time? | Options? | Notes |
|---|---|---|---|---|
| **yfinance** (Yahoo) | Free | ~15-min delayed | Yes | Default. Unofficial, can break. Best for $0 budget. |
| **Schwab Developer API** | Free w/ brokerage | Yes | Yes | Requires Schwab account + OAuth setup. Production-grade. |
| **Tradier Sandbox** | Free | No (sim data) | Yes | Real-time needs a funded brokerage account. |
| **Polygon.io** Stocks Starter | $29/mo | Yes | No (stocks only) | Options requires Options Starter ~$99/mo. |
| **Polygon.io** Options Advanced | $199/mo | Yes | Yes | Production-grade. Overkill for a $1k account. |
| **marketdata.app** | Free tier | Delayed | Yes (limited) | Worth trying as a yfinance backup. |

For a $1k account, **stick with yfinance**. The 15-minute delay doesn't matter
if your strategy isn't sub-minute scalping, and even if it is, scalping with
$1k against algos with millisecond data is not a winning game.

## Sheet guide

- **Config** — API key, account size, risk parameters, refresh log.
- **Watchlist** — Live quotes for tickers in column A. Refreshed by the script.
- **OptionsChain** — Pick a ticker (B3) and expiration (D3 — leave blank for
  nearest weekly), then re-run refresh. Calls on the left, strike center,
  puts on the right.
- **StrategyCalc** — Plug in up to 4 legs and an underlying price; the sheet
  computes net debit/credit, P&L at expiry, and a 21-point payoff diagram
  spanning ±20% of the underlying. Strategy templates listed at the bottom.
- **PositionSizer** — Given account size and max-risk %, shows how many
  contracts you can responsibly buy at various premium levels. Built-in
  reality check on small-account sizing.
- **Positions** — Manual log of open positions. Enter the option in column C
  in either format:
  - OCC: `AAPL250620C00200000`
  - Loose: `AAPL 2025-06-20 CALL 200`
  The refresh script populates the Mark column.
- **Journal** — Trade journal. Use it. Reread it monthly. Survivors learn from
  every trade.

## Automating refreshes

**macOS / Linux** (cron, every 15 min during market hours):
```cron
*/15 9-16 * * 1-5  cd /path/to/folder && /usr/bin/python3 yfinance_refresh.py options_dashboard.xlsx >> refresh.log 2>&1
```

**Windows** (Task Scheduler):
- Action: Start a program
- Program: `python.exe`
- Arguments: `yfinance_refresh.py options_dashboard.xlsx`
- Start in: folder containing the script
- Trigger: every 15 minutes, weekdays 9:30–16:00 ET

## Switching to a paid API later

The dashboard is data-source-agnostic. To swap from yfinance to Polygon /
Schwab / Tradier, write a parallel refresh script that:

1. Reads the same Config + Watchlist + OptionsChain selector cells.
2. Writes into the same target cells (column layouts documented in
   `yfinance_refresh.py` source).
3. Updates the Config status cells when done.

The dashboard will work identically.

## Risk warnings (please read)

Options can lose more than you put in (when shorting/writing uncovered).
Even long options can go to zero overnight on a gap, an earnings miss, or
expiration. Targeting >100% returns in a few months requires strategies
whose base rate of catastrophic loss is very high. The PositionSizer sheet
exists because the most common failure mode for small accounts isn't picking
the wrong direction — it's sizing too large on a single trade and getting
wiped before the strategy has time to play out.

This repo is a tool, not financial advice. You are responsible for your own
trades. Anthropic is not a registered investment adviser.

## Troubleshooting

- **`Permission denied` saving xlsx** — Excel has the file open. Close it.
- **`Missing dependency`** — re-run the pip install command above.
- **Watchlist quotes are all blank** — yfinance hit a rate limit or the
  ticker symbol is wrong. Try a smaller watchlist (≤20 tickers) and re-run.
- **OptionsChain didn't populate** — the ticker has no listed options, or
  the expiration you typed isn't a valid date. Leave D3 blank to use the
  nearest expiry.
- **`Last refresh status` shows ERROR** — open the script in a terminal so
  you can see the full Python traceback.

## Updating the dashboard structure

The dashboard was generated by `build_dashboard.py` (in the same folder). To
add a sheet, change column layouts, or modify formulas, edit that script
and re-run:
```bash
python build_dashboard.py options_dashboard.xlsx
```
This will overwrite the file (and erase any data you've entered manually).
For incremental edits, modify the workbook directly in Excel.
