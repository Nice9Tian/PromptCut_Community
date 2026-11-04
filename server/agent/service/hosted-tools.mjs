/**
 * Tools implemented on the server for Cloud Agent (task brief `docs/plan/cloud-agent-task.md` J;
 * contract `docs/plan/cloud-agent-contract.md` section 9).
 *
 * In the desktop app, these tools are executed by the page, calling the editor process `/api/*`
 * under the hood (storing into the library, creating cards, voiceover...). On cloud nodes there is
 * no page and no editor process, so server-side implementations are provided here, with the following rules:
 *
 *   - **Local files only go into this chat's workspace** (`workspace.mjs`): attachments, downloads,
 *     and synthesized voice audio all land inside, with paths validated by the workspace;
 *   - **Outbound network access via model-provided addresses only goes through the egress gate** (`egress.mjs`);
 *   - **Media bytes go through the asset service**: request an asset ticket from the document service
 *     via this chat's connection (permissions not exceeding the member themselves; read-only members
 *     cannot get read-write tickets), and write chunked by content hash into the `media` namespace;
 *   - **Project changes go through the document service**: modify on the project replica, compute diff,
 *     and commit with expected version (`mutate` in `agent-exec.mjs`), taking the same path as tools
 *     in the routing table;
 *   - **Card source code goes through the document service content store** (`card-source`):
 *     creating/editing cards only performs static translation, review, and syntax checks;
 *     **card code is not executed in this process**; this card executes in other members' browsers
 *     and render nodes, protected by isolation in those two places (same path as local Agent creating
 *     cards in collaborative projects);
 *   - **Paid external calls** (voiceover) use the host's configuration, recording one usage row each time.
 *
 * External waits (downloads, uploads, synthesis) are all outside the process-level lock; entering
 * the lock only performs synchronous project modifications.
 * This file does not import `src/`: frontend code only goes through `ssr-host.mjs` (`ctx.host()`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { findAgentExtension } from './extensions.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAssetClient } from '../../asset-store/client.mjs';
import { createSlot, createSoundTools, newSoundState } from './hosted-sound.mjs';
import { createAudioTools } from './hosted-audio.mjs';
import { createCardAudioTools, newCardAudioState } from './hosted-card-audio.mjs';
import { createCollect, newCollectState } from './hosted-collect.mjs';
import { loadCardLib } from '../ssr-host.mjs';

const SERVER_DIR = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export const HOSTED_TOOL_DEFAULTS = Object.freeze({
  /** Single-file limit when importing media by URL */
  maxImportBytes: 512 * 1024 * 1024,
  /** Download time limit */
  downloadMs: 120_000,
  /** Size limit for a single card source code */
  maxCardBytes: 256 * 1024,
  /** How often project card source code is re-listed */
  cardListMs: 3_000,
  /** Limit for attachment text inlined into the prompt */
  inlineTextBytes: 64 * 1024,
});

/** Message to the model when run assets are not enabled: do not retry, tell it where media comes from */
export const RUN_ASSETS_OFF_TEXT = 'This cloud version cannot let the Agent add files to the media library (run assets is off); retrying will not help, do not retry.' +
  ' Images, videos and audio the user sent in the chat were already added to the media library when the page sent them; find that item with list_media and use it directly; ' +
  'for other files, tell the user to click "Import media" in the media library on the left to add them.';

export class HostedToolError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

/* ---------------------------------------------------------------- Media types and metadata */

const EXT_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image', svg: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', m4v: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', flac: 'audio', opus: 'audio',
};
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
};
const KIND_LABEL = { video: 'Video', image: 'Image', audio: 'audio' };

export const extOf = (name) => (/\.([A-Za-z0-9]{1,5})$/.exec(String(name ?? ''))?.[1] ?? '').toLowerCase();
export const kindOfName = (name) => EXT_KIND[extOf(name)] ?? null;

/**
 * Errors considered "temporarily unresponsive" when storing into the library; only these are
 * retried (listed by error code, not generalized by status code):
 * Unable to connect or connection dropped midway (to asset service, to document service), asset
 * service or document service still reconciling. Other 503s are useless to retry and will just fail
 * again after waiting an extra round:
 * Task already stopped (`project-assets-closed`, `run-assets-unconfigured`), configuration or file
 * itself invalid (`project-assets-workspace-unconfigured`, `project-assets-unconfigured`), states
 * where asset service awaits manual intervention (`asset-run-recovery-pending`), working directory quota.
 */
export const RUN_ASSET_TRANSIENT_CODES = Object.freeze(['run-asset-unavailable', 'run-client-unavailable', 'run-authority-unavailable',
  'asset-run-not-ready', 'asset-run-head-pending', 'asset-not-ready', 'asset-run-unavailable', 'run-assets-unavailable',
  'doc-agent-unavailable', 'account-event-gap']);

/**
 * Retries when storing bytes into the project media library in account mode. The request id
 * **is generated only once for the entire import**: the import id is derived from it, and the asset
 * service stores staged chunks by import id; retrying with the same id resumes uploading beyond
 * already received chunks, whereas changing the id each time opens another uncollected staging
 * directory on the asset service.
 * @param {(requestId: string) => Promise<any>} importOnce Perform one import (source must be reopened each time)
 */
