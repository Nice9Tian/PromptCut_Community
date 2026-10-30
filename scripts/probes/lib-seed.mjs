/**
 * 探针共用:给刚用 `createSharedProject` 建好的共享项目写进一份空项目内容(替创建者的桌面版)。
 *
 * 在线页面只加入、不新建(`dce4b22b`,2026-10-04:加入用 `initialize: false`,服务端没有项目内容就拒绝,
 * 不拿本地这份去盖),所以探针里「建项目 → 页面加入」之间要先有内容,否则页面显示「连不上服务器」、等不到成员按钮。
 * 尺寸、时长同「新建项目」的缺省。
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
      tracks: [{ id: 't-1', name: '序列 1', clips: [] }, { id: 't-2', name: '序列 2', clips: [] }] };
    const seeded = await ask({ type: 'project.op', projectId, opId: randomBytes(16).toString('base64url'), ops: [{ op: 'set', path: '', value: body }] });
    const bad = (m) => /error|reject/i.test(String(m?.type ?? ''));
    return { ok: !bad(opened) && !bad(seeded), opened: opened?.type, seeded: seeded?.type };
  } finally {
    ws.close();
  }
}
