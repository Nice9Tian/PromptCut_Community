/**
 * For testing only; must not be referenced by production code.
 *
 * Shared utilities for C10a contract tests (`server/test/c10a-*.test.mjs`,
 * `src/**\/c10a-*.test.mjs`, `scripts/probes/c10a-*.mjs`).
 * Based solely on `docs/plan/c10a-contract.md` (sections 2, 5, 8, 9, 11.1, 12) and the
 * `docs/plan/auth-contract.md` it references; the test author did not inspect the implementation
 * (`claude/c10a-web`, `claude/c10a-lowmem`).
 *
 * Module paths, function names, parameters, and response shapes not fixed by the contract are all
 * concentrated in this file; during integration, only this file is modified to reconcile.
 * Each assumption is marked as "Assumption K<n>", listed under the same numbers in report
 * `docs/archive/agent-reports/AGENT-c10a-tests.md`.
 *
 * # What to do when implementation is absent
 *
 * At the beginning of each test suite, call `*Support()` in this file to probe whether the API
 * exists: if absent, mark the test suite as `node:test` skip with reason "missing API: …". Probing
 * checks only "whether implementation exists", not "whether implementation is correct": once the
 * API appears, tests actually run, and mismatches in name or shape against assumptions fail
 * directly (reconciled by integration team editing this file) rather than being silently skipped.
 * Therefore, before integration, `npm test` skip count will include these extra skips; after
 * integration, it must return to skipping only the 1 test that requires 5190.
 *
 *   K1  Invite code (contract section 5): mounted alongside existing shared project HTTP endpoints,
 *       standalone mode `shared/invite/resolve`, `shared/invite/redeem`, attached mode
 *       `<WS path>/shared/invite/…`; server side is the suite assembled by `auth-kit.mjs`
 *       (`createSharedDocService`), without setting up a separate entry point.
 *       - Probe: send `POST shared/invite/resolve` for a random invite code; returning 404
 *         `{ error: 'invite-invalid' }` counts as implementation present; current implementation
 *         returns 404 `not-found` for unrecognized `shared/…` paths, judged as missing accordingly.
 *       - `invite-create` / `invite-revoke` / `invite-status` response fields of `shared.admin` are
 *         flattened on `shared.admin.ok` (same approach as C6.5 `list-bans` returning `bans`);
 *         `invite-status` also accepts wrapping inside `status`.
 *       - `expiresAt`, `revokedAt` are millisecond timestamps (same as ticket `exp` in auth
 *         contract section 8).
 *       - Issuance and expiration are calculated based on clock injected by document service
 *         (`testClock` in `auth-kit.mjs`).
 *   K2  Old tier determination (contract section 8): revoked (user decision, 2026-10-07), deleted
 *       on 2026-10-22 (`claude/online-browser`) along with its test cases; see "K2 / K3 tiers" below.
 *   K3  Capability gate (contract section 8): "small size only" branch of `src/render/mediaTier.ts`
 *       (currently named `opts.smallOnly`, lowest tier) and single stage gate of
 *       `src/editor/stageSwap.ts` (currently named `SwapHost.singleStage()`). Probe:
 *       `src/online/onlineTier.ts` exists.
 *   K4  Prerender small size (contract section 9):
 *       - Size rule is a pure function `(width, height) → { width, height }`, in one of
 *         `SMALL_SIZE_FILES`, with a name taken from `SMALL_SIZE_NAMES`; probe: find this function.
 *       - Snapshot manifest (C6.2 `SnapshotResult`) additionally carries
 *         `small: [[frame, hash, bytes], …]`, chunks are WebP, pushed to `px`
 *         (`client.put('px', bytes, { ext: 'webp' })`); `pushResult` returns only when both tiers
 *         push successfully, throwing if any chunk fails.
 *       - Small size in ready index (`server/ready-index.mjs`) is an independent `kind` (the one
 *         whose name contains `small` in `READY_KINDS`), non-overlapping with the `html` layer.
 *   K5  MP4 muxer (contract section 11 [ruling]): a `.ts` under `src/export/` exporting a class or
 *       factory, with a name taken from `MUXER_NAMES`; constructor parameters
 *       `{ video: { codec: 'avc', width, height, frameRate }, audio?: { codec: 'aac', sampleRate, numberOfChannels }, fastStart? }`;
 *       methods `addVideoChunk(chunk, meta?)`, `addAudioChunk(chunk, meta?)`, `finalize()`. `chunk`
 *       is WebCodecs `EncodedVideoChunk` / `EncodedAudioChunk` shape (`type`, `timestamp`/`duration`
 *       in microseconds, `byteLength`, `copyTo`), `meta.decoderConfig.description` is avcC /
 *       AudioSpecificConfig. Output takes return value of `finalize()` (Uint8Array / ArrayBuffer /
 *       Blob), falling back to `muxer.target.buffer` if none.
 *   K6  `/api` guard (contract section 2): a `.ts` under `src/online/` exporting a function whose
 *       name contains `guard` (case-insensitive); when called, makes `fetch('/api/…')` throw (either
 *       synchronous throw or reject) when `ONLINE`, forwarding other addresses to original `fetch`
 *       as usual; does not intercept when `ONLINE` is false.
 *       Static check for online build: literals in artifacts starting with `/api/` immediately
 *       followed by an address (`apiLiterals`) must be 0; `"/api/"` used by the guard to check
 *       prefixes does not count.
 *   K7  Single stage (contract section 8.1): still determined by `src/editor/previewMode.ts` how
 *       many stages to open; starting 2026-10-22 determined by stage gate tier (stopping at level 1
 *       opens cross-origin A only), `stageSrc('A')` is always cross-origin with `preview=stage`.
 *       Probe: `src/online/onlineTier.ts` exists.
 *
 * # Integration reconciliation (`claude/c10a-integ`, 2026-09-27; see `docs/archive/agent-reports/AGENT-c10a-integ.md` for item-by-item rationales)
 *
 *   K1  Consistent with implementation, unchanged.
 *   K2  (Deleted, see above)
 *   K3  "small size only" branch of `mediaTier` and single stage gate of `stageSwap`, see
 *       `singleStageSwapHost` (renamed 2026-10-22).
 *   K4  Size rule `smallSize({ projectWidth, projectHeight })` in
 *       `server/bakery/small-bitmap.mjs`; manifest `small`, push `px` consistent with assumption;
 *       ready index does not accept small size, two tiers recorded separately in manifest
 *       (verify before export `src/export/originals.ts` only recognizes `frames`).
 *   K5  `Mp4Muxer` + `MemorySink` in `src/export/mp4Mux.ts`, requires decoder config during
 *       construction; see `muxerAdapter`.
 *   K6  `bootApiGuard(online)` in `src/online/apiGuard.ts`; static check changed to ratchet
 *       (`ONLINE_API_RATCHET_FILE`).
 *   K7  Consistent with implementation, unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const repoPath = (rel) => path.join(ROOT, ...rel.split('/'));
export const repoUrl = (rel) => pathToFileURL(repoPath(rel)).href;
export const exists = (rel) => fs.existsSync(repoPath(rel));

/** skip option for `node:test`: false if API exists (actually runs), "missing API: …" if absent */
export const skipIf = (missing, what) => (missing ? `interface missing: ${what} (C10a implementation not integrated yet; runs for real automatically once integrated)` : false);

