/**
 * Local document service + asset service used by probes, assembled entirely from public code,
 * with all data under `dataDir`.
 * Both mobile app probes (`mobile-env.mjs`) and direct execution of `hosted-proxy.mjs` connect to
 * it, so the community edition can also run it.
 *
 *   const s = await startProbeServices({ dataDir, docPort, assetPort, docPublicUrl, assetPublicUrl });
 *   s.service / s.stores / s.credentialStore / await s.close()
 *
 * Probes that need to launch a separate process run it directly, configured via environment
 * variables: `PROMPTCUT_DATA_DIR`, `PROMPTCUT_DOCSERVICE_PORT`, `PROMPTCUT_ASSET_PORT`.
 *
 * `mode: 'hosted'` in document service and the three namespaces in asset service are all public.
 * Only these two are started here, bound only to the local machine; when `trustLoopback` is false,
 * a cluster token is required.
 * Asset service middleware consists of `.ts` written in Vite style with extensionless relative
 * imports, so a resolution hook is registered first.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedDocService } from '../../../server/docservice/shared-service.mjs';
import { credentialStoreFor } from '../../../server/auth/store.mjs';
import { isLocalOrigin } from '../../../server/auth/origin.mjs';
import { createAssetTicketVerifier } from '../../../server/auth/asset-tickets.mjs';
import { createFsStore, ensureLayoutSync, LAYOUTS } from '../../../server/asset-store/fs-store.mjs';
import { startAssetAnnounce } from '../../../server/asset-announce.mjs';

const NAMESPACES = ['media', 'snap', 'px'];
const REGISTERED = Symbol.for('promptcut.probe.ts-resolve');

function registerTsResolve() {
  if (globalThis[REGISTERED]) return;
  globalThis[REGISTERED] = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context?.parentURL;
      if (parent?.startsWith('file:') && parent.endsWith('.ts') && /^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
        for (const ext of ['.ts', '.mjs', '.js']) {
          const candidate = new URL(specifier + ext, parent);
          if (fs.existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/** Content type of artifacts: `.m4s` and HTML snapshots, rest same as assets. */
const artifactContentType = (base) => (ext) => {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'html' || e === 'htm') return 'text/html; charset=utf-8';
  if (e === 'm4s') return 'video/iso.segment';
  return base(e);
};

export async function startProbeServices({ dataDir, docPort, assetPort, host = '127.0.0.1', docPublicUrl, assetPublicUrl, trustLoopback = true, clusterToken, log = () => {} }) {
  const docDir = path.join(dataDir, 'docservice');
  const assetDir = path.join(dataDir, 'assets');
  fs.mkdirSync(docDir, { recursive: true });
  const layout = ensureLayoutSync(assetDir, LAYOUTS.shard);
  if (!layout.ok) throw new Error(`Asset catalog layout mismatch: ${layout.found}`);

  registerTsResolve();
  const [assetService, media] = await Promise.all([
    import('../../../server/asset-service.ts'),
    import('../../../server/vite-plugin-media.ts'),
  ]);
  const stores = {};
  for (const ns of NAMESPACES) {
    const contentTypeForExt = ns === 'media' ? media.contentTypeForExt : artifactContentType(media.contentTypeForExt);
    stores[ns] = createFsStore({ dir: path.join(assetDir, ns), shard: true, hooks: { contentTypeForExt } });
  }

  const store = credentialStoreFor(path.join(docDir, 'auth'), { log });
  const tickets = createAssetTicketVerifier({ store: () => store });
  const assetMiddleware = assetService.assetServiceMiddleware(dataDir, { stores, tickets, isTrusted: (req) => trustLoopback && isLocalOrigin(req) });
  const preflight = assetService.assetPreflightMiddleware();
  const linkOrigin = docPublicUrl ? new URL(docPublicUrl).origin.replace(/^ws/, 'http') : null;
  const { service } = createSharedDocService({ mode: 'hosted', dataDir: docDir, store, trustLoopback, clusterToken, linkOrigin, log });

  const assetServer = http.createServer((req, res) => preflight(req, res, () => assetMiddleware(req, res, () => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"not-found"}');
  })));
  const docAddr = await service.listen(docPort, host);
  const assetAddr = await new Promise((resolve, reject) => {
    assetServer.once('error', reject);
    assetServer.listen(assetPort, host, () => resolve(assetServer.address()));
  });

  const publicUrl = assetPublicUrl || `http://127.0.0.1:${assetAddr.port}/api/asset`;
  let announcer;
  const announced = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    announcer = startAssetAnnounce({
      url: `ws://127.0.0.1:${docAddr.port}`, token: clusterToken, announcerId: 'asset:probe', urls: [publicUrl],
      log(event, fields) {
        log(event, fields);
        if (event === 'asset-announce.announced') { clearTimeout(timer); resolve(true); }
      },
    });
  });
  await announced;

  let closed = false;
  return {
    docPort: docAddr.port, assetPort: assetAddr.port, assetPublicUrl: publicUrl, service, stores, credentialStore: store,
    async close() {
      if (closed) return;
      closed = true;
      try { announcer.stop(); } catch { /* Stopped */ }
      await new Promise((resolve) => { assetServer.close(() => resolve()); assetServer.closeAllConnections?.(); });
      await service.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { PROMPTCUT_DATA_DIR: dataDir, PROMPTCUT_DOCSERVICE_PORT: docPort, PROMPTCUT_ASSET_PORT: assetPort } = process.env;
  await startProbeServices({ dataDir, docPort: Number(docPort), assetPort: Number(assetPort) });
}
