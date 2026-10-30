/**
 * 素材收集的登录态:站点定义、cookie 判定、Netscape cookies.txt 读写。
 *
 * 纯逻辑,不碰浏览器也不碰网络,所以能单测。浏览器那半边(打开登录页、
 * 从 CDP 取 cookie、挪窗口)在 vite-plugin-collect.ts 里调 server/web/ 的模块。
 *
 * 为什么存成 cookies.txt 而不是直接用浏览器 profile:
 * 下载是 yt-dlp(Python 进程)干的,它读不了 Chrome 的 cookie 库(Windows 上
 * 有应用绑定加密,实测 Edge / Chrome 都是 Could not copy cookie database),
 * 但认 Netscape 格式的文本文件 —— 所以登录一次、导出一次,之后每次下载自动带上。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 站点定义。加站点就加一项:
 *   loginUrl   让用户登录的页面
 *   domains    哪些 cookie 域归这个站(正则)
 *   required   这几个 cookie 都在才算登录
 *   userCookie 哪个 cookie 的值能当用户标识回显
 *   match      一条链接 / 视频号归不归它管
 */
export const SITES = {
  bilibili: {
    name: '哔哩哔哩',
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

/** 一条链接属于哪个有登录支持的站点;都不是就 null */
export function siteOfUrl(url) {
  for (const [id, site] of Object.entries(SITES)) {
    if (site.match(url)) return id;
  }
  return null;
}

/** cookies.txt 落在哪。dataDir 是 PROMPTCUT_DATA_DIR(默认 out/),这里面不进 git */
export function cookieFilePath(dataDir, siteId) {
  return path.join(dataDir, 'cookies', `${siteId}.txt`);
}

/**
 * CDP Network.getAllCookies 的条目 → Netscape 一行。
 * 7 列 tab 分隔:domain / includeSubdomains / path / secure / expires / name / value。
 * 会话 cookie(expires 为 -1)写 0,yt-dlp 会当成会话 cookie 照发。
 */
export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# 由 PromptCut 素材收集在登录后导出;删掉这个文件就等于退出登录。', ''];
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

/** Netscape 文本 → cookie 条目(只解析,不校验) */
export function parseNetscape(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    // yt-dlp 自己导出的文件会给 httpOnly 的行加 #HttpOnly_ 前缀,别当注释丢掉
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
 * 这一堆 cookie 对某个站点算不算登录了。
 * 返回 { loggedIn, missing, userId, expiresAt(ms 或 null), expired, cookies(只留该站的) }。
 */
export function assessLogin(siteId, cookies, now = Date.now()) {
  const site = SITES[siteId];
  if (!site) throw new Error(`没有叫 ${siteId} 的站点,可选:${siteNames().join(', ')}`);
  const mine = (cookies || []).filter((c) => site.domains.test(String(c.domain || '').replace(/^\./, '')));
  const byName = new Map(mine.map((c) => [c.name, c]));
  const missing = site.required.filter((n) => !byName.get(n)?.value);
  // 过期时间取关键 cookie 里最早的那个;会话 cookie(-1 / 0)不参与
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

/** 存盘那份登录态现在什么情况。文件不存在也返回一个能读的对象,不抛 */
export function savedCookieStatus(dataDir, siteId, now = Date.now()) {
  const file = cookieFilePath(dataDir, siteId);
  if (!fs.existsSync(file)) {
    return { site: siteId, path: file, exists: false, loggedIn: false, expired: false, userId: null, expiresAt: null, missing: SITES[siteId]?.required ?? [] };
  }
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 读不了按没有算 */ }
  const a = assessLogin(siteId, parseNetscape(text), now);
  return { site: siteId, path: file, exists: true, loggedIn: a.loggedIn, expired: a.expired, userId: a.userId, expiresAt: a.expiresAt, missing: a.missing };
}

/** 把登录态写盘。返回文件路径 */
export function saveCookies(dataDir, siteId, cookies) {
  const file = cookieFilePath(dataDir, siteId);
  // 0700 / 0600:这个文件里是 SESSDATA,拿到就等于拿到账号,不该是同机器上人人可读的
  // (Windows 上 mode 基本不起作用,真正挡住网页那一路的是 vite.config.ts 里的 fs.deny)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, toNetscape(cookies), { encoding: 'utf8', mode: 0o600 });
  return file;
}

/** 删掉存盘的登录态(等于退出登录)。返回是否真删了东西 */
export function forgetCookies(dataDir, siteId) {
  const file = cookieFilePath(dataDir, siteId);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/**
 * 下载 / 探测前决定带不带 cookie。
 * 显式传了路径就用它;没传就看这条链接归哪个站、那个站有没有没过期的存盘登录态。
 * 返回 { path, site, reason } —— path 为 null 时 reason 说明为什么没带(给作业 notes 用)。
 */
export function pickCookies(dataDir, url, explicitPath) {
  if (explicitPath) {
    return fs.existsSync(explicitPath)
      ? { path: explicitPath, site: siteOfUrl(url), reason: '用调用方给的 cookies 文件' }
      : { path: null, site: siteOfUrl(url), reason: `调用方给的 cookies 文件不存在:${explicitPath},按未登录处理` };
  }
  const site = siteOfUrl(url);
  if (!site) return { path: null, site: null, reason: null };
  const st = savedCookieStatus(dataDir, site);
  if (!st.exists) return { path: null, site, reason: `${SITES[site].name}未登录,按未登录画质下载;要登录才有的画质先 user_interface_collect_login` };
  if (st.expired) return { path: null, site, reason: `${SITES[site].name}的登录态已过期,按未登录画质下载;重新 user_interface_collect_login 可续上` };
  return { path: st.path, site, reason: `带上${SITES[site].name}的登录态(用户 ${st.userId ?? '?'})` };
}