export function tempDir(prefix = 'pc-c10a-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ================================================================== K1 Invite code

/** Contract section 5: 32-byte random number base64url, unpadded, 43 characters */
export const INVITE_CODE_RE = /^[A-Za-z0-9_-]{43}$/;
export const newInviteCode = () => randomBytes(32).toString('base64url');
export const INVITE_DEFAULT_TTL_MS = 604_800 * 1000;

let inviteProbe = null;
/**
 * Probe whether invite code endpoint exists (K1). Spin up a temporary hosted side document
 * service to query once, returning `{ ok, detail }`.
 * Depends on `auth-kit.mjs` (which must be able to start services); if it fails to start, treat as
 * missing and surface the reason.
 */
export function inviteSupport() {
  inviteProbe ??= (async () => {
    const { startHost } = await import('./auth-kit.mjs');
    let env = null;
    try {
      env = await startHost();
      const r = await env.http('shared/invite/resolve', { method: 'POST', body: { code: newInviteCode() } });
      const ok = r.status === 404 && r.json?.error === 'invite-invalid';
      return { ok, detail: ok ? '' : `POST shared/invite/resolve returned ${r.status} ${r.text.slice(0, 120)}` };
    } catch (err) {
      return { ok: false, detail: `failed to start the hosted side: ${err?.message ?? err}` };
    } finally {
      await env?.close();
    }
  })();
  return inviteProbe;
}

export function resolveInvite(env, code, { remote } = {}) {
  return env.http('shared/invite/resolve', { method: 'POST', body: { code }, remote });
}

export function redeemInvite(env, { code, username, deviceId }, { remote } = {}) {
  return env.http('shared/invite/redeem', { method: 'POST', body: { code, username, deviceId }, remote });
}

/** Response of `invite-status`: fields flattened, or wrapped in `status` (K1) */
export function inviteStatusOf(reply) {
  assert.equal(reply?.type, 'shared.admin.ok', `invite-status should be shared.admin.ok: ${JSON.stringify(reply)}`);
  return reply.status && typeof reply.status === 'object' ? reply.status : reply;
}

/** Full text of all files in directory (binary read as latin1), used to check "plaintext not written to disk" */
export function filesContaining(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = fs.readFileSync(p);
        if (buf.includes(Buffer.from(needle, 'utf8'))) hits.push(p);
      }
    }
  };
  walk(dir);
  return hits;
}

