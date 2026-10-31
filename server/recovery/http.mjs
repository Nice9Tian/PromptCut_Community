import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { openRecoveryVault, recoveryStorageFailure } from './vault.mjs';
import { parseCollaboration } from './descriptor.mjs';
import { roomUnavailableReason } from './relocation.mjs';
import { fileNameOf } from '../docservice/store/index.mjs';
import { fromLocalClient, guard } from '../http-guard.mjs';

const TASK_ENDPOINTS = ['/cancel-host', '/activate-host', '/restore-host'];

/**
 * Local-only identity API. Its root and protection backend are owned by the app.
 * 局域网项目的开启、刷新、重开都靠它。`extension` 是可选的：闭源版用它把房间登记到托管端、做搬迁（`cloud/server/recovery/http.mjs`），
 * 没有它时主机只在本机绑定，不起后台任务。
 */
export function recoveryHttp({ dir, dataDir, store, device, baseOf, assetBaseOf, assets, reloadSpace, onClose, extension }) {
  let vault;
  const hosts = new Map();
  const tasks = new Map();
  const getVault = () => vault ??= openRecoveryVault({ dir });
  const hostId = d => JSON.stringify([d.service, d.roomId]);
  const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const ext = extension?.({ getVault, hosts, hostId, dataDir, store, device, baseOf, assetBaseOf, assets, reloadSpace, reply }) ?? null;
  const taskEndpoints = [...TASK_ENDPOINTS, ...(ext?.taskEndpoints ?? [])];
  function activate(descriptor, owner) {
    const id = hostId(descriptor);
    if (hosts.has(id)) { const entry = hosts.get(id); entry.owners.add(owner); return entry; }
    const h = getVault().host(descriptor);
    if (!h || h.deviceId !== device.deviceId || descriptor.where !== 'lan') throw new Error('not-original-host');
    const entry = { state: ext ? 'pending' : 'inactive', worker: null, owners: new Set([owner]) };
    entry.worker = ext?.startHost(descriptor, h, entry) ?? null;
    hosts.set(id, entry); return entry;
  }
  onClose?.(() => { ext?.close(); for (const entry of hosts.values()) void entry.worker?.stop(); hosts.clear(); });
  return async (req, res, next) => {
    const p = String(req.url).split('?')[0];
    if (!p.startsWith('/api/collaboration/')) return next();
    if (!fromLocalClient(req) || !guard(req, res)) { if (!res.headersSent) reply(res, 403, { ok: false, error: 'forbidden' }); return; }
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' });
    const began = Date.now(); let recoveryPhase = 'body-parse';
    try {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 64 * 1024 * 1024) return reply(res, 413, { ok: false, error: 'too-large' }); }
      const body = JSON.parse(raw); recoveryPhase = 'descriptor-parse'; const descriptor = parseCollaboration(body.descriptor);
      if (!descriptor || descriptor.version !== 1) return reply(res, 400, { ok: false, error: 'unsupported' });
      recoveryPhase = 'vault-open'; const v = getVault(); recoveryPhase = 'vault-operation';
      const task = typeof body.task === 'string' && body.task.length <= 128 ? body.task : null;
      const version = Number.isSafeInteger(body.taskVersion) && body.taskVersion >= 0 ? body.taskVersion : null;
      if (taskEndpoints.some(end => p.endsWith(end))) {
        if (!task || version === null) return reply(res, 400, { ok: false, error: 'bad-task' });
        if ((tasks.get(task) ?? -1) > version) return reply(res, 409, { ok: false, error: 'cancelled' });
        tasks.set(task, version);
      }
      if (p.endsWith('/cancel-host')) {
        const entry = hosts.get(hostId(descriptor));
        entry?.owners.delete(task);
        if (entry && !entry.owners.size) { hosts.delete(hostId(descriptor)); await entry.worker?.stop(); }
        return reply(res, 200, { ok: true });
      }
      if (p.endsWith('/settings-read')) return reply(res, 200, { ok: true, settings: v.settings(descriptor) });
      if (await ext?.handle(p, descriptor, body, v, res)) return;
      if (p.endsWith('/settings-write')) { if (body.settings?.projectId !== descriptor.roomId) return reply(res, 400, { ok: false, error: 'bad-settings' }); v.saveSettings(descriptor, body.settings); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/journal')) { v.journal(descriptor, body.contentId, body.journal); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/identity')) { v.remember({ ...body.record, service: descriptor.service, roomId: descriptor.roomId }, body.contentId); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/select')) { const selected = v.select(descriptor, body.contentId); if (selected.host) selected.host = { deviceId: selected.host.deviceId };
        return reply(res, 200, { ok: true, ...selected, settings: v.settings(descriptor), protection: v.protection, recoveryMove: ext?.recoveryMove(descriptor, v) ?? null }); }
      if (p.endsWith('/revoke')) { const entry = hosts.get(hostId(descriptor)); v.revoke(descriptor); await entry?.worker?.stop({ deleted: true }); hosts.delete(hostId(descriptor)); ext?.revoked(); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/host-state')) return reply(res, 200, { ok: true, state: hosts.get(hostId(descriptor))?.state ?? 'inactive' });
      if (p.endsWith('/host-update')) { await hosts.get(hostId(descriptor))?.worker?.update(); return reply(res, 200, { ok: true }); }
      if (p.endsWith('/activate-host')) {
        if (!store?.peek(descriptor.roomId) || descriptor.where !== 'lan') return reply(res, 404, { ok: false, error: 'no-project' });
        const unavailable = roomUnavailableReason(store.peek(descriptor.roomId));
        if (unavailable) return reply(res, 409, { ok: false, error: unavailable });
        v.bindHost(descriptor, device.deviceId); activate(descriptor, task); return reply(res, 200, { ok: true });
      }
      if (p.endsWith('/restore-host')) {
        const h = v.host(descriptor);
        if (!h || h.deviceId !== device.deviceId) return reply(res, 403, { ok: false, error: 'not-original-host' });
        const rec = store?.peek(descriptor.roomId);
        if (!rec) return reply(res, 409, { ok: false, error: 'host-data-missing' });
        const unavailable = roomUnavailableReason(rec);
        if (unavailable) return reply(res, 409, { ok: false, error: unavailable });
        const projects = path.join(dataDir, 'tenants', descriptor.roomId, 'projects');
        if (!fs.existsSync(path.join(projects, `${fileNameOf(descriptor.roomId)}.ops.ndjson`))) return reply(res, 409, { ok: false, error: 'host-data-missing' });
        return reply(res, 200, { ok: true, candidate: { where: 'lan', projectId: rec.projectId, name: rec.name, mode: rec.mode, base: baseOf(), service: descriptor.service, hostDeviceName: device.deviceName, originalHost: true } });
      }
      reply(res, 404, { ok: false, error: 'no-endpoint' });
    } catch (e) {
      // Fixed categories only: never send paths, messages, stacks, project data or protected bytes.
      const failure = recoveryStorageFailure(e), retryable = failure.error === 'recovery-storage-busy';
      reply(res, 503, { ok: false, error: failure.error, ...(retryable ? { retryAfter: 1 } : {}), storageDiagnostic: {
        phase: recoveryPhase, storagePhase: failure.storagePhase, code: failure.code,
        elapsedMs: Date.now() - began,
      }, message: retryable ? '协作恢复信息暂时无法读取或保存；原数据已保留，将自动重试。' : '无法可靠读取或保存协作恢复信息；原数据已保留，请从备份恢复或重新认证。' });
    }
  };
}
