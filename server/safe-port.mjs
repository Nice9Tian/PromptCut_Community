/**
 * 让系统分配端口时避开「坏端口」。只用 Node 内置模块。
 *
 * 背景：WHATWG fetch 规范「bad port」一节列了一张端口表，浏览器（Chromium 报 `ERR_UNSAFE_PORT`）
 * 和 Node 的 `fetch` / 内置 `WebSocket`（undici，报 `bad port`）都拒绝连这些端口，连都不连。
 * 有的机器把 TCP 动态端口段改到了低段（例如从 1024 起），`listen(0)` 就可能拿到 1719、6000、
 * 6665～6669、10080 这些号，起起来的服务从浏览器和 Node 那边都连不上。
 *
 * 用法：本来写 `server.listen(0, host, cb)` 的地方，改成 `const port = await listenSafe(server, host)`。
 * 拿到坏端口就关掉重来，最多 20 次。
 */

/**
 * WHATWG fetch 规范「bad port」表，全表（含 1～1023 里的那些）。
 * 与 Chromium 的受限端口表一致；本机 Node 24 的 fetch 实测拒绝的端口（1～11000 扫过）与本表除 0 外逐个相同。
 * 0 在规范表里，但 `listen(0)` 不会返回 0，放进来只为和规范一致。
 */
export const UNSAFE_PORTS = Object.freeze([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995,
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const UNSAFE_SET = new Set(UNSAFE_PORTS);

/** 这个端口浏览器 / fetch 会不会拒绝连 */
export function isUnsafePort(port) {
  return UNSAFE_SET.has(Number(port));
}

/** 最多试几次 */
export const LISTEN_SAFE_TRIES = 20;

function listenOnce(server, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    if (host === undefined) server.listen(0);
    else server.listen(0, host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * 在 `host` 上 `listen(0)`，拿到坏端口就关掉重来，最多 {@link LISTEN_SAFE_TRIES} 次。
 * 成功时 server 保持监听，返回端口号；试满仍是坏端口就关掉 server 并抛错。
 * `server` 只要有 `listen` / `close` / `address` 和 `once` / `off` 事件接口（`net.Server`、`http.Server` 都行）。
 *
 * @param {import('node:net').Server} server
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export async function listenSafe(server, host) {
  const got = [];
  for (let i = 0; i < LISTEN_SAFE_TRIES; i++) {
    const port = await listenOnce(server, host);
    if (!isUnsafePort(port)) return port;
    got.push(port);
    await closeServer(server);
  }
  throw new Error(`listenSafe: ${LISTEN_SAFE_TRIES} 次都拿到坏端口（${got.join(', ')}）`);
}