// ================================================================== K2 / K3 tiers (old tier determination revoked 2026-10-07)

/**
 * 2026-10-22 (`claude/online-browser`): old tier revoked
 * (`docs/semantics/product/platforms.md` "online browser"), original K2 determination (original
 * determination module and device setting "display tier") deleted entirely, and the two test case
 * files testing it deleted together.
 * Responsibilities of this tier split into three places: only one stage (stage gate level 1,
 * `src/online/onlineTier.ts`), lowest tier (`smallOnly` in tier selection policy), identity as
 * mobile phone.
 * Probing and stubs below now recognize `onlineTier.ts`.
 */
export const TIER_FILE = 'src/online/onlineTier.ts';

/**
 * K3 (after integration reconciliation, renamed 2026-10-22): single stage gate of `stageSwap.ts`
 * is on `SwapHost.singleStage()` (provided by `Preview.tsx` based on how many stages are currently
 * attached).
 * Test case `setSwapHost` patches `singleStage` through here.
 */
export function singleStageSwapHost(host, single = true) {
  return { ...host, singleStage: () => single };
}

// ================================================================== K4 prerender small size

/**
 * After integration reconcile (K4): the sizing rule is
 * `server/bakery/small-bitmap.mjs`'s `smallSize({ projectWidth, projectHeight, boxWidth?, boxHeight? })`,
 * returning `{ width, height }`. The small bitmap draws the wrapper layer box, scaled using the same
 * scale ratio; if no box is given, it is the full frame, exactly Section 9's "project aspect ratio"
 * in the contract.
 */
export const SMALL_SIZE_FILE = 'server/bakery/small-bitmap.mjs';
export const SMALL_SIZE_NAME = 'smallSize';

/** Find sizing rule function (K4); returns `{ fn: (w, h) => size, file, name }`, returns `{ file, error }` if exported but failed to load, returns null if not found */
export async function findSmallSize() {
  if (!exists(SMALL_SIZE_FILE)) return null;
  const src = fs.readFileSync(repoPath(SMALL_SIZE_FILE), 'utf8');
  let mod;
  try { mod = await import(repoUrl(SMALL_SIZE_FILE)); } catch (err) {
    // Exported this name in text but failed to load: do not silently skip as "missing", let test report error
    if (exportsName(src, SMALL_SIZE_NAME)) return { file: SMALL_SIZE_FILE, error: err };
    return null;
  }
  const f = mod[SMALL_SIZE_NAME];
  if (typeof f !== 'function') return null;
  return { fn: (w, h) => f({ projectWidth: w, projectHeight: h }), file: SMALL_SIZE_FILE, name: SMALL_SIZE_NAME };
}

/** After integration reconcile (K4): module that checks and retrieves prerender original size before export; only recognizes manifest `frames`, not `small` */
export const ORIGINALS_FILE = 'src/export/originals.ts';

/** Whether source text contains `export … <name>` (rough filter: function / const / class / export { … }) */
export function exportsName(src, name) {
  const re = new RegExp(String.raw`export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+${name}\b|export\s*\{[^}]*\b${name}\b`);
  return re.test(src);
}

