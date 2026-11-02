/** Test-only asset service entry point: reads the same environment variables and starts the same
 * runtime as the production entry point server/hosted/asset-main.mjs (loaded from the file in the
 * current directory assembled per deployment manifest), with one addition: shuts down gracefully
 * before exiting when the parent process sends close over the IPC channel.
 *
 * Why it is needed: if the asset service is terminated without a graceful shutdown, next startup
 * requires proof from root that "the old instance was cleanly shut down" before starting up
 * (server/hosted/asset-lifecycle.mjs). On Windows, killing child processes only offers hard-kill,
 * which cannot produce that proof; so when testing "asset service stops for a while and restarts",
 * this entry point lets it stop gracefully. Excludes the asset-running configuration set.
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
