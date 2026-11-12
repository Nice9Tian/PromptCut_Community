/**
 * Local Data Server inspection, member-account mutation, commit-history reader, and handover
 * adoption helpers for Desktop Data Server mode (Issue #8).
 *
 * All HTTP routes backed by these helpers are loopback-only and same-origin guarded.
 * Derived keys (`K`) and salts are never returned in `inspectLocalDataServer` responses.
 */
import fs from "node:fs";
import path from "node:path";
import { fileNameOf } from "./docservice/store/index.mjs";
import { makeCredential } from "./auth/client.mjs";
import { isProjectId, isUsername } from "./auth/protocol.mjs";
import { roomUnavailableReason } from "./recovery/relocation.mjs";

function summarizeOps(ops) {
  if (!Array.isArray(ops)) return [];
  const out = [];
  const seen = new Set();
  for (const item of ops) {
    if (!item || typeof item !== "object") continue;
    const p = typeof item.path === "string" ? (item.path || "/") : "/";
    const label = `${item.op || "set"} ${p}`;
    if (!seen.has(label)) {
      seen.add(label);
      out.push(label);
      if (out.length >= 8) break;
    }
  }
  return out;
}

/**
 * Reads recent project commits from `<dataDir>/tenants/<projectId>/projects/<encoded>.ops.ndjson`
 * (shared space) or `<dataDir>/projects/<encoded>.ops.ndjson` (local space).
 */
export function readProjectHistory(dataDir, projectId, { scope = "shared", limit = 100 } = {}) {
  if (!dataDir || typeof projectId !== "string" || !projectId.trim()) {
    return { latestRev: 0, records: [] };
  }
  const encoded = fileNameOf(`${projectId}.ops`);
  const file = scope === "shared"
    ? path.join(dataDir, "tenants", projectId, "projects", `${encoded}.ndjson`)
    : path.join(dataDir, "projects", `${encoded}.ndjson`);
  if (!fs.existsSync(file)) {
    return { latestRev: 0, records: [] };
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { latestRev: 0, records: [] };
  }
  const parsed = [];
  let latestRev = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if (rec.projectId && rec.projectId !== projectId) continue;
    const rev = Number(rec.rev) || 0;
    if (rev > latestRev) latestRev = rev;
    const actor = rec.actor && typeof rec.actor === "object" ? rec.actor : {};
    parsed.push({
      rev,
      opId: typeof rec.opId === "string" ? rec.opId : "",
      at: Number(rec.at) || 0,
      actor: {
        userId: typeof actor.userId === "string" ? actor.userId : "local",
        username: typeof actor.username === "string" ? actor.username : (typeof actor.userId === "string" ? actor.userId : "local"),
        deviceId: typeof actor.deviceId === "string" ? actor.deviceId : null,
        displayName: typeof actor.displayName === "string" ? actor.displayName : null,
        creator: actor.creator === true,
        role: typeof actor.role === "string" ? actor.role : "page",
      },
      entities: Array.isArray(rec.entities) ? rec.entities.slice(0, 12) : [],
      opCount: Array.isArray(rec.ops) ? rec.ops.length : 0,
      summary: summarizeOps(rec.ops),
    });
  }
  return {
    latestRev,
    records: parsed.slice(-Math.max(1, limit)).reverse(),
  };
}

