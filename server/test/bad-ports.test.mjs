/**
 * Self-test for `global-setup.mjs`: bad port list matches local Node fetch; under `npm test`, these
 * ports are all occupied (regardless of who occupies them).
 * Run: npm test (when running this file alone, there is no global setup; skip the second check)
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

test('For every port on the list, fetch on this machine reports bad port; neighboring ports outside the list do not', async () => {
  for (const port of FETCH_BAD_PORTS) assert.equal(await causeOf(port), 'bad port', `Port ${port}`);
  for (const port of [1718, 6001, 6670, 10081]) assert.notEqual(await causeOf(port), 'bad port', `Port ${port}`);
});

const listenCode = (port, host) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', (err) => resolve(err.code));
  server.listen(port, host, () => server.close(() => resolve('listening')));
});

// Invariant: every bad port in the list cannot be listened on during tests: occupied by this
// global setup, or occupied by another parallel npm test or another program all count.
// When running in parallel, the later instance may occupy none of them at startup, so we do not
// check "how many we occupied this time".
test('Under npm test, every bad port on the list is held on 127.0.0.1, so listen cannot get it', async (t) => {
  if (process.env.PROMPTCUT_TEST_BAD_PORTS_HELD === undefined) { t.skip('Did not go through the global setup of npm test (running this file on its own)'); return; }
  for (const port of FETCH_BAD_PORTS) assert.equal(await listenCode(port, '127.0.0.1'), 'EADDRINUSE', `Port ${port}`);
});
