/**
 * 在线执行用户卡与素材效果卡的**隔离策略原文**(契约 `docs/plan/online-card-exec-contract.md` 第 3.3、4.1 节)。
 *
 * 策略文本只写在这一个文件里,四处从这里取,不各抄一份:
 *   - 在线构建给舞台入口 `stage.html` 注入的 `<meta http-equiv="Content-Security-Policy">`(`vite.config.ts`);
 *   - 本机仿 nginx 的代理(`scripts/probes/lib/hosted-proxy.mjs`,探针与本机隔离托管组合用);
 *   - nginx 模板里的策略片段(`server/hosted/deploy/nginx-snippet-*.conf`,由 `cloud/scripts/gen-stage-policy-nginx.mjs` 生成,
 *     单测 `stagePolicy.test.mjs` 核对模板与这里一致);
 *   - 舞台自检(`isolation/isolationCheck.ts`)用来分辨策略出自响应头还是只有 `<meta>` 兜底。
 *
 * 纯函数、没有依赖:浏览器、Node 单测、构建脚本都能直接引。
 */

/** 素材票据换成的 cookie 的名字(HttpOnly,卡片代码读不到) */
export const MEDIA_COOKIE = "pc_rt";
/** cookie 的寿命(秒),与只读素材票据的有效期相同(15 分钟) */
export const MEDIA_COOKIE_MAX_AGE_S = 900;
/** 舞台源上凭 cookie 读素材的路径前缀:`/media-s/<sid>/media/<哈希>`;交接票据的地址是 `/media-s/<sid>/_grant` */
export const MEDIA_S_PREFIX = "/media-s";
/** 舞台素材路径号的形状:按账号加项目固定,对其它项目的舞台保密,把 cookie 与缓存圈在一段路径上 */
export const SID_PATTERN = "[A-Za-z0-9]{16,64}";
/** `/media-s/<sid>/` 之后放行的路径(只读素材字节:原尺寸与小尺寸都按哈希寻址) */
export const MEDIA_S_PATH_PATTERN = "media/[0-9a-f]{64}(?:\\.[A-Za-z0-9]{1,8})?";
/**
 * 素材服务自己的 API 基址(`server/asset-service.ts`:`<origin>/api/asset`,契约固定)。`/media-s/<sid>/media/<哈希>` 转给素材服务时
 * 接在它后面;编辑器页这边的素材基址必须是同一台素材服务经 `/media` 反代出来的 `MEDIA_PROXY_BASE`,否则不走 cookie 这条路。
 */
export const ASSET_API_PREFIX = "/api/asset";
/** 编辑器页的源上素材服务的基址路径(nginx 的 `/media` 反代 + 素材服务的 API 基址) */
export const MEDIA_PROXY_BASE = "/media/api/asset";
/**
 * 素材票据的形状,两种,各自写死:
 * - 旧共享项目的(`server/auth/tickets.mjs`):`v1.<base64url>.<base64url>`,总长不超过 2048;
 * - 账号云端项目的(`cloud/docservice/account-hosted.mjs` 的 `issue`:32 个随机字节的 base64url):恰好 43 个字符。
 * nginx 的舞台站点模板(`server/hosted/deploy/nginx-site-promptcut-stages.conf`)里手写着同一个正则,改这里要一起改(测试会对)。
 */
export const TICKET_PATTERN = "(?:v1\\.[A-Za-z0-9_-]{1,1600}\\.[A-Za-z0-9_-]{1,200}|[A-Za-z0-9_-]{43})";

/**
 * 舞台策略的指令(顺序固定,生成的文本逐字稳定)。`frame-ancestors` 只能出现在响应头里(`<meta>` 里无效),单列。
 *
 * - `'unsafe-eval'`:执行转译结果(`new Function`)必需;舞台本来就按不可信对待,不靠它防注入。
 * - `worker-src blob:` 不含 `'self'`:从同源脚本地址起的 Worker 不继承文档的策略,只许从 blob 地址起(继承创建者的策略)。
 * - 外链图片、字体、样式、脚本和连接照常允许；三版本不设置卡片出口护栏。
 * - frame/object/base/form 约束保护舞台文档和嵌入结构，不把编辑页面或账号放进卡片的源。
 */
