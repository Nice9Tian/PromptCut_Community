import { useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { prerenderUrl, usePrerenderBase, withBase } from "../../render/prerender";
import { cloudTicket } from "../../ai/extensions";

/**
 * 聊天栏里一步工具的「看得见的结果」:当时返回的位图、改了哪几个参数、前后两段动图。
 *
 * 记录由执行工具的那一方交给服务端存着(src/ai/mcpExecutor.ts 的 withVisual,或者服务端直接执行的
 * 看图工具),工具结果最前面带一个 visualId。四家的工具结果摘要都保留开头那一截,所以这里从摘要里
 * 认 id 就够了,不用关心这一步是 API 直连还是 agy / Claude / Codex 跑的。
 *
 * 本机模式下记录和动图存在预渲染进程上(/api/ai/visual);
 * 云端对话模式下记录和动图存在 Agent 服务的受权对话端点(/agent/v1/conversations/:id/visuals/:vid),
 * 每次读取核对当前对话 ACL 与 aclRevision,切私有或被撤权时立即失效并清空缓存与 DOM。
 */
export function visualIdOf(summary?: string): string | null {
  const m = /"visualId"\s*:\s*"(v-[0-9a-z]{6,40})"/.exec(summary || "");
  return m ? m[1] : null;
}

export interface VisualRecord {
  tool: string;
  images?: { url: string; label?: string }[];
  before?: { gif: string };
  after?: { gif: string };
  diff?: { key: string; from: string; to: string }[];
  aclRevision?: number;
  cacheKey?: string;
}

export interface CloudVisualScope {
  /** Agent 服务的 `/v1` 根地址（如 `/agent/v1` 或 `https://.../agent/v1`，不带末尾斜杠） */
  baseUrl: string;
  projectId: string;
  conversationId: string;
  accountId?: string | null;
  aclRevision?: number;
  visibility?: "shared" | "private";
  revoked?: boolean;
  ticket?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
const inflight = new Map<string, Promise<VisualRecord>>();
const loaded = new Map<string, VisualRecord>();
const blobUrls = new Set<string>();
const scopeListeners = new Set<() => void>();

let currentCloudScope: CloudVisualScope | null = null;
let scopeEpoch = 0;

function scopeKeyOf(scope: CloudVisualScope | null): string {
  if (!scope) return "local";
  if (scope.revoked) return `cloud-revoked:${scope.projectId}:${scope.conversationId}:${scope.accountId ?? ""}`;
  return `cloud:${scope.projectId}:${scope.conversationId}:${scope.accountId ?? ""}:${scope.aclRevision ?? 0}:${scope.visibility ?? "shared"}`;
}

function cacheKeyOf(id: string, scope: CloudVisualScope | null = currentCloudScope): string {
  return `${scopeKeyOf(scope)}:${id}`;
}

function revokeAllBlobUrls() {
  for (const url of blobUrls) {
    try {
      if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
      }
    } catch { /* ignore */ }
  }
  blobUrls.clear();
}

function notifyScopeListeners() {
  for (const fn of [...scopeListeners]) {
    try { fn(); } catch { /* ignore */ }
  }
}

/**
 * 清空可视记录与受权文件缓存（切换项目、切换对话、共有切私有、撤权时调用）。
 */
export function clearVisualCache(): void {
  scopeEpoch += 1;
  inflight.clear();
  loaded.clear();
  revokeAllBlobUrls();
  notifyScopeListeners();
}

/**
 * 设置或更新云端对话的可视记录作用域。
 * 当作用域（项目、对话、账号、aclRevision、可见性）变化或被撤权（`revoked: true`）时，立即作废旧缓存并通知界面卸载残留画面。
 */
export function setCloudVisualScope(scope: CloudVisualScope | null): void {
  const prevKey = scopeKeyOf(currentCloudScope);
  const nextKey = scopeKeyOf(scope);
  currentCloudScope = scope ? { ...scope } : null;
  if (prevKey !== nextKey || scope?.revoked) {
    scopeEpoch += 1;
    inflight.clear();
    loaded.clear();
    revokeAllBlobUrls();
    notifyScopeListeners();
  }
}

export function getCloudVisualScope(): CloudVisualScope | null {
  return currentCloudScope;
}

export function subscribeVisualScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  return () => { scopeListeners.delete(listener); };
}

