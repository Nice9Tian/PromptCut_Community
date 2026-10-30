/**
 * 文档服务骨架的连通性探针：真正发起一条 WebSocket 连接，按渲染节点、发布方的身份报到，逐项断言回包。
 *
 * 跑：node scripts/probes/ws-client-test.mjs [ws://host:port]      缺省 ws://127.0.0.1:8787
 * 只用 Node 内置的 WebSocket 与 fetch（Node >= 22），不装依赖。全过退出码 0，有失败 1，连不上 2。
 * 退出前先等连接的 close 事件（最多 CLOSE_WAIT_MS）：关闭握手没完成就 process.exit，Windows 上 libuv 会断言
 * `!(handle->flags & UV_HANDLE_CLOSING)` 崩掉（远端多一个往返时必现）。
 *
 * 凭证（M6a，`docs/plan/auth-contract.md` 第 5、11 节；集群令牌已退出数据面，本探针不再读它）：
 * - 设了环境变量 PROMPTCUT_SHARED_CONFIG（指向共享项目配置 JSON）：取它的第一项，凭项目证明以 `render` 角色进入
 *   （node.hello 只许 render 连接），并断言服务端只回显 `promptcut.v1`；没给地址参数时连配置里的 `url`；
 * - 没设：不带子协议（旧客户端）。连本机回环时是本机身份；连别的机器会被 401。
 * 配置文件里的口令、派生密钥与证明都不打印。
 *
 * 断言依据：`docs/plan/render-queue-contract.md` A.6（node.hello → node.welcome、publisher.hello → publisher.welcome、
 * queue.watch → queue.snapshot、格式错误 → error bad-message），以及 server/docservice/service.mjs 的 /healthz
 * （G.4：有 protocol === 'promptcut.v1' 和模块名数组 modules）。
 */
let sharedEntry = null;
let sharedProtocolsOf = null;
if (process.env.PROMPTCUT_SHARED_CONFIG) {
  const { loadSharedConfig, sharedProtocols } = await import('../../server/auth/shared-config.mjs');
  [sharedEntry] = loadSharedConfig();
  sharedProtocolsOf = sharedProtocols(sharedEntry, { role: 'render' });
}
const url = process.argv[2] ?? sharedEntry?.url ?? 'ws://127.0.0.1:8787';
const TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 3_000;
const nodeId = `probe-node-${process.pid}`;
const publisherId = `probe-page-${process.pid}`;
/** 这一次握手的子协议：共享项目配置的每次现取（nonce 只能用一次） */
let protocols;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** 连接失败时也要拿到这条 socket，好等它关干净 */
let socket;
async function connect() {
  if (sharedProtocolsOf) protocols = await sharedProtocolsOf();
  return new Promise((resolve, reject) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    socket = ws;
    const t = setTimeout(() => { ws.close(); reject(new Error(`${TIMEOUT_MS} ms 内没连上`)); }, TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(ws); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message ?? '连接出错')); }, { once: true });
  });
}

/** 发一条带 reqId 的消息，等 reqId 相同的回包；返回 { msg, rttMs } */
function request(ws, message) {
  return new Promise((resolve, reject) => {
    const sentAt = performance.now();
    const onMessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.reqId !== message.reqId) return;
      cleanup();
      resolve({ msg, rttMs: Math.round(performance.now() - sentAt) });
    };
    const t = setTimeout(() => { cleanup(); reject(new Error(`${message.type} 在 ${TIMEOUT_MS} ms 内没有回包`)); }, TIMEOUT_MS);
    const cleanup = () => { clearTimeout(t); ws.removeEventListener('message', onMessage); };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

/** 关连接并等 close 事件，最多 CLOSE_WAIT_MS；已经关上的直接返回 */
function closeAndWait(ws, code, reason) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, CLOSE_WAIT_MS);
    t.unref();
    ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
    if (ws.readyState !== WebSocket.CLOSING) {
      try { if (code === undefined) ws.close(); else ws.close(code, reason); } catch { /* 已在关 */ }
    }
  });
}

