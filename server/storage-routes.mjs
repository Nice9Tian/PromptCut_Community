import { tr } from "./i18n.mjs";
/**
 * `/api/storage*` (the first three items in section 4 of the storage footprint plan;
 * `/api/exports*` belongs to the UI branch).
 *
 *   GET  /api/storage               { ok, frameLibrary: { bytes, capBytes, capSource, diskBytes, pinnedBytes, scannedAt, lastEvict, … },
 *                                     exports: { bytes, count, intermediateBytes }, leftovers: { bytes } }
 *                                   `?detail=1` also includes `frameLibrary.units` (most recent use
 *                                   timestamp, byte count, whether protected for each eviction unit)
 *                                   and `frameLibrary.lastEvictDetail` (what was deleted and skipped
 *                                   in the last round), for probes and diagnostics.
 *                                   If the last check was more than 60 seconds ago, initiates a
 *                                   measurement in the background first (measure only, no eviction,
 *                                   `refreshIfStale`); this response is still returned immediately
 *                                   as usual with `frameLibrary.scanning` set to true; the UI
 *                                   fetches again after a few seconds upon seeing it
 *   POST /api/storage/cap           { bytes }  → { ok, capBytes }; out of range 400 `CAP_OUT_OF_RANGE`
 *                                   (with min / max). Evaluates immediately once set (does not wait
 *                                   for deletion to finish)
 *   POST /api/storage/clear-cache   → { ok, freedBytes, removed, skipped } (returns only after deletion)
 *
 * Answered only in the prerender process (it is the primary writer of the frame store; scanning and
 * eviction take place here); the editor process forwards it as is (`vite-plugin-frames.ts`).
 * All are behind the `/api` same-origin guard (`vite-plugin-api-guard.ts` placed before all plugins).
 * Online builds have no dev server and none of these routes.
 */

/** The remaining path after connect strips the prefix when mounted under `/api/storage` */
export const STORAGE_ROUTES = ['/', '/cap', '/clear-cache'];

/** Whether this request is one of the three `/api/storage*` routes (if not, `next()`) */
export function storageRouteOf(req) {
  const pathname = String(req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (!STORAGE_ROUTES.includes(pathname)) return null;
  if (pathname === '/' && req.method !== 'GET') return null;
  if (pathname !== '/' && req.method !== 'POST') return null;
  return pathname;
}

const json = (res, status, data) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
};

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > limit) { reject(Object.assign(new Error(tr("Request body too large")), { status: 413 })); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * @param {object} options
 * @param {() => ReturnType<import('./frame-library-storage.mjs').createFrameLibraryStorage>} options.storage
 * @param {{ get: (o?: { fresh?: boolean }) => Promise<{ bytes: number, count: number, intermediateBytes: number }> }} options.exports
 */
export function createStorageHandler({ storage, exports: exportSummary }) {
  return async (req, res, next) => {
    const route = storageRouteOf(req);
    if (!route) return next();
    try {
      const manager = storage();
      if (route === '/') {
        const detail = new URL(req.url || '/', 'http://x').searchParams.get('detail') === '1';
        // Last check was over 60s ago: measure once in background (does not block this response;
        // response scanning is true, UI fetches again in a few seconds)
        try { manager.refreshIfStale?.(); } catch { /* Failure to measure does not block response */ }
        const [frameLibrary, exportsInfo] = await Promise.all([manager.summary({ detail }), exportSummary.get()]);
        const { leftoverBytes, ...library } = frameLibrary;
        return json(res, 200, { ok: true, frameLibrary: library, exports: exportsInfo, leftovers: { bytes: leftoverBytes } });
      }
      if (route === '/cap') {
        let input;
        try { input = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { ok: false, code: 'BAD_JSON', error: 'Request body is not JSON' }); }
        const bytes = Number(input?.bytes);
        const { capBytes } = await manager.setCap(bytes);
        return json(res, 200, { ok: true, capBytes });
      }
      req.resume();
      const result = await manager.clearCache();
      return json(res, 200, { ok: true, freedBytes: result.freedBytes, removed: result.removed, skipped: result.skipped });
    } catch (error) {
      const status = Number(error?.status) >= 400 ? Number(error.status) : 500;
      return json(res, status, { ok: false, code: error?.code || 'STORAGE_ERROR', error: error?.message || String(error),
        ...(error?.min !== undefined ? { min: error.min, max: error.max } : {}) });
    }
  };
}
