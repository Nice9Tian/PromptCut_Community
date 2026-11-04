/**
 * Standalone document service. Can run locally, on another machine in the LAN, or in the public
 * cloud, using the same protocol (`docs/semantics/product/document-service.md` "Deployment
 * Combinations"). The hosted side (Alibaba Cloud) is this service.
 *
 * Run: node server/docservice/main.mjs
 * Environment variables:
 *   PROMPTCUT_DOCSERVICE_PORT   default 8787
 *   PROMPTCUT_DOCSERVICE_HOST   default 0.0.0.0
 *   PROMPTCUT_CLUSTER_TOKEN     Cluster token, guards only management endpoints (service address
 *                               registration, management HTTP, migration export), grants no data
 *                               plane permissions
 *   PROMPTCUT_DOCSERVICE_DATA   Data directory, defaults to <deployment-dir>/data (../../data
 *                               relative to this file):
 *                                 Project version logs and content store for the local (`local`)
 *                                 space live under it; shared project spaces are in
 *                                 `tenants/<projectId>/`, credential store is in `auth/`
 *   PROMPTCUT_DEVICE_ID / PROMPTCUT_DEVICE_NAME  Local device info (used for local declarations,
 *                                                generated from hostname by default)
 *   PROMPTCUT_TRUST_LOOPBACK    Trust loopback (`docs/plan/http-transport-contract.md` Section 10):
 *                                 1 (default) loopback origin counts as local; 0 does not
 *                                 (handshakes and shared endpoints are treated as remote, used when
 *                                 deployed behind a reverse proxy); cluster token is required in
 *                                 this case
 *
 * Authentication (`docs/plan/auth-contract.md` Section 5): members enter with shared project proof
 * or connection ticket; loopback origin with no credentials is local identity; providing the valid
 * cluster token is admin identity, which can only use management endpoints.
 *
 * Fail closed (Section 10):
 *   - Token set but format invalid (requires 32-256 base64url characters) → logs
 *     `config.error { reason: 'bad-token-format' }`, exit code 1;
 *   - Bound to non-loopback address but credential store fails to load (data directory not writable,
 *     `auth/` read failure) → `config.error { reason: 'auth-store' }`, exit code 1;
 *   - `PROMPTCUT_TRUST_LOOPBACK` is not 0 or 1 → `config.error { reason: 'trust-loopback' }`;
 *     is 0 without a token set → `config.error { reason: 'cluster-token-required' }`, exit code 1;
 *   - Starts normally if no token is set; management endpoints (handshakes with token) all return 401.
 *   Starts normally if credential store fails to load when bound only to loopback: only local
 *   identity can be used, and shared endpoints return 503.
 *
 * Generate token (32 random bytes as base64url, 43 characters):
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
 * Tokens are only kept in environment variables, never committed to repository or passed on CLI;
 * logs record only rejection reasons, never tokens.
 *
 * Depends only on Node built-in modules, `server/docservice/` (including `modules/`, `store/`),
 * `server/auth/`, and `server/render-queue/`; copying these three directories is sufficient
 * for deployment (`cloud/scripts/remote/docservice.mjs deploy`).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTokenFormat, isLoopbackHost } from './auth.mjs';
import { createSharedDocService } from './shared-service.mjs';
import { openCredentialStore } from '../auth/store.mjs';
import { localDeviceInfo } from '../auth/device.mjs';

function log(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/** Configuration error: write the same line to stdout and stderr, then exit with code 1 */
function configError(reason, extra = {}) {
  const line = `${JSON.stringify({ t: new Date().toISOString(), event: 'config.error', reason, ...extra })}\n`;
  process.stdout.write(line);
  process.stderr.write(line);
  process.exitCode = 1;
}

async function main() {
  const port = Number(process.env.PROMPTCUT_DOCSERVICE_PORT ?? 8787);
  const host = process.env.PROMPTCUT_DOCSERVICE_HOST ?? '0.0.0.0';
  const rawToken = process.env.PROMPTCUT_CLUSTER_TOKEN;
  const token = rawToken === '' ? undefined : rawToken;

  if (token !== undefined && !checkTokenFormat(token)) return configError('bad-token-format');
  const rawTrust = process.env.PROMPTCUT_TRUST_LOOPBACK;
  if (rawTrust !== undefined && rawTrust !== '' && rawTrust !== '0' && rawTrust !== '1') return configError('trust-loopback');
  const trustLoopback = rawTrust !== '0';
  if (!trustLoopback && token === undefined) return configError('cluster-token-required');

  const dataDir = process.env.PROMPTCUT_DOCSERVICE_DATA
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
  let store = null;
  try {
    store = openCredentialStore({ dir: path.join(dataDir, 'auth'), log });
  } catch (err) {
    // Error message contains only path and system error code, no credential content
    if (!isLoopbackHost(host)) return configError('auth-store', { message: String(err?.code ?? err?.message ?? err) });
    log('auth.store.unavailable', { message: String(err?.code ?? err?.message ?? err) });
  }

  const { service } = createSharedDocService({
    mode: 'hosted',
    dataDir,
    store,
    clusterToken: token,
    trustLoopback,
    localDevice: localDeviceInfo(),
    log,
  });

  const addr = await service.listen(port, host);
  log('listen', {
    host: addr.address, port: addr.port, node: process.version,
    admin: token === undefined ? 'disabled' : 'token', loopbackTrust: trustLoopback, authStore: store ? 'ok' : 'unavailable', dataDir,
  });

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      service.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

await main();
