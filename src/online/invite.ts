/**
 * 邀请链接与在线地址（C10a 契约 `docs/plan/c10a-contract.md` 第 2、4、5 节）。
 *
 * - 邀请链接：`<源>/editor#invite=<邀请码>&doc=<文档服务的路径>`；邀请码是 43 个 base64url 字符。邀请码只放在
 *   `#` 片段里，不进查询串（`?join=` 已被本机第二页占用，第 15 节）。
 * - **路径写在链接里，页面不猜**（2026-10-26 用户定）：托管端的文档服务在 `/hosted/`，局域网主机的在 `/docservice`
 *   ——两种不一样，光有源推不出来。所以签发时把路径一并写进链接（`inviteLinkOf`），页面照着用（`docBaseOf`）。
 *   **不带 `doc=` 的旧链接一律当失效**，让创建者重新生成一张（用户同日定：不用兼容旧的）。
 * - 页面启动时读 `location.hash` 里的 `invite=`：核对字符集与长度后放进内存，随即 `history.replaceState` 把 `#` 片段清掉，
 *   之后才向服务器提交。不写 localStorage、不进日志。
 * - 粘贴邀请链接：从完整链接里取服务器的源与邀请码（扫码后 `#` 片段没保留时的退路）。
 * - 托管端的文档服务在同一个源的 `/hosted/` 下（nginx 转发，契约第 2 节），素材服务在 `/media/` 下（由文档服务的
 *   `service.endpoints` 下发，页面不自己拼）。
 *
 * 不引 `mode.ts`，Node 单测直接用。
 */

export const INVITE_LENGTH = 43;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** 托管端文档服务在源下的路径（nginx 的 `location /hosted/`） */
export const HOSTED_DOC_PATH = "/hosted/";
/** 在线构建的路径 */
export const EDITOR_PATH = "/editor";

export const isInviteCode = (v: unknown): v is string => typeof v === "string" && CODE_RE.test(v);

export interface InviteFromLink {
  code: string;
  /** 文档服务在这个源下的路径（`/hosted/` 或 `/docservice`）；旧链接没带，为 null */
  doc: string | null;
}

/**
 * 从 `#` 片段里取 `invite=` 与 `doc=`：片段可以是 `#invite=<码>`，也可以和别的参数用 `&` 并列。
 * 回 `{ code, doc }`（合格）、`{ bad: true }`（有 `invite=` 但不合格）或 null（没有）。
 * `doc=` 是转义过的路径；没带或转义坏了都记 null，由调用方决定怎么说（现在一律当旧链接）。
 */
export function inviteFromHash(hash: string): InviteFromLink | { bad: true } | null {
  const text = String(hash || "").replace(/^#/, "");
  if (!text) return null;
  let value: string | null = null;
  let doc: string | null = null;
  for (const part of text.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i);
    if (key === "invite" && value === null) value = part.slice(i + 1);
    else if (key === "doc" && doc === null) {
      try {
        const raw = decodeURIComponent(part.slice(i + 1));
        doc = raw.startsWith("/") ? raw : null;
      } catch {
        doc = null;
      }
    }
  }
  if (value === null) return null;
  return isInviteCode(value) ? { code: value, doc } : { bad: true };
}

/**
 * 粘贴的邀请链接 → `{ origin, code, doc }`；不是 `http(s)://…#invite=<43 位>` 的回 null（「这不是有效的邀请链接。」）。
 * `doc` 为 null 表示旧链接（没带路径），由调用方当失效处理。
 * 容忍首尾空白、微信等把链接包在文字里（取第一个 http(s):// 起到空白为止）。
 */
export function parseInviteLink(text: string): { origin: string; code: string; doc: string | null } | null {
  const m = /https?:\/\/\S+/i.exec(String(text || "").trim());
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(m[0]);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const found = inviteFromHash(u.hash);
  if (!found || !("code" in found)) return null;
  return { origin: u.origin, code: found.code, doc: found.doc };
}

/**
 * 编辑器页在这个源下的路径：托管端是 `/editor`（nginx 把在线产物放在那儿），
 * 局域网主机（本机 dev server、桌面应用）就是根 `/` —— 那里没有 `/editor` 这个路径。
 * 按文档服务的路径分：`/hosted/` 的是托管端，别的都是本机。
 */
export function editorPathFor(docPath: string): string {
  return docPath === HOSTED_DOC_PATH ? EDITOR_PATH : "/";
}

/**
 * 邀请链接：`<源><编辑器页路径>#invite=<码>&doc=<文档服务的路径>`。
 * 两个路径都要给对：托管端是 `/editor` + `/hosted/`，局域网主机是 `/` + `/docservice`，页面不猜（见文件头）。
 */
export function inviteLinkOf(origin: string, code: string, docPath: string, pagePath = editorPathFor(docPath)): string {
  return `${origin.replace(/\/+$/, "")}${pagePath}#invite=${code}&doc=${encodeURIComponent(docPath)}`;
}

/** 源 + 链接里带的路径 → 文档服务的 http 基址（与 route.mjs 候选的 `base` 同形，末尾斜杠按路径原样留） */
export function docBaseOf(origin: string, docPath: string): string {
  const path = docPath.startsWith("/") ? docPath : `/${docPath}`;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/** 源 → 托管端文档服务的 http 基址（`https://h/hosted/`，以 `/` 结尾，与 route.mjs 候选的 `base` 同形） */
export function hostedDocBaseOf(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${HOSTED_DOC_PATH}`;
}

/**
 * 文档服务的 http 基址 → WebSocket 地址，**保留末尾斜杠**：`https://h/hosted/` → `wss://h/hosted/`。
 * nginx 的 `location /hosted/` 对不带斜杠的 `/hosted` 回 301，WebSocket 升级跟不了重定向，所以凭源走 `/hosted/`
 * 的连接要带斜杠（route.mjs 的 `wsBaseOf` 会去掉它，局域网主机的 `/docservice` 要的是不带斜杠的）。
 */
export function hostedWsUrlOf(base: string): string {
  const u = new URL(base);
  const protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  return `${protocol}//${u.host}${u.pathname}`;
}

/* ---------------- 启动时读、读完即清 ---------------- */

let captured: InviteFromLink | { bad: true } | null = null;

/**
 * 页面启动时调一次：读 `location.hash` 的 `invite=`，放进内存，然后把 `#` 片段清掉（只清掉带 `invite=` 的片段）。
 * `loc` / `hist` 可注入（测试）。
 */
export function captureInviteFromLocation(
  loc: Pick<Location, "hash" | "pathname" | "search"> = location,
  hist: Pick<History, "replaceState" | "state"> = history,
): void {
  const found = inviteFromHash(loc.hash);
  if (!found) return;
  captured = found;
  try {
    hist.replaceState(hist.state, "", `${loc.pathname}${loc.search}`);
  } catch {
    /* 清不掉就算了：邀请码只在片段里，片段不发给服务器 */
  }
}

/** 取走启动时读到的邀请码（只给一次） */
export function takeCapturedInvite(): InviteFromLink | { bad: true } | null {
  const c = captured;
  captured = null;
  return c;
}

/** 看一眼（不取走） */
export function peekCapturedInvite(): InviteFromLink | { bad: true } | null {
  return captured;
}
