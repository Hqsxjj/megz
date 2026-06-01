# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

"每日工作" (Daily Work) — a Cloudflare Worker that serves a single-page app for tracking daily work metrics: WeChat counts, intent counts, client registrations, and todo lists. The entire application (HTML, CSS, JS, and API routes) lives in one file: `src/index.js`.

## Commands

- **Deploy**: `npx wrangler deploy`
- **Preview locally**: `npx wrangler dev`

No build step, no package.json, no tests.

## Architecture

**Storage**: Cloudflare Workers KV (`DATA_KV` namespace, binding defined in `wrangler.toml`). All persistence goes through KV — keys are prefixed with `work:YYYY-MM-DD`. The frontend also mirrors data in `localStorage` and auto-syncs from KV on first load, then pushes local changes to KV every 5 seconds.

**Routing**: The Worker checks `request.url` pathname. Four API routes (`/api/data`, `/api/calendar`, `/api/stats`) handle JSON CRUD; any other request receives the full HTML page. All API responses include CORS `Access-Control-Allow-Origin: *`.

**Frontend**: Inline SPA with no frameworks. Features PIN-lock privacy screen (default PIN `8520`), +/- counters with gradient cards, weekly/monthly stats, compact calendar, client registration with edit/delete, today/tomorrow todo lists with daily auto-rollover, dark mode toggle, and dynamic wallpaper from picsum.photos with daily cache. Keyboard shortcuts: `+`/`-` to increment/decrement WeChat count, `Ctrl+Z` to lock the page.

**Deployment**: GitHub Actions triggers `wrangler deploy` on push to `main` (requires `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets).
