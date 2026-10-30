/** TMP配置＋真实stage runtime；仅拥有当前测试子树，可控真实文件流_destroy用于关闭证据。 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { startHostedAssetService } = await import(pathToFileURL(config.runtimeFile));
const gates = new Map();
const tls = name => ({ key: fs.readFileSync(config[name + 'Key']), cert: fs.readFileSync(config[name + 'Cert']), ca: fs.readFileSync(config.caFile) });
let sequence = 0;
const service = await startHostedAssetService({ dataDir: config.dataDir, port: config.assetPort, internalPort: config.assetInternalPort, publicUrl: `http://127.0.0.1:${config.assetPort}/api/asset`,
  doc: { authorityId: config.authorityId, origin: config.docOrigin, serverFingerprint256: config.docPin, tls: tls('asset') },
  internalTls: tls('asset'), docFingerprint256: config.docPin, recoveryFence: config.recoveryFence, allowFixtureRecoveryFence: true,
  wrapStore: (_id, ns, store) => new Proxy(store, { get(target, key) {
    if (key !== 'read' || ns !== 'media') return Reflect.get(target, key);
    return async (...args) => {
      const source = await target.read(...args); if (!source) return source;
      const id = ++sequence, original = source._destroy.bind(source);
      source._destroy = (error, callback) => { gates.set(id, () => original(error, callback)); process.send({ event: 'destroy-gated', id, closed: source.closed, fd: source.fd }); };
      source.once('close', () => process.send({ event: 'actual-close', id, closed: source.closed, fd: source.fd }));
      return source;
    };
  } }),
});
process.send({ event: 'started', instanceId: service.instanceId });
process.on('message', async message => {
  if (message.type === 'release') { const resume = gates.get(message.id); gates.delete(message.id); resume?.(); }
  if (message.type === 'close') { await service.close(); process.send({ event: 'clean-close' }); process.disconnect(); }
});