export function inspectLocalDataServer({
  store,
  dataDir,
  device,
  lanHost = false,
  port = null,
  projectId = "",
  contentId = "",
}) {
  const pid = typeof projectId === "string" ? projectId.trim() : "";
  const rec = pid && isProjectId(pid) ? store?.get(pid) ?? null : null;
  const unavailable = rec ? roomUnavailableReason(rec) : null;
  const isLocalHost = Boolean(rec && !unavailable);
  const historyTarget = isLocalHost ? pid : (pid || String(contentId || "").trim());
  const history = historyTarget
    ? readProjectHistory(dataDir, historyTarget, { scope: isLocalHost ? "shared" : "local", limit: 120 })
    : { latestRev: 0, records: [] };

  return {
    ok: true,
    localDeviceId: device?.deviceId ?? null,
    localDeviceName: device?.deviceName ?? null,
    lanHost: Boolean(lanHost),
    port,
    base: port ? `http://127.0.0.1:${port}/docservice` : null,
    isLocalHost,
    project: rec
      ? {
          projectId: rec.projectId,
          name: rec.name,
          mode: rec.mode,
          createdAt: rec.createdAt ?? null,
          creatorUsername: rec.creator?.username ?? null,
          allowlist: Array.isArray(rec.list)
            ? rec.list.map((u) => ({
                username: u.username,
                access: u.access === "r" || (Array.isArray(rec.readonly) && rec.readonly.includes(u.username)) ? "r" : "rw",
              }))
            : [],
          bans: Array.isArray(rec.bans)
            ? rec.bans.map((b) => ({
                deviceId: b.deviceId,
                username: b.username ?? null,
                displayName: b.displayName ?? null,
                at: b.at ?? null,
              }))
            : [],
        }
      : null,
    history,
  };
}

/**
 * Exports the verified room credential record for creator-to-creator handover after mutual 6-digit
 * pairing verification succeeds on the original creator machine.
 */
export function exportHandoverPackage({ store, projectId }) {
  const pid = String(projectId || "").trim();
  if (!isProjectId(pid)) {
    const err = new Error("Invalid projectId");
    err.code = "bad-project-id";
    throw err;
  }
  const rec = store?.get(pid);
  if (!rec || roomUnavailableReason(rec)) {
    const err = new Error("Project is not hosted on this machine");
    err.code = "not-local-host";
    throw err;
  }
  return {
    sourceProjectId: rec.projectId,
    name: rec.name,
    mode: rec.mode,
    kdf: rec.kdf,
    creator: rec.creator,
    ...(rec.mode === "free" ? { project: rec.project } : { list: rec.list ?? [] }),
    bans: rec.bans ?? [],
  };
}

/**
 * Provisions an incoming handover package onto this machine's local credential store so this desktop
 * becomes the active Data Server and its editor can join as creator.
 */
export function adoptDataServerProject({ store, roomAuth, lanSync }) {
  if (!store) {
    const err = new Error("Local credential store unavailable");
    err.code = "no-store";
    throw err;
  }
  if (!roomAuth || typeof roomAuth !== "object" || typeof roomAuth.name !== "string" || !roomAuth.creator?.username || !roomAuth.creator?.key || !roomAuth.creator?.salt) {
    const err = new Error("Invalid handover package");
    err.code = "bad-handover";
    throw err;
  }
  let targetName = roomAuth.name.trim() || "Untitled";
  if (store.nameTaken(targetName)) {
    const existing = store.byName(targetName);
    if (existing && existing.creator?.key === roomAuth.creator.key) {
      store.remove(existing.projectId);
    } else {
      let suffix = 2;
      while (store.nameTaken(`${targetName} (${suffix})`)) suffix += 1;
      targetName = `${targetName} (${suffix})`;
    }
  }
  const mode = roomAuth.mode === "restricted" ? "restricted" : "free";
  const created = store.create({
    name: targetName,
    mode,
    kdf: roomAuth.kdf,
    creator: roomAuth.creator,
    ...(mode === "free"
      ? { project: roomAuth.project }
      : { list: Array.isArray(roomAuth.list) ? roomAuth.list : [] }),
  });
  if (Array.isArray(roomAuth.bans) && roomAuth.bans.length > 0) {
    store.update(created.projectId, (draft) => {
      draft.bans = structuredClone(roomAuth.bans);
    });
  }
  lanSync?.();
  return {
    ok: true,
    projectId: created.projectId,
    name: created.name,
    mode: created.mode,
    creatorUsername: created.creator.username,
    creatorKey: roomAuth.creator.key,
  };
}