/** Sizing function may return `{ width, height }` or `[w, h]` */
export function sizeOf(r) {
  if (Array.isArray(r)) return { width: r[0], height: r[1] };
  return { width: r?.width ?? r?.w, height: r?.height ?? r?.h };
}

// ================================================================== K5 MP4 muxer

/**
 * After integration reconcile (K5): `Mp4Muxer` and `MemorySink` in `src/export/mp4Mux.ts`.
 * Implementation shape differs from test case assumptions:
 * - Requires `{ video: { codec: 'avc1.…', width, height, fps, avcC }, audio?: { codec: 'mp4a.40.2', sampleRate, channels, asc }, sink }`
 *   at construction time, whereas avcC / AudioSpecificConfig must wait for the first chunk's
 *   `meta.decoderConfig.description`;
 * - `addVideoChunk(bytes, { timestampUs, key })` and `addAudioChunk(bytes, { timestampUs, durationUs })`
 *   take copied bytes;
 * - `finalize()` returns byte count; output is in `MemorySink.bytes()`.
 * The adapter below follows `browserExport.ts`: buffer chunks first, create muxer once required
 * decoder configs arrive, and feed them in order of arrival.
 */
export const MUXER_FILE = 'src/export/mp4Mux.ts';
export const MUXER_NAMES = ['Mp4Muxer'];

const chunkBytes = (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); return b; };

function muxerAdapter(mod, opts) {
  const wantAudio = !!opts.audio;
  const sink = new mod.MemorySink();
  let real = null;
  let video = null;
  let audio = null;
  const pending = [];
  const feed = (e) => (e.kind === 'v'
    ? real.addVideoChunk(e.data, { timestampUs: e.timestampUs, key: e.key })
    : real.addAudioChunk(e.data, { timestampUs: e.timestampUs, durationUs: e.durationUs }));
  const push = (e) => {
    if (!real && video && (!wantAudio || audio)) {
      real = new mod.Mp4Muxer({ video, audio, sink });
      for (const p of pending.splice(0)) feed(p);
    }
    if (real) feed(e); else pending.push(e);
  };
  return {
    target: sink,
    addVideoChunk(chunk, meta) {
      const d = meta?.decoderConfig;
      if (d?.description && !video) video = { codec: d.codec, width: d.codedWidth ?? opts.video.width, height: d.codedHeight ?? opts.video.height, fps: opts.video.frameRate, avcC: new Uint8Array(d.description) };
      push({ kind: 'v', data: chunkBytes(chunk), timestampUs: chunk.timestamp, key: chunk.type === 'key' });
    },
    addAudioChunk(chunk, meta) {
      const d = meta?.decoderConfig;
      if (d?.description && !audio) audio = { codec: d.codec, sampleRate: d.sampleRate ?? opts.audio.sampleRate, channels: d.numberOfChannels ?? opts.audio.numberOfChannels, asc: new Uint8Array(d.description) };
      push({ kind: 'a', data: chunkBytes(chunk), timestampUs: chunk.timestamp, durationUs: chunk.duration });
    },
    async finalize() {
      assert.ok(real, `the muxer was not built: video decoder config ${video ? 'present' : 'missing'}, audio ${wantAudio ? (audio ? 'present' : 'missing') : 'does not want'}`);
      await real.finalize();
      return sink.bytes();
    },
  };
}

/** Find muxer (K5); returns `{ make, file, name }`, returns `{ file, error }` if exported but failed to load, returns null if not found */
export async function findMuxer() {
  if (!exists(MUXER_FILE)) return null;
  const src = fs.readFileSync(repoPath(MUXER_FILE), 'utf8');
  let mod;
  try { mod = await import(repoUrl(MUXER_FILE)); } catch (err) {
    if (exportsName(src, 'Mp4Muxer')) return { file: MUXER_FILE, error: err };
    return null;
  }
  if (typeof mod.Mp4Muxer !== 'function' || typeof mod.MemorySink !== 'function') return null;
  return { file: MUXER_FILE, name: 'Mp4Muxer', make: (opts) => muxerAdapter(mod, opts) };
}