function getScopeSnapshot(): string {
  return `${scopeEpoch}:${scopeKeyOf(currentCloudScope)}`;
}

const AGENT_V1_PREFIX = "/agent/v1";

function resolveCloudEndpointUrl(baseUrl: string, rawPath: string, aclRevision?: number): string {
  const base = baseUrl.replace(/\/+$/, "");
  let resolved: string;
  if (/^https?:\/\//i.test(rawPath)) {
    resolved = rawPath;
  } else if (rawPath.startsWith(AGENT_V1_PREFIX) && rawPath[AGENT_V1_PREFIX.length] === "/") {
    resolved = `${base}${rawPath.slice(AGENT_V1_PREFIX.length)}`;
  } else if (rawPath.startsWith("/v1/")) {
    resolved = `${base}${rawPath.slice("/v1".length)}`;
  } else if (rawPath.startsWith("/")) {
    resolved = `${base}${rawPath}`;
  } else {
    resolved = `${base}/${rawPath}`;
  }
  if (typeof aclRevision === "number" && Number.isInteger(aclRevision) && !/[?&]aclRevision=/.test(resolved)) {
    resolved += `${resolved.includes("?") ? "&" : "?"}aclRevision=${aclRevision}`;
  }
  return resolved;
}

async function fetchCloudAssetAsUrl(
  rawUrl: string,
  scope: CloudVisualScope,
  myEpoch: number,
  ticketStr: string,
): Promise<string> {
  const f = scope.fetchImpl ?? globalThis.fetch;
  const target = resolveCloudEndpointUrl(scope.baseUrl, rawUrl, scope.aclRevision);
  const res = await f(target, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${ticketStr}`,
      ...(typeof scope.aclRevision === "number" ? { "X-PC-ACL-Revision": String(scope.aclRevision) } : {}),
    },
    credentials: "omit",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || "image/gif";
  const buf = await res.arrayBuffer();
  if (myEpoch !== scopeEpoch || currentCloudScope?.revoked) {
    throw new Error("对话权限已变更");
  }
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
    const u = URL.createObjectURL(new Blob([buf], { type: mime }));
    blobUrls.add(u);
    return u;
  }
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function" ? btoa(binary) : "";
  return `data:${mime};base64,${b64}`;
}

async function loadCloudVisualRecord(id: string, scope: CloudVisualScope, myEpoch: number): Promise<VisualRecord> {
  if (scope.revoked) throw new Error("当前账号已无法读取这个对话的画面记录");
  const getTicket = scope.ticket ?? cloudTicket;
  const ticketStr = await getTicket();
  if (myEpoch !== scopeEpoch || currentCloudScope?.revoked) {
    throw new Error("对话权限已变更");
  }
  const f = scope.fetchImpl ?? globalThis.fetch;
  const recordUrl = resolveCloudEndpointUrl(
    scope.baseUrl,
    `/v1/conversations/${encodeURIComponent(scope.conversationId)}/visuals/${encodeURIComponent(id)}`,
    scope.aclRevision,
  );
  const res = await f(recordUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${ticketStr}`,
      ...(typeof scope.aclRevision === "number" ? { "X-PC-ACL-Revision": String(scope.aclRevision) } : {}),
    },
    credentials: "omit",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (myEpoch !== scopeEpoch || currentCloudScope?.revoked) {
    throw new Error("对话权限已变更");
  }
  // 如果服务端返回的 aclRevision 与当前 scope 期望的不一致，同步更新缓存键
  const rawRec = (data?.record ?? data) as VisualRecord;
  const hydrated: VisualRecord = { ...rawRec };

  if (Array.isArray(rawRec.images) && rawRec.images.length > 0) {
    const imgs = await Promise.all(
      rawRec.images.map(async (im) => ({
        ...im,
        url: await fetchCloudAssetAsUrl(im.url, scope, myEpoch, ticketStr),
      })),
    );
    hydrated.images = imgs;
  }
  if (rawRec.before?.gif) {
    hydrated.before = {
      ...rawRec.before,
      gif: await fetchCloudAssetAsUrl(rawRec.before.gif, scope, myEpoch, ticketStr),
    };
  }
  if (rawRec.after?.gif) {
    hydrated.after = {
      ...rawRec.after,
      gif: await fetchCloudAssetAsUrl(rawRec.after.gif, scope, myEpoch, ticketStr),
    };
  }
  return hydrated;
}

