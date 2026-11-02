import { useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { prerenderUrl, usePrerenderBase, withBase } from "../../render/prerender";
import { cloudTicket } from "../../ai/extensions";
import { tr } from "../../i18n/index.ts";

/**
 * The "visible result" of one tool step in the chat panel: the bitmap returned at the time, which
 * parameters were changed, and the before and after animated images.
 *
 * The record is handed by whoever executed the tool to the server to keep (`withVisual` in
 * src/ai/mcpExecutor.ts, or the image-viewing tools the server executes directly), and the tool
 * result carries a visualId at the very front. All four vendors' tool result summaries keep the
 * leading part, so recognizing the id from the summary is enough here, with no need to care whether
 * the step ran through direct API or agy / Claude / Codex.
 *
 * In local mode the records and animated images are stored in the prerender process
 * (/api/ai/visual); in cloud chat mode they are stored in the Agent service's authorized chat
 * endpoint (/agent/v1/conversations/:id/visuals/:vid), and every read checks the current chat's ACL
 * and aclRevision; on switching to private or on revocation they are invalidated immediately and
 * the cache and DOM are cleared.
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
  /** Root URL of the Agent service's `/v1` (e.g. `/agent/v1` or `https://.../agent/v1`, without a trailing slash) */
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
 * Clears the visual records and the authorized file cache (called on switching project, switching
 * chat, switching a shared chat to private, and on revocation).
 */
export function clearVisualCache(): void {
  scopeEpoch += 1;
  inflight.clear();
  loaded.clear();
  revokeAllBlobUrls();
  notifyScopeListeners();
}

/**
 * Sets or updates the scope of the visual records of a cloud chat.
 * When the scope (project, chat, account, aclRevision, visibility) changes or access is revoked
 * (`revoked: true`), immediately invalidates the old cache and notifies the UI to unmount any
 * leftover imagery.
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
    throw new Error(tr("Chat permissions changed"));
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
  if (scope.revoked) throw new Error(tr("The current account can no longer read this chat's visual records"));
  const getTicket = scope.ticket ?? cloudTicket;
  const ticketStr = await getTicket();
  if (myEpoch !== scopeEpoch || currentCloudScope?.revoked) {
    throw new Error(tr("Chat permissions changed"));
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
    throw new Error(tr("Chat permissions changed"));
  }
  // If the aclRevision returned by the server differs from what the current scope expects, update the
  // cache key accordingly
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
    if (scope.revoked) return Promise.reject(new Error(tr("The current account can no longer read this chat's visual records")));
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

  if (ONLINE_BUILD) return Promise.reject(new Error(tr("Online browser mode has no visual record for this step")));
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

/** A record that has already been fetched, read synchronously; undefined if not yet fetched, the fetch failed, or the current scope was revoked */
export function peekVisualRecord(id: string): VisualRecord | undefined {
  if (currentCloudScope?.revoked) return undefined;
  return loaded.get(cacheKeyOf(id, currentCloudScope));
}

/** Get a record for the UI: if it is in the cache, hand it over directly (no "Fetching" flicker), otherwise go and fetch it; on fetch failure or revocation, surface the reason and clear the old record */
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
      setState({ key: k, rec: null, err: tr("The current account can no longer read this chat's visual records") });
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
  if (currentCloudScope?.revoked) return { rec: null, err: tr("The current account can no longer read this chat's visual records") };
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

  if (err) return <div className="ai-visual-note">{tr("The visual for this step can no longer be retrieved ({0})", err)}</div>;
  if (!rec) return <div className="ai-visual-note">{tr("Retrieving visual…")}</div>;
  if (!cloudMode && base === null) return <div className="ai-visual-note">{tr("The prerender process is not ready yet, can't retrieve the visual")}</div>;

  const resolveSrc = (u: string) => (cloudMode || isDirectAssetUrl(u) ? u : withBase(base ?? "", u));
  const hasGif = !!(rec.before || rec.after);
  const afterLabel = rec.before ? tr("After") : rec.tool === "get_gif" ? tr("Full animation") : tr("New card");
  const beforeLabel = rec.after ? tr("Before") : tr("Deleted card");

  return (
    <div className="ai-visual">
      {rec.images?.length ? (
        <div className="ai-visual-images">
          {rec.images.map((im, i) => (
            <figure key={i}>
              <img src={resolveSrc(im.url)} alt={im.label || tr("Frame {0}", i + 1)} loading="lazy" />
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
        <div className="ai-visual-note">{tr("Parameters unchanged (maybe only other tracks were changed, or this step was clamped back to the original value)")}</div>
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
 * The server only renders the animated image (8 frames + encoding) when it is first opened, which
 * takes a few seconds to tens of seconds: show a spinner, and allow retry on failure.
 * The carousel uses it too; it starts loading as soon as it mounts, so don't mount it in a page that
 * has not been flipped to yet.
 */
/** onSettled: called when the animated image is ready or has definitively failed (the operation detail preview control uses it to tell whether this page has finished rendering, and only then lets you flip past it) */
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
          <button type="button" onClick={() => { setState("loading"); setAttempt((n) => n + 1); }}>{tr("The animation failed to generate, click here to retry")}</button>
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
      <figcaption>{label}{state === "loading" ? tr(" · Rendering…") : ""}</figcaption>
    </figure>
  );
}
