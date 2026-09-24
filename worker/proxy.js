// Anchorage API as a Cloudflare Worker: the same /api routes as server.mjs, for when
// index.html is hosted on a static host such as GitHub Pages.
//
//   GET /api/fetch?url=<page>     -> the page's HTML (final URL in the X-Final-URL header)
//   GET /api/resolve?url=<link>   -> { status, finalStatus, finalUrl, hops: [{ url, status }] }
//
// Deploy from the repo root: `npx wrangler deploy` (settings in wrangler.toml), then set
// API_BASE in index.html to the URL wrangler prints.

// Only these sites may call the API from a browser.
const ALLOWED_ORIGINS = ['https://gundaif.github.io'];
const ALLOW_LOCALHOST = true;

const USER_AGENT = 'Mozilla/5.0 (compatible; AnchorageLinkExtractor/1.0; +https://github.com/gundaIf/link-checker)';
const MAX_HOPS = 10;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) || (ALLOW_LOCALHOST && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Final-URL',
    Vary: 'Origin',
  };
}

async function followRedirects(start, method) {
  const hops = [];
  let url = start;
  for (let i = 0; i <= MAX_HOPS; i++) {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    hops.push({ url, status: res.status });
    const location = res.headers.get('Location');
    if (res.status >= 300 && res.status < 400 && location) {
      res.body?.cancel();
      url = new URL(location, url).href;
      continue;
    }
    return { res, finalUrl: url, hops };
  }
  throw new Error('Too many redirects.');
}

export default {
  async fetch(request) {
    const cors = corsHeaders(request.headers.get('Origin') || '');
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const { pathname, searchParams } = new URL(request.url);
    if (pathname !== '/api/fetch' && pathname !== '/api/resolve') return json({ error: 'Not found' }, 404);
    const target = searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return json({ error: 'Pass an http(s) URL as ?url=' }, 400);

    if (pathname === '/api/resolve') {
      try {
        let result = await followRedirects(target, 'HEAD');
        // Some servers reject HEAD; retry those with GET.
        if ([403, 405, 501].includes(result.res.status)) result = await followRedirects(target, 'GET');
        result.res.body?.cancel();
        const first = result.hops[0].status;
        return json({
          status: first >= 300 && first < 400 ? first : result.res.status,
          finalStatus: result.res.status,
          finalUrl: result.finalUrl,
          hops: result.hops,
        });
      } catch (e) {
        return json({ status: 0, finalUrl: target, hops: [], error: String(e.message || e) });
      }
    }

    try {
      const { res, finalUrl } = await followRedirects(target, 'GET');
      if (!res.ok) {
        res.body?.cancel();
        return json({ error: `The page answered with HTTP ${res.status}. Check the address and try again.` }, 502);
      }
      const type = res.headers.get('Content-Type') || '';
      if (type && !/html|xml|text\/plain/i.test(type)) {
        res.body?.cancel();
        return json({ error: `That URL is a ${type.split(';')[0]} file, not a web page.` }, 415);
      }
      const length = Number(res.headers.get('Content-Length') || 0);
      if (length > MAX_BYTES) {
        res.body?.cancel();
        return json({ error: 'That page is too large to read (over 8 MB).' }, 413);
      }
      const body = await res.text();
      if (body.length > MAX_BYTES) return json({ error: 'That page is too large to read (over 8 MB).' }, 413);
      return new Response(body, {
        headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'X-Final-URL': finalUrl, 'Cache-Control': 'no-store' },
      });
    } catch (e) {
      const timedOut = e.name === 'TimeoutError';
      return json({ error: timedOut ? 'The page took too long to respond.' : 'Couldn’t reach that page. Check the address and try again.' }, timedOut ? 504 : 502);
    }
  },
};
