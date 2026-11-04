/**
 * Login state for media collection: site definitions, cookie evaluation, Netscape cookies.txt read/write.
 *
 * Pure logic, touches neither browser nor network, so unit testable. The browser side (opening login page,
 * getting cookies from CDP, moving window) calls server/web/ modules in vite-plugin-collect.ts.
 *
 * Why save as cookies.txt instead of using the browser profile directly:
 * Downloading is done by yt-dlp (Python process), which cannot read Chrome's cookie store (on Windows
 * there is application-bound encryption; verified Edge / Chrome both give Could not copy cookie database),
 * but accepts Netscape-format text files: log in once, export once, and automatically include it with
 * every subsequent download.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tr } from './i18n.mjs';

/**
 * Site definitions. Adding a site adds an item:
 *   loginUrl   page where users log in
 *   domains    cookie domains belonging to this site (regex)
 *   required   all these cookies must be present to be considered logged in
 *   userCookie which cookie's value can echo back as user identifier
 *   match      whether a link / video ID is handled by this site
 */
export const SITES = {
  bilibili: {
    name: 'Bilibili',
    loginUrl: 'https://passport.bilibili.com/login',
    domains: /(^|\.)(bilibili\.com|bilibili\.tv|biliapi\.net|bigfun\.cn)$/i,
    required: ['SESSDATA', 'bili_jct', 'DedeUserID'],
    userCookie: 'DedeUserID',
    match: (url) => {
      const u = String(url || '').trim();
      if (/^BV[0-9A-Za-z]{10}$/.test(u) || /^av\d+$/i.test(u)) return true;
      return /(^|\/\/|\.)(www\.|m\.)?(bilibili\.com|b23\.tv|bilibili\.tv)(\/|$)/i.test(u.includes('://') ? u : 'https://' + u);
    },
  },
};

export function siteNames() {
  return Object.keys(SITES);
}

/** Which site with login support a link belongs to; null if none */
export function siteOfUrl(url) {
  for (const [id, site] of Object.entries(SITES)) {
    if (site.match(url)) return id;
  }
  return null;
}

/** Where cookies.txt is stored. dataDir is PROMPTCUT_DATA_DIR (default out/), which is not tracked in git */
export function cookieFilePath(dataDir, siteId) {
  return path.join(dataDir, 'cookies', `${siteId}.txt`);
}

/**
 * CDP Network.getAllCookies entry → Netscape single line.
 * 7 tab-separated columns: domain / includeSubdomains / path / secure / expires / name / value.
 * Session cookies (expires is -1) are written as 0, which yt-dlp sends as session cookies as-is.
 */
export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Exported by PromptCut media collection after login; deleting this file is the same as logging out.', ''];
  for (const c of cookies) {
    const domain = String(c.domain || '');
    const expires = typeof c.expires === 'number' && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push([
      domain,
      domain.startsWith('.') ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      String(expires),
      c.name,
      c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/** Netscape text → cookie entries (parses only, does not validate) */
export function parseNetscape(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    // Files exported by yt-dlp prefix httpOnly lines with #HttpOnly_; do not discard as comments
    const line = raw.startsWith('#HttpOnly_') ? raw.slice('#HttpOnly_'.length) : raw;
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const [domain, , p, secure, expires, name, value] = cols;
    out.push({
      domain, path: p, secure: secure === 'TRUE',
      expires: Number(expires) > 0 ? Number(expires) : -1,
      name, value: cols.slice(6).join('\t'),
    });
  }
  return out;
}

/**
 * Whether these cookies count as logged in for a site.
 * Returns { loggedIn, missing, userId, expiresAt (ms or null), expired, cookies (site-only) }.
 */
export function assessLogin(siteId, cookies, now = Date.now()) {
  const site = SITES[siteId];
  if (!site) throw new Error(tr("No site named {0}, available: {1}", siteId, siteNames().join(', ')));
  const mine = (cookies || []).filter((c) => site.domains.test(String(c.domain || '').replace(/^\./, '')));
  const byName = new Map(mine.map((c) => [c.name, c]));
  const missing = site.required.filter((n) => !byName.get(n)?.value);
  // Expiration time takes earliest among key cookies; session cookies (-1 / 0) do not participate
  let expiresAt = null;
  for (const n of site.required) {
    const c = byName.get(n);
    if (c && typeof c.expires === 'number' && c.expires > 0) {
      const ms = c.expires * 1000;
      if (expiresAt === null || ms < expiresAt) expiresAt = ms;
    }
  }
  const expired = expiresAt !== null && expiresAt <= now;
  const user = byName.get(site.userCookie)?.value ?? null;
  return {
    site: siteId,
    loggedIn: missing.length === 0 && !expired,
    missing,
    expired,
    userId: user,
    expiresAt,
    cookies: mine,
  };
}

/** Current status of persisted login state on disk. Returns readable object even if file does not exist, does not throw */
export function savedCookieStatus(dataDir, siteId, now = Date.now()) {
  const file = cookieFilePath(dataDir, siteId);
  if (!fs.existsSync(file)) {
    return { site: siteId, path: file, exists: false, loggedIn: false, expired: false, userId: null, expiresAt: null, missing: SITES[siteId]?.required ?? [] };
  }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* Unreadable counts as missing */ }
  const a = assessLogin(siteId, parseNetscape(text), now);
  return { site: siteId, path: file, exists: true, loggedIn: a.loggedIn, expired: a.expired, userId: a.userId, expiresAt: a.expiresAt, missing: a.missing };
}

/** Persist login state to disk. Returns file path */
export function saveCookies(dataDir, siteId, cookies) {
  const file = cookieFilePath(dataDir, siteId);
  // 0700 / 0600: this file contains SESSDATA, which grants full account access; should not be readable by everyone on the same machine
  // (mode is largely ineffective on Windows; what actually blocks the web path is fs.deny in vite.config.ts)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, toNetscape(cookies), { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** Delete persisted login state on disk (equivalent to logout). Returns whether anything was actually deleted */
export function forgetCookies(dataDir, siteId) {
  const file = cookieFilePath(dataDir, siteId);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/**
 * Decide whether to include cookies before download / probe.
 * Use path if passed explicitly; if not, check which site this link belongs to and whether that site
 * has unexpired persisted login state.
 * Returns { path, site, reason }: when path is null, reason explains why it was not included (for job notes).
 */
export function pickCookies(dataDir, url, explicitPath) {
  if (explicitPath) {
    return fs.existsSync(explicitPath)
      ? { path: explicitPath, site: siteOfUrl(url), reason: 'Using the cookies file given by the caller' }
      : { path: null, site: siteOfUrl(url), reason: `The cookies file given by the caller does not exist: ${explicitPath}, treated as not logged in` };
  }
  const site = siteOfUrl(url);
  if (!site) return { path: null, site: null, reason: null };
  const st = savedCookieStatus(dataDir, site);
  if (!st.exists) return { path: null, site, reason: `Not logged in to ${SITES[site].name}, downloading at logged-out quality; to get quality that needs login, run user_interface_collect_login first` };
  if (st.expired) return { path: null, site, reason: `The login state for ${SITES[site].name} has expired, downloading at logged-out quality; run user_interface_collect_login again to resume it` };
  return { path: st.path, site, reason: `Using the login state for ${SITES[site].name} (user ${st.userId ?? '?'})` };
}
