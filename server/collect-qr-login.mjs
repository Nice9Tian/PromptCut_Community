/**
 * Bilibili QR code login (API version, without opening a browser).
 *
 * QR code login on Bilibili web uses two public endpoints:
 *   GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate
 *       → { code: 0, data: { url, qrcode_key } }   url is the content of the QR code
 *   GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=…
 *       → { code: 0, data: { code: 0 | 86101 | 86090 | 86038, message, url, refresh_token } }
 *       86101 not scanned / 86090 scanned but unconfirmed / 86038 QR code expired (~3 minutes) /
 *       0 login success.
 *       The Set-Cookie on that successful response carries SESSDATA, bili_jct, DedeUserID, etc.,
 *       saved directly as cookies.txt.
 *
 * Verified in testing (2026-09-08): sending Chrome UA + Referer is required to avoid 412; omitting
 * UA also works, but keeping it consistent with downloads prevents getting blocked later.
 * The QR code is generated on the fly by qr.mjs, and the frontend only receives the SVG for display.
 *
 * Sessions exist only in memory: key → { site, url, createdAt, state }. The QR code expires in
 * 3 minutes; once expired, the frontend simply restarts one.
 */
import { assessLogin, saveCookies } from './collect-cookies.mjs';
import { qrSvg } from './qr.mjs';
import { tr } from './i18n.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const ENDPOINTS = {
  bilibili: {
    generate: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
    poll: 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=',
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    /** QR code validity period (seconds); 180 for Bilibili */
    ttl: 180,
    /** data.code returned by poll → our state */
    states: { 0: 'ok', 86101: 'waiting', 86090: 'scanned', 86038: 'expired' },
  },
};

/** Single Set-Cookie line → CDP-shaped cookie object (matches toNetscape in collect-cookies.mjs) */
export function parseSetCookie(line, defaultDomain = '.bilibili.com') {
  const parts = String(line).split(';').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const eq = parts[0].indexOf('=');
  if (eq <= 0) return null;
  const cookie = {
    name: parts[0].slice(0, eq).trim(),
    value: parts[0].slice(eq + 1).trim(),
    domain: defaultDomain,
    path: '/',
    expires: -1,
    secure: false,
    httpOnly: false,
  };
  for (const attr of parts.slice(1)) {
    const [k, ...rest] = attr.split('=');
    const key = k.trim().toLowerCase();
    const val = rest.join('=').trim();
    if (key === 'domain' && val) cookie.domain = val.startsWith('.') ? val : '.' + val;
    else if (key === 'path' && val) cookie.path = val;
    else if (key === 'expires' && val) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
    } else if (key === 'max-age' && val && /^-?\d+$/.test(val)) {
      cookie.expires = Math.floor(Date.now() / 1000) + Number(val);
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
  }
  return cookie;
}

/**
 * data.url on a successful response has the shape:
 *   https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=…&SESSDATA=…&bili_jct=…&Expires=1234
 * In some environments Set-Cookie headers are incomplete (fetch redirects / proxies);
 * supplement from here.
 */
export function cookiesFromCrossDomainUrl(url) {
  const out = [];
  let u;
  try { u = new URL(String(url)); } catch { return out; }
  const expires = Number(u.searchParams.get('Expires'));
  const exp = Number.isFinite(expires) && expires > 0 ? Math.floor(Date.now() / 1000) + expires : -1;
  for (const [k, v] of u.searchParams) {
    if (k === 'Expires' || k === 'gourl') continue;
    out.push({ name: k, value: v, domain: '.bilibili.com', path: '/', expires: exp, secure: false, httpOnly: false });
  }
  return out;
}

/**
 * Merge cookies from Set-Cookie headers and crossDomain links: Set-Cookie takes precedence on name collision.
 */
export function mergeCookies(fromHeaders, fromUrl) {
  const byName = new Map();
  for (const c of fromUrl) if (c) byName.set(c.name, c);
  for (const c of fromHeaders) if (c) byName.set(c.name, c);
  return [...byName.values()];
}

/** Read Set-Cookie header: Node 19.7+ has getSetCookie; older versions fall back to a single header */
function setCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const one = headers.get('set-cookie');
  return one ? [one] : [];
}

export function createQrLogin({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const sessions = new Map();

  /** Prevent old sessions from piling up: clean up those expired for more than 10 minutes */
  function sweep() {
    const cutoff = now() - 10 * 60 * 1000;
    for (const [k, s] of sessions) if (s.createdAt < cutoff) sessions.delete(k);
  }

  async function start(site = 'bilibili') {
    const ep = ENDPOINTS[site];
    if (!ep) throw new Error(tr("Site {0} has no QR code login", site));
    sweep();
    const r = await fetchImpl(ep.generate, { headers: ep.headers });
    if (!r.ok) throw new Error(tr("Failed to get QR code: HTTP {0}", r.status));
    const body = await r.json();
    if (body?.code !== 0 || !body?.data?.url || !body?.data?.qrcode_key) {
      throw new Error(tr("Failed to get QR code: {0}", body?.message ?? tr("unexpected response format")));
    }
    const key = String(body.data.qrcode_key);
    const session = { key, site, url: String(body.data.url), createdAt: now(), state: 'waiting', ttl: ep.ttl };
    sessions.set(key, session);
    return { key, site, url: session.url, expiresIn: ep.ttl };
  }

  function svg(key, opts) {
    const s = sessions.get(key);
    if (!s) return null;
    return qrSvg(s.url, opts);
  }

  /**
   * Poll once. Returns { state: waiting | scanned | expired | ok, message, ...fields on login success }.
   * On success, passes cookies to onLogin(cookies) to persist to disk; does not write files directly
   * here to simplify testing.
   */
  async function poll(key, { dataDir } = {}) {
    const s = sessions.get(key);
    if (!s) return { state: 'expired', message: tr("This QR code does not exist or the service was restarted. Generate a new one") };
    if (s.state === 'ok') return { state: 'ok', ...s.result };
    const ep = ENDPOINTS[s.site];
    if (now() - s.createdAt > ep.ttl * 1000) {
      s.state = 'expired';
      return { state: 'expired', message: tr("QR code expired. Generate a new one") };
    }
    const r = await fetchImpl(ep.poll + encodeURIComponent(key), { headers: ep.headers, redirect: 'manual' });
    if (!r.ok) return { state: s.state, message: tr("Query failed: HTTP {0}", r.status), transient: true };
    const body = await r.json();
    const code = body?.data?.code;
    const state = ep.states[code] ?? (body?.code === 0 ? 'waiting' : 'expired');
    if (state !== 'ok') {
      s.state = state;
      return { state, message: body?.data?.message || body?.message || '' };
    }
    const cookies = mergeCookies(
      setCookieLines(r.headers).map((l) => parseSetCookie(l)),
      cookiesFromCrossDomainUrl(body?.data?.url),
    );
    const a = assessLogin(s.site, cookies, now());
    if (!a.loggedIn) {
      s.state = 'expired';
      return { state: 'expired', message: tr("Login response is missing {0}, scan again", a.missing.join(' / ')) };
    }
    const file = dataDir ? saveCookies(dataDir, s.site, a.cookies) : null;
    s.state = 'ok';
    s.result = {
      site: s.site, loggedIn: true, userId: a.userId,
      expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
      path: file, count: a.cookies.length,
    };
    return { state: 'ok', ...s.result };
  }

  return { start, poll, svg, sessions };
}

/** Process-level singleton: used by routes; tests call createQrLogin themselves to inject a mock fetch */
let shared = null;
export function qrLogin() {
  if (!shared) shared = createQrLogin();
  return shared;
}
