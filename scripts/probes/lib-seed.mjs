/**
 * Shared by probes: write empty project content into a shared project freshly created with
 * `createSharedProject` (on behalf of the creator's desktop app).
 *
 * Online pages only join, never create (`dce4b22b`, 2026-10-04: join uses `initialize: false`; if
 * server has no project content, it rejects instead of overwriting with the local copy), so in
 * probes content must exist between "create project → page join"; otherwise the page displays
 * "Cannot connect to server" and never waits for the member button. Dimensions and duration match
 * defaults of "New project".
 */
import { randomBytes } from 'node:crypto';
import { buildAuthProtocols } from '../../server/auth/client.mjs';

/**
 * @param {{ base: string, projectId: string, creator: { username: string, password: string }, name: string, deviceId?: string }} o
 * @returns {Promise<{ ok: boolean, opened: string | undefined, seeded: string | undefined }>}
 */
export async function seedSharedProject({ base, projectId, creator, name, deviceId = 'probe-seed-node-01' }) {
  const protocols = await buildAuthProtocols({ base, projectId, username: creator.username, deviceId, deviceName: 'probe-seed', as: 'creator', password: creator.password, role: 'page' });
  const ws = new WebSocket(base.replace(/^http/, 'ws'), protocols);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const ask = (msg) => new Promise((resolve) => {
    const reqId = `seed${Math.random().toString(36).slice(2)}`;
    const on = (ev) => { const m = JSON.parse(String(ev.data)); if (m.reqId === reqId) { ws.removeEventListener('message', on); resolve(m); } };
    ws.addEventListener('message', on);
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
  try {
    const opened = await ask({ type: 'project.open', projectId });
    const body = { version: 1, id: `seed-${projectId.slice(-8)}`, name, width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [],
      tracks: [{ id: 't-1', name: 'Track 1', clips: [] }, { id: 't-2', name: 'Track 2', clips: [] }] };
    const seeded = await ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    const bad = (m) => /error|reject/i.test(String(m?.type ?? ''));
    return { ok: !bad(opened) && !bad(seeded), opened: opened?.type, seeded: seeded?.type };
  } finally {
    ws.close();
  }
}
