/** Keep the task-owned hosting directory and its temporary public entry up while other machines use it.
 * Same isolated gateway and temporary tunnel as reopen-wan.mjs (authorised test host over SSH, no
 * production service, DNS, firewall or account), but long-lived: probes on other machines register
 * and join through the printed address until the stop file appears.
 *
 *   PC_REOPEN_SSH_HOST=… PC_REOPEN_SSH_KEY=… PC_REOPEN_PUBLIC_TUNNEL_BIN=… \
 *   node --import=./scripts/lib/test-silent-processes.mjs scripts/probes/reopen-public-gateway.mjs --out <state.json> --stop-file <path>
 * Exits 0 after the stop file appears, 1 when the entry is lost. The address is temporary and dies with this process.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { startWanProbe } from './reopen-wan.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg('--out'), stopFile = arg('--stop-file');
assert(out && stopFile, '--out <state.json> and --stop-file <path> are required');
const say = (phase, more = {}) => console.log(JSON.stringify({ phase, at: new Date().toISOString(), ...more }));
const wan = await startWanProbe();
let code = 0;
try {
  assert.equal(wan.path, 'temporary-public-https-tunnel', 'other machines need the temporary public entry, not a local proxy');
  const state = { service: wan.service, path: wan.path, publicHttp: wan.publicHttp, remoteDirectory: wan.remoteDirectory, gatewayPid: wan.gatewayPid, startedAt: new Date().toISOString() };
  fs.writeFileSync(out, JSON.stringify(state, null, 2)); say('ready', state);
  let last = null, failures = 0;
  while (!fs.existsSync(stopFile)) {
    let onlineNow = null;
    try { onlineNow = (await (await fetch(`${wan.service}/hosting/healthz`, { signal: AbortSignal.timeout(8000) })).json()).online; failures = 0; } catch { failures++; }
    if (onlineNow !== null && onlineNow !== last) { last = onlineNow; say('online', { online: onlineNow }); }
    if (failures >= 6) { say('lost', { service: wan.service }); code = 1; break; }
    await new Promise(r => setTimeout(r, 5000));
  }
} finally { await wan.close(); say('closed'); }
process.exit(code);