export async function runAssetImportWithRetry(importOnce, { attempts = 3, backoffMs = 500, onRetry = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const requestId = `import-${randomUUID()}`;
  for (let attempt = 1; ; attempt += 1) {
    try { return await importOnce(requestId); }
    catch (err) {
      if (attempt >= attempts || err?.workspace || !RUN_ASSET_TRANSIENT_CODES.includes(err?.code)) throw err;
      onRetry({ code: err?.code ?? 'unavailable', attempt });
      await sleep(backoffMs * attempt);
    }
  }
}

/**
 * Keep only safe characters in the filename (filename entering the workspace; original name
 * stored separately in the response for the model)
 */
export function safeName(name, fallback = 'file') {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.normalize('NFC').replace(/[\0-\x1f<>:"|?*\\/]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').slice(0, 96);
  return cleaned || fallback;
}

/** Read file header to determine image dimensions (PNG / JPEG / GIF / WebP); returns {} if not recognized */
export function imageSize(buf) {
  try {
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.length >= 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const tag = buf.toString('latin1', 12, 16);
      if (tag === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (tag === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (tag === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* Incomplete file header */ }
  return {};
}

/**
 * WAV duration (seconds); `totalSize` is total file size in bytes (provided when only the header
 * was read). Returns undefined if not WAV or unreadable
 */
export function wavDuration(buf, totalSize = buf.length) {
  try {
    if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return undefined;
    let i = 12;
    let byteRate = 0;
    while (i + 8 <= buf.length) {
      const id = buf.toString('latin1', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (id === 'fmt ') byteRate = buf.readUInt32LE(i + 16);
      if (id === 'data') return byteRate > 0 ? Math.min(size, Math.max(0, totalSize - i - 8)) / byteRate : undefined;
      i += 8 + size + (size % 2);
    }
  } catch { /* Incomplete file header */ }
  return undefined;
}

/** Find ffprobe (in the same directory as ffmpeg, or on PATH); returns null if not found. Results cached per process. */
let ffprobeCache;
export function findFfprobe() {
  if (ffprobeCache !== undefined) return ffprobeCache;
  const cands = [];
  if (process.env.PROMPTCUT_FFPROBE) cands.push(process.env.PROMPTCUT_FFPROBE);
  if (process.env.PROMPTCUT_FFMPEG) cands.push(path.join(path.dirname(process.env.PROMPTCUT_FFMPEG), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
  cands.push('ffprobe');
  ffprobeCache = null;
  for (const cand of cands) {
    try {
      const r = spawnSync(cand, ['-version'], { timeout: 5000, windowsHide: true });
      if (r.status === 0 && !r.error) { ffprobeCache = cand; break; }
    } catch { /* Next */ }
  }
  return ffprobeCache;
}

/** Use ffprobe to read duration and dimensions (subprocess launched via workspace: working directory and environment variables tightened). */
function ffprobeMeta(workspace, abs) {
  const bin = findFfprobe();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = workspace.spawn(bin, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', abs], { timeoutMs: 20_000 });
    } catch { return resolve(null); }
    child.stdout.on('data', (d) => { out += d; if (out.length > 1_000_000) child.kill(); });
    child.once('error', () => resolve(null));
    child.once('exit', () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
        const d = Number(j.format?.duration);
        resolve({ duration: Number.isFinite(d) && d > 0 ? d : undefined, width: v?.width || undefined, height: v?.height || undefined });
      } catch { resolve(null); }
    });
  });
}

function sha256File(abs) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(abs).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/* ---------------------------------------------------------------- Host voiceover configuration */

/** Where host voiceover configuration is stored (same directory and same disk encryption as model configuration; written by `server/agent-service/import-key.mjs --service voice`). */
export function voiceConfigPaths(dataDir) {
  const dir = path.join(dataDir, 'config');
  return { file: path.join(dir, 'voice.json'), keyFile: path.join(dir, 'keys', 'voice.key') };
}

/**
 * Read host voiceover configuration; returns null if not configured. Returned object shape is
 * identical to desktop app `readVoiceConfig()` (`apiKey` is plaintext, used only in-process).
 * Address, provider, and token are read via `readServiceKey(dataDir, 'voice')` in
 * `server/agent-service/service-keys.mjs` (the copy imported from encrypted distribution, without
 * creating a separate storage mechanism); if `voice.json` also specifies default voice, speech
 * rate, and registered voices for each provider, fetch them together following desktop app rules.
 */
export async function readHostedVoiceConfig(dataDir) {
  if (!dataDir) return null;
  const { file } = voiceConfigPaths(dataDir);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const { normalizeVoiceConfig } = await import(new URL('../../voice/voice-config.mjs', import.meta.url).href);
  // The actual implementation of service keys is on the closed-source side, retrieved from the Agent
  // extensions table (`./extensions.mjs`, the loading point on the allowlist).
  // Community edition does not have that table → no such entry → returns null: host voiceover
  // configuration only exists on the hosted side in the first place.
  const keys = findAgentExtension('service-keys');
  if (!keys || typeof keys.readServiceKey !== 'function') return null;
  const key = keys.readServiceKey(dataDir, 'voice');
  const cfg = normalizeVoiceConfig({ ...raw, baseUrl: key.baseUrl ?? raw.baseUrl, provider: key.provider ?? raw.provider });
  return { ...cfg, effectiveBaseUrl: cfg.baseUrl, apiKey: key.apiKey ?? '' };
}

/* ---------------------------------------------------------------- Tools */

/**
 * Process-level instance (shared across instances).
 * @param {object} o
 * @param {string} o.root Repository root directory (read built-in card source, card authoring guide)
 * @param {(id: string) => Promise<any>} o.loadModule Vite's `ssrLoadModule` (used to load card
 *   checks when Node cannot directly load TypeScript)
 * @param {ReturnType<import('./workspace.mjs').createWorkspaces>} o.workspaces
 * @param {ReturnType<import('./egress.mjs').createEgressGate>} o.egress
 * @param {string | null} o.assetBase Address of local asset service (`http://127.0.0.1:<port>`);
 *   when not configured, media import and voiceover storage cannot be performed
 * @param {() => Promise<object | null>} o.voiceConfig Host voiceover configuration
 * @param {(row: object) => void} o.recordService Record one row of external service usage
 * @param {object | null} [o.collect] Collection tool on node (`readCollectConfig` in
 *   `hosted-collect.mjs`; determined by deployment, null if absent)
 */
export function createHostedTools({
  root,
  loadModule = null,
  workspaces,
  egress,
  assetBase = null,
  voiceConfig = async () => null,
  recordService = () => {},
  collect: collectConfig = null,
  fetchImpl = globalThis.fetch,
  limits: limitsIn = {},
  log = () => {},
} = {}) {
  const limits = { ...HOSTED_TOOL_DEFAULTS, ...limitsIn };
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect tools */ } };

  /** Web collection: process-level instance (concurrent download count is process-wide) */
  const collector = createCollect({ config: collectConfig, egress, limits: limitsIn.collect ?? {}, log });

  /** Sound effect synthesis only runs one at a time across the entire process */
  const soundSlot = createSlot();
  /** Same for loudness measurement (ffmpeg subprocess) */
  const measureSlot = createSlot();

  /** Card translation, review, syntax check: pure functions loaded via `ssr-host.mjs` seam (same copy used by desktop app card creation) */
  const cardLib = () => loadCardLib(loadModule);

  /**
   * Tool context for a chat.
   * @param {object} c
   * @param {{ projectId: string, userId: string, username?: string }} c.identity
   * @param {string} c.ownerKey
   * @param {string} c.conversationId
   * @param {() => object} c.side That set from `agent-side.mjs` (executor, connection)
   * @param {() => Promise<object>} c.host `ssr-host.mjs`
   * @param {() => { online: boolean, t: number }} c.pageState Whether sender is online, and playhead
   *   when message was sent
   * @param {() => string | null} c.runId
   * @param {{ cards: object }} c.shared Shared across chats in this instance (project × member):
   *   card source table of project (`newSharedState()`)
   * @param {() => (Function | null)} [c.look] Function for this project to query local render service
   *   (viewing video path); returns null if node has no endpoint configured
   * @param {{ authorizeWrite(): Promise<any>, import(source, o): Promise<any>, openRead(mediaId, o?): Promise<any> }} [c.runAssets]
   *   "Project assets" for this task in account mode (`project-assets.mjs`, using task authorization,
   *   without borrowing member ticket). When provided, storing into library and reading by media both
   *   go through it, no longer requesting member's media ticket from document service (task data
   *   connection cannot obtain such tickets)
   * @param {() => (null | { download: Function, login: Function, loginCheck: Function })} [c.collectDelegate]
   *   Collection delegation hook for this round in account mode (`forRun(context)` in
   *   `collect-bridge.mjs`): when provided, sites requiring login first try downloading via
   *   sender's computer; `user_interface_collect_login` and `collect_login_check` also go through it;
   *   when not provided, collection behavior is identical to before, and these two login tools are
   *   not here
   */
  function forConversation(c) {
    const { identity, conversationId } = c;
    const agentKey = conversationId;
    const exec = () => c.side().executor;
    const workspace = () => workspaces.open({ projectId: identity.projectId, ownerKey: c.ownerKey, conversationId });

    /* ---------- Document service ---------- */

    async function docRequest(message, okTypes) {
      const reply = await exec().request(agentKey, message, (m) => okTypes.includes(m.type) || m.type === 'error');
      if (reply.type === 'error') {
        const reason = reply.reason ?? 'error';
        throw new HostedToolError(reason === 'forbidden'
          ? 'The document service rejected this operation: you do not have this permission in this project.'
          : `The document service did not accept this operation (${reason})${reply.detail ? `:${reply.detail}` : ''}`, { code: reason });
      }
      return reply;
    }

    /* ---------- Asset service ---------- */

    function assetClient() {
      if (!assetBase) throw new HostedToolError('This cloud node has no asset service address configured, so the Cloud Agent cannot store files for now. Contact the host.', { code: 'no-asset-service' });
      let cached = null;
      return createAssetClient({
        base: `${assetBase.replace(/\/+$/, '')}/api/asset`,
        fetch: fetchImpl,
        // Media ticket: requested on demand via this chat's connection (permissions do not exceed the
        // member; read-only members cannot get read-write tickets, document service returns forbidden)
        ticket: async (opts) => {
          if (cached && !opts?.refresh && cached.exp - Date.now() > 20_000) return cached.ticket;
          const reply = await docRequest({ type: 'auth.ticket', kind: 'asset', access: 'rw' }, ['auth.ticket.ok']);
          cached = { ticket: reply.ticket, exp: Number(reply.exp) < 1e12 ? Number(reply.exp) * 1000 : Number(reply.exp) };
          return cached.ticket;
        },
      });
    }

    /**
     * Before taking action, confirm this member can write to media (read-only members cannot obtain
     * read-write media tickets): download and synthesis (costing money) are both queued after it,
     * preventing read-only member chats from wasting bandwidth and wasting the host's money.
     */
    async function ensureCanWrite() {
      if (c.runAssets) {
        try { await c.runAssets.authorizeWrite(); }
        catch { throw new HostedToolError('This task cannot write media to the project right now (the task was stopped, or the initiator has no write permission in this project).', { code: 'forbidden' }); }
        return;
      }
      if (!assetBase) throw new HostedToolError('This cloud node has no asset service address configured, so the Cloud Agent cannot store files for now. Contact the host.', { code: 'no-asset-service' });
      try {
        await docRequest({ type: 'auth.ticket', kind: 'asset', access: 'rw' }, ['auth.ticket.ok']);
      } catch (err) {
        if (err?.code === 'forbidden') throw new HostedToolError('You only have read-only permission in this project, so the Cloud Agent cannot write media to the project for you.', { code: 'forbidden' });
        throw err;
      }
    }

    /** Account mode: store bytes into this project's media library with this task's authorization. Stored only; registering into the project is the caller's next step. */
    async function runAssetImport(sourceOf, { name, kind }, origin = {}) {
      try {
        // Temporary failure of asset service or document service to respond is not a failure: retry after
        // a short delay, up to three times, continuing transfer with same request id (see runAssetImportWithRetry)
        const out = await runAssetImportWithRetry((requestId) => c.runAssets.import(sourceOf(), { name, kind, requestId }, origin),
          { onRetry: (row) => say('agent.run-assets.retry', row) });
        return { hash: out.assetRef.hash, size: out.assetRef.size };
      } catch (err) {
        if (err?.status === 403 || err?.status === 401 || ['run-access-denied', 'run-revoked', 'run-resource-fenced'].includes(err?.code)) {
          throw new HostedToolError('The asset service rejected this write: this task cannot write media to the project right now (the task was stopped, or the initiator has no write permission).', { code: 'forbidden' });
        }
        if (err?.workspace) throw new HostedToolError(`Media was not stored: ${err.message}`, { code: err.code ?? 'quota' });
        if (err?.code === 'run-assets-unconfigured') throw new HostedToolError(RUN_ASSETS_OFF_TEXT, { code: 'run-assets-unconfigured' });
        throw err;
      }
    }

    /** Send a file from workspace into asset service (`media` namespace); returns `{ hash, ext, bytes }` */
    async function ingest(rel, kindHint = null) {
      const ws = workspace();
      const abs = ws.resolve(rel);
      const st = ws.stat(rel);
      if (!st) throw new HostedToolError('This file is not in the working directory.', { code: 'not-found' });
      if (st.size === 0) throw new HostedToolError('This file is empty.');
      const hash = await sha256File(abs);
      const ext = extOf(rel);
      if (c.runAssets) {
        const kind = kindHint ?? kindOfName(rel);
        if (!kind || !ext) throw new HostedToolError('Cannot recognize this file\'s type; use a video, audio or image file.');
        // Source is already a file in working directory (verified against quota when incoming, also counted
        // in usage): temporary copy written to disk during import is not counted against quota a second time
        const stored = await runAssetImport(() => fs.createReadStream(abs), { name: `import.${ext}`, kind }, { inWorkspace: true, size: st.size });
        if (stored.hash !== hash || stored.size !== st.size) throw new HostedToolError('The stored media does not match the original file, so it was not registered.');
        return { hash, ext, bytes: st.size };
      }
      try {
        await assetClient().putFile('media', abs, { hash, ext });
      } catch (err) {
        if (err?.code === 'forbidden' || err?.status === 403 || err?.status === 401) {
          throw new HostedToolError('The asset service rejected this write: you only have read-only permission in this project, so the Cloud Agent cannot import media for you.', { code: 'forbidden' });
        }
        throw err;
      }
      return { hash, ext, bytes: st.size };
    }

    /** Read kind and metadata of a workspace file */
    async function probe(rel, kind) {
      const ws = workspace();
      const abs = ws.resolve(rel);
      if (kind === 'image') {
        const fd = fs.openSync(abs, 'r');
        try {
          const head = Buffer.alloc(Math.min(256 * 1024, ws.stat(rel)?.size ?? 0));
          fs.readSync(fd, head, 0, head.length, 0);
          return imageSize(head);
        } finally { fs.closeSync(fd); }
      }
      const viaProbe = await ffprobeMeta(ws, abs);
      if (viaProbe) return viaProbe;
      if (extOf(rel) === 'wav') {
        const fd = fs.openSync(abs, 'r');
        try {
          const size = ws.stat(rel)?.size ?? 0;
          const head = Buffer.alloc(Math.min(1024 * 1024, size));
          fs.readSync(fd, head, 0, head.length, 0);
          const d = wavDuration(head, size);
          return d === undefined ? { probeMissing: true } : { duration: d };
        } finally { fs.closeSync(fd); }
      }
      return { probeMissing: true };
    }

    /** Register media into project after storing into library (optional: place on timeline); returns `{ media, clip }` */
    async function registerMedia(track, { rel, name, kind, place = null }) {
      const [up, meta] = [await ingest(rel, kind), await probe(rel, kind)];
      let media = null;
      let clip = null;
      await exec().mutate('import_media', agentKey, track, (host) => {
        media = host.addMedia({
          kind, name,
          url: `/@media/${up.hash}`, hash: up.hash, ...(up.ext ? { ext: up.ext } : {}), size: up.bytes,
          tiers: { original: up.hash },
          ...(meta.duration !== undefined ? { duration: meta.duration } : {}),
          ...(meta.width ? { width: meta.width } : {}), ...(meta.height ? { height: meta.height } : {}),
        });
        if (place) {
          const start = typeof place.start === 'number' ? Math.max(0, place.start) : (place.atEnd ? host.contentEnd() : 0);
          clip = host.addMediaClip(media.id, start, place.trackId ? { trackId: place.trackId } : {});
          if (!clip && place.required) throw new HostedToolError(`Media was stored, but placing it on the timeline failed: is trackId wrong?`);
        }
        return { ok: true };
      });
      return { media, clip, meta };
    }

    /* ---------- Import media ---------- */

    /**
     * Address given by model → file in workspace. Three kinds:
     *   - `work:<relative-path>`: file in this chat's workspace (what is given in attachment manifest);
     *   - `/@pcwork/<chat-id>/<filename>`: desktop app attachment address format, only recognizes this
     *     chat's own, pointing under `attachments/`;
     *   - `http(s)://…`: downloaded via egress gate under `downloads/`.
     */
    async function materialize(url, nameIn) {
      const ws = workspace();
      if (typeof url !== 'string' || !url) {
        throw new HostedToolError('The address (url) of the attachment to upload is required. For an attachment, use the address in the manifest at the end of the user\'s message (like work:attachments/<filename>); for a file on the web, pass the http(s) address directly.');
      }
      if (url.startsWith('work:')) {
        const rel = url.slice(5);
        if (!ws.exists(rel)) throw new HostedToolError(`${rel} is not in the working directory. The attachment address is whatever the manifest at the end of the user's message says.`, { code: 'not-found' });
        return { rel, name: nameIn || rel.split('/').pop() };
      }
      const pc = /^\/@pcwork\/([^/]+)\/([^/?#]+)$/.exec(url);
      if (pc) {
        if (decodeURIComponent(pc[1]) !== conversationId) throw new HostedToolError('This attachment does not belong to this chat.', { code: 'not-found' });
        const rel = `attachments/${decodeURIComponent(pc[2])}`;
        if (!ws.exists(rel)) throw new HostedToolError('This attachment is gone; ask the user to add it again.', { code: 'not-found' });
        return { rel, name: nameIn || decodeURIComponent(pc[2]) };
      }
      if (!/^https?:\/\//i.test(url)) throw new HostedToolError('The address must be one from the attachment manifest, or an http(s) address.');
      let name = safeName(nameIn || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download'), 'download');
      const tmpRel = `downloads/${Date.now().toString(36)}-${name}`;
      const writer = ws.writer(tmpRel);
      let res;
      try {
        res = await egress.request(url, { maxBytes: limits.maxImportBytes, timeoutMs: limits.downloadMs, onChunk: (chunk) => writer.write(chunk) });
      } catch (err) {
        writer.abort();
        if (err?.egress) throw new HostedToolError(`Cannot fetch this address: ${err.message}`, { code: `egress-${err.code}` });
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        writer.abort();
        throw new HostedToolError(`Failed to fetch the file (HTTP ${res.status}); the address may be wrong or expired.`);
      }
      writer.end();
      // Direct links often lack an extension: supply one based on response type
      let rel = tmpRel;
      const mimeExt = MIME_EXT[String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()];
      if (mimeExt && !kindOfName(name)) {
        name = `${name}.${mimeExt}`;
        rel = `${tmpRel}.${mimeExt}`;
        fs.renameSync(ws.resolve(tmpRel), ws.resolve(rel));
      }
      return { rel, name, downloaded: true };
    }

    async function importMedia(args, track) {
      await ensureCanWrite();
      const got = await materialize(args?.url, typeof args?.name === 'string' ? args.name : '');
      const kind = kindOfName(got.rel) ?? kindOfName(got.name);
      if (!kind) {
        if (got.downloaded) workspace().remove(got.rel);
        throw new HostedToolError(`Cannot recognize the type of file "${got.name}"; use a video, audio or image file.`);
      }
      const ps = c.pageState();
      const { media, clip, meta } = await registerMedia(track, {
        rel: got.rel, name: got.name, kind,
        // Same as desktop app: video is placed directly on video track after import. Placed at sender's
        // playhead when sender is online, appended after existing content when offline
        place: kind === 'video' ? (ps.online ? { start: ps.t } : { atEnd: true }) : null,
      });
      if (got.downloaded) workspace().remove(got.rel);
      const base = { mediaId: media.id, name: got.name, kind, kindLabel: KIND_LABEL[kind], cardUrl: media.url };
      const missing = meta.probeMissing ? ' This cloud node has no ffprobe, so duration and dimensions were not read; provide duration yourself when placing it on the timeline.' : '';
      if (kind === 'image') {
        return { ...base, width: media.width, height: media.height, hint: `The image was added to the "Images" media library (not placed on the timeline). To use this image in card parameters, fill in cardUrl.` };
      }
      if (kind === 'audio') return { ...base, duration: media.duration, hint: `The audio was added to the media library (not placed on the timeline). ${missing}` };
      return {
        ...base, duration: media.duration, width: media.width, height: media.height, ...(clip ? { clipId: clip.id } : {}),
        hint: `Added to the media library${clip ? ' and placed on the video track' : ''}. ${missing}`,
      };
    }

    /* ---------- Voiceover ---------- */

    async function voiceList() {
      const cfg = await voiceConfig();
      const presets = await import(new URL('../../voice/presets.mjs', import.meta.url).href);
      const set = !!cfg?.apiKey && !!cfg?.effectiveBaseUrl;
      return {
        provider: cfg?.provider ?? presets.PROVIDERS[0],
        apiKeySet: set,
        defaults: cfg ? { minimax: cfg.minimax, kling: cfg.kling, vidu: cfg.vidu } : {},
        systemVoices: presets.SYSTEM_VOICES,
        customVoices: (cfg?.customVoices ?? []).map((v) => ({ provider: v.provider, voiceId: v.voiceId, name: v.name, kind: v.kind, note: v.note })),
        textLimits: presets.TEXT_LIMITS,
        hint: set
          ? 'For voice_generate, pick voiceId from systemVoices / customVoices (customVoices must be paired with provider). Cloud voiceover uses the host\'s configuration.'
          : 'The host has not configured a voiceover service for the Cloud Agent, so voice_generate will fail. Tell the user to contact the host, or to make the voiceover in PromptCut on their computer.',
      };
    }

    async function voiceGenerate(args, track) {
      if (!args?.text || !String(args.text).trim()) throw new HostedToolError('text must not be empty');
      const cfg = await voiceConfig();
      if (!cfg?.apiKey || !cfg?.effectiveBaseUrl) {
        throw new HostedToolError('The host has not configured a voiceover service for the Cloud Agent. Tell the user to contact the host, or to make the voiceover in PromptCut on their computer.', { code: 'no-voice-config' });
      }
      await ensureCanWrite();
      const { generateVoice } = await import(new URL('../../voice/generate.mjs', import.meta.url).href);
      const ws = workspace();
      const outDir = path.dirname(ws.resolve('voice/x'));
      const t0 = Date.now();
      const row = (out, ok) => recordService({
        t: Date.now(), projectId: identity.projectId, userId: identity.userId, username: identity.username ?? '',
        conversationId, runId: c.runId() ?? '', kind: 'service', service: 'voice',
        vendor: out?.provider ?? String(args.provider ?? cfg.provider ?? ''), model: out?.model ?? '',
        units: out?.chars ?? [...String(args.text)].length, unit: 'chars', ok, ms: Date.now() - t0,
      });
      let out;
      try {
        out = await generateVoice({
          cfg,
          args: { text: args.text, provider: args.provider, voiceId: args.voiceId, speed: args.speed, emotion: args.emotion, name: args.name },
          outDir,
          fetch: fetchImpl,
        });
      } catch (err) {
        // Invalid parameters (voice not in list, speech rate out of bounds) send no request, usage not
        // recorded; requests that failed after being sent are still recorded (provider may have already billed)
        if (err?.name !== 'VoiceError' || /HTTP|gateway|timeout|timed out/.test(String(err?.message))) row(null, false);
        throw new HostedToolError(String(err?.message ?? err).slice(0, 300));
      }
      row(out, true);
      const rel = `voice/${out.name}`;
      // Generated files count toward workspace total (written to disk by generateVoice itself): delete
      // and report error if exceeded
      const usage = ws.usage();
      if (usage.bytes > workspaces.limits.maxConversationBytes) { ws.remove(rel); throw new HostedToolError('The working directory of this chat is full, so the speech was not saved.'); }
      const place = typeof args.start === 'number' ? { start: args.start, trackId: args.trackId, required: true } : null;
      const { media, clip } = await registerMedia(track, { rel, name: out.name, kind: 'audio', place });
      ws.remove(rel);
      return {
        mediaId: media.id, name: out.name, duration: media.duration, ...(clip ? { clipId: clip.id } : {}),
        provider: out.provider, model: out.model, voiceId: out.voiceId, chars: out.chars,
        hint: clip
          ? 'Added to the media library and placed on the timeline. The next clip\'s start follows this clip\'s start + duration.'
          : 'Added to the media library (not placed on the timeline). To put it on the timeline, pass start and generate again.',
      };
    }

    /* ---------- Card source (content store `card-source`) ---------- */

    const CARD_KIND = 'card-source';
    const USER_PREFIX = 'src/cards/user/';
    const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    /** Card source in this project's content store: key → { hash, body? }; definition parsed from entry file. Shared across chats in an instance */
    const cards = c.shared.cards;

    async function refreshCards(force = false) {
      if (!force && Date.now() - cards.at < limits.cardListMs) return cards;
      cards.pending ??= (async () => {
        try {
          const listing = await docRequest({ type: 'content.list', kind: CARD_KIND, prefix: 'src/' }, ['content.listing']);
          const next = new Map();
          for (const it of listing.items ?? []) {
            const prev = cards.items.get(it.key);
            // `rev`: version of this entry in content store (passed to render service when viewing video,
            // which waits for isolated worker process to install this card to at least this version)
            if (prev && prev.hash === it.hash && typeof prev.body === 'string') { next.set(it.key, { ...prev, rev: it.rev ?? prev.rev ?? null }); continue; }
            const item = await docRequest({ type: 'content.get', kind: CARD_KIND, key: it.key }, ['content.item']);
            if (item.missing || typeof item.body !== 'string') continue;
            next.set(it.key, { hash: it.hash, rev: it.rev ?? null, body: item.body });
          }
          cards.items = next;
          const host = await c.host();
          const parsed = [];
          for (const [key, v] of next) {
            if (!/^src\/cards\/user\/[^/]+\.tsx$/.test(key)) continue;
            try { for (const p of host.parseCard(v.body, { key, files: (k) => next.get(k)?.body ?? null })) parsed.push(p); } catch { /* Do not register if unparseable */ }
          }
          cards.parsed = parsed;
          cards.at = Date.now();
        } catch (err) {
          // When unreadable (connection just dropped; can read even with read-only permissions; rejection
          // means server has not enabled this category yet), keep held table unchanged
          say('agent.cards.refresh-failed', { projectId: identity.projectId, message: String(err?.message ?? err).slice(0, 120) });
          cards.at = Date.now();
        } finally {
          cards.pending = null;
        }
        return cards;
      })();
      return cards.pending;
    }

    const repoFile = (rel) => {
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(path.resolve(root, 'src') + path.sep)) return null;
      try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
    };
    /** Effective source of a file right now: use from project content store if present, otherwise the copy in checkout */
    const effective = (rel) => cards.items.get(rel)?.body ?? repoFile(rel);

    /** Definition file of this card and files used along the way */
    async function closureOf(id) {
      const lib = await cardLib();
      const userKey = `${USER_PREFIX}${id}.tsx`;
      if (cards.items.has(userKey)) {
        const host = await c.host();
        const seen = new Set([userKey]);
        const queue = [userKey];
        while (queue.length && seen.size < 60) {
          const key = queue.shift();
          const src = effective(key);
          if (typeof src !== 'string') continue;
          for (const dep of host.cardImports(src, key)) {
            if (!seen.has(dep) && lib.isEditablePath(dep) && typeof effective(dep) === 'string') { seen.add(dep); queue.push(dep); }
          }
        }
        return { defFile: userKey, closure: [...seen], builtin: false };
      }
      const defFile = lib.findCardFile(root, id);
      if (!defFile) return null;
      return { defFile, closure: lib.importClosure(root, defFile), builtin: !defFile.startsWith(USER_PREFIX) };
    }

    async function putCard(key, source) {
      if (Buffer.byteLength(source, 'utf8') > limits.maxCardBytes) throw new HostedToolError(`The source is over ${Math.round(limits.maxCardBytes / 1024)}KB, which is too large.`);
      // The precheck performed when render node installs cards (illegal constructs like out-of-bounds
      // @import, @plugin, import.meta.glob will be rejected) is reported early here: cards that cannot pass
      // will fail to render even if stored into the library.
      // The actual implementation of the precheck is on the closed-source side, retrieved from Agent
      // extensions table. Community edition does not have that table → skip this precheck,
      // and it was originally about "whether cloud render nodes can install it"; community edition has no
      // cloud render nodes.
      const gate = findAgentExtension('source-gate');
      if (gate && typeof gate.checkSyncedSource === 'function') {
        const pre = gate.checkSyncedSource(key, source);
        if (!pre.ok) throw new HostedToolError(`This source cannot be installed on the cloud render node and was not saved:\n${pre.errors.join('\n')}`, { errors: pre.errors });
      }
      const stored = await docRequest({ type: 'content.put', kind: CARD_KIND, key, body: source, session: `agent:${agentKey}`.slice(0, 128) }, ['content.stored']);
      cards.items.set(key, { hash: stored.hash, rev: stored.rev ?? null, body: source });
      await refreshCards(true);
    }

    async function cardGuide() {
      const lib = await cardLib();
      const guide = fs.readFileSync(path.join(SERVER_DIR, 'card-authoring-guide.md'), 'utf8');
      return `${guide}\n${lib.renderCatalog()}`;
    }

    async function getCardSource(args) {
      const id = String(args?.cardId ?? args?.id ?? '');
      if (!ID_RE.test(id)) throw new HostedToolError(`Card id "${id}" is invalid.`);
      await refreshCards();
      const lib = await cardLib();
      const found = await closureOf(id);
      if (!found) {
        const cat = lib.readCatalogSource(id);
        if (cat) {
          return {
            ok: true, id, file: cat.entry.file, source: cat.source, lines: cat.source.split('\n').length,
            catalog: true, tier: cat.entry.tier, blockers: cat.entry.blockers, props: cat.entry.props,
            hint: `This is raw source from the Magic UI catalog (MIT), not a card yet. Wrap it as a CardDef, write "Source: https://magicui.design/docs/components/${cat.name}" and MIT in the file header, then create the card with create_card using id "${id}". ${cat.entry.blockers.length ? 'Handle this first:' + cat.entry.blockers.join(', ') : ''}`,
          };
        }
        throw new HostedToolError(`Cannot find the source of card "${id}". Confirm the id with list_cards first; for components in the Magic UI catalog that have not been moved over yet, read them with mu-<name> (see the catalog at the end of card_authoring_guide).`);
      }
      const target = typeof args?.file === 'string' && args.file ? args.file : found.defFile;
      if (!found.closure.includes(target)) throw new HostedToolError(`"${target}" is not in the source files of card ${id}. Readable files: ${found.closure.join(', ')}`);
      const source = effective(target);
      if (typeof source !== 'string') throw new HostedToolError(`Cannot read "${target}".`);
      return {
        ok: true, id, file: target, source, lines: source.split('\n').length, builtin: found.builtin,
        files: found.closure.map((f) => ({ file: f, ...(cards.items.has(f) ? { inProject: true } : {}) })),
        ...(found.builtin ? { hint: 'This is a built-in card. Use edit_card to change it: the changes only go into this project (stored in the project\'s content store) and do not affect other projects.' } : {}),
      };
    }

    async function createCard(args) {
      const id = args?.id;
      const source = args?.source;
      if (typeof id !== 'string' || typeof source !== 'string') throw new HostedToolError('id and source must both be strings');
      if (!ID_RE.test(id)) throw new HostedToolError(`Card id "${id}" is invalid: it may only contain lowercase letters, digits and hyphens, and must start with a letter.`);
      await refreshCards(true);
      const lib = await cardLib();
      const host = await c.host();
      const key = `${USER_PREFIX}${id}.tsx`;
      const already = cards.items.has(key);
      if (already && args.overwrite !== true) {
        throw new HostedToolError(`${key} already exists. To change it, read the source back with get_card_source, then change that spot with edit_card; pass overwrite: true only if you really need to tear down and redo the whole card.`);
      }
      if (!already && host.cardIds().includes(id)) throw new HostedToolError(`Card id "${id}" duplicates an existing built-in card. Change the id and try again.`);
      const translated = lib.translateCardSource(source);
      const finalSource = translated.source;
      const existing = already ? [] : [...new Set([...host.cardIds(), ...cards.parsed.map((p) => p.id)])];
      const check = lib.checkCardSource(id, finalSource, existing, { vendored: translated.rewrites.length > 0, mode: 'author', before: '' });
      if (!check.ok) {
        throw new HostedToolError(check.errors.join('\n'), { errors: check.errors, findings: check.findings ?? [], rewrites: translated.rewrites });
      }
      const declared = new Set([...finalSource.matchAll(/\bkey:\s*["']([^"']+)["']/g)].map((m) => m[1]));
      const suggestedControls = lib.suggestControls(finalSource).filter((s) => !declared.has(s.key));
      await putCard(key, finalSource);
      const known = cards.parsed.some((p) => p.id === id);
      say('agent.card.create', { projectId: identity.projectId, overwritten: already });
      return {
        ok: true, id, file: key, overwritten: already, rewrites: translated.rewrites, suggestedControls,
        ...(check.findings?.length ? { findings: check.findings } : {}),
        source: finalSource, lines: finalSource.split('\n').length,
        hint: `Saved to this project's card library; all members will receive it. To change it again, use edit_card for a partial replacement; do not rewrite the whole thing with create_card. ${known ? '' : ' Note: the cloud could not statically read this card\'s parameter table from the source (id, name, defaults and controls must be written as literals), so add_clip cannot recognize it for now. Change them into literals.'}`,
      };
    }

    async function editCard(args) {
      const { file, find, replace, replaceAll } = args ?? {};
      const id = args?.cardId ?? args?.id;
      if (typeof id !== 'string' || typeof find !== 'string' || typeof replace !== 'string') throw new HostedToolError('cardId, find and replace must all be strings');
      if (!ID_RE.test(id)) throw new HostedToolError(`Card id "${id}" is invalid.`);
      await refreshCards(true);
      const lib = await cardLib();
      const found = await closureOf(id);
      if (!found) throw new HostedToolError(`Cannot find the source of card "${id}". Confirm the id and the editable files with get_card_source first.`);
      const target = typeof file === 'string' && file ? file : found.defFile;
      if (!found.closure.includes(target) || !lib.isEditablePath(target)) {
        throw new HostedToolError(`"${target}" is not a source file of card ${id} and cannot be changed. Editable files: ${found.closure.join(', ')}`);
      }
      const before = effective(target);
      if (typeof before !== 'string') throw new HostedToolError(`Cannot read "${target}".`);
      const patch = lib.applyCardPatch(before, find, replace, replaceAll === true);
      if (!patch.ok) throw new HostedToolError(patch.error);
      const isUserDef = target === found.defFile && found.defFile.startsWith(USER_PREFIX);
      const check = isUserDef ? lib.checkCardSource(id, patch.after, [], { mode: 'author', before }) : lib.checkSourceEdit(target, before, patch.after);
      if (!check.ok) throw new HostedToolError(check.errors.join('\n'), { errors: check.errors });
      await putCard(target, patch.after);
      say('agent.card.edit', { projectId: identity.projectId, builtin: found.builtin });
      return {
        ok: true, id, file: target, replaced: patch.replaced, source: patch.after, builtin: found.builtin,
        hint: found.builtin
          ? 'Rewritten. The changes are stored in this project\'s content store (only affecting this project), and all members will receive them.'
          : 'Rewritten. All members will receive it.',
      };
    }

    /* ---------- Sound effect synthesis (`hosted-sound.mjs`) ---------- */

    /** Write generated WAV into asset service (`media`, with member's own ticket) */
    const putWav = async (wav) => {
      if (c.runAssets) { const stored = await runAssetImport(() => wav, { name: 'sound.wav', kind: 'audio' }, { size: wav.length }); return { ...stored, uploaded: true }; }
      try {
        return await assetClient().put('media', wav, { ext: 'wav' });
      } catch (err) {
        if (err?.code === 'forbidden' || err?.status === 403 || err?.status === 401) {
          throw new HostedToolError('The asset service rejected this write: you only have read-only access in this project, so the Cloud Agent cannot generate audio for you.', { code: 'forbidden' });
        }
        throw err;
      }
    };
    const usageRow = (row) => recordService({
      t: Date.now(), projectId: identity.projectId, userId: identity.userId, username: identity.username ?? '',
      conversationId, runId: c.runId() ?? '', kind: 'service', ...row,
    });
    const sound = createSoundTools({
      state: c.shared.sound,
      slot: soundSlot,
      host: c.host,
      snapshot: () => exec().snapshot(agentKey),
      mutate: (track, apply) => exec().mutate('sound_generate', agentKey, track, apply),
      ensureCanWrite,
      put: putWav,
      record: usageRow,
      ToolError: HostedToolError,
    });

    /* ---------- Card audio (`hosted-card-audio.mjs`): card code only runs in render service worker processes ---------- */

    const cardAudio = createCardAudioTools({
      state: c.shared.cardAudio,
      look: () => (typeof c.look === 'function' ? c.look() : null),
      snapshot: () => exec().snapshot(agentKey),
      refreshCards: () => refreshCards(true),
      mutate: (track, apply) => exec().mutate('render_card_audio', agentKey, track, apply),
      ensureCanWrite,
      put: putWav,
      // Account mode has no "query existence by hash" check (task authorization only reads media
      // registered in project): treat as not present; re-saving identical bytes is idempotent
      has: (hash) => (c.runAssets ? false : assetClient().has('media', hash)),
      record: usageRow,
      ToolError: HostedToolError,
      limits: limits.cardAudio ?? {},
    });

    /* ---------- Measure loudness (`hosted-audio.mjs`) ---------- */

    /** Fetch an asset by hash with member's own read-only media ticket (local asset service address is configured by host, does not go through egress gate) */
    async function fetchAssetByHash(hash, onChunk, { timeoutMs }) {
      if (c.runAssets) {
        // Task authorization can only read media registered in project: first find the entry corresponding
        // to the hash in the project replica
        const { project } = await exec().snapshot(agentKey);
        const media = (project?.media ?? []).find((m) => m?.hash === hash || m?.tiers?.original === hash || String(m?.url ?? '').endsWith(`/${hash}`));
        if (!media?.id) return { status: 404 };
        let opened;
        try { opened = await c.runAssets.openRead(media.id); }
        catch (err) { return { status: err?.status === 404 || err?.code === 'asset-missing' ? 404 : err?.status === 401 || err?.status === 403 ? 403 : 502 }; }
        const timer = setTimeout(() => opened.stream.destroy(new Error('timeout')), timeoutMs);
        try { for await (const chunk of opened.stream) onChunk(chunk); await opened.closed; }
        finally { clearTimeout(timer); opened.stream.destroy(); }
        return { status: 200 };
      }
      if (!assetBase) throw new HostedToolError('This cloud node has no asset service address configured, so the Cloud Agent cannot read media for now. Contact the host.', { code: 'no-asset-service' });
      const reply = await docRequest({ type: 'auth.ticket', kind: 'asset', access: 'r' }, ['auth.ticket.ok']);
      const res = await fetchImpl(`${assetBase.replace(/\/+$/, '')}/api/asset/media/${hash}`, {
        headers: { Authorization: `Bearer ${reply.ticket}` }, signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status < 200 || res.status >= 300 || !res.body) { try { await res.body?.cancel(); } catch { /* Finished reading */ } return { status: res.status }; }
      for await (const chunk of res.body) onChunk(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      return { status: res.status };
    }
    const audio = createAudioTools({
      workspace, host: c.host, slot: measureSlot, fetchAsset: fetchAssetByHash, ToolError: HostedToolError,
      limits: limits.audio ?? {},
      ...(limits.audioTools ? { tools: limits.audioTools } : {}),
      // Read-only: compute "what to measure" on store holding project replica, produces no writes
      read: (apply) => exec().mutate('measure_audio', agentKey, {}, apply),
    });

    /* ---------- Web collection (`hosted-collect.mjs`): external programs only launch via restricted workspace subprocesses, egress only via egress gate proxy ---------- */

    const collect = collector.forConversation({
      state: c.shared.collect, workspace, ensureCanWrite, record: usageRow, ToolError: HostedToolError, conversationId,
      ...(typeof c.collectDelegate === 'function' ? { delegate: c.collectDelegate } : {}),
      // Downloads enter media library: same path as import_media (member's own media ticket, registered
      // on project replica; video placed on timeline as in desktop app)
      importFile: async (rel, name) => {
        const kind = kindOfName(rel) ?? kindOfName(name);
        if (!kind) throw new HostedToolError(`Cannot identify the type of file "${name}"`);
        const ps = c.pageState();
        const { media, clip } = await registerMedia({}, { rel, name, kind, place: kind === 'video' ? (ps.online ? { start: ps.t } : { atEnd: true }) : null });
        return { mediaId: media.id, kind, ...(clip ? { clipId: clip.id } : {}), duration: media.duration, width: media.width, height: media.height, bytes: media.size };
      },
    });

    const TOOLS = {
      collect_status: collect.collect_status,
      collect_install: collect.collect_install,
      collect_search: collect.collect_search,
      collect_probe: collect.collect_probe,
      collect_download: collect.collect_download,
      collect_job: collect.collect_job,
      collect_logout: collect.collect_logout,
      // Only present here when delegation hook is provided (account mode): without the hook, these two
      // still belong to "manipulating sender interface" category, answered by tool table using original wording
      ...(typeof c.collectDelegate === 'function' ? { user_interface_collect_login: collect.collect_login, collect_login_check: collect.collect_login_check } : {}),
      measure_audio: audio.measure_audio,
      render_card_audio: cardAudio.render_card_audio,
      cancel_card_audio: cardAudio.cancel_card_audio,
      sound_generate: sound.sound_generate,
      sound_status: sound.sound_status,
      sound_cancel: sound.sound_cancel,
      import_media: importMedia,
      voice_list: voiceList,
      voice_generate: voiceGenerate,
      card_authoring_guide: cardGuide,
      get_card_source: getCardSource,
      create_card: createCard,
      edit_card: editCard,
    };

    return {
      has: (tool) => Object.hasOwn(TOOLS, tool),
      /** Execute a tool implemented on the server. `track` is the event context for this call (persisted writes are recorded on it) */
      call(tool, args, track) {
        return TOOLS[tool](args ?? {}, track ?? {});
      },
      /** Called before entering lock: list card sources for this project (fetch body only if changed) */
      refreshCards,
      workspace,
    };
  }

  return {
    forConversation,
    /** State shared across chats in an instance (project × member) */
    newSharedState: () => ({ cards: { at: -Infinity, items: new Map(), parsed: [], pending: null }, sound: newSoundState(), cardAudio: newCardAudioState(), collect: newCollectState() }),
    /** Whether collection tools are installed on the node (reported by status endpoint) */
    collectInstalled: collector.available,
    /** For testing: clear ffprobe cache */
    _resetFfprobe() { ffprobeCache = undefined; },
  };
}

/* ---------------------------------------------------------------- Attachments */

const TEXT_EXT = new Set(['txt', 'md', 'srt', 'vtt', 'json', 'csv', 'ass', 'lrc']);

/**
 * Save an attachment sent from page into chat workspace (under `attachments/`). Returns
 * `{ name, url, size, kind, text? }`: `url` is address for model
 * (`work:attachments/<filename>`), not a disk path.
 * @param {ReturnType<ReturnType<typeof import('./workspace.mjs').createWorkspaces>['open']>} workspace
 * @param {string} nameIn File name reported by page
 * @param {AsyncIterable<Buffer>} stream
 */
export async function saveAttachment(workspace, nameIn, stream, { maxBytes = HOSTED_TOOL_DEFAULTS.maxImportBytes, inlineTextBytes = HOSTED_TOOL_DEFAULTS.inlineTextBytes } = {}) {
  const name = safeName(nameIn, 'attachment');
  let rel = `attachments/${name}`;
  for (let i = 1; workspace.exists(rel) && i < 100; i += 1) {
    const ext = extOf(name);
    rel = `attachments/${ext ? name.slice(0, -(ext.length + 1)) : name}-${i}${ext ? `.${ext}` : ''}`;
  }
  const writer = workspace.writer(rel);
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new HostedToolError('The attachment is too large.', { code: 'too-large' });
      writer.write(chunk);
    }
  } catch (err) {
    writer.abort();
    throw err;
  }
  writer.end();
  if (size === 0) { workspace.remove(rel); throw new HostedToolError('The attachment is empty.', { code: 'bad-request' }); }
  const ext = extOf(rel);
  const out = { name: rel.slice('attachments/'.length), url: `work:${rel}`, size, kind: kindOfName(rel) ?? (TEXT_EXT.has(ext) ? 'text' : 'file') };
  if (TEXT_EXT.has(ext) && size <= inlineTextBytes) {
    try { out.text = workspace.read(rel).toString('utf8'); } catch { /* Do not inline if unreadable */ }
  }
  return out;
}

/** Attachments on this message → snippet assembled into prompt (only recognizes files that actually exist in this chat's workspace; does not provide disk paths) */
export function attachmentsPrompt(workspace, attachments, { inlineTextBytes = HOSTED_TOOL_DEFAULTS.inlineTextBytes } = {}) {
  const lines = [];
  let inLibrary = 0;
  for (const a of Array.isArray(attachments) ? attachments.slice(0, 32) : []) {
    const url = typeof a?.url === 'string' ? a.url : '';
    if (!url.startsWith('work:attachments/')) continue;
    const rel = url.slice(5);
    let st = null;
    try { st = workspace.stat(rel); } catch { st = null; }
    if (!st) continue;
    const kind = kindOfName(rel);
    let line = `- [${kind ? KIND_LABEL[kind] : 'file'}] ${rel.slice('attachments/'.length)} · URL ${url}`;
    // Already stored into media library when sent from page (cloud chat, user decision, 2026-10-18):
    // use that media library entry directly, do not import again
    const lib = a?.library && typeof a.library === 'object' ? a.library : null;
    if (lib && typeof lib.mediaId === 'string' && typeof lib.url === 'string') {
      line += ` · Already in the media library: mediaId ${lib.mediaId} · cardUrl ${lib.url} (use this one directly, do not import_media again)`; inLibrary++;
    } else if (typeof a?.libraryError === 'string' && a.libraryError) line += ` · The page could not put it into the media library: ${a.libraryError}`;
    if (TEXT_EXT.has(extOf(rel)) && st.size <= inlineTextBytes) {
      try { line += `\n\`\`\`\n${workspace.read(rel).toString('utf8')}\n\`\`\``; } catch { /* Do not inline if unreadable */ }
    }
    lines.push(line);
  }
  if (!lines.length) return '';
  // When all are already in media library, do not invoke import_media (doing so only fails when cloud
  // asset execution is not enabled)
  const head = inLibrary === lines.length
    ? 'Attachment (the page has put it into the media library; use the marked mediaId / cardUrl; the original file is also in the working directory)'
    : 'Attachment (in this chat\'s working directory; for those marked "Already in the media library", use that entry directly; for the rest, to edit, transcribe or add motion graphics, first pass its URL to import_media to load it into the media library)';
  return `\n\n${head}:\n${lines.join('\n')}`;
}
