/**
 * Connectivity probe for document service skeleton: genuinely initiates a WebSocket connection,
 * checks in as a render node or publisher identity, and asserts each response item by item.
 *
 * Run: node scripts/probes/ws-client-test.mjs [ws://host:port]      default ws://127.0.0.1:8787
 * Uses only Node built-in WebSocket and fetch (Node >= 22), without installing dependencies. Exit
 * code 0 if all pass, 1 on failure, 2 if unreachable.
 * Wait for connection close event before exiting (at most CLOSE_WAIT_MS): calling process.exit
 * before closing handshake finishes causes libuv on Windows to crash with assertion
 * `!(handle->flags & UV_HANDLE_CLOSING)` (reliably reproduced when remote side has an extra round
 * trip).
 *
 * Credentials (M6a, `docs/plan/auth-contract.md` sections 5 and 11; cluster tokens have exited the
 * data plane and are no longer read by this probe):
 * - If environment variable PROMPTCUT_SHARED_CONFIG is set (pointing to shared project config
 *   JSON): take its first entry, enter with `render` role using project proof (node.hello only
 *   allows render connections), and assert server only echoes `promptcut.v1`; connect to `url` in
 *   the config when no address argument is provided;
 * - If not set: without subprotocol (legacy client). Resolves to local identity when connecting to
 *   local loopback; gets 401 when connecting to other machines.
 * Passphrases, derived keys, and proofs in config files are never printed.
 *
 * Assertion basis: `docs/plan/render-queue-contract.md` A.6 (node.hello → node.welcome,
 * publisher.hello → publisher.welcome, queue.watch → queue.snapshot, malformed → error
 * bad-message), and server/docservice/service.mjs /healthz (G.4: has protocol === 'promptcut.v1'
 * and module name array modules).
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
/** Subprotocol for this handshake: fetched fresh each time for shared project configs (nonce can only be used once) */
let protocols;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** Also obtain this socket when connection fails to wait for it to close cleanly */
let socket;
async function connect() {
  if (sharedProtocolsOf) protocols = await sharedProtocolsOf();
  return new Promise((resolve, reject) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    socket = ws;
    const t = setTimeout(() => { ws.close(); reject(new Error(`Could not connect within ${TIMEOUT_MS} ms`)); }, TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(ws); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(e.message ?? 'Connection error')); }, { once: true });
  });
}

/** Send a message with reqId, wait for response with matching reqId; return { msg, rttMs } */
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
    const t = setTimeout(() => { cleanup(); reject(new Error(`${message.type} got no reply within ${TIMEOUT_MS} ms`)); }, TIMEOUT_MS);
    const cleanup = () => { clearTimeout(t); ws.removeEventListener('message', onMessage); };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify(message));
  });
}

/** Close connection and wait for close event, at most CLOSE_WAIT_MS; return directly if already closed */
function closeAndWait(ws, code, reason) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, CLOSE_WAIT_MS);
    t.unref();
    ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
    if (ws.readyState !== WebSocket.CLOSING) {
      try { if (code === undefined) ws.close(); else ws.close(code, reason); } catch { /* Already closing */ }
    }
  });
}

/** Run once, return exit code; each exit path first waits for connection to close cleanly */
async function run() {
  console.log(`target ${url}  credential ${sharedEntry ? 'shared-project' : 'none'}`);
  let ws;
  const t0 = performance.now();
  try {
    ws = await connect();
  } catch (err) {
    check('WebSocket handshake', false, err.message);
    await closeAndWait(socket);
    return 2;
  }
  check('WebSocket handshake', true, `${Math.round(performance.now() - t0)} ms`);
  if (protocols) check('Subprotocol echoes only promptcut.v1', ws.protocol === 'promptcut.v1', `protocol=${JSON.stringify(ws.protocol)}`);

  try {
    // 1. Render node checks in
    const hello = {
      type: 'node.hello', reqId: 'hello-1', nodeId, profile: 'host',
      capabilities: { transcode: false }, codeVersions: [], maxConcurrent: 1,
    };
    console.log(`>>> ${JSON.stringify(hello)}`);
    const { msg: welcome, rttMs } = await request(ws, hello);
    console.log(`<<< ${JSON.stringify(welcome)}`);
    check('node.hello → node.welcome', welcome.type === 'node.welcome', `${rttMs} ms`);
    check('welcome.nodeId echoed back', welcome.nodeId === nodeId);
    check('welcome carries resumed / lost arrays', Array.isArray(welcome.resumed) && Array.isArray(welcome.lost));
    check('welcome carries the queue epoch', typeof welcome.epoch === 'string' && welcome.epoch.length > 0);

    // 2. Same connection checks in again as publisher (contract A.5: one connection can be both)
    const { msg: pub } = await request(ws, { type: 'publisher.hello', reqId: 'hello-2', publisherId });
    check('publisher.hello → publisher.welcome', pub.type === 'publisher.welcome' && pub.publisherId === publisherId);

    // 3. Node subscribes to queue
    const { msg: snap } = await request(ws, { type: 'queue.watch', reqId: 'watch-1', projects: 'all' });
    check('queue.watch → queue.snapshot', snap.type === 'queue.snapshot' && Array.isArray(snap.tasks), `tasks=${snap.tasks?.length}`);

    // 4. Malformed message
    const { msg: bad } = await request(ws, { type: 'node.hello', reqId: 'bad-1', nodeId, profile: 'toaster' });
    check('Malformed message → error bad-message', bad.type === 'error' && bad.reason === 'bad-message', bad.detail);

    // 5. Server recorded the identity of this connection (HTTP same port)
    const health = await fetch(url.replace(/^ws/, 'http').replace(/\/?$/, '/healthz')).then((r) => r.json());
    console.log(`healthz ${JSON.stringify(health)}`);
    check('healthz records the node and the publisher', health.ok === true && health.nodes >= 1 && health.publishers >= 1);
    check('healthz.protocol is promptcut.v1', health.protocol === 'promptcut.v1', `protocol=${JSON.stringify(health.protocol)}`);
    check('healthz.modules is an array of module names', Array.isArray(health.modules) && health.modules.every((m) => typeof m === 'string'), JSON.stringify(health.modules));
    // Start one queue per space (auth-contract section 6): /healthz epoch is from the local space;
    // welcome when entering via a shared project is from the project space
    if (sharedEntry) check('healthz carries the queue epoch', typeof health.epoch === 'string' && typeof welcome.epoch === 'string');
    else check('healthz carries the queue epoch', health.epoch === welcome.epoch);
    if (protocols) check('healthz does not contain the proof', !JSON.stringify(health).includes(protocols[1]));
  } catch (err) {
    check('Request flow', false, err.message);
  }

  await closeAndWait(ws, 1000, 'probe done');
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed ? 1 : 0;
}

// Do not use process.exit to race out before handles finish closing: set exit code and let the event
// loop end naturally; if other handles are still blocking, fall back to an unref timer (it will
// not fire if nothing is blocking)
const code = await run();
process.exitCode = code;
setTimeout(() => process.exit(code), 0).unref();
