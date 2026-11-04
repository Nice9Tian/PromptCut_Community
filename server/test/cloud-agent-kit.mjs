/**
 * Shared setup across test files for Cloud Agent service (moved from
 * cloud-agent-service.test.mjs, content unchanged):
 * In-memory document service on local loopback (port 0), vite without plugins, hosted tier service
 * (not via HTTP). Model uses mock provider, completely no network egress.
 * Credentials for auth and connecting to document service are test mocks: connection uses the
 * loopback agent role item.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createHostedAgentService } from '../agent/service/create-agent-service.mjs';
import { wsClient, waitFor } from './fake-ws-kit.mjs';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/** Owner key (same rule as `ownerKeyOf` in `create-agent-service.mjs`, only key name needed here) */
export const ownerNameOf = (i) => (i.creator === true ? 'creator' : (i.mode === 'restricted' && i.username ? `user:${i.username}` : `device:${i.userId}`));

/** Reads an event stream (SSE) until `until(event)` is true, returning received events */
export async function readSse(url, headers, until = (e) => e.type === 'end', { signal } = {}) {
  const res = await fetch(url, { headers, signal });
  if (res.status !== 200) return { status: res.status, events: [], body: await res.text() };
  const out = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    let stop = false;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      const ev = JSON.parse(chunk.slice(6));
      out.push(ev);
      if (until(ev, out)) { stop = true; break; }
    }
    if (stop) { await reader.cancel().catch(() => {}); break; }
  }
  return { status: 200, events: out };
}

export function project(id, name) {
  return {
    version: 1, id, name, width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight', media: [],
    tracks: [{ id: 't1', name: 'Track 1', clips: [{ id: 'c1', cardId: 'title', start: 0, end: 4, params: {}, label: `${name}'s card` }] }],
    transitions: [],
  };
}

export const script = (steps) => `Follow the script.\n\`\`\`mock-script\n${JSON.stringify(steps)}\n\`\`\``;
export const credentials = { protocolsFor: (_identity, n) => ['promptcut.v1', `promptcut.role.agent.${n}`] };
export const modelConfig = () => ({ vendor: 'mock', model: 'mock-1' });

/**
 * Document service on local loopback (in-memory) plus two tools: write project, read current
 * content
 */
export async function startDoc(t) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/docservice`;
  const clients = [];
  t.after(async () => {
    for (const c of clients) c.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  let seq = 0;
  async function open(projectId) {
    const c = wsClient(url);
    clients.push(c);
    await c.opened;
    c.send({ type: 'project.open', projectId, reqId: `open-${++seq}` });
    const st = await c.next((m) => m.type === 'project.state', 5000);
    if (st.project === undefined && Number.isSafeInteger(st.parts)) {
      await c.next((m) => m.type === 'project.state.end' && m.rev === st.rev, 5000);
      const parts = c.all.filter((m) => m.type === 'project.state.part' && m.rev === st.rev).sort((x, y) => x.index - y.index);
      st.project = JSON.parse(parts.map((m) => m.data).join(''));
    }
    return { c, st };
  }
  return {
    url,
    async seed(p) {
      const { c } = await open(p.id);
      const opId = `seed-${++seq}`;
      c.send({ type: 'project.op', projectId: p.id, opId, session: 'seed', ops: [{ op: 'set', path: '', value: p }], reqId: opId });
      const r = await c.next((m) => m.reqId === opId, 5000);
      assert.equal(r.type, 'project.op.ok', `Project ${p.id} written into the document service`);
      c.close();
    },
    async stateOf(projectId) {
      const { c, st } = await open(projectId);
      c.close();
      return st;
    },
  };
}

/** A suite: document service + vite + hosted tier service (not via HTTP) */
export async function startKit(t, { limits, extra = {}, dataDir: dataDirIn = null } = {}) {
  const doc = await startDoc(t);
  const dataDir = dataDirIn ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pc-cloud-agent-'));
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const logs = [];
  const others = [];
  /**
   * Start another service on the same data directory and document service (simulates process killed
   * and restarted: previous one did not finalize)
   */
  const another = (extra2 = {}) => {
    const s = createHostedAgentService({
      root: ROOT, loadModule: (id) => vite.ssrLoadModule(id), docUrl: doc.url, credentials, modelConfig, dataDir,
      ...(limits ? { limits } : {}), log: (event, fields) => logs.push({ event, ...fields }), ...extra, ...extra2,
    });
    others.push(s);
    return s;
  };
  const service = another();
  t.after(async () => {
    for (const s of others.reverse()) await s.close();
    await vite.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  /** Wait for end to appear in events for this chat, returning all events */
  async function finished(identity, conversationId, ms = 30_000, svc = service) {
    const seen = [];
    // Viewer uses another device id: prevents "waiting for end" itself from being counted as
    // "initiator online"
    const watcher = { ...identity, userId: `${identity.userId}#watch`, ownerKey: identity.ownerKey ?? ownerNameOf(identity) };
    await waitFor(() => {
      seen.length = 0;
      const off = svc.subscribe(watcher, conversationId, 0, (ev) => seen.push(ev));
      off?.();
      return seen.some((e) => e.type === 'end');
    }, ms, `Chat ${conversationId} ended`);
    return seen;
  }
  return { doc, vite, service, another, dataDir, logs, finished };
}
