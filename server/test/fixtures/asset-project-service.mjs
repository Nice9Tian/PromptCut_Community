/** 独立素材 HTTP 测试夹具：实际素材模块，合成 opaque 权威；不冒称生产doc已接线。 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createProjectAssetStores } from '../../asset-store/project-stores.mjs';
import { createProjectAssetAccess } from '../../asset-store/project-access.mjs';
const ts = createRequire(import.meta.url)('typescript');
const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export function compileAssetModules(out) {
  const compiled = new Map();
  function compile(file) {
    if (compiled.has(file)) return compiled.get(file);
    const dest = path.join(out, path.relative(ROOT, file).replace(/[\\/]/g, '__').replace(/\.ts$/, '.mjs'));
    const url = pathToFileURL(dest).href;
    compiled.set(file, url);
    const rewrite = spec => {
      const base = path.resolve(path.dirname(file), spec);
      const hit = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts')].find(p => fs.existsSync(p) && fs.statSync(p).isFile());
      return hit ? hit.endsWith('.ts') ? compile(hit) : pathToFileURL(hit).href : spec;
    };
    let source = fs.readFileSync(file, 'utf8');
    source = source.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.\.?\/[^"']+)\2/g, (_, a, q, spec) => `${a}${q}${rewrite(spec)}${q}`);
    fs.writeFileSync(dest, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText);
    return url;
  }
  return Promise.all([import(compile(path.join(ROOT, 'server/asset-service.ts'))), import(compile(path.join(ROOT, 'server/vite-plugin-media.ts'))), import(compile(path.join(ROOT, 'server/vite-plugin-shots.ts')))]).then(([asset, media, shots]) => ({ asset, media, shots }));
}

export async function startAssetProjectFixture({ port = 0, out = null, wrapStore = null } = {}) {
  out ??= await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-asset-project-http-'));
  await fsp.mkdir(out, { recursive: true });
  const { asset, media, shots } = await compileAssetModules(out);
  const principals = new Map();
  for (const projectId of ['A', 'B']) for (const access of ['r', 'rw']) principals.set(`${projectId}-${access}`, { projectId, access, accountId: `u-${projectId}`, loginId: `l-${projectId}`, credentialId: `c-${projectId}`, authorizationId: `doc-opaque-${projectId}-${access}` });
  const revoked = new Set(), subscribers = new Map();
  let checks = 0;
  const authority = {
    async checkAccess({ principal, projectId, action }) {
      checks++;
      const known = [...principals.values()].find(p => p.authorizationId === principal?.authorizationId);
      return { allowed: !!known && known.projectId === projectId && principal.projectId === projectId && !revoked.has(projectId) && (action === 'read' || principal.access === 'rw'), accessRevision: 1, revocationSeq: revoked.size };
    },
    subscribeRevocations(context, callback) { const key = Symbol(); subscribers.set(key, { context, callback }); return () => subscribers.delete(key); },
  };
  const projectAccess = createProjectAssetAccess({ authority, resolvePrincipal: async req => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const query = new URL(req.url, 'http://fixture.local').searchParams.get('t');
    const p = principals.get(bearer ?? query);
    if (!p || (!bearer && p.access !== 'r')) return null;
    return p;
  } });
  const factory = createProjectAssetStores({ dir: path.join(out, 'assets'), contentTypeForExt: media.contentTypeForExt });
  const projectStores = wrapStore ? { project: id => { const p = factory.project(id); return { ...p, stores: Object.fromEntries(Object.entries(p.stores).map(([ns, store]) => [ns, wrapStore(id, ns, store)])) }; } } : factory;
  const opts = { projectStores, projectAccess, pullArtifact: null, pxEvict: null };
  const a = asset.assetServiceMiddleware(out, opts);
  const m = media.mediaMiddleware(out, { ...opts, verifyRemoteTarget: async (_req, target) => ({ ...target, projectId: principals.get(target.ticket)?.projectId }) });
  const thumbnail = shots.shotsThumbMiddleware(out, opts);
  const server = http.createServer((req, res) => { void a(req, res, () => { void m(req, res, () => { void thumbnail(req, res, () => { res.statusCode = 404; res.end('no route'); }); }); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  port = server.address().port;
  return {
    out, base: `http://127.0.0.1:${port}`, factory, projectAccess, authority, media, shots,
    get checks() { return checks; },
    async revoke(projectId) { revoked.add(projectId); await Promise.all([...subscribers.values()].filter(s => s.context.projectId === projectId).map(s => s.callback({ eventId: `revoke-${projectId}`, reason: 'kicked' }))); },
    async close() { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
  };
}
