// Anchorage API as a Cloudflare Worker — the same /api routes as server.mjs, for when
// index.html is hosted on a static host such as GitHub Pages.
//
//   GET /api/fetch?url=<page>     -> the page's HTML (final URL in the X-Final-URL header)
//   GET /api/resolve?url=<link>   -> { status, finalStatus, finalUrl, hops: [{ url, status }] }
//
// Deploy: `npx wrangler deploy worker/proxy.js --name anchorage-api`, then set
// API_BASE in index.html to the URL wrangler prints.
// Set ALLOWED_ORIGIN to your site's origin to stop other sites using your proxy.

const ALLOWED_ORIGIN = '*';
const USER_AGENT = 'Mozilla/5.0 (compatible; AnchorageLinkExtractor/1.0)';
const MAX_HOPS = 10;

const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Final-URL',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const { pathname, searchParams: params } = new URL(request.url);
    if (pathname !== '/api/fetch' && pathname !== '/api/resolve') return json({ error: 'Not found' }, 404);
    const target = params.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return json({ error: 'Pass an http(s) URL as ?url=' }, 400);

    if (pathname === '/api/resolve') {
      const hops = [];
      let url = target;
      try {
        for (let i = 0; i < MAX_HOPS; i++) {
          const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT } });
          hops.push({ url, status: res.status });
          const location = res.headers.get('Location');
          if (res.status >= 300 && res.status < 400 && location) {
            url = new URL(location, url).href;
            continue;
          }
          const first = hops[0].status;
          return json({ status: first >= 300 && first < 400 ? first : res.status, finalStatus: res.status, finalUrl: url, hops });
        }
        return json({ status: 508, finalUrl: url, hops, error: 'Too many redirects' });
      } catch (e) {
        return json({ status: 0, finalUrl: url, hops, error: String(e) });
      }
    }

    try {
      const res = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' } });
      if (!res.ok) return json({ error: `The page answered with HTTP ${res.status}. Check the address and try again.` }, 502);
      return new Response(res.body, {
        status: res.status,
        headers: { ...cors, 'Content-Type': res.headers.get('Content-Type') || 'text/html', 'X-Final-URL': res.url },
      });
    } catch (e) {
      return json({ error: 'Couldn’t reach that page. Check the address and try again.' }, 502);
    }
  },
};
