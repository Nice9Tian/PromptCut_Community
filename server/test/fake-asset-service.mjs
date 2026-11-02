/**
 * For testing only, must not be referenced by production code.
 *
 * Starts a real HTTP asset service (port 0), injecting memory implementations for all three
 * namespaces `media` / `snap` / `px` (Section 1 of contract `docs/plan/artifact-transfer-contract.md`).
 * Shared by three C6.2 test files: `asset-namespaces.test.mjs`, `asset-client.test.mjs`, and
 * `artifact-transfer.test.mjs`.
 *
 * `server/asset-service.ts` is transpiled to a temporary directory with typescript and then
 * imported following the approach in `asset-store-http.test.mjs`: relative imports in source code
 * (static and dynamic) are all converted to absolute URLs, `.ts` is transpiled recursively, and
 * `.mjs` / `.js` point directly to files in the repository.
 *
 *   const harness = createAssetHarness();          // each test handles after(() => harness.cleanup())
 *   const asset = await harness.asset();            // transpiled asset-service module
 *   const srv = await harness.serve({ chunkSize, tickets, isTrusted, stores, legacyStore });
 *   // srv = { origin, base, root, stores: { media, snap, px }, close() }
 *
 * Options for `serve`:
 *   - `chunkSize`: chunk size for the three memory implementations, default 8 MiB;
 *   - `stores`: custom provided three data layers (not recreated if provided);
 *     `'default'` = pass nothing, falling back to middleware default (fs implementation);
 *   - `tickets` / `isTrusted`: passed as is to `assetServiceMiddleware` (not passed if not provided,
 *     falling back to middleware default). Starting in M6a, asset service reads and writes with
 *     tickets, and cluster tokens are retired: `token` is still passed as is (middleware ignores
 *     it), solely to test that "providing it has no effect";
 *   - `legacyStore: true`: pass only `opts.store` (= media) using legacy syntax, without
 *     passing `opts.stores` (used by S3).
 */
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

function resolveRel(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.mjs')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

export function createAssetHarness() {
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-c62-asset-'));
  const compiled = new Map();
  const services = new Set();
  let ts = null;
  let assetMod = null, mediaMod = null, storeMod = null;
  let rootSeq = 0;

  function compileTs(absFile) {
    if (compiled.has(absFile)) return compiled.get(absFile);
    ts ||= require_('typescript');
    const rel = path.relative(ROOT, absFile).replace(/[\\/]/g, '__').replace(/\.ts$/, '');
    const outFile = path.join(OUT, `${rel}.mjs`);
    const url = pathToFileURL(outFile).href;
    compiled.set(absFile, url);
    let src = fs.readFileSync(absFile, 'utf8');
    const rewrite = (spec) => {
      const hit = resolveRel(absFile, spec);
      if (!hit) return spec;
      return hit.endsWith('.ts') ? compileTs(hit) : pathToFileURL(hit).href;
    };
    src = src.replace(/(\bfrom\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
    src = src.replace(/(\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
    src = src.replace(/(\bimport\s+)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
    const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
    fs.writeFileSync(outFile, js);
    return url;
  }

  async function asset() {
    mediaMod ||= await import(compileTs(path.join(ROOT, 'server', 'vite-plugin-media.ts')));
    assetMod ||= await import(compileTs(path.join(ROOT, 'server', 'asset-service.ts')));
    return assetMod;
  }
  async function blobStores() {
    storeMod ||= await import(pathToFileURL(path.join(ROOT, 'server', 'asset-store', 'index.mjs')).href);
    return storeMod;
  }
  async function memoryStore(chunkSize = 8 * 1024 * 1024) {
    return (await blobStores()).createBlobStore({ kind: 'memory', chunkSize });
  }

  async function serve({ chunkSize = 8 * 1024 * 1024, stores = null, token, tickets, isTrusted, legacyStore = false } = {}) {
    const a = await asset();
    const root = path.join(OUT, `project-${++rootSeq}`);
    fs.mkdirSync(mediaMod.mediaDir(root), { recursive: true });
    const useDefault = stores === 'default';
    const own = useDefault ? null : (stores ?? { media: await memoryStore(chunkSize), snap: await memoryStore(chunkSize), px: await memoryStore(chunkSize) });
    const opts = useDefault ? {} : legacyStore ? { store: own.media } : { stores: own };
    if (token !== undefined) opts.token = token;
    if (tickets !== undefined) opts.tickets = tickets;
    if (isTrusted !== undefined) opts.isTrusted = isTrusted;
    const service = a.assetServiceMiddleware(root, opts);
    const legacy = mediaMod.mediaMiddleware(root);
    const requests = new Set(), streams = new Set();
    const failures = [];
    const track = (set, promise) => {
      set.add(promise);
      void promise.then(() => set.delete(promise), error => { set.delete(promise); failures.push(error); });
      return promise;
    };
    const server = http.createServer((req, res) => {
      // A response may finish before its file descriptor closes. Register the source
      // at pipe time, before either HTTP close or the source close can be observed.
      res.on('pipe', source => {
        if (source.closed) return;
        track(streams, new Promise(resolve => source.once('close', resolve)));
        res.once('close', () => { if (!source.closed) source.destroy(); });
      });
      track(requests, (async () => {
        let fallback;
        await service(req, res, () => { fallback = legacy(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
        await fallback;
      })());
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let closing;
    const close = () => closing ??= (async () => {
      await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
      await Promise.all([...requests]);
      await Promise.all([...streams]);
      // Production deliberately shares this registry between module instances.
      // Only inspect this fixture's root: creating a service here would start new work.
      const registry = globalThis[Symbol.for('promptcut.media-tiers.services')];
      const pending = registry?.get(path.resolve(root));
      if (pending) {
        const { manager, queue } = await pending;
        await manager.idle(); // ffprobe/ffmpeg close, tiers index and enqueue finished
        if (queue) {
          await queue.stop();
          // stop aborts the upload but its catch/finally can still persist after it.
          const deadline = Date.now() + 30_000;
          while (queue.stats().working) {
            if (Date.now() >= deadline) throw new Error('asset fixture upload did not settle');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          await queue.stop(); // flush writes enqueued by the final pump
        }
        registry.delete(path.resolve(root));
      }
      if (failures.length) throw new AggregateError(failures, 'asset fixture request failed');
      services.delete(close);
    })();
    services.add(close);
    return { origin, base: `${origin}/api/asset`, root, stores: own, close, server };
  }

  async function cleanup() {
    await Promise.all([...services].map(close => close()));
    fs.rmSync(OUT, { recursive: true, force: true });
  }

  return { asset, serve, memoryStore, cleanup, compileTs };
}
