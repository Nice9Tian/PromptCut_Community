/** 只给测试用的素材服务入口：和生产入口 server/hosted/asset-main.mjs 读同一组环境变量、起同一个运行时
 * （从当前目录下那份按部署清单拼出来的文件里载入），多一样：父进程经进程间通道说 close 时正常收口再退出。
 *
 * 为什么要它：素材服务没正常收口就被结束的话，下次启动要 root 给的「旧实例确实关干净了」的证明才肯起
 * （server/hosted/asset-lifecycle.mjs）。这台机器是 Windows，结束子进程只有硬杀一种，给不出那份证明；
 * 所以测「素材服务停了一阵再起来」时，用这个入口让它正常停。不含运行素材那一组配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const file = name => fs.readFileSync(env[name]);
const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ event, ...fields }) + '\n');
const { startHostedAssetService } = await import(pathToFileURL(path.resolve('cloud/server/hosted/asset-runtime.mjs')));
const ca = file('PROMPTCUT_ASSET_DOC_CA_FILE');
let service;
try {
  service = await startHostedAssetService({ dataDir: env.PROMPTCUT_ASSET_DATA_DIR, host: env.PROMPTCUT_ASSET_HOST || '127.0.0.1',
    port: Number(env.PROMPTCUT_ASSET_PORT), internalPort: Number(env.PROMPTCUT_ASSET_INTERNAL_PORT), publicUrl: env.PROMPTCUT_ASSET_PUBLIC_URL,
    doc: { authorityId: env.PROMPTCUT_ASSET_DOC_AUTHORITY_ID, origin: env.PROMPTCUT_ASSET_DOC_ORIGIN,
      serverFingerprint256: env.PROMPTCUT_ASSET_DOC_FINGERPRINT256,
      tls: { key: file('PROMPTCUT_ASSET_CLIENT_KEY_FILE'), cert: file('PROMPTCUT_ASSET_CLIENT_CERT_FILE'), ca } },
    internalTls: { key: file('PROMPTCUT_ASSET_INTERNAL_KEY_FILE'), cert: file('PROMPTCUT_ASSET_INTERNAL_CERT_FILE'), ca },
    docFingerprint256: env.PROMPTCUT_ASSET_DOC_CLIENT_FINGERPRINT256, log });
  log('asset.listen', { port: service.port, internalPort: service.internalPort, instanceId: service.instanceId, ready: service.ready });
} catch (error) { log('asset.config-error', { code: error.code ?? error.message ?? 'asset-configuration' }); process.exitCode = 1; process.disconnect?.(); }
if (service) process.on('message', message => {
  if (message?.type !== 'close') return;
  void service.close().then(() => { log('asset.closed'); }, () => { log('asset.close-failed'); process.exitCode = 1; })
    .finally(() => process.disconnect());
});
