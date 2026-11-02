/**
 * Loudness measurement for Cloud Agent (`measure_audio`; contract `docs/plan/cloud-agent-contract.md`
 * Section 9.4b).
 *
 * In the desktop app, ffmpeg directly takes addresses on the local asset service as input. On cloud
 * nodes, ffmpeg is not allowed direct network egress:
 *
 *   "What to measure" is computed on the project replica (`measureAudioRequest` in
 *   `src/mcp/common.ts`, same copy as desktop app; only recognizes assets in this project's asset
 *   table)
 *     → Fetches assets to measure into this chat's working directory (under `measure/`, verifying
 *       content hash after fetch) using the member's own **read-only** asset ticket
 *     → Measures with ffprobe / ffmpeg spawned via restricted child process in workspace
 *       (`server/audio-loudness.mjs`, same parameters and parsing as desktop app)
 *     → Deletes fetched files after measuring.
 *
 * Child process: working directory is the chat directory, environment variables are rebuilt from
 * a whitelist, no windows popup (`spawn` in `workspace.mjs`); what is spawned is a killable process
 * tree (`perception/runner.mjs`), and timeouts kill the entire tree (both `child.kill()` in
 * `audio-loudness.mjs` and the workspace's built-in timeout do so); each input is prepended with
 * `-protocol_whitelist file`: assets are uploaded by members, and playlists disguised as media
 * must not allow ffmpeg to connect to network addresses.
 * Only one measurement (`slot`) runs at a time in the entire process. Read-only members can also
 * measure (read-only, no writes).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { measureLoudness } from '../../audio-loudness.mjs';
import { ffprobeText } from '../../audio-source.mjs';

export const HOSTED_AUDIO_DEFAULTS = Object.freeze({
  /** Total limit on assets fetched for a single measurement */
  maxFetchBytes: 1024 * 1024 * 1024,
  /** Time limit for fetching an asset */
  fetchMs: 40_000,
  /** Time limit for ffmpeg */
  measureMs: 50_000,
  /** Maximum number of clips for timeline tier */
  maxEntries: 200,
});

/** Finds ffmpeg and ffprobe in same dir (`PROMPTCUT_FFMPEG` or on PATH); returns null if not found. Results cached per process */
let toolsCache;
export function findAudioTools(env = process.env) {
  if (toolsCache !== undefined) return toolsCache;
  toolsCache = null;
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const cand of [env.PROMPTCUT_FFMPEG, 'ffmpeg'].filter(Boolean)) {
    try {
      const r = spawnSync(cand, ['-version'], { timeout: 5000, windowsHide: true });
      if (r.status !== 0 || r.error) continue;
      const probeCands = [env.PROMPTCUT_FFPROBE, path.isAbsolute(cand) ? path.join(path.dirname(cand), `ffprobe${exe}`) : 'ffprobe'].filter(Boolean);
      for (const p of probeCands) {
        const pr = spawnSync(p, ['-version'], { timeout: 5000, windowsHide: true });
        if (pr.status === 0 && !pr.error) { toolsCache = { ffmpeg: cand, ffprobe: p }; return toolsCache; }
      }
    } catch { /* Next */ }
  }
  return toolsCache;
}
export function _resetAudioTools() { toolsCache = undefined; }

/** Prepends `-protocol_whitelist file` before each input (`-i`): ffmpeg only reads local files */
export function localOnlyArgs(args) {
  const out = [];
  for (const a of args) {
    if (a === '-i') out.push('-protocol_whitelist', 'file');
    out.push(a);
  }
  return out;
}