/** 跑一遍，返回退出码；每条出口都先等连接关干净 */
async function run() {
  console.log(`target ${url}  credential ${sharedEntry ? 'shared-project' : 'none'}`);
  let ws;
  const t0 = performance.now();
  try {
    ws = await connect();
  } catch (err) {
    check('WebSocket 握手', false, err.message);
    await closeAndWait(socket);
    return 2;
  }
  check('WebSocket 握手', true, `${Math.round(performance.now() - t0)} ms`);
  if (protocols) check('子协议只回显 promptcut.v1', ws.protocol === 'promptcut.v1', `protocol=${JSON.stringify(ws.protocol)}`);

  try {
    // 1. 渲染节点报到
    const hello = {
      type: 'node.hello', reqId: 'hello-1', nodeId, profile: 'host',
      capabilities: { transcode: false }, codeVersions: [], maxConcurrent: 1,
    };
    console.log(`>>> ${JSON.stringify(hello)}`);
    const { msg: welcome, rttMs } = await request(ws, hello);
    console.log(`<<< ${JSON.stringify(welcome)}`);
    check('node.hello → node.welcome', welcome.type === 'node.welcome', `${rttMs} ms`);
    check('welcome.nodeId 回显', welcome.nodeId === nodeId);
    check('welcome 带 resumed / lost 数组', Array.isArray(welcome.resumed) && Array.isArray(welcome.lost));
    check('welcome 带队列 epoch', typeof welcome.epoch === 'string' && welcome.epoch.length > 0);

    // 2. 同一连接再以发布方报到（契约 A.5：一条连接可以两者都是）
    const { msg: pub } = await request(ws, { type: 'publisher.hello', reqId: 'hello-2', publisherId });
    check('publisher.hello → publisher.welcome', pub.type === 'publisher.welcome' && pub.publisherId === publisherId);

    // 3. 节点订阅队列
    const { msg: snap } = await request(ws, { type: 'queue.watch', reqId: 'watch-1', projects: 'all' });
    check('queue.watch → queue.snapshot', snap.type === 'queue.snapshot' && Array.isArray(snap.tasks), `tasks=${snap.tasks?.length}`);

    // 4. 格式错误的消息
    const { msg: bad } = await request(ws, { type: 'node.hello', reqId: 'bad-1', nodeId, profile: 'toaster' });
    check('格式错误 → error bad-message', bad.type === 'error' && bad.reason === 'bad-message', bad.detail);

    // 5. 服务端记下了这条连接的身份（HTTP 同端口）
    const health = await fetch(url.replace(/^ws/, 'http').replace(/\/?$/, '/healthz')).then((r) => r.json());
    console.log(`healthz ${JSON.stringify(health)}`);
    check('healthz 里记到节点与发布方', health.ok === true && health.nodes >= 1 && health.publishers >= 1);
    check('healthz.protocol 是 promptcut.v1', health.protocol === 'promptcut.v1', `protocol=${JSON.stringify(health.protocol)}`);
    check('healthz.modules 是模块名数组', Array.isArray(health.modules) && health.modules.every((m) => typeof m === 'string'), JSON.stringify(health.modules));
    // 按空间各起一份队列（auth-contract 第 6 节）：/healthz 的 epoch 是本机（local）空间那一份；凭共享项目进入时 welcome 是项目空间的
    if (sharedEntry) check('healthz 带队列 epoch', typeof health.epoch === 'string' && typeof welcome.epoch === 'string');
    else check('healthz 带队列 epoch', health.epoch === welcome.epoch);
    if (protocols) check('healthz 里没有证明', !JSON.stringify(health).includes(protocols[1]));
  } catch (err) {
    check('请求过程', false, err.message);
  }

  await closeAndWait(ws, 1000, 'probe done');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed ? 1 : 0;
}

// 不用 process.exit 抢在句柄关完之前退出：设退出码，让事件循环自然结束；
// 万一还有别的句柄挡着，再用 unref 的计时器兜底（没东西挡时它不会触发）
const code = await run();
process.exitCode = code;
setTimeout(() => process.exit(code), 0).unref();
