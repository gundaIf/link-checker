// Anchorage server: serves index.html and fetches pages on the browser's behalf.
// No dependencies. Node 18+.
//
//   GET /api/fetch?url=<page>     -> the page's HTML (final URL in X-Final-URL)
//   GET /api/resolve?url=<link>   -> { status, finalStatus, finalUrl, hops: [{ url, status }] }
//
// Run: `node server.mjs` (PORT defaults to 8080).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const USER_AGENT = 'Mozilla/5.0 (compatible; AnchorageLinkExtractor/1.0; +https://github.com/gundaIf/link-checker)';
const MAX_HOPS = 10;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
};

// Refuse private, loopback and link-local addresses so the server can't be used
// to reach internal services (e.g. cloud metadata endpoints).
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new HttpError(400, 'That isn’t a valid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Only http and https URLs are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }); }
  catch { throw new HttpError(502, `Couldn’t find a server at ${url.hostname}.`); }
  if (addresses.some(a => isPrivateAddress(a.address))) throw new HttpError(403, 'That address points to a private network.');
  return url;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Follows redirects by hand so every hop is checked against private addresses.
async function followRedirects(raw, method) {
  const hops = [];
  let url = raw;
  for (let i = 0; i <= MAX_HOPS; i++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    hops.push({ url, status: res.status });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      res.body?.cancel();
      url = new URL(location, url).href;
      continue;
    }
    return { res, finalUrl: url, hops };
  }
  throw new HttpError(508, 'Too many redirects.');
}

async function readCapped(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new HttpError(413, 'That page is too large to read (over 8 MB).');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleFetch(target) {
  const { res, finalUrl } = await followRedirects(target, 'GET');
  if (!res.ok) {
    res.body?.cancel();
    throw new HttpError(502, `The page answered with HTTP ${res.status}. Check the address and try again.`);
  }
  const type = res.headers.get('content-type') || '';
  if (type && !/html|xml|text\/plain/i.test(type)) {
    res.body?.cancel();
    throw new HttpError(415, `That URL is a ${type.split(';')[0]} file, not a web page.`);
  }
  return { body: await readCapped(res), finalUrl };
}

async function handleResolve(target) {
  let result;
  try {
    result = await followRedirects(target, 'HEAD');
    // Some servers reject HEAD; retry those with GET.
    if ([403, 405, 501].includes(result.res.status)) result = await followRedirects(target, 'GET');
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) throw e;
    return { status: 0, finalUrl: target, hops: [], error: e.message };
  }
  result.res.body?.cancel();
  const first = result.hops[0].status;
  return { status: first >= 300 && first < 400 ? first : result.res.status, finalStatus: result.res.status, finalUrl: result.finalUrl, hops: result.hops };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Final-URL', ...headers });
  res.end(body);
}
const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json' });

http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/fetch' || pathname === '/api/resolve') {
      const target = searchParams.get('url');
      if (!target) throw new HttpError(400, 'Pass a URL as ?url=');
      if (pathname === '/api/fetch') {
        const { body, finalUrl } = await handleFetch(target);
        return send(res, 200, body, { 'Content-Type': 'text/html; charset=utf-8', 'X-Final-URL': finalUrl, 'Cache-Control': 'no-store' });
      }
      return sendJson(res, 200, await handleResolve(target));
    }
    const file = STATIC[pathname];
    if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    return send(res, 200, await readFile(path.join(ROOT, file[0])), { 'Content-Type': file[1] });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e.name === 'TimeoutError' ? 504 : 502;
    const message = e instanceof HttpError ? e.message
      : e.name === 'TimeoutError' ? 'The page took too long to respond.'
      : 'Couldn’t reach that page. Check the address and try again.';
    return sendJson(res, status, { error: message });
  }
}).listen(PORT, () => console.log(`Anchorage running at http://localhost:${PORT}`));