const HASH_URL = /^\/@media\/([a-f0-9]{64})(?:[/?#.]|$)/;

/**
 * @param {object} d
 * @param {() => object} d.workspace Workspace for this chat
 * @param {() => Promise<object>} d.host `ssr-host.mjs`
 * @param {(apply: (host: object) => any) => Promise<any>} d.read Executes on store holding project replica (read-only)
 * @param {(hash: string, onChunk: (chunk: Buffer) => void, o: { maxBytes: number, timeoutMs: number }) => Promise<{ status: number }>} d.fetchAsset
 *   Fetches an asset by hash using the member's own read-only asset ticket
 * @param {{ acquire(signal?: AbortSignal): Promise<() => void> }} d.slot Process-level measurement slot
 * @param {() => ({ ffmpeg: string, ffprobe: string } | null)} [d.tools]
 */
export function createAudioTools({ workspace, host, read, fetchAsset, slot, tools = findAudioTools, limits: limitsIn = {}, ToolError = Error }) {
  const limits = { ...HOSTED_AUDIO_DEFAULTS, ...limitsIn };

  async function measureAudio(args) {
    const bins = tools();
    if (!bins) throw new ToolError('This cloud node has no ffmpeg / ffprobe installed, so the Cloud Agent cannot measure loudness. Tell the user to contact the host, or measure in PromptCut on their computer.', { code: 'no-ffmpeg' });
    const h = await host();
    let req = null;
    await read((hh) => { req = hh.audio.measureRequest(args ?? {}); return { ok: true }; });
    if (!req.body) return req.empty;
    const entries = req.scope === 'timeline' ? req.body.entries : [{ media: req.body.media }];
    if (entries.length > limits.maxEntries) throw new ToolError(`More than ${limits.maxEntries} clips on the timeline produce sound; the cloud cannot measure that many at once. Measure them separately by clip (clipId).`);

    const ws = workspace();
    const release = await slot.acquire();
    /** Asset hash → relative path in workspace (each asset is fetched only once) */
    const fetched = new Map();
    let budget = limits.maxFetchBytes;
    const spawnIn = (cmd, a, o = {}) => ws.spawn(cmd, localOnlyArgs(a), { stdio: o.stdio, timeoutMs: limits.measureMs + 5000 });
    try {
      const resolveSource = async (m) => {
        const hash = HASH_URL.exec(String(m?.url ?? ''))?.[1];
        if (!hash) return null;
        if (fetched.has(hash)) return fetched.get(hash);
        const rel = `measure/${hash}`;
        const writer = ws.writer(rel);
        const digest = createHash('sha256');
        let size = 0;
        let res;
        try {
          res = await fetchAsset(hash, (chunk) => {
            size += chunk.length;
            if (size > budget) throw new ToolError('The media to measure is too large for the cloud to measure at once; measure just one clip of it (clipId).', { code: 'too-large' });
            digest.update(chunk);
            writer.write(chunk);
          }, { maxBytes: budget, timeoutMs: limits.fetchMs });
        } catch (err) {
          writer.abort();
          throw err;
        }
        if (res.status === 404) { writer.abort(); fetched.set(hash, null); return null; }
        if (res.status < 200 || res.status >= 300) {
          writer.abort();
          throw new ToolError(`The asset service refused the read (HTTP ${res.status}).`, { code: res.status === 401 || res.status === 403 ? 'forbidden' : 'asset-error' });
        }
        writer.end();
        if (digest.digest('hex') !== hash) { ws.remove(rel); throw new ToolError('The fetched asset does not match its content hash; not measured.'); }
        budget -= size;
        const abs = ws.resolve(rel);
        fetched.set(hash, abs);
        return abs;
      };
      const out = await measureLoudness({
        body: req.body,
        resolveSource,
        ffmpeg: bins.ffmpeg,
        ffprobe: bins.ffprobe,
        timeoutMs: limits.measureMs,
        spawnImpl: spawnIn,
        hasAudio: async (src, ffprobe) => {
          const text = await ffprobeText(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', '-i', src], { spawnImpl: spawnIn });
          return !!text && text.trim().length > 0;
        },
      });
      if (out.status !== 200 || out.body?.ok === false) {
        // Error messages do not include working directory disk path
        const root = ws.dir();
        throw new ToolError(String(out.body?.error ?? `Loudness measurement failed (${out.status})`).split(root).join('<working directory>').slice(0, 400));
      }
      return h.audio.measureFinish(req, out.body);
    } finally {
      release();
      for (const hash of fetched.keys()) { try { ws.remove(`measure/${hash}`); } catch { /* Left to be cleaned up when chat is deleted */ } }
    }
  }

  return { measure_audio: measureAudio };
}
