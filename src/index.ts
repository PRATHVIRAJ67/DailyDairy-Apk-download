/**
 * DailyDairy download service.
 *
 *   POST /api/link    -> { url } a signed link to the APK that expires in 15 minutes
 *   GET  /api/latest  -> { available, size, uploaded } about the APK currently stored
 *   GET  /apk?exp&sig -> streams the APK from the private R2 bucket (needs a valid link)
 *
 * The bucket is never public; the Worker only serves the file for an unexpired signature.
 */
export interface Env {
  APK: R2Bucket;
  ASSETS: Fetcher;
  /** Random string used to sign download links: `npx wrangler secret put DOWNLOAD_SECRET`. */
  DOWNLOAD_SECRET: string;
}

const OBJECT_KEY = 'DailyDairy.apk';
const FILE_NAME = 'DailyDairy.apk';
const LINK_TTL_SECONDS = 15 * 60;
const encoder = new TextEncoder();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function signingKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}

async function sign(secret: string, exp: number) {
  return toHex(await crypto.subtle.sign('HMAC', await signingKey(secret, 'sign'), encoder.encode(String(exp))));
}

async function isValidLink(secret: string, exp: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const bytes = fromHex(sig);
  if (!bytes) return false;
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', await signingKey(secret, 'verify'), bytes, encoder.encode(String(exp)));
}

async function serveApk(request: Request, env: Env): Promise<Response> {
  const headers = new Headers({
    'content-type': 'application/vnd.android.package-archive',
    'content-disposition': `attachment; filename="${FILE_NAME}"`,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
  });

  if (request.method === 'HEAD') {
    const head = await env.APK.head(OBJECT_KEY);
    if (!head) return new Response(null, { status: 404 });
    headers.set('content-length', String(head.size));
    headers.set('etag', head.httpEtag);
    return new Response(null, { headers });
  }

  const object = await env.APK.get(OBJECT_KEY, { range: request.headers });
  if (!object) return json({ error: 'The app file has not been uploaded yet.' }, 404);
  headers.set('etag', object.httpEtag);

  // Resume support for flaky mobile connections.
  const range = request.headers.has('range') ? object.range : undefined;
  if (range) {
    const size = object.size;
    const start = 'suffix' in range ? Math.max(0, size - range.suffix) : (range.offset ?? 0);
    const length = 'suffix' in range ? size - start : (range.length ?? size - start);
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('content-length', String(object.size));
  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/latest' && request.method === 'GET') {
      const head = await env.APK.head(OBJECT_KEY);
      return json(head ? { available: true, size: head.size, uploaded: head.uploaded.toISOString() } : { available: false });
    }

    if (url.pathname === '/api/link' && request.method === 'POST') {
      if (!env.DOWNLOAD_SECRET) return json({ error: 'Downloads are not configured yet.' }, 503);
      const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
      return json({ url: `/apk?exp=${exp}&sig=${await sign(env.DOWNLOAD_SECRET, exp)}`, expires_in: LINK_TTL_SECONDS });
    }

    if (url.pathname === '/apk' && (request.method === 'GET' || request.method === 'HEAD')) {
      if (!env.DOWNLOAD_SECRET) return json({ error: 'Downloads are not configured yet.' }, 503);
      const ok = await isValidLink(env.DOWNLOAD_SECRET, Number(url.searchParams.get('exp')), url.searchParams.get('sig') ?? '');
      if (!ok) return json({ error: 'This download link has expired. Open the download page again for a fresh one.' }, 403);
      return serveApk(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
