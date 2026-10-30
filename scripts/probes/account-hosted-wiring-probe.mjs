/**
 * Inputs: --url <absolute http(s) doc URL> --out <absolute artifact directory>, plus
 * PROMPTCUT_ACCOUNT_PROBE_TOKEN and PROMPTCUT_ACCOUNT_PROBE_PROJECT_ID in this process only.
 * Assertions: authenticated authority status, real session ticket, WebSocket project body,
 * and cross-project denial. Exit 1 on any failed assertion; never print or store credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function option(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
const url = option('--url'), out = option('--out');
const token = process.env.PROMPTCUT_ACCOUNT_PROBE_TOKEN;
const projectId = process.env.PROMPTCUT_ACCOUNT_PROBE_PROJECT_ID;
const fail = error => { process.stderr.write(`account-hosted-wiring probe failed: ${error?.code ?? error?.message ?? 'unknown'}\n`); process.exitCode = 1; };

try {
  assert.ok(url && /^https?:\/\//.test(url) && out && path.isAbsolute(out) && token && projectId, 'probe-input');
  const root = url.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${token}` };
  const statusResponse = await fetch(`${root}/hosted/shared/account/status?authorityId=${encodeURIComponent(process.env.PROMPTCUT_ACCOUNT_PROBE_AUTHORITY_ID ?? '')}&projectId=${encodeURIComponent(projectId)}`, { headers });
  const status = await statusResponse.json();
  assert.equal(statusResponse.status, 200, 'status-response');
  assert.equal(status.state, 'exists', 'authoritative-exists');
  const sessionResponse = await fetch(`${root}/hosted/shared/account/session`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, deviceId: 'account-wiring-probe', requestId: `probe-${Date.now()}` }) });
  const session = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200, 'session-response');
  assert.ok(typeof session.connectionTicket === 'string' && typeof session.assetTicket === 'string', 'real-tickets');
  const wsUrl = root.replace(/^http/, 'ws');
  const ws = new WebSocket(wsUrl, ['promptcut.v1', `promptcut.account.${session.connectionTicket}`]);
  const opened = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws-timeout')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(true); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws-auth')); }, { once: true });
  });
  const next = expected => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error(`ws-${expected}-timeout`)); }, 5000);
    const listener = event => {
      const value = JSON.parse(event.data);
      if (value.type !== expected) return;
      clearTimeout(timer); ws.removeEventListener('message', listener); resolve(value);
    };
    ws.addEventListener('message', listener);
  });
  const project = next('project.state'); ws.send(JSON.stringify({ type: 'project.open', projectId }));
  assert.equal((await project).projectId, projectId, 'project-body');
  const forbidden = next('error'); ws.send(JSON.stringify({ type: 'project.open', projectId: `sp_${'a'.repeat(26)}` }));
  assert.equal((await forbidden).reason, 'project-mismatch', 'cross-project');
  ws.close();
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'account-hosted-wiring.json'), JSON.stringify({ ok: true, projectId, checks: ['status', 'session', 'websocket-project', 'cross-project'] }, null, 2));
  process.stdout.write('account-hosted-wiring probe: 4/4 checks passed\n');
} catch (error) { fail(error); }
