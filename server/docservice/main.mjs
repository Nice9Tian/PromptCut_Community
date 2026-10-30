/**
 * 独立运行的文档服务。可以跑在本机、局域网里的另一台机器或公网云端，协议相同
 * （`docs/semantics/product/document-service.md`「部署组合」）。托管端（阿里云）就是它。
 *
 * 跑：node server/docservice/main.mjs
 * 环境变量：
 *   PROMPTCUT_DOCSERVICE_PORT   缺省 8787
 *   PROMPTCUT_DOCSERVICE_HOST   缺省 0.0.0.0
 *   PROMPTCUT_CLUSTER_TOKEN     集群令牌，只守管理接口（服务地址登记、管理 HTTP、迁移导出），不给数据面任何权限
 *   PROMPTCUT_DOCSERVICE_DATA   数据目录，缺省 <部署目录>/data（相对本文件的 ../../data）：
 *                                 本机（`local`）空间的项目版本日志、内容库在它下面，
 *                                 共享项目的空间在 `tenants/<projectId>/`，凭证存储在 `auth/`
 *   PROMPTCUT_DEVICE_ID / PROMPTCUT_DEVICE_NAME  本机设备信息（本机声明用，缺省按主机名生成）
 *   PROMPTCUT_TRUST_LOOPBACK    本机信任（`docs/plan/http-transport-contract.md` 第 10 节）：1（缺省）回环来源算本机；
 *                                 0 不算（握手与共享端点都按远端对待，部署在反向代理之后时用），此时必须有集群令牌
 *
 * 鉴权（`docs/plan/auth-contract.md` 第 5 节）：成员凭共享项目的证明或连接票据进入；回环来源什么都不带是本机身份；
 * 带对集群令牌的是管理身份，只能用管理接口。
 *
 * 失败即关（第 10 节）：
 *   - 设了令牌但格式不对（要 32～256 个 base64url 字符）→ 打 `config.error { reason: 'bad-token-format' }`，退出码 1；
 *   - 绑非回环地址而凭证存储加载不了（数据目录不可写、`auth/` 读失败）→ `config.error { reason: 'auth-store' }`，退出码 1；
 *   - `PROMPTCUT_TRUST_LOOPBACK` 不是 0 或 1 → `config.error { reason: 'trust-loopback' }`；是 0 而没设令牌 →
 *     `config.error { reason: 'cluster-token-required' }`，退出码 1；
 *   - 没设令牌照常启动，管理接口（带令牌的握手）全部 401。
 *   只绑回环时凭证存储加载不了照常启动：只有本机身份能用，共享端点回 503。
 *
 * 生成令牌（32 字节随机数的 base64url，43 个字符）：
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
 * 令牌只放在环境变量里，不写进仓库、不上命令行；日志里只记拒绝原因，不记令牌。
 *
 * 只依赖 Node 内置模块、`server/docservice/`（含 `modules/`、`store/`）、`server/auth/` 和 `server/render-queue/`，
 * 部署时拷这三个目录即可（`cloud/scripts/remote/docservice.mjs deploy`）。
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

/** 配置错误：同一行写到 stdout 与 stderr，然后以退出码 1 结束 */
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
    // 错误信息里只有路径与系统错误码，没有凭证内容
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