const STAGE_DIRECTIVES = Object.freeze([
  "default-src 'none'",
  "script-src 'self' http: https: 'unsafe-eval'",
  "style-src 'self' http: https: 'unsafe-inline'",
  "img-src 'self' http: https: data: blob:",
  "media-src 'self' http: https: data: blob:",
  "font-src 'self' http: https: data:",
  "connect-src 'self' http: https: ws: wss:",
  "worker-src blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]);

/** 响应头与 `<meta>` 共有的那一段 */
const STAGE_CSP_BASE = STAGE_DIRECTIVES.join("; ");

/** 舞台入口 `stage.html` 里 `<meta>` 用的策略:共有的一段(不含 `frame-ancestors`,它在 `<meta>` 里无效) */
export const STAGE_CSP_META = STAGE_CSP_BASE;

/** 只出现在响应头那一份里的指令名:舞台自检据此分辨「策略出自响应头」还是「只有 `<meta>` 兜底」 */
export const STAGE_CSP_HEADER_ONLY_DIRECTIVE = "frame-ancestors";

/** 一个源:`http(s)://host[:port]`,不带路径 */
function checkOrigin(origin, what) {
  let u;
  try { u = new URL(String(origin)); } catch { throw new Error(`${what} 不是合法的源:${String(origin)}`); }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== String(origin)) throw new Error(`${what} 不是合法的源:${String(origin)}`);
  return u.origin;
}

/**
 * 舞台源的响应头策略:舞台文档、舞台源上一切脚本与素材响应都带。`editorOrigin` 是编辑器页的源(只有它能把舞台嵌进 iframe)。
 * nginx 模板里 `editorOrigin` 是 `https://{{DOMAIN}}`(占位符原样传进来,不校验)。
 */
export function stageCspHeader(editorOrigin, { template = false } = {}) {
  const origin = template ? String(editorOrigin) : checkOrigin(editorOrigin, "编辑器页的源");
  return `${STAGE_CSP_BASE}; ${STAGE_CSP_HEADER_ONLY_DIRECTIVE} ${origin}`;
}

/**
 * 第三方登录(Google Identity Services)画按钮和弹窗用的 iframe 源。
 * 2026-10-23 线上实测:不放行它,登录页上「通过 Google 继续操作」会被这条 CSP 挡掉
 * (控制台报 `Framing 'https://accounts.google.com/' violates ... frame-src`),哪怕控制台那边把来源配好了也没用。
 */
export const THIRD_PARTY_SIGNIN_FRAME_ORIGIN = "https://accounts.google.com";

/**
 * 编辑器页的策略:只加舞台隔离必需的一条 —— 舞台 iframe 只能载入本源、两个舞台源,
 * 外加第三方登录那一个源(见上)。它自己跳走也归这条管。
 * `blob:` 与 `data:` 不放行:编辑器页自己没有这样的子框架。
 */
export function editorCspHeader(stageOrigins, { template = false } = {}) {
  const list = (Array.isArray(stageOrigins) ? stageOrigins : []).map((o) => (template ? String(o) : checkOrigin(o, "舞台源")));
  return ["frame-src 'self'", ...list, THIRD_PARTY_SIGNIN_FRAME_ORIGIN].join(" ");
}

/**
 * 舞台源上**每个**响应都带的安全头(小写名 → 值)。`Origin-Agent-Cluster`、`Referrer-Policy`、`X-Content-Type-Options`
 * 是原有的,照旧;文档策略与关 DNS 预解析沿用，外链资源不设出口白名单。
 */
export function stageSecurityHeaders(editorOrigin, opts = {}) {
  return {
    "content-security-policy": stageCspHeader(editorOrigin, opts),
    "x-dns-prefetch-control": "off",
    "origin-agent-cluster": "?1",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

/** 编辑器页响应多带的头 */
export function editorSecurityHeaders(stageOrigins, opts = {}) {
  return { "content-security-policy": editorCspHeader(stageOrigins, opts) };
}

/* ------------------------------------------------------------------ 票据换 cookie(契约第 4.1 节) */

const SID_RE = new RegExp(`^${SID_PATTERN}$`);
const TICKET_RE = new RegExp(`^${TICKET_PATTERN}$`);
const MEDIA_S_RE = new RegExp(`^${MEDIA_S_PREFIX}/(${SID_PATTERN})/(.*)$`);
const MEDIA_S_PATH_RE = new RegExp(`^${MEDIA_S_PATH_PATTERN}$`);

export function isSid(v) { return typeof v === "string" && SID_RE.test(v); }
export function isTicketShaped(v) { return typeof v === "string" && v.length <= 2048 && TICKET_RE.test(v); }

/** 交接票据的地址(编辑器页向每个舞台源各发一次带凭据的 POST) */
export function mediaGrantUrl(stageOrigin, sid) {
  return `${stageOrigin}${MEDIA_S_PREFIX}/${sid}/_grant`;
}
/** 舞台取素材的基址(相对舞台自己的源;后面接 `/media/<哈希>`) */
export function mediaSBase(sid) {
  return `${MEDIA_S_PREFIX}/${sid}`;
}

/** `Set-Cookie` 的值。`secure`:https 站点恒真;本机代理走 http 时为假(本机的 http 源设不了带 Secure 的 cookie 时用) */
export function mediaGrantCookie(sid, ticket, { secure = true } = {}) {
  return `${MEDIA_COOKIE}=${ticket}; Path=${MEDIA_S_PREFIX}/${sid}/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Strict; Max-Age=${MEDIA_COOKIE_MAX_AGE_S}`;
}

/** 交接请求的跨源应答头(只对编辑器页的源开;带凭据,所以不能是 `*`) */
export function mediaGrantCorsHeaders(editorOrigin) {
  return {
    "access-control-allow-origin": editorOrigin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization",
    "access-control-allow-methods": "POST",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/**
 * `/media-s/…` 上一个请求该怎么办(nginx 模板与本机代理同一套判定;纯函数,单测逐条核):
 *
 *   { kind: "none" }                       不是这条路由
 *   { kind: "reject", status }             拒绝(404 路径不对、405 方法不对、403 来源不对、400 票据形状不对、401 没有 cookie)
 *   { kind: "preflight", headers }         交接的预检:204
 *   { kind: "grant", headers }             交接:204,带 `Set-Cookie`
 *   { kind: "proxy", path, authorization } 读素材:转给素材服务的 `path`(`/api/asset/media/<哈希>`),`Authorization` 换成 cookie 里的票据(不转发 cookie)
 */
export function mediaSRoute({ method, pathname, origin, authorization, cookie }, { editorOrigin, secure = true }) {
  const m = MEDIA_S_RE.exec(String(pathname || ""));
  if (!m) return String(pathname || "").startsWith(`${MEDIA_S_PREFIX}/`) ? { kind: "reject", status: 404 } : { kind: "none" };
  const sid = m[1], rest = m[2];
  const verb = String(method || "GET").toUpperCase();
  if (rest === "_grant") {
    if (verb === "OPTIONS") return origin === editorOrigin ? { kind: "preflight", headers: mediaGrantCorsHeaders(editorOrigin) } : { kind: "reject", status: 403 };
    if (verb !== "POST") return { kind: "reject", status: 405 };
    if (origin !== editorOrigin) return { kind: "reject", status: 403 };
    const t = /^Bearer[ \t]+(\S+)$/i.exec(String(authorization || "").trim())?.[1];
    if (!isTicketShaped(t)) return { kind: "reject", status: 400 };
    return { kind: "grant", headers: { ...mediaGrantCorsHeaders(editorOrigin), "set-cookie": mediaGrantCookie(sid, t, { secure }), "cache-control": "no-store" } };
  }
  if (!MEDIA_S_PATH_RE.test(rest)) return { kind: "reject", status: 404 };
  if (verb !== "GET" && verb !== "HEAD") return { kind: "reject", status: 405 };
  const ticket = cookieValue(cookie, MEDIA_COOKIE);
  if (!isTicketShaped(ticket)) return { kind: "reject", status: 401 };
  return { kind: "proxy", path: `${ASSET_API_PREFIX}/${rest}`, authorization: `Bearer ${ticket}` };
}

/** 从 `Cookie` 头里取一个值;没有给 null */
export function cookieValue(header, name) {
  for (const part of String(header || "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
