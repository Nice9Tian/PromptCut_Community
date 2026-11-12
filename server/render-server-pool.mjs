/**
 * Multi-project render-server pool and task/throughput aggregator for the Desktop Render Server panel
 * (Issues #7 and #8).
 *
 * Manages:
 *   1. Target shared projects bound to this machine's render server (including the editor's active
 *      auto-render-node binding, already-joined projects from local collaboration history, and projects
 *      added via invite link + optional restricted-member password).
 *   2. Live render task records (ring buffer of recent clip/segment/preload/queue tasks with timestamps,
 *      frame/segment counts, duration, and status).
 *   3. Rolling and cumulative throughput metrics (frames/s, segments/min, completed/in-flight/failed counts).
 *
 * Security invariants:
 *   - Invite codes, passwords, derived keys (`K`), and connection tickets are NEVER stored in public
 *     records or written to logs.
 */
import { resolveInvite as defaultResolveInvite, redeemInvite as defaultRedeemInvite, buildAuthProtocols } from "./auth/client.mjs";
import { localDeviceInfo } from "./auth/device.mjs";
import { createWsEndpoint } from "./render-node/ws-transport.mjs";

const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const HOSTED_DOC_PATH = "/hosted/";

/**
 * Parse a pasted invite URL (`http(s)://...#invite=<43-char-code>&doc=<encoded-path>`).
 * Returns `{ origin, code, doc, base }` or `null` when invalid. Legacy links without `doc=` return
 * `{ origin, code, doc: null, base: null }` so callers can report an expired legacy link cleanly.
 */
