/**
 * Where perception tools (`detect_shots`, `track_points`, `detect_subjects`) read assets from:
 * **only via the asset service HTTP interface** (`docs/semantics/product/agent.md` "Assets and outputs";
 * `product/asset-service.md` "Responsibilities", item 3).
 *
 * The page only passes the media identifier (`media: { id, name, kind, url, hash }`), which the server
 * resolves via the resolver in `audio-source.mjs` to an HTTP URL on the asset service, and ffmpeg / ffprobe
 * directly takes the URL as input. `path` (and `media.path`) in the request body is **completely ignored**:
 * previously these three endpoints accepted arbitrary absolute paths, running `existsSync` before passing
 * to ffmpeg, which opened an arbitrary file read vulnerability; moreover, assets without local paths in
 * shared projects could not be used.
 *
 * The Python half (TransNetV2, BootsTAPIR / template matching, YuNet + RT-DETR / Grounding DINO) also
 * spawns ffmpeg child processes for decoding; new packages accept http URLs (`ACCEPTS_URL = True` in the
 * package); old packages (desktop app only patched the Node half and Python package in runtime is still old)
 * will report "Video file not found" when seeing a URL; in this case, stream bytes from asset service to a
 * temporary file first, pass the temporary path, and delete it once the job finishes.
 *
 * This file does not import vite and recognizes no directories; `server/test/perception-asset-path.test.mjs`
 * tests it directly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AssetSourceError } from './audio-source.mjs';
import { tr } from './i18n.mjs';

/** Media identifier in the request body. Only takes these fields; `path` is omitted (see file header) */
const REF_KEYS = ['id', 'name', 'kind', 'url', 'hash'];

/**
 * Request body → media identifier. Page sends `{ mediaId, media: { id, name, kind, url, hash } }`;
 * returns null if neither url nor hash can be obtained.
 * @returns {{ id?: string, name?: string, kind?: string, url?: string, hash?: string } | null}
 */
export function mediaRefOf(body) {
  const m = body && typeof body.media === 'object' && body.media ? body.media : null;
  if (!m) return null;
  const ref = {};
  for (const k of REF_KEYS) if (typeof m[k] === 'string' && m[k]) ref[k] = m[k];
  if (!ref.id && typeof body.mediaId === 'string' && body.mediaId) ref.id = body.mediaId;
  return ref.url || ref.hash ? ref : null;
}

/** Human-readable media name: used for identification in error messages */
export function mediaLabel(ref) {
  return ref?.name || ref?.id || ref?.hash || ref?.url || tr("(Unnamed media)");
}

/**
 * Request body → URL on the asset service, distinguishing three outcomes (same as `audio-source.mjs`):
 * - `{ ok: true, src, media }`: asset service responded with 2xx;
 * - `{ ok: false, status: 404 }`: asset does not exist on asset service (or URL cannot be formed,
 *   e.g. still uploading, only blob: URL);
 * - `{ ok: false, status: 502, kind: 'asset-service' }`: asset service unreachable or refused read,
 *   error specifies URL and reason;
 * - `{ ok: false, status: 400 }`: request body lacks media identifier (old pages sending only `path`
 *   also fall here).
 * @param {any} body
 * @param {(m: any) => Promise<string | null>} resolveSource resolver built by `createAssetSourceResolver`
 */
export async function resolveMediaSource(body, resolveSource) {
  const ref = mediaRefOf(body);
  if (!ref) {
    return { ok: false, status: 400, error: tr("No media given: the request body must include media (the media id / url / hash); local file paths are no longer accepted, and bytes are always fetched through the asset service") };
  }
  try {
    const src = await resolveSource(ref);
    if (!src) return { ok: false, status: 404, error: tr("This media is not on the asset service: {0} (if it is still uploading, wait for the upload to finish and retry; otherwise import it again)", mediaLabel(ref)) };
    return { ok: true, src, media: ref };
  } catch (e) {
    if (e instanceof AssetSourceError) return { ok: false, status: 502, kind: 'asset-service', error: e.message };
    throw e;
  }
}

export const isHttpSource = (src) => /^https?:\/\//i.test(String(src || ''));

/** Checks if Python package accepts URLs. No double quotes: spawnPython rejects cmd metacharacters when `.cmd` is interpreter */
export const acceptsUrlCode = (pkg) =>
  `import importlib,sys;m=importlib.import_module('${pkg}');sys.stdout.write('1' if getattr(m,'ACCEPTS_URL',False) else '0')`;

/**
 * Whether this Python package accepts http URLs (`ACCEPTS_URL = True` in package). If unable to query
 * (interpreter fails to start, import fails, timeout), treat as not accepted and fall back to temporary
 * files: that path works for both new and old packages, just copying bytes once more.
 * @param {{ python: string, env: NodeJS.ProcessEnv, pkg: string, spawnPython: Function, timeoutMs?: number }} p
 * @returns {Promise<boolean>}
 */
export function pythonAcceptsUrl({ python, env, pkg, spawnPython, timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnPython(python, ['-c', acceptsUrlCode(pkg)], env); } catch { return resolve(false); }
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* Already exited */ } finish(false); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0 && out.trim() === '1'));
  });
}

/** Temp file extension: follows media name, omitted if absent (ffmpeg probes format by content, not extension) */
function extOf(ref) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(ref?.name || ''));
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * Streams bytes from the asset service to a temporary file. Returns `{ file, cleanup }`; throws
 * `AssetSourceError` on failure (connection failure, non-2xx, disk write failure all count as byte
 * fetch failure). One temporary directory per job (`os.tmpdir()/pc-perception-*`), cleanup deletes
 * the directory as well.
 */
export async function downloadToTemp(src, ref, { fetchImpl = globalThis.fetch, tmpRoot = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'pc-perception-'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* If deletion fails, leave it for the system to clean up */ } };
  const file = path.join(dir, `media${extOf(ref)}`);
  try {
    const res = await fetchImpl(src);
    if (!res.ok || !res.body) {
      try { await res.body?.cancel(); } catch { /* Fully read */ }
      throw new AssetSourceError(tr("The asset service refused the read (HTTP {0})", res.status));
    }
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    return { file, cleanup };
  } catch (e) {
    cleanup();
    if (e instanceof AssetSourceError) throw e;
    throw new AssetSourceError(tr("Failed to fetch bytes from the asset service: {0}", String(e?.cause?.code || e?.message || e)));
  }
}

/**
 * Video parameters for Python: passes URL as-is if package accepts URLs; otherwise streams to temporary
 * file first and passes path. Returns `{ input, cleanup, via }`, where `via` is `'url'` or `'temp'`
 * (for tests and logs). Passes src as-is if not an http URL (will not happen: resolver only builds http URLs).
 */
export async function pythonInput({ src, ref, python, env, pkg, spawnPython, fetchImpl, tmpRoot }) {
  const noop = () => {};
  if (!isHttpSource(src)) return { input: src, cleanup: noop, via: 'url' };
  if (await pythonAcceptsUrl({ python, env, pkg, spawnPython })) return { input: src, cleanup: noop, via: 'url' };
  const t = await downloadToTemp(src, ref, { fetchImpl, tmpRoot });
  return { input: t.file, cleanup: t.cleanup, via: 'temp' };
}
