/**
 * For testing only. Global setup for `npm test`
 * (`node --test --test-global-setup=server/test/global-setup.mjs`), running once in the test
 * runner's main process, ahead of child processes of all test files.
 *
 * Does two things:
 *
 * 1. **Do not inherit external `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`**
 *    (`scripts/lib/user-dirs.mjs`): desktop app sets them to `%USERPROFILE%\Videos\PromptCut` and
 *    the application data directory; running `npm test` from the desktop app environment (e.g.
 *    Agent in the desktop app), the editor, prerender process, and `FramePipeline` spawned by
 *    tests will write frame store and cost records into the user directory. Here they are
 *    stripped in the main process, so child processes of each test file inherit the cleaned
 *    environment, with outputs falling into repo `out/` or temporary directories set by tests
 *    themselves. Gatekeeper check: see `no-user-dirs.test.mjs`.
 * 2. **Hold "bad ports" from the fetch spec throughout the test run**, preventing `listen(0)` in
 *    test files from acquiring them. The discussion below focuses on this.
 *
 * Why: Node's `fetch` and built-in `WebSocket` (both undici) refuse to connect to these ports per
 * the WHATWG fetch spec, throwing `TypeError: fetch failed` (cause `bad port`) or WebSocket errors
 * directly with 1006 without even connecting. Services in tests almost always use `listen(0)` to
 * let the system assign ports; the system ephemeral port range defaults to 49152-65535, never
 * touching this list, but the Windows ephemeral port range can be reconfigured to a lower range
 * (as is true on some machines), and Windows **issues port numbers sequentially from a single
 * machine-wide counter**, with dozens of test processes advancing together in parallel: when
 * passing 1719, 4190, 6000, 6665-6669, 10080, any service that happens to receive one cannot
 * connect. The symptom is sporadic failures in full test runs while passing reliably in
 * isolation, often with several files failing simultaneously around 30 ms (five consecutive
 * ports from 6665 to 6669).
 *
 * How it holds them: bind a listener on both 127.0.0.1 and ::1 for each port that does not accept
 * connections (binds only to loopback, opening no firewall holes). Empirically, when Windows
 * issues numbers for `listen(0)`, it skips these occupied numbers regardless of whether the caller
 * binds to 127.0.0.1, ::1, 0.0.0.0, ::, or default. If binding fails (port already held by
 * another program), skip it: since another program holds it, the system will not assign it to
 * tests either.
 *
 * When running multiple `npm test` runs in parallel (several worktrees running concurrently),
 * the first one holds them while subsequent ones cannot; once the first finishes and releases
 * them, test files from subsequent runs might acquire these numbers. Therefore, unheld (port,
 * address) pairs are retried every second during runtime: whichever process releases first, the
 * still-running instance takes over holding them. The timer is `unref`'d so it does not keep the
 * process alive; `globalTeardown` stops the timer and closes all listeners.
 *
 * Child processes learn from the environment variable `PROMPTCUT_TEST_BAD_PORTS_HELD` which ports
 * were held at startup (for reference only). `bad-ports.test.mjs` verifies that "no port on the
 * list can be listened on", regardless of who holds it.
 */
import net from 'node:net';
import { scrubUserDirEnv, markNoPortFile } from '../../scripts/lib/user-dirs.mjs';

/**
 * Ports >= 1024 from the WHATWG fetch spec "bad port" list (systems will not assign ports below
 * 1024 as ephemeral ports).
 * The largest is 10080; the auto-port-selection script therefore picks from 20000 and above.
 */
export const FETCH_BAD_PORTS = Object.freeze([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const HOSTS = ['127.0.0.1', '::1'];
const TOTAL = FETCH_BAD_PORTS.length * HOSTS.length;
const RETRY_MS = 1000;
/** `${port}@${host}` → listener holding it */
const held = new Map();
let retryTimer = null;
let retrying = null;

function hold(port, host) {
  const key = `${port}@${host}`;
  if (held.has(key)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.unref();
      held.set(key, server);
      resolve(true);
    });
  });
}

/** Try all (port, address) pairs not yet bound; return a port bound by at least one address. */
async function holdAll() {
  const got = [];
  for (const port of FETCH_BAD_PORTS) {
    let any = false;
    for (const host of HOSTS) if (await hold(port, host)) any = true;
    if (any) got.push(port);
  }
  return got;
}

function stopRetry() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
}

export async function globalSetup() {
  for (const { key, value } of scrubUserDirEnv(process.env)) {
    console.error(`[global-setup] not inheriting external ${key}=${value} (tests do not write to the user directory, see scripts/lib/user-dirs.mjs)`);
  }
  // Editors started by tests do not write to shared %TEMP%\promptcut\port.json
  // (markNoPortFile in scripts/lib/user-dirs.mjs; gatekeeper test port-file.test.mjs)
  markNoPortFile(process.env);
  const got = await holdAll();
  process.env.PROMPTCUT_TEST_BAD_PORTS_HELD = got.join(',');
  if (held.size >= TOTAL) return;
  retryTimer = setInterval(() => {
    if (retrying) return;
    retrying = holdAll().finally(() => {
      retrying = null;
      if (held.size >= TOTAL) stopRetry();
    });
  }, RETRY_MS);
  retryTimer.unref();
}

export async function globalTeardown() {
  stopRetry();
  if (retrying) await retrying;
  const servers = [...held.values()];
  held.clear();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
}