export function parseInviteFromInput(text) {
  const m = /https?:\/\/\S+/i.exec(String(text || "").trim());
  if (!m) return null;
  let u;
  try {
    u = new URL(m[0]);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const hash = String(u.hash || "").replace(/^#/, "");
  if (!hash) return null;
  let code = null;
  let doc = null;
  for (const part of hash.split("&")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === "invite" && code === null) code = v;
    else if (k === "doc" && doc === null) {
      try {
        const decoded = decodeURIComponent(v);
        doc = decoded.startsWith("/") ? decoded : null;
      } catch {
        doc = null;
      }
    }
  }
  if (!code || !INVITE_CODE_RE.test(code)) return null;
  const base = doc ? `${u.origin.replace(/\/+$/, "")}${doc}` : null;
  return { origin: u.origin, code, doc, base };
}

/**
 * Normalize an HTTP or WebSocket docservice base URL to a WebSocket endpoint URL.
 * Preserves trailing slash on `/hosted/` (required by nginx) and strips trailing slashes elsewhere
 * (`/docservice` on LAN hosts).
 */
export function normalizeWsUrl(rawUrl) {
  const u = new URL(String(rawUrl || "").trim());
  if (!["ws:", "wss:", "http:", "https:"].includes(u.protocol)) {
    throw new Error("URL protocol must be ws(s):// or http(s)://");
  }
  const protocol = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  const pathname = u.pathname === HOSTED_DOC_PATH ? HOSTED_DOC_PATH : (u.pathname.replace(/\/+$/, "") || "/");
  return `${protocol}//${u.host}${pathname}`;
}

export function normalizeHttpBase(rawUrl) {
  const u = new URL(String(rawUrl || "").trim());
  if (!["ws:", "wss:", "http:", "https:"].includes(u.protocol)) {
    throw new Error("URL protocol must be ws(s):// or http(s)://");
  }
  const protocol = u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:";
  const pathname = u.pathname === HOSTED_DOC_PATH ? HOSTED_DOC_PATH : u.pathname.replace(/\/+$/, "");
  return `${protocol}//${u.host}${pathname}`;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Default lightweight background render-session connector for projects added to the render-server pool
 * when credentials (`key` or `password`) are provided. Opens an authenticated `role: 'render'` WebSocket
 * to the project's docservice so the host registers as a render node and tracks queue events.
 */
export function connectRenderPoolSession(entry, cred, { device = localDeviceInfo(), WebSocketImpl = globalThis.WebSocket, onQueueTask } = {}) {
  if (!cred || (!cred.key && !cred.password) || !cred.username || typeof WebSocketImpl !== "function") {
    return null;
  }
  let state = "connecting";
  let lastError = null;
  const endpoint = createWsEndpoint({
    url: entry.url,
    WebSocket: WebSocketImpl,
    protocols: () => buildAuthProtocols({
      base: entry.httpBase,
      projectId: entry.projectId,
      username: cred.username,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      as: cred.as === "creator" ? "creator" : "member",
      role: "render",
      ...(cred.key ? { key: cred.key } : { password: cred.password }),
    }),
  });
  endpoint.onOpen(() => {
    state = "connected";
    lastError = null;
    endpoint.send({ type: "queue.watch", projectId: entry.projectId });
  });
  endpoint.onClose((info) => {
    state = endpoint.closed ? "closed" : "reconnecting";
    if (info?.reason) lastError = String(info.reason);
  });
  endpoint.onMessage((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "queue.snapshot" && Array.isArray(msg.tasks)) {
      for (const t of msg.tasks) {
        if (t && typeof t.id === "string" && (t.state === "done" || t.state === "claimed")) {
          onQueueTask?.({
            id: `${entry.projectId}:${t.id}`,
            projectId: entry.projectId,
            projectName: entry.name,
            kind: t.kind || "render",
            status: t.state === "done" ? "completed" : "running",
            frames: Number(t.frames ?? t.frameCount ?? 0) || 0,
            segments: Number(t.segments ?? (t.kind === "stream" ? 1 : 0)) || 0,
          });
        }
      }
    } else if (msg.type === "queue.updated" && msg.task && typeof msg.task.id === "string") {
      const t = msg.task;
      if (t.state === "done" || t.state === "claimed" || t.state === "failed") {
        onQueueTask?.({
          id: `${entry.projectId}:${t.id}`,
          projectId: entry.projectId,
          projectName: entry.name,
          kind: t.kind || "render",
          status: t.state === "done" ? "completed" : t.state === "failed" ? "failed" : "running",
          frames: Number(t.frames ?? t.frameCount ?? 0) || 0,
          segments: Number(t.segments ?? (t.kind === "stream" ? 1 : 0)) || 0,
        });
      }
    }
  });
  return {
    connected: () => endpoint.connected === true,
    state: () => (endpoint.connected ? "connected" : state),
    error: () => lastError,
    close: () => endpoint.close(),
  };
}

export function createRenderServerPool({
  maxRecords = 200,
  now = () => Date.now(),
  connectProject = connectRenderPoolSession,
} = {}) {
  const startedAt = now();
  /** @type {Map<string, any>} */
  const projects = new Map();
  /** @type {Array<any>} */
  const records = [];
  let seq = 0;

  function publicProjectOf(item, activeProjectId, queueNodeMap) {
    const qNode = queueNodeMap.get(item.projectId) ?? null;
    const handleConnected = item.handle?.connected?.() === true;
    const isCurrent = item.projectId === activeProjectId;
    const connected = Boolean(qNode?.connected || handleConnected || (isCurrent && item.currentBound));
    const state = connected
      ? "connected"
      : item.handle?.state?.() || (isCurrent ? "bound" : item.state || "standby");
    return {
      projectId: item.projectId,
      name: item.name,
      url: item.url,
      httpBase: item.httpBase,
      assetBase: item.assetBase ?? null,
      mode: item.mode ?? null,
      source: item.source,
      username: item.username ?? null,
      addedAt: item.addedAt,
      activeBinding: isCurrent,
      connected,
      state,
      error: item.handle?.error?.() ?? item.error ?? null,
      stats: qNode
        ? {
            claimed: Number(qNode.claimed) || 0,
            completed: Number(qNode.completed) || 0,
            dedup: Number(qNode.dedup) || 0,
            failed: Number(qNode.failed) || 0,
            lost: Number(qNode.lost) || 0,
          }
        : { claimed: 0, completed: 0, dedup: 0, failed: 0, lost: 0 },
    };
  }

  function recordTask(event = {}) {
    const ts = now();
    const id = typeof event.id === "string" && event.id.trim() ? event.id.trim() : `rt-${++seq}-${ts.toString(36)}`;
    const projectId = typeof event.projectId === "string" && event.projectId.trim() ? event.projectId.trim() : "local";
    const known = projects.get(projectId);
    const projectName = (typeof event.projectName === "string" && event.projectName.trim()) || known?.name || projectId;
    const status = event.status === "running" || event.status === "failed" ? event.status : "completed";
    const frames = Math.max(0, Math.floor(Number(event.frames) || 0));
    const segments = Math.max(0, Math.floor(Number(event.segments) || 0));
    const existingIdx = records.findIndex((r) => r.id === id);
    if (existingIdx >= 0) {
      const prev = records[existingIdx];
      const started = Number.isFinite(event.startedAt) ? Number(event.startedAt) : prev.startedAt;
      const finished = status === "running" ? null : (Number.isFinite(event.finishedAt) ? Number(event.finishedAt) : ts);
      const durationMs = Number.isFinite(event.durationMs)
        ? Math.max(0, Math.round(Number(event.durationMs)))
        : finished !== null
          ? Math.max(1, finished - started)
          : Math.max(0, ts - started);
      const updated = {
        ...prev,
        projectId,
        projectName,
        kind: typeof event.kind === "string" && event.kind ? event.kind : prev.kind,
        status,
        frames: frames || prev.frames,
        segments: segments || prev.segments,
        startedAt: started,
        finishedAt: finished,
        durationMs,
      };
      records.splice(existingIdx, 1);
      records.unshift(updated);
      return { ...updated };
    }
    const started = Number.isFinite(event.startedAt) ? Number(event.startedAt) : ts;
    const finished = status === "running" ? null : (Number.isFinite(event.finishedAt) ? Number(event.finishedAt) : ts);
    const durationMs = Number.isFinite(event.durationMs)
      ? Math.max(0, Math.round(Number(event.durationMs)))
      : finished !== null
        ? Math.max(0, finished - started)
        : 0;
    const entry = {
      id,
      projectId,
      projectName,
      kind: typeof event.kind === "string" && event.kind ? event.kind : "snapshot",
      status,
      frames,
      segments,
      startedAt: started,
      finishedAt: finished,
      durationMs,
    };
    records.unshift(entry);
    if (records.length > maxRecords) records.length = maxRecords;
    return { ...entry };
  }

  function syncCurrentBinding(binding, extra = {}) {
    if (!binding || typeof binding.projectId !== "string" || !PROJECT_ID_RE.test(binding.projectId)) {
      for (const [id, item] of [...projects.entries()]) {
        if (item.source === "current") {
          try { item.handle?.close?.(); } catch { /* ignore */ }
          projects.delete(id);
        } else if (item.currentBound) {
          item.currentBound = false;
        }
      }
      return;
    }
    for (const item of projects.values()) {
      if (item.projectId !== binding.projectId && item.source === "current") {
        try { item.handle?.close?.(); } catch { /* ignore */ }
        projects.delete(item.projectId);
      } else if (item.projectId !== binding.projectId) {
        item.currentBound = false;
      }
    }
    const existing = projects.get(binding.projectId);
    const url = normalizeWsUrl(binding.url);
    const httpBase = normalizeHttpBase(binding.url);
    if (existing) {
      existing.url = url;
      existing.httpBase = httpBase;
      existing.assetBase = binding.assetBase ?? existing.assetBase ?? null;
      existing.currentBound = true;
      if (typeof extra.name === "string" && extra.name.trim()) existing.name = extra.name.trim();
      return;
    }
    projects.set(binding.projectId, {
      projectId: binding.projectId,
      name: (typeof extra.name === "string" && extra.name.trim()) || binding.projectId,
      url,
      httpBase,
      assetBase: binding.assetBase ?? null,
      mode: extra.mode ?? null,
      source: "current",
      username: extra.username ?? null,
      addedAt: now(),
      currentBound: true,
      state: "bound",
      error: null,
      handle: null,
    });
  }

  async function addJoinedProject(input = {}, options = {}) {
    const projectId = String(input.projectId || "").trim();
    if (!PROJECT_ID_RE.test(projectId)) {
      const err = new Error("Invalid projectId");
      err.code = "bad-project-id";
      throw err;
    }
    const rawUrl = String(input.url || input.base || "").trim();
    if (!rawUrl) {
      const err = new Error("Missing project service URL");
      err.code = "bad-url";
      throw err;
    }
    const url = normalizeWsUrl(rawUrl);
    const httpBase = normalizeHttpBase(rawUrl);
    const prev = projects.get(projectId);
    if (prev?.handle) {
      try { prev.handle.close?.(); } catch { /* ignore */ }
    }
    const item = {
      projectId,
      name: String(input.name || prev?.name || projectId).trim() || projectId,
      url,
      httpBase,
      assetBase: typeof input.assetBase === "string" && input.assetBase.trim() ? input.assetBase.trim() : (prev?.assetBase ?? null),
      mode: input.mode === "free" || input.mode === "restricted" ? input.mode : (prev?.mode ?? null),
      source: prev?.source === "invite" ? "invite" : "joined",
      username: typeof input.username === "string" && input.username.trim() ? input.username.trim() : (prev?.username ?? null),
      addedAt: prev?.addedAt ?? now(),
      currentBound: Boolean(prev?.currentBound),
      state: prev?.currentBound ? "bound" : "standby",
      error: null,
      handle: null,
    };
    if (!item.currentBound && connectProject && (input.key || input.password) && item.username) {
      item.handle = connectProject(
        item,
        { username: item.username, key: input.key, password: input.password, as: input.as },
        { ...options, onQueueTask: recordTask },
      );
    }
    projects.set(projectId, item);
    return publicProjectOf(item, prev?.currentBound ? projectId : null, new Map());
  }

  async function addInviteProject(input = {}, deps = {}) {
    const resolveInviteFn = deps.resolveInvite ?? defaultResolveInvite;
    const redeemInviteFn = deps.redeemInvite ?? defaultRedeemInvite;
    const device = deps.device ?? localDeviceInfo();

    let base = typeof input.base === "string" && input.base.trim() ? input.base.trim() : null;
    let code = typeof input.code === "string" && INVITE_CODE_RE.test(input.code.trim()) ? input.code.trim() : null;
    if (!base || !code) {
      const parsed = parseInviteFromInput(input.inviteLink || input.link || "");
      if (!parsed) {
        const err = new Error("Invalid invite link");
        err.code = "bad-invite-link";
        throw err;
      }
      if (!parsed.doc || !parsed.base) {
        const err = new Error("Legacy invite link without service path");
        err.code = "legacy-invite-link";
        throw err;
      }
      base = parsed.base;
      code = parsed.code;
    }

    const resolved = await resolveInviteFn({ base, code, fetch: deps.fetch });
    const username = String(input.username || device.deviceName || "render-node").trim().slice(0, 64);
    if (resolved.mode === "restricted" && !input.password && !input.key) {
      const err = new Error("Restricted project requires member username and password");
      err.code = "password-required";
      err.project = { projectId: resolved.projectId, name: resolved.name, mode: resolved.mode };
      throw err;
    }

    const redeemed = await redeemInviteFn({
      base,
      code,
      username,
      deviceId: device.deviceId,
      fetch: deps.fetch,
    });

    const url = normalizeWsUrl(base);
    const httpBase = normalizeHttpBase(base);
    const prev = projects.get(redeemed.projectId);
    if (prev?.handle) {
      try { prev.handle.close?.(); } catch { /* ignore */ }
    }
    const item = {
      projectId: redeemed.projectId,
      name: redeemed.name || resolved.name || redeemed.projectId,
      url,
      httpBase,
      assetBase: prev?.assetBase ?? null,
      mode: redeemed.mode || resolved.mode || "free",
      source: "invite",
      username,
      addedAt: prev?.addedAt ?? now(),
      currentBound: Boolean(prev?.currentBound),
      state: "connecting",
      error: null,
      handle: null,
    };
    if (!item.currentBound && connectProject) {
      item.handle = connectProject(
        item,
        { username, key: input.key || redeemed.key, password: input.password, as: "member" },
        { device, WebSocketImpl: deps.WebSocketImpl, onQueueTask: recordTask },
      );
      if (!item.handle) item.state = "standby";
    }
    projects.set(item.projectId, item);
    return publicProjectOf(item, prev?.currentBound ? item.projectId : null, new Map());
  }

  async function removeProject(projectId) {
    const id = String(projectId || "").trim();
    const item = projects.get(id);
    if (!item) return false;
    try { item.handle?.close?.(); } catch { /* ignore */ }
    projects.delete(id);
    return true;
  }

  function status({ nodeStatus = null, queueSummary = null, prerenderReady = false } = {}) {
    const activeProjectId = typeof nodeStatus?.projectId === "string" ? nodeStatus.projectId : null;
    const queueNodeMap = new Map();
    if (Array.isArray(queueSummary?.nodes)) {
      for (const n of queueSummary.nodes) {
        if (n && typeof n.projectId === "string") queueNodeMap.set(n.projectId, n);
      }
    }
    const list = [...projects.values()].map((p) => publicProjectOf(p, activeProjectId, queueNodeMap));

    let recCompleted = 0;
    let recInFlight = 0;
    let recFailed = 0;
    let totalFrames = 0;
    let totalSegments = 0;
    let totalRenderMs = 0;
    for (const r of records) {
      if (r.status === "completed") {
        recCompleted += 1;
        totalFrames += r.frames;
        totalSegments += r.segments;
        totalRenderMs += r.durationMs;
      } else if (r.status === "running") {
        recInFlight += 1;
      } else if (r.status === "failed") {
        recFailed += 1;
      }
    }

    let queueCompleted = 0;
    let queueClaimed = 0;
    let queueFailed = 0;
    let queueDedup = 0;
    for (const n of queueNodeMap.values()) {
      queueCompleted += Number(n.completed) || 0;
      queueClaimed += Number(n.claimed) || 0;
      queueFailed += Number(n.failed) || 0;
      queueDedup += Number(n.dedup) || 0;
    }

    const completedTasks = Math.max(recCompleted, queueCompleted);
    const failedTasks = Math.max(recFailed, queueFailed);
    const inFlightTasks = Math.max(recInFlight, Math.max(0, queueClaimed - queueCompleted - queueFailed - queueDedup));
    const uptimeMs = Math.max(0, now() - startedAt);
    const framesPerSec = totalRenderMs > 0 ? round2((totalFrames * 1000) / totalRenderMs) : 0;
    const segmentsPerMin = totalRenderMs > 0 ? round2((totalSegments * 60_000) / totalRenderMs) : 0;

    return {
      ok: true,
      prerenderReady: Boolean(prerenderReady),
      nodeStatus,
      projects: list,
      records: records.map((r) => ({ ...r })),
      throughput: {
        completedTasks,
        inFlightTasks,
        failedTasks,
        dedupTasks: queueDedup,
        totalFrames,
        totalSegments,
        totalRenderMs,
        framesPerSec,
        segmentsPerMin,
        uptimeMs,
      },
    };
  }

  async function close() {
    for (const item of projects.values()) {
      try { item.handle?.close?.(); } catch { /* ignore */ }
    }
    projects.clear();
  }

  return {
    syncCurrentBinding,
    addJoinedProject,
    addInviteProject,
    removeProject,
    recordTask,
    status,
    close,
  };
}
