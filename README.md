# Anchorage

Paste any URL and get every hyperlink on the page: anchor text, destination, page section (nav, content, sidebar, footer), rel attributes, and where each link really goes after redirects. Links are grouped by type (internal, external, social, files, email & phone, same-page anchors), domain, or page section, and export to CSV or JSON.

- `index.html`: the whole front end, no build step
- `server.mjs`: serves the page plus `/api/fetch` and `/api/resolve` (Node 18+, no dependencies)
- `worker/proxy.js`: the same API as a Cloudflare Worker, for static hosting

## Run locally

```bash
node server.mjs
```

Then open http://localhost:8080 (set `PORT` to change it).

## Deploy

**Option A: one Node service.** Deploy the repo to Render, Railway or Fly.io with start command `node server.mjs`. The page and API share an origin, so nothing needs configuring.

**Option B: GitHub Pages + Cloudflare Worker (free).** Pages serves `index.html`; the Worker in `worker/proxy.js` does the fetching.

```bash
npx wrangler login
npx wrangler deploy
```

Then set `API_BASE` at the top of the script in `index.html` to the `https://anchorage-api.<you>.workers.dev` URL that `wrangler deploy` prints. The Worker only answers browsers on the origins listed in `ALLOWED_ORIGINS` (plus localhost), so add your own domain there if you use one.

Without either API, the page falls back to public CORS proxies, which are often rate-limited or down.

## Safety

The server refuses private, loopback and link-local addresses on every redirect hop, caps pages at 8 MB, and times out after 15 s. If a site blocks the fetch, users can paste the page source instead.
