/**
 * `/api/storage*`(存储占用计划第 4 节的前三条;`/api/exports*` 归界面那一支)。
 *
 *   GET  /api/storage               { ok, frameLibrary: { bytes, capBytes, capSource, diskBytes, pinnedBytes, scannedAt, lastEvict, … },
 *                                     exports: { bytes, count, intermediateBytes }, leftovers: { bytes } }
 *                                   `?detail=1` 另带 `frameLibrary.units`(每个淘汰单元的最近使用时刻、字节数、保护与否)和
 *                                   `frameLibrary.lastEvictDetail`(上一轮删了哪些、跳过哪些),给探针和诊断。
 *                                   上一次检查早于 60 秒时先在后台发起一次量(只量不淘汰,`refreshIfStale`),
 *                                   这次回包照旧立刻回,`frameLibrary.scanning` 为 true;界面见到它隔几秒再取
 *   POST /api/storage/cap           { bytes }  → { ok, capBytes };越界 400 `CAP_OUT_OF_RANGE`(带 min / max)。设了立即判一次(不等删完)
 *   POST /api/storage/clear-cache   → { ok, freedBytes, removed, skipped }(删完才回)
 *
 * 只在预渲染进程里答(它是帧库的主要写入方,扫描与淘汰在它这里);编辑器进程原样转过去(`vite-plugin-frames.ts`)。
 * 都在 `/api` 同源守卫之后(`vite-plugin-api-guard.ts` 排在全部插件之前)。在线构建没有 dev server,也没有这些路由。
 */

/** 挂在 `/api/storage` 下时,connect 剥掉前缀之后剩下的路径 */
export const STORAGE_ROUTES = ['/', '/cap', '/clear-cache'];

/** 这个请求是不是 `/api/storage*` 的三条之一(不是就 `next()`) */
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
    req.on('data', chunk => { body += chunk; if (body.length > limit) { reject(Object.assign(new Error('请求体太大'), { status: 413 })); req.destroy(); } });
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
        // 上一次检查早于 60 秒:后台量一次(不挡这次回包;回包的 scanning 为 true,界面过几秒再取)
        try { manager.refreshIfStale?.(); } catch { /* 量不了不挡回包 */ }
        const [frameLibrary, exportsInfo] = await Promise.all([manager.summary({ detail }), exportSummary.get()]);
        const { leftoverBytes, ...library } = frameLibrary;
        return json(res, 200, { ok: true, frameLibrary: library, exports: exportsInfo, leftovers: { bytes: leftoverBytes } });
      }
      if (route === '/cap') {
        let input;
        try { input = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { ok: false, code: 'BAD_JSON', error: '请求体不是 JSON' }); }
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
