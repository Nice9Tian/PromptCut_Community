/**
 * 「本机」按真正的发起方判断（语义 `docs/semantics/product/document-service.md`「本机按真正的发起方判断」；
 * 契约 `docs/plan/http-transport-contract.md` 第 10 节〔裁：2026-09-27 主会话，HT-a〕）。
 *
 * 套接字对端是回环，而且请求（HTTP 与 WebSocket 升级）里转发头记下的每一跳（`Forwarded` 的 `for=`、
 * `X-Forwarded-For` 的每一跳、`X-Real-IP`）都是回环，才算本机；任何一跳不是回环就不算。只收紧、不放宽：
 * 对端不是回环的，转发头怎么写都不算本机；本机信任开关为 0 时由调用方照旧一律不算本机。
 *
 * 放在 `server/auth/`：文档服务单独部署（`cloud/scripts/remote/docservice.mjs deploy`）只带 docservice、auth、render-queue
 * 三个目录。只引 Node 内置模块（这里一个都不引），浏览器侧不用它。
 */

/** 回环地址:127.0.0.0/8、::1、IPv4 映射的 ::ffff:127.x */
export function isLoopbackAddress(address) {
  const a = String(address || "").toLowerCase();
  return a === "::1" || /^127./.test(a) || /^::ffff:127./.test(a);
}

/** 转发头里的一跳 → 地址:去引号、去 IPv6 的方括号与端口、去 IPv4 的端口;空的回 null */
export function hopAddress(raw) {
  let v = String(raw ?? "").trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).trim();
  if (v === "") return null;
  const bracket = /^\[([^\]]*)\](?::\d+)?$/.exec(v);
  if (bracket) return bracket[1];
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(v);
  if (v4port) return v4port[1];
  return v;
}

const headerText = (value) => (Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "");

/**
 * 请求里转发头记下的每一跳(`Forwarded` 的 `for=`、`X-Forwarded-For` 的每一跳、`X-Real-IP`),没有转发头回 []。
 * 不认识的写法(`for=unknown`、混淆名 `_abc`、主机名)原样留着,判本机时它们都不是回环。
 */
export function forwardedHops(req) {
  const headers = req?.headers ?? {};
  const hops = [];
  for (const element of headerText(headers.forwarded).split(",")) {
    for (const pair of element.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0 || pair.slice(0, eq).trim().toLowerCase() !== "for") continue;
      const a = hopAddress(pair.slice(eq + 1));
      if (a !== null) hops.push(a);
    }
  }
  for (const part of headerText(headers["x-forwarded-for"]).split(",")) {
    const a = hopAddress(part);
    if (a !== null) hops.push(a);
  }
  const real = hopAddress(headerText(headers["x-real-ip"]));
  if (real !== null) hops.push(real);
  return hops;
}

/**
 * 真正的发起方是不是本机(语义 `product/document-service.md`「本机按真正的发起方判断」;契约
 * `docs/plan/http-transport-contract.md` 第 10 节):对端地址是回环,**而且**转发头里每一跳都是回环。
 * 经同机反向代理转进来的请求,对端虽是回环,转发头里记着外面的地址,不算本机;链上全是回环(本机组件转本机)仍算本机。
 * 只收紧、不放宽:对端不是回环的,转发头怎么写都不算本机。`address` 缺省是套接字对端,调用方可以换成已认过的真实对端
 * (舞台端口代理写进的 `STAGE_CLIENT_HEADER`,见 `clientAddressOf`)。
 */
export function isLocalOrigin(req, address = req?.socket?.remoteAddress) {
  if (!isLoopbackAddress(address)) return false;
  return forwardedHops(req).every(isLoopbackAddress);
}

/**
 * 日志与限速用的来源:对端是回环而转发头说它不是本机转来的,记成 `proxied:<对端>`(不再像回环地址,
 * 只凭来源地址判本机的地方 —— 如创建者操作的限速豁免 —— 也就不会把它当本机);其余照原样。
 */
export function remoteTagOf(req, address = req?.socket?.remoteAddress ?? null) {
  if (address === null || address === undefined) return null;
  return isLoopbackAddress(address) && !isLocalOrigin(req, address) ? `proxied:${address}` : address;
}