/** Muxer output bytes (K5) */
export async function muxerBytes(muxer, finalized) {
  let out = await finalized;
  if (out === undefined || out === null) out = muxer?.target?.buffer ?? muxer?.buffer ?? muxer?.bytes;
  if (out && typeof out.arrayBuffer === 'function') out = await out.arrayBuffer();
  if (out instanceof ArrayBuffer) return Buffer.from(out);
  if (ArrayBuffer.isView(out)) return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  assert.fail(`muxer finalize() returned no bytes: ${Object.prototype.toString.call(out)}`);
}

/** WebCodecs EncodedVideoChunk / EncodedAudioChunk shape */
export function fakeChunk({ type, timestamp, duration, data }) {
  const bytes = new Uint8Array(data);
  return {
    type, timestamp, duration, byteLength: bytes.byteLength,
    copyTo(dest) {
      const view = dest instanceof ArrayBuffer ? new Uint8Array(dest) : new Uint8Array(dest.buffer, dest.byteOffset, dest.byteLength);
      view.set(bytes);
    },
  };
}

// ---- Sample: ffmpeg outputs H.264 Annex B / AAC ADTS on the fly; test splits into WebCodecs chunks

export function findFfmpegSync() {
  for (const cmd of ['ffmpeg']) {
    const r = spawnSync(cmd, ['-version'], { windowsHide: true });
    if (r.status === 0) return cmd;
  }
  return null;
}
export const ffprobeOf = (ffmpeg) => ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));

export function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code === 0) resolve({ out: buf.toString('utf8'), buf, err });
      else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} exit code ${code}: ${err.slice(-800)}`));
    });
  });
}

/** Annex B splits NAL (strip start codes) */
export function splitAnnexB(buf) {
  const nals = [];
  let i = 0;
  let start = -1;
  while (i + 3 <= buf.length) {
    const sc3 = buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1;
    const sc4 = i + 4 <= buf.length && buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1;
    if (sc3 || sc4) {
      if (start >= 0) nals.push(buf.subarray(start, i));
      i += sc4 ? 4 : 3;
      start = i;
    } else i++;
  }
  if (start >= 0) nals.push(buf.subarray(start));
  // Strip trailing 0s from NAL (leading 0s of the next start code)
  return nals.map((n) => { let e = n.length; while (e > 0 && n[e - 1] === 0) e--; return n.subarray(0, e); }).filter((n) => n.length);
}

/**
 * H.264 Annex B → `{ avcC, samples: [{ key, data(AVCC length prefix) }] }`.
 * Requires one slice per frame, no B-frames (guaranteed when ffmpeg generates samples);
 * SPS/PPS only go into avcC, not into samples (WebCodecs `avc` format).
 */
export function annexBToAvcc(buf) {
  const nals = splitAnnexB(buf);
  let sps = null, pps = null;
  const samples = [];
  let cur = [];
  let key = false;
  for (const nal of nals) {
    const t = nal[0] & 0x1f;
    if (t === 7) { sps ??= nal; continue; }
    if (t === 8) { pps ??= nal; continue; }
    if (t === 9) continue; // AUD
    cur.push(nal);
    if (t === 5) key = true;
    if (t === 1 || t === 5) {
      const len = cur.reduce((s, n) => s + 4 + n.length, 0);
      const data = Buffer.alloc(len);
      let o = 0;
      for (const n of cur) { data.writeUInt32BE(n.length, o); n.copy(data, o + 4); o += 4 + n.length; }
      samples.push({ key, data });
      cur = [];
      key = false;
    }
  }
  assert.ok(sps && pps, 'no SPS / PPS in the H.264 sample');
  const avcC = Buffer.concat([
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    Buffer.from([sps.length >> 8, sps.length & 0xff]), sps,
    Buffer.from([1, pps.length >> 8, pps.length & 0xff]), pps,
  ]);
  const codec = `avc1.${[sps[1], sps[2], sps[3]].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { avcC, codec, samples };
}

/** AAC ADTS → `{ asc, sampleRate, channels, frames: [Buffer] }` (strip ADTS header) */
export function adtsToRaw(buf) {
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const frames = [];
  let i = 0;
  let profile = 1, srIdx = 4, ch = 2;
  while (i + 7 <= buf.length) {
    assert.ok(buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0, `ADTS sync word is wrong (offset ${i})`);
    const protectionAbsent = buf[i + 1] & 1;
    profile = (buf[i + 2] >> 6) + 1;
    srIdx = (buf[i + 2] >> 2) & 0xf;
    ch = ((buf[i + 2] & 1) << 2) | (buf[i + 3] >> 6);
    const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    const head = protectionAbsent ? 7 : 9;
    frames.push(buf.subarray(i + head, i + len));
    i += len;
  }
  const asc = Buffer.from([(profile << 3) | (srIdx >> 1), ((srIdx & 1) << 7) | (ch << 3)]);
  return { asc, sampleRate: RATES[srIdx], channels: ch, frames };
}