export function loadVisualRecord(id: string): Promise<VisualRecord> {
  const scope = currentCloudScope;
  if (scope) {
    if (scope.revoked) return Promise.reject(new Error("当前账号已无法读取这个对话的画面记录"));
    const key = cacheKeyOf(id, scope);
    const hit = inflight.get(key);
    if (hit) return hit;
    const myEpoch = scopeEpoch;
    const p = loadCloudVisualRecord(id, scope, myEpoch).then((rec) => {
      if (myEpoch === scopeEpoch && !currentCloudScope?.revoked) {
        loaded.set(key, rec);
      }
      return rec;
    });
    inflight.set(key, p);
    p.catch(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    return p;
  }

  if (ONLINE_BUILD) return Promise.reject(new Error("在线浏览器模式没有这一步的画面记录"));
  const key = cacheKeyOf(id, null);
  const hit = inflight.get(key);
  if (hit) return hit;
  const myEpoch = scopeEpoch;
  const p = prerenderUrl(`/api/ai/visual/${id}.json`)
    .then((u) => fetch(u))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((d) => {
      const rec = (d?.record ?? d) as VisualRecord;
      if (myEpoch === scopeEpoch) loaded.set(key, rec);
      return rec;
    });
  inflight.set(key, p);
  p.catch(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  return p;
}

/** 已经取回来的记录,同步读;还没取回来或者取失败、或当前作用域被撤权时是 undefined */
export function peekVisualRecord(id: string): VisualRecord | undefined {
  if (currentCloudScope?.revoked) return undefined;
  return loaded.get(cacheKeyOf(id, currentCloudScope));
}

/** 取一份记录给界面用:缓存里有就直接给(不闪「正在取回」),没有就去取,取失败或撤权把原因带出来并清空旧记录 */
export function useVisualRecord(id: string | null): { rec: VisualRecord | null; err: string } {
  const snap = useSyncExternalStore(subscribeVisualScope, getScopeSnapshot, getScopeSnapshot);
  const [state, setState] = useState<{ key: string; rec: VisualRecord | null; err: string }>(() => {
    const k = id ? `${snap}:${id}` : "";
    return { key: k, rec: (id && peekVisualRecord(id)) || null, err: "" };
  });

  useEffect(() => {
    if (!id) return;
    const k = `${snap}:${id}`;
    if (currentCloudScope?.revoked) {
      setState({ key: k, rec: null, err: "当前账号已无法读取这个对话的画面记录" });
      return;
    }
    const cached = peekVisualRecord(id);
    if (cached) {
      setState((s) => (s.key === k && s.rec === cached && !s.err ? s : { key: k, rec: cached, err: "" }));
      return;
    }
    setState((s) => (s.key === k && s.rec === null && !s.err ? s : { key: k, rec: null, err: "" }));
    let alive = true;
    loadVisualRecord(id).then(
      (rec) => {
        if (alive && !currentCloudScope?.revoked) {
          setState((s) => (s.key === k && s.rec === rec && !s.err ? s : { key: k, rec, err: "" }));
        }
      },
      (e) => {
        if (alive) setState({ key: k, rec: null, err: String(e?.message || e) });
      },
    );
    return () => { alive = false; };
  }, [id, snap]);

  if (!id) return { rec: null, err: "" };
  if (currentCloudScope?.revoked) return { rec: null, err: "当前账号已无法读取这个对话的画面记录" };
  const expectedKey = `${snap}:${id}`;
  if (state.key !== expectedKey) return { rec: peekVisualRecord(id) || null, err: "" };
  return { rec: state.rec, err: state.err };
}

function isDirectAssetUrl(u: string): boolean {
  return u.startsWith("blob:") || u.startsWith("data:") || /^https?:\/\//i.test(u);
}

export function ToolVisual({ id }: { id: string }): JSX.Element {
  const { rec, err } = useVisualRecord(id);
  const base = usePrerenderBase();
  const cloudMode = currentCloudScope !== null;

  if (err) return <div className="ai-visual-note">这一步的画面取不回来了({err})</div>;
  if (!rec) return <div className="ai-visual-note">正在取回画面…</div>;
  if (!cloudMode && base === null) return <div className="ai-visual-note">预渲染进程还没就绪,画面取不回来</div>;

  const resolveSrc = (u: string) => (cloudMode || isDirectAssetUrl(u) ? u : withBase(base ?? "", u));
  const hasGif = !!(rec.before || rec.after);
  const afterLabel = rec.before ? "修改后" : rec.tool === "get_gif" ? "整段动效" : "新加的卡片";
  const beforeLabel = rec.after ? "修改前" : "删掉的卡片";

  return (
    <div className="ai-visual">
      {rec.images?.length ? (
        <div className="ai-visual-images">
          {rec.images.map((im, i) => (
            <figure key={i}>
              <img src={resolveSrc(im.url)} alt={im.label || `画面 ${i + 1}`} loading="lazy" />
              {im.label ? <figcaption>{im.label}</figcaption> : null}
            </figure>
          ))}
        </div>
      ) : null}

      {rec.diff?.length ? (
        <ul className="ai-visual-diff">
          {rec.diff.map((d) => (
            <li key={d.key}>
              <span className="k">{d.key}</span>
              <span className="from">{d.from}</span>
              <span className="arrow" aria-hidden>→</span>
              <span className="to">{d.to}</span>
            </li>
          ))}
        </ul>
      ) : rec.before && rec.after ? (
        <div className="ai-visual-note">参数没有变化(可能只改了别的轨道,或者这一步被夹回了原值)</div>
      ) : null}

      {hasGif ? (
        <div className="ai-visual-gifs">
          {rec.before ? <Gif src={resolveSrc(rec.before.gif)} label={beforeLabel} /> : null}
          {rec.before && rec.after ? <div className="ai-visual-arrow" aria-hidden>→</div> : null}
          {rec.after ? <Gif src={resolveSrc(rec.after.gif)} label={afterLabel} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 动图第一次打开时服务端才去渲(8 帧 + 编码),要等几秒到几十秒 —— 转圈,失败了能重试。
 * 轮播也用它;挂载即开始加载,所以别在还没翻到的页里挂它。
 */
/** onSettled:动图出来或确定失败时调(操作详细预览控件靠它判断这一页渲染好没有,好了才让翻过去) */
export function Gif({ src, label, onSettled }: { src: string; label: string; onSettled?: () => void }): JSX.Element {
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  const [attempt, setAttempt] = useState(0);
  const querySep = src.includes("?") ? "&" : "?";
  const retrySrc = attempt && !src.startsWith("blob:") && !src.startsWith("data:")
    ? `${src}${querySep}retry=${attempt}`
    : src;
  return (
    <figure className={`ai-visual-gif is-${state}`}>
      <div className="box">
        {state === "err" ? (
          <button type="button" onClick={() => { setState("loading"); setAttempt((n) => n + 1); }}>动图没做出来,点这里重试</button>
        ) : (
          <>
            {state === "loading" ? <span className="ai-spinner" aria-hidden /> : null}
            <img
              key={attempt}
              src={retrySrc}
              alt={label}
              onLoad={() => { setState("ok"); onSettled?.(); }}
              onError={() => { setState("err"); onSettled?.(); }}
            />
          </>
        )}
      </div>
      <figcaption>{label}{state === "loading" ? " · 正在渲染…" : ""}</figcaption>
    </figure>
  );
}
