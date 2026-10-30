/**
 * `global-setup.mjs` 的自检：坏端口名单与本机 Node 的 fetch 一致；`npm test` 下这些端口都被占着（不论谁占）。
 * 跑：npm test（单独跑本文件时没有全局准备，第二条跳过）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { FETCH_BAD_PORTS } from './global-setup.mjs';

const causeOf = async (port) => {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return 'ok';
  } catch (err) {
    return String(err?.cause?.message ?? err?.cause?.code ?? err?.name);
  }
};

test('名单里的每个端口，本机 fetch 都报 bad port；名单之外的邻号不报', async () => {
  for (const port of FETCH_BAD_PORTS) assert.equal(await causeOf(port), 'bad port', `端口 ${port}`);
  for (const port of [1718, 6001, 6670, 10081]) assert.notEqual(await causeOf(port), 'bad port', `端口 ${port}`);
});

const listenCode = (port, host) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', (err) => resolve(err.code));
  server.listen(port, host, () => server.close(() => resolve('listening')));
});

// 不变式：名单里每个坏端口，测试期间都 listen 不到——本次全局准备占着，或并行的另一份 npm test、别的程序占着都算。
// 并行跑时后起的那份启动时可能一个都没占到，所以不核对「本次自己占到了多少」。
test('npm test 下名单里每个坏端口在 127.0.0.1 上都被占着，listen 拿不到', async (t) => {
  if (process.env.PROMPTCUT_TEST_BAD_PORTS_HELD === undefined) { t.skip('没有经 npm test 的全局准备（单独跑本文件）'); return; }
  for (const port of FETCH_BAD_PORTS) assert.equal(await listenCode(port, '127.0.0.1'), 'EADDRINUSE', `端口 ${port}`);
});