export function relinquishLocalDataServer({ store, projectId, lanSync }) {
  const pid = String(projectId || "").trim();
  if (!isProjectId(pid) || !store) return false;
  const removed = store.remove(pid);
  if (removed) lanSync?.();
  return removed;
}

/**
 * Incremental member-account management on the local Data Server (`add-member`, `remove-member`,
 * `set-mode`, `unban`). Preserves existing members' derived credentials without requiring their
 * plaintext passwords to be re-entered.
 */
export async function mutateDataServerMembers({
  store,
  projectId,
  action,
  username,
  password,
  access,
  mode,
  projectPassword,
  deviceId,
  makeCredentialFn = makeCredential,
}) {
  const pid = String(projectId || "").trim();
  if (!isProjectId(pid) || !store) {
    const err = new Error("Project not hosted on this machine");
    err.code = "not-local-host";
    throw err;
  }
  const cur = store.get(pid);
  if (!cur || roomUnavailableReason(cur)) {
    const err = new Error("Project not hosted on this machine");
    err.code = "not-local-host";
    throw err;
  }

  if (action === "add-member" || action === "set-member-password") {
    const cleanUser = String(username || "").trim();
    if (!isUsername(cleanUser)) {
      const err = new Error("Invalid member username");
      err.code = "bad-username";
      throw err;
    }
    if (cleanUser === cur.creator?.username) {
      const err = new Error("Username matches creator account");
      err.code = "creator-conflict";
      throw err;
    }
    const cleanPw = String(password || "");
    if (!cleanPw) {
      const err = new Error("Member password cannot be empty");
      err.code = "bad-password";
      throw err;
    }
    const cred = await makeCredentialFn(cleanPw, cur.kdf);
    const memberAccess = access === "r" ? "r" : "rw";
    store.update(pid, (draft) => {
      draft.mode = "restricted";
      delete draft.project;
      const list = Array.isArray(draft.list) ? draft.list : [];
      const idx = list.findIndex((item) => item.username === cleanUser);
      const entry = { username: cleanUser, salt: cred.salt, key: cred.key, access: memberAccess };
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      draft.list = list;
      draft.userGenerations ??= {};
      draft.userGenerations[cleanUser] = (Number(draft.userGenerations[cleanUser]) || 0) + 1;
    });
    return store.get(pid);
  }

  if (action === "remove-member") {
    const cleanUser = String(username || "").trim();
    store.update(pid, (draft) => {
      draft.list = (draft.list ?? []).filter((item) => item.username !== cleanUser);
      draft.userGenerations ??= {};
      draft.userGenerations[cleanUser] = (Number(draft.userGenerations[cleanUser]) || 0) + 1;
    });
    return store.get(pid);
  }

  if (action === "set-mode") {
    if (mode === "restricted") {
      store.update(pid, (draft) => {
        draft.mode = "restricted";
        draft.list = Array.isArray(draft.list) ? draft.list : [];
        delete draft.project;
        draft.generation = (Number(draft.generation) || 1) + 1;
      });
      return store.get(pid);
    }
    if (mode === "free") {
      const pw = String(projectPassword || "");
      if (!pw) {
        const err = new Error("Open mode requires a project password");
        err.code = "bad-password";
        throw err;
      }
      const cred = await makeCredentialFn(pw, cur.kdf);
      store.update(pid, (draft) => {
        draft.mode = "free";
        draft.project = { salt: cred.salt, key: cred.key };
        delete draft.list;
        draft.generation = (Number(draft.generation) || 1) + 1;
      });
      return store.get(pid);
    }
    const err = new Error("Invalid mode");
    err.code = "bad-mode";
    throw err;
  }

  if (action === "unban") {
    const dev = String(deviceId || "").trim();
    store.update(pid, (draft) => {
      draft.bans = (draft.bans ?? []).filter((b) => b.deviceId !== dev);
    });
    return store.get(pid);
  }

  const err = new Error("Unknown data-server member action");
  err.code = "bad-action";
  throw err;
}
