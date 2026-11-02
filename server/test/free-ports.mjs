/**
 * Free ports needed in tests: pick one and try listening to confirm it is free; when multiple
 * are needed at once, they are pairwise distinct.
 * Port numbers are not hardcoded, so no port collisions occur between files within the same npm
 * test run, or between two npm test runs running concurrently on the same machine.
 * Ports are chosen randomly from 20000-49151 and will not fall into reserved ranges like 5xxx,
 * 58xx, or 59xx.
 *
 * There is a gap between "confirming free" and "actually occupying": the fixture spawning child
 * processes takes a second or two to occupy it; during this window, another test process trying to
 * listen on the same port also sees it as free, so both pick the same one, and the one that
 * occupies it later gets EADDRINUSE (empirically observed when the machine is busy and multiple
 * full test suites run concurrently: 16 concurrent `move-guard.test.mjs` runs produced 1 asset
 * child process reporting `EADDRINUSE` out of 32 runs). Therefore, the selected port is recorded
 * separately in the temporary directory (`<tmpdir>/promptcut-test-port-claims/<port>`, created
 * exclusively); if another process sees an active claim that has not expired, it picks a
 * different one. This record only exists to cover that gap and is invalidated after `CLAIM_MS`
 * without needing to be released; if recording fails (e.g. unwriteable directory), it acts as if
 * this never happened and falls back to the original approach.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CLAIM_DIR = path.join(os.tmpdir(), 'promptcut-test-port-claims');
/**
 * How long a record lasts: much longer than the "picked to occupied" gap, yet short enough that
 * concurrently recorded ports only occupy a small fraction of this range.
 */
const CLAIM_MS = 90_000;
let swept = false;

/** Clean up expired records on each process's first use (best effort) */
function sweepClaims() {
  if (swept) return;
  swept = true;
  try {
    fs.mkdirSync(CLAIM_DIR, { recursive: true });
    const now = Date.now();
    for (const name of fs.readdirSync(CLAIM_DIR)) {
      const file = path.join(CLAIM_DIR, name);
      try { if (now - fs.statSync(file).mtimeMs > CLAIM_MS) fs.unlinkSync(file); } catch { /* Just cleaned up by another process */ }
    }
  } catch { /* Directory unavailable: do not record, proceed with original approach */ }
}

/**
 * Record a claim for this port. Returns false = another process just picked it and it has not
 * expired, pick another.
 */
function claimPort(port) {
  sweepClaims();
  const file = path.join(CLAIM_DIR, String(port));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true; }
    catch (error) {
      if (error?.code !== 'EEXIST') return true; // Failure to record does not block
      try {
        if (Date.now() - fs.statSync(file).mtimeMs <= CLAIM_MS) return false;
        fs.unlinkSync(file); // Expired: clean up and record again
      } catch { /* Just cleaned up or re-recorded by another process: try again */ }
    }
  }
  return false;
}

export async function freePorts(count = 1, host = '127.0.0.1') {
  // This machine's system ephemeral port range is 1024-15000, which falls into reserved ranges like
  // 58xx; randomly pick within 20000-49151 and test listening on each to confirm it is free.
  const servers = [], ports = [];
  while (ports.length < count) {
    const port = 20000 + Math.floor(Math.random() * (49152 - 20000));
    if (ports.includes(port) || !claimPort(port)) continue;
    try {
      servers.push(await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
      }));
      ports.push(port);
    } catch { /* Already occupied, pick another */ }
  }
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

export async function freePort(host = '127.0.0.1') {
  return (await freePorts(1, host))[0];
}

/**
 * Request a contiguous range of free ports (the "base port + code" pattern in fixtures):
 * first pick a free port, then test whether the next count-1 ports are also free; if not, pick
 * another and try again.
 * Returns the starting port.
 */
export async function freePortRange(count, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = await freePort(host);
    if (base + count > 65535) continue;
    const servers = [];
    try {
      for (let i = 0; i < count; i += 1) {
        // The start port is already recorded by freePort; record each of the next ones too; if any is
        // claimed by another process, pick a different start port
        if (i > 0 && !claimPort(base + i)) break;
        servers.push(await new Promise((resolve, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(base + i, host, () => resolve(server));
        }));
      }
    } catch { /* Some port in this range is occupied, pick a different start port */ }
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    if (servers.length === count) return base;
  }
  throw new Error('free-port-range-unavailable');
}

/**
 * The port set required by startRunnerProcessFixture, all drawn from system-assigned free ports
 * (identityBase and controlBase each provide a range for the "code" to increment).
 */
export async function runnerPorts() {
  const [a, b, c, d, e, f, g, agent, masterEvents, look, renderWorker] = await freePorts(11);
  return { combo: [a, b, c, d, e, f, g], agent, masterEvents, look, renderWorker,
    identityBase: await freePortRange(16), controlBase: await freePortRange(16) };
}
