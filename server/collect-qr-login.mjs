/**
 * 哔哩哔哩扫码登录(接口版,不开浏览器)。
 *
 * B 站网页端的扫码登录是两个公开接口:
 *   GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate
 *       → { code: 0, data: { url, qrcode_key } }   url 就是二维码里的内容
 *   GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=…
 *       → { code: 0, data: { code: 0 | 86101 | 86090 | 86038, message, url, refresh_token } }
 *       86101 未扫码 / 86090 已扫码未确认 / 86038 二维码过期(约 3 分钟) / 0 登录成功。
 *       成功那次响应的 Set-Cookie 里带 SESSDATA、bili_jct、DedeUserID 等,直接存成 cookies.txt。
 *
 * 实测(2026-09-08):带 Chrome UA + Referer 才不会 412;不带 UA 也能过,但和下载那边
 * 保持一致省得哪天被拦。二维码由 qr.mjs 现画,前端只拿 SVG 显示。
 *
 * 会话只在内存里:key → { site, url, createdAt, state }。二维码 3 分钟过期,过期了前端
 * 重新 start 一张就是。
 */
import { assessLogin, saveCookies } from './collect-cookies.mjs';
import { qrSvg } from './qr.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const ENDPOINTS = {
  bilibili: {
    generate: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate',
    poll: 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=',
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
    /** 二维码有效期(秒),B 站是 180 */
    ttl: 180,
    /** poll 返回的 data.code → 我们的状态 */
    states: { 0: 'ok', 86101: 'waiting', 86090: 'scanned', 86038: 'expired' },
  },
};

/** 一行 Set-Cookie → CDP 那种形状的 cookie 对象(和 collect-cookies.mjs 的 toNetscape 对得上) */
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
 * 成功响应的 data.url 形如
 *   https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=…&SESSDATA=…&bili_jct=…&Expires=1234
 * 有些环境 Set-Cookie 头拿不全(fetch 的 redirect / 代理),从这里补。
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
 * 把 Set-Cookie 头和 crossDomain 链接里的 cookie 合并:同名以 Set-Cookie 为准。
 */
export function mergeCookies(fromHeaders, fromUrl) {
  const byName = new Map();
  for (const c of fromUrl) if (c) byName.set(c.name, c);
  for (const c of fromHeaders) if (c) byName.set(c.name, c);
  return [...byName.values()];
}

/** 读 Set-Cookie 头:Node 19.7+ 有 getSetCookie;老的退回单头 */
function setCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const one = headers.get('set-cookie');
  return one ? [one] : [];
}

export function createQrLogin({ fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const sessions = new Map();

  /** 老会话别越攒越多:过期超过 10 分钟的顺手清掉 */
  function sweep() {
    const cutoff = now() - 10 * 60 * 1000;
    for (const [k, s] of sessions) if (s.createdAt < cutoff) sessions.delete(k);
  }

  async function start(site = 'bilibili') {
    const ep = ENDPOINTS[site];
    if (!ep) throw new Error(`站点 ${site} 没有扫码登录`);
    sweep();
    const r = await fetchImpl(ep.generate, { headers: ep.headers });
    if (!r.ok) throw new Error(`拿二维码失败:HTTP ${r.status}`);
    const body = await r.json();
    if (body?.code !== 0 || !body?.data?.url || !body?.data?.qrcode_key) {
      throw new Error(`拿二维码失败:${body?.message ?? '返回格式不对'}`);
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
   * 轮询一次。返回 { state: waiting | scanned | expired | ok, message, ...登录成功时的字段 }。
   * 成功时把 cookie 交给 onLogin(cookies) 存盘,这里不直接写文件,方便测试。
   */
  async function poll(key, { dataDir } = {}) {
    const s = sessions.get(key);
    if (!s) return { state: 'expired', message: '这张二维码不存在或服务已重启,重新生成一张' };
    if (s.state === 'ok') return { state: 'ok', ...s.result };
    const ep = ENDPOINTS[s.site];
    if (now() - s.createdAt > ep.ttl * 1000) {
      s.state = 'expired';
      return { state: 'expired', message: '二维码已过期,重新生成一张' };
    }
    const r = await fetchImpl(ep.poll + encodeURIComponent(key), { headers: ep.headers, redirect: 'manual' });
    if (!r.ok) return { state: s.state, message: `查询失败:HTTP ${r.status}`, transient: true };
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
      return { state: 'expired', message: `登录响应里缺 ${a.missing.join(' / ')},重新扫一次` };
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

/** 进程级单例:路由用它;测试自己 createQrLogin 注入假 fetch */
let shared = null;
export function qrLogin() {
  if (!shared) shared = createQrLogin();
  return shared;
}