// ================================================================== K6 `/api` guard

/**
 * After integration reconcile (K6): guard is in `src/online/apiGuard.ts`. `installApiGuard()`
 * itself does not check mode (installs whenever called); the rule "install only when `ONLINE`" is
 * in `bootApiGuard(online, options)`, which `boot.ts` calls based on `ONLINE`.
 * Here, following `boot.ts`, pass `ONLINE` from this process's `mode.ts` (stubbed out by test case).
 */
// 2026-10-28: this constant was not updated with the move, while apiGuard.ts already moved to cloud/online/.
// The consequence was not an error but **silent skip**: findApiGuard() returns null → skipIf is true → C10A-API-05/06
// went from "actual run" to "skipped", and skip does not count as failure, so "zero regressions in
// item-by-item reconcile with baseline" could not detect it at all.
// This is a hole in that reconcile method itself: matching numbers does not mean coverage did not shrink.
export const API_GUARD_FILE = 'cloud/online/apiGuard.ts';

/** Find guard (K6); returns `{ fn, file, name }` or null */
export async function findApiGuard(importer) {
  if (!exists(API_GUARD_FILE)) return null;
  const mod = await importer(API_GUARD_FILE);
  if (typeof mod.bootApiGuard !== 'function') return null;
  const { ONLINE } = await importer('src/online/mode.ts');
  return { fn: () => mod.bootApiGuard(ONLINE), file: API_GUARD_FILE, name: 'bootApiGuard' };
}

/** All files under directory (recursive) */
export const walkFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/**
 * Online build `/api/` path ratchet [ruling, lead session 2026-09-27]: existing `/api/` paths in
 * artifacts at integration time are recorded in this manifest. C10A-API-03 asserts
 * "artifact `/api/` paths ⊆ manifest", marking newly appearing ones red. Graying out or replacing
 * with online alternatives one by one belongs to the rest of C10; delete from manifest once resolved.
 * Runtime guard plus 0 `/api/` requests in network logs remains the acceptance check (probe).
 */
export const ONLINE_API_RATCHET_FILE = 'server/test/c10a-online-api-paths.json';

/**
 * The translation table chunk (`assets/i18n-*.js`) contains all UI copy, even copy for features
 * cut from this build (for example "/api/stt/install returned {0}"). That is text, not a request;
 * skip it when scanning `/api/`.
 */
export const isTranslationTable = (file) => /^i18n-[\w-]+\.js$/.test(path.basename(file));

/** Normalize `/api/` literals in artifacts into paths (take up to the first non-path char: template `${`, quotes, query strings truncated); returns deduplicated sorted array */
export function apiPaths(dir) {
  const out = new Set();
  for (const file of walkFiles(dir)) {
    if (!/\.(m?js|html)$/.test(file) || isTranslationTable(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    // Same criteria as `apiLiterals` (quote or backtick followed immediately by `/api/`
    // and path chars), only additionally extracts path
    for (const m of text.matchAll(/["'`](\/api\/[A-Za-z0-9_$][A-Za-z0-9_\-./]*)/g)) out.add(m[1].replace(/\$.*$/, ''));
  }
  return [...out].sort();
}

/**
 * Literals in build artifacts starting with `/api/` immediately followed by an address
 * (starting with quote or backtick); returns `[{ file, at, context }]`.
 * `"/api/"` used by the guard to check prefixes (quote immediately after the slash) does not count.
 */
export function apiLiterals(dir) {
  const hits = [];
  for (const file of walkFiles(dir)) {
    if (!/\.(m?js|html)$/.test(file) || isTranslationTable(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const re = /["'`]\/api\/[A-Za-z0-9_$]/g;
    let m;
    while ((m = re.exec(text))) hits.push({ file: path.relative(dir, file), at: m.index, context: text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ') });
  }
  return hits;
}
