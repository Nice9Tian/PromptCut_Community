/**
 * Avoid "bad ports" when the system allocates a port. Uses only Node built-in modules.
 *
 * Background: The "bad port" section of the WHATWG fetch spec lists a table of ports. Browsers
 * (Chromium reports `ERR_UNSAFE_PORT`) and Node's `fetch` / built-in `WebSocket` (undici, reporting
 * `bad port`) all refuse to connect to these ports altogether.
 * Some machines modify the TCP ephemeral port range to lower ranges (e.g. starting from 1024),
 * so `listen(0)` might get ports like 1719, 6000, 6665-6669, 10080; the started service cannot be
 * reached from either the browser or Node.
 *
 * Usage: Where `server.listen(0, host, cb)` was previously written, change to
 * `const port = await listenSafe(server, host)`. If a bad port is obtained, close and retry,
 * up to 20 times.
 */

/**
 * Full "bad port" table from the WHATWG fetch specification (including those in 1-1023).
 * Consistent with Chromium's restricted ports table; ports rejected in tests by local Node 24 fetch
 * (scanned 1-11000) match this table one by one, except for 0.
 * 0 is in the spec table, but `listen(0)` will not return 0; included here solely to match the spec.
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

/** Whether browsers / fetch will refuse to connect to this port */
export function isUnsafePort(port) {
  return UNSAFE_SET.has(Number(port));
}

/** Maximum retry attempts */
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
 * Calls `listen(0)` on `host`; if a bad port is obtained, close and retry, up to
 * {@link LISTEN_SAFE_TRIES} times.
 * On success, the server keeps listening and returns the port number; if it still gets a bad
 * port after exhausting all attempts, closes the server and throws an error.
 * `server` only needs to provide `listen` / `close` / `address` and `once` / `off` event
 * interfaces (both `net.Server` and `http.Server` work).
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
  throw new Error(`listenSafe: got a bad port ${LISTEN_SAFE_TRIES} times (${got.join(', ')})`);
}
