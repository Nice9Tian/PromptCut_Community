import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Frame pipeline asset stamp (`_frameSourceStamp`): `FramePipeline.entry()` embeds it into each
 * asset record, and `frameIdentity` uses it to compute the whole scene key: if asset bytes change,
 * the key must change so old frame store entries are not mistaken for hits on new ones.
 *
 * **The prerender process does not directly read the asset service storage directory**
 * (`docs/semantics/product/asset-service.md` "Responsibilities" item 3;
 * `docs/semantics/product/rendering.md` "Heavy pipeline: prerender"). Previously this converted
 * URLs to local paths per `card-media-path.mjs` and ran `fs.stat`, using `${size}:${mtimeMs}` as
 * the stamp; now:
 *
 *   - **Those with content hashes** (`m.hash`, or `url` is `/@media/<hash>[.ext]`):
 *     the stamp is the hash. Content addressed by hash is immutable once written;
 *     identical hashes mean identical bytes, no need to query anyone.
 *   - **Those without hashes** (stored by filename during transition period as
 *     `/@media/<filename>`, legacy `.proc` `path` / `/api/media/file?path=`): sends a `HEAD` to
 *     the asset service, stamp = `Content-Length:Last-Modified`. If asset service is unreachable
 *     or `HEAD` fails → `'missing'` (same as previous stat failures). Results are cached by URL
 *     for `MEDIA_STAMP_TTL_MS`, avoiding sending separate requests for each of N assets on every
 *     `entry()`.
 *   - **`/@export/<id>/media/…`**: this export pass's **own artifact directory** (moved from
 *     staging into `export-<id>/media/` when export begins, `vite-plugin-export.ts`), not content
 *     in the media library and not managed by the asset service; locally `stat`ed as before, just
 *     like the export page and `mux-audio.mjs`.
 *   - Others (`blob:`, `data:`, external http URLs): not stamped, same as before.
 *
 * How URLs are composed (hash → `/@media/<hash>`, legacy path → `/api/media/file?path=`,
 * filename → `/@media/<filename>`) is not rewritten here: injected by the caller via `mediaUrl(m)`
 * (`vite-plugin-frames.ts` passes `mediaSourceOf` from `server/vision/ffmpeg-frames.ts`, with the
 * base URL determined by `server/asset-client.ts`).
 */

/**
 * How long HEAD results are cached. Scrubbing the timeline enters `entry()` on every tick;
 * the same asset is only queried once within 5 seconds
 */
export const MEDIA_STAMP_TTL_MS = 5000;
/**
 * Maximum wait time for a single HEAD; the asset service is on the local machine, normally
 * taking a few milliseconds
 */
export const MEDIA_STAMP_TIMEOUT_MS = 2000;

const HASH = /^[0-9a-f]{64}$/;
const HASH_NAME = /^([0-9a-f]{64})(?:\.[a-z0-9]+)?$/;

/**
 * Content hash of an asset: `m.hash`, or `url` is `/@media/<hash>[.ext]`. Content addressed by hash
 * is immutable once written, so it can be used directly as a cache key; returns null for assets
 * without a hash (stored by filename during transition period, absolute paths in legacy .proc).
 * (`server/vision/ffmpeg-frames.ts` re-exports the function with the same name from here.)
 */
export function mediaHashOf(m) {
  const hash = String(m?.hash || '').toLowerCase();
  if (HASH.test(hash)) return hash;
  const url = String(m?.url || '').split('?')[0];
  if (!url.startsWith('/@media/')) return null;
  const hit = HASH_NAME.exec(url.slice('/@media/'.length).toLowerCase());
  return hit ? hit[1] : null;
}

/**
 * `/@export/<id>/media/<file>` → local file (the artifact directory of this export pass); returns
 * null if out of bounds or not this kind of address.
 * `exportRoot` = export root directory (`PROMPTCUT_EXPORT_DIR`, defaults to `out/`, parent of the
 * frame store directory).
 */
export function exportMediaFile(url, exportRoot) {
  const raw = String(url || '');
  if (!raw.startsWith('/@export/')) return null;
  let relative;
  try { relative = decodeURIComponent(raw.slice('/@export/'.length).split('?')[0]); } catch { return null; }
  const match = /^([^/]+)\/media\/(.+)$/.exec(relative);
  if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..')) return null;
  const base = path.resolve(exportRoot, `export-${match[1]}/media`);
  const file = path.resolve(base, match[2]);
  return file.startsWith(base + path.sep) ? file : null;
}

/** URL types that previously relied on local paths for stamping: only these need to query the asset service */
function needsServiceStamp(m) {
  if (m?.path) return true;
  const url = String(m?.url || '');
  return url.startsWith('/api/media/file?') || url.startsWith('/@media/');
}

/**
 * Creates a stamper.
 *
 *   `mediaUrl(m)`  → Absolute HTTP URL for this asset on the asset service; returns null if unreachable;
 *   `exportRoot()` → Directory where `/@export/` URLs reside;
 *   `fetch` / `now` / `ttlMs` substituted for unit testing.
 *
 * `stamp(m)` returns a stamp (string); returns undefined if it should not be stamped.
 */
export function createMediaStamper({ mediaUrl = () => null, exportRoot = () => null, fetch: doFetch = globalThis.fetch, now = Date.now, ttlMs = MEDIA_STAMP_TTL_MS, timeoutMs = MEDIA_STAMP_TIMEOUT_MS, ownership = null } = {}) {
  /** url → { at, value: Promise<string> }: stores a Promise so concurrent requests at the same time share a single HEAD */
  const cache = new Map();
  const head = url => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = (async () => {
      try {
        const res = await doFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return 'missing';
        return `${res.headers.get('content-length') ?? ''}:${res.headers.get('last-modified') ?? ''}`;
      } catch { return 'missing'; }
    })();
    cache.set(url, { at: now(), value });
    // Clean up expired entries along the way, avoiding having a long-running prerender process accumulate every URL it has seen
    if (cache.size > 256) for (const [key, entry] of cache) if (now() - entry.at >= ttlMs) cache.delete(key);
    return value;
  };
  return {
    async stamp(m) {
      await ownership?.assert();
      if (ownership && m?.projectId && m.projectId !== ownership.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
      const hash = mediaHashOf(m);
      if (hash) return hash;
      const exported = exportMediaFile(m?.url, exportRoot() || '.');
      if (exported && !ownership) {
        try { const stat = await fs.stat(exported); return `${stat.size}:${stat.mtimeMs}`; }
        catch { return 'missing'; }
      }
      if (!needsServiceStamp(m)) return undefined;
      const url = mediaUrl(m);
      if (!url) return 'missing';
      return head(url);
    },
    /** Diagnostics / unit tests: number of entries in the cache */
    get size() { return cache.size; },
  };
}
