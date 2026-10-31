/** Device-owned identity store. Atomic encrypted snapshots; no secrets in project files. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { identityKey, roomKey } from './descriptor.mjs';
import { migrateHostedDeep } from '../auth/hosted-default.mjs';

const transientStorageCodes = new Set(['ETIMEDOUT', 'EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE', 'RECOVERY_LOCK_BUSY']);
const diagnosticCodes = new Set([...transientStorageCodes, 'INVALID', 'OTHER', 'DPAPI_FAILED', 'ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EIO', 'EEXIST', 'ERR_OSSL_BAD_DECRYPT', 'ERR_CRYPTO_INVALID_AUTH_TAG']);
const readPhases = new Set(['file-read', 'envelope-parse', 'protect-open', 'digest', 'state-parse']);
/** Positive transient OS/provider evidence only; decrypt, digest and schema faults stay terminal. */
export function recoveryStorageFailure(error) {
  const rawCode = error.storageCode ?? error.code;
  const phase = readPhases.has(error.storagePhase) ? error.storagePhase : null;
  const retryable = transientStorageCodes.has(rawCode) && (!phase || phase === 'file-read' || phase === 'protect-open');
  return { error: retryable ? 'recovery-storage-busy' : 'recovery-storage',
    storagePhase: phase, code: diagnosticCodes.has(rawCode) ? rawCode : 'OTHER' };
}

function atomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let n = 0; ; n++) {
      try { fs.renameSync(tmp, file); break; } catch (e) {
        if (n >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (n + 1));
      }
    }
  } finally { try { fs.unlinkSync(tmp); } catch { /* already renamed */ } }
}
/** 系统保护存储(Windows 的 DPAPI 经 PowerShell)一次输出的上限 */
export const PROTECT_MAX_BUFFER = 256 * 1024 * 1024;
export function systemProtector(dir) {
  if (process.platform === 'win32') {
    const run = (mode, value) => {
      const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $j=[Console]::In.ReadToEnd()|ConvertFrom-Json; $b=[Convert]::FromBase64String($j.value); $e=[Text.Encoding]::UTF8.GetBytes('PromptCut-collaboration-v1'); if($j.mode -eq 'seal'){$r=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$r=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)}; [Console]::Write([Convert]::ToBase64String($r))";
      const p = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        input: JSON.stringify({ mode, value: Buffer.from(value).toString('base64') }), windowsHide: true, encoding: 'utf8', timeout: 15000,
        // 保护存储里有各房间的离线修改记录(整份项目内容):缺省的 1 MiB 输出上限下,项目正文过了约 780 KB 就写不进去(ENOBUFS),
        // 房间里的保存、取消多用户协作、搬到云端都跟着失败。上限放到与恢复接口请求体相同的量级
        maxBuffer: PROTECT_MAX_BUFFER,
      });
      if (p.status !== 0) throw Object.assign(new Error('系统保护存储不可用'), { storageCode: p.error?.code ?? 'DPAPI_FAILED' });
      const output = p.stdout.trim();
      // 判的仍是「一段合法的 base64」;写成长度加一条不嵌套的正则:原来那条带分组重复的正则在几 MB 的输出上会把调用栈撑爆
      if (!output || output.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(output)) throw Object.assign(new Error('系统保护存储响应无效'), { storageCode: 'DPAPI_FAILED' });
      return Buffer.from(output, 'base64');
    };
    return { kind: 'dpapi-current-user', seal: value => run('seal', value), open: value => run('open', value) };
  }
  return privateDeviceProtector(dir);
}
/** Non-Windows deployments: a private device key separated from the ciphertext. */
export function privateDeviceProtector(dir) {
  const file = path.join(dir, 'device.key');
  if (!fs.existsSync(file)) {
    const tmp = `${file}.publish-${process.pid}-${randomBytes(6).toString('hex')}`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, randomBytes(32)); fs.fsyncSync(fd);
      // Exclusive publication: a competing first instance must never replace the winning key.
      try { fs.linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally { fs.closeSync(fd); fs.unlinkSync(tmp); }
  }
  const key = fs.readFileSync(file); if (key.length !== 32) throw new Error('设备保护密钥损坏');
  return {
    kind: 'private-device-key',
    seal(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from('pc-collab-v1')); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]); },
    open(value) { const d = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAAD(Buffer.from('pc-collab-v1')); d.setAuthTag(value.subarray(-16)); return Buffer.concat([d.update(value.subarray(12, -16)), d.final()]); },
  };
}
export function openRecoveryVault({ dir, protector, write = atomic }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const crypt = protector || systemProtector(dir);
  const file = path.join(dir, 'identities.json');
  const empty = () => ({ version: 1, identities: {}, bindings: {}, revoked: {}, hosts: {}, journals: {}, settings: {}, unregister: {}, moves: {} });
  let state = empty();
  const read = () => {
    if (!fs.existsSync(file)) { state = empty(); return; }
    let storagePhase = 'file-read';
    try {
      const text = fs.readFileSync(file, 'utf8'); storagePhase = 'envelope-parse';
      const j = JSON.parse(text);
      if (j.version !== 1 || j.protection !== crypt.kind || typeof j.payload !== 'string') throw new Error();
      storagePhase = 'protect-open';
      const bytes = crypt.open(Buffer.from(j.payload, 'base64'));
      storagePhase = 'digest';
      if (createHash('sha256').update(bytes).digest('hex') !== j.digest) throw new Error();
      storagePhase = 'state-parse';
      const v = JSON.parse(bytes);
      if (v.version !== 1 || !v.identities || !v.bindings || !v.revoked || !v.hosts) throw new Error();
      // 旧托管主机名（键与值里都有）换成新的，见 hosted-default.mjs 的 RETIRED_HOSTED_HOSTS；下次写入时落盘
      const m = migrateHostedDeep(v);
      state = { ...m, journals: m.journals ?? {}, settings: m.settings ?? {}, unregister: m.unregister ?? {}, moves: m.moves ?? {} };
    } catch (e) { throw Object.assign(new Error('协作恢复数据损坏；保留原数据，请从备份恢复或重新认证'), { storagePhase, storageCode: e.storageCode ?? e.code ?? 'INVALID' }); }
  };
  read();
  const lockFile = path.join(dir, 'identities.lock');
  const acquire = () => {
    let liveOwner = false;
    for (let n = 0; n < 120; n++) {
      const tmp = `${lockFile}.owner-${process.pid}-${randomBytes(6).toString('hex')}`;
      try {
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); fs.linkSync(tmp, lockFile); return fd; }
        catch (e) { fs.closeSync(fd); throw e; }
        finally { fs.unlinkSync(tmp); }
      }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          liveOwner = false; const owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid;
          if (Number.isSafeInteger(owner) && owner > 0) {
            try { process.kill(owner, 0); liveOwner = true; } catch (err) { if (err.code === 'ESRCH') { fs.unlinkSync(lockFile); continue; } }
          }
        } catch { /* A partly written or damaged lock is never guessed away. */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    throw Object.assign(new Error('协作恢复记录正在被另一个实例保存，请重试'), { code: liveOwner ? 'RECOVERY_LOCK_BUSY' : 'INVALID' });
  };
  const change = fn => {
    const lock = acquire();
    try {
    read();
    const draft = structuredClone(state); fn(draft);
    const bytes = Buffer.from(JSON.stringify(draft));
    const encoded = JSON.stringify({ version: 1, protection: crypt.kind, digest: createHash('sha256').update(bytes).digest('hex'), payload: crypt.seal(bytes).toString('base64') });
    if (fs.existsSync(file)) write(`${file}.bak`, fs.readFileSync(file));
    write(file, encoded); state = draft;
    } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  };
  return {
    protection: crypt.kind,
    list: descriptor => { read(); return Object.values(state.identities).filter(r => roomKey(r) === roomKey(descriptor)).map(r => structuredClone(r)); },
    select(descriptor, contentId) {
      read();
      // 已注销的房间不再给身份；这台设备上没发出去的离线修改仍然给（过期的云端项目转成本地项目时要并进去，见 `src/editor/sync/cloudGone.ts`）
      if (state.revoked[roomKey(descriptor)]) return { revoked: true, identities: [], journal: structuredClone(state.journals[JSON.stringify([roomKey(descriptor), contentId])] ?? null) };
      const identities = Object.values(state.identities).filter(r => roomKey(r) === roomKey(descriptor)).map(r => structuredClone(r));
      const bound = state.bindings[JSON.stringify([roomKey(descriptor), contentId])];
      return { identities, selected: identities.find(r => identityKey(r) === bound) ?? (identities.length === 1 ? identities[0] : null), host: structuredClone(state.hosts[roomKey(descriptor)] ?? null), journal: structuredClone(state.journals[JSON.stringify([roomKey(descriptor), contentId])] ?? null) };
    },
    remember(record, contentId) {
      if (!['creator', 'member'].includes(record.as) || typeof record.username !== 'string' || !record.username || !/^[A-Za-z0-9_-]{43}$/.test(record.key)) throw new TypeError('身份恢复记录无效');
      const k = identityKey(record);
      change(s => { s.identities[k] = structuredClone(record); if (contentId) s.bindings[JSON.stringify([roomKey(record), contentId])] = k; });
    },
    host(descriptor) { read(); return structuredClone(state.hosts[roomKey(descriptor)] ?? null); },
    settings(descriptor) { read(); return structuredClone(state.settings[roomKey(descriptor)] ?? null); },
    saveSettings(descriptor, value) { change(s => { s.settings[roomKey(descriptor)] = structuredClone(value); }); },
    journal(descriptor, contentId, journal) {
      if (journal && (journal.version !== 1 || journal.projectId !== descriptor.roomId || !Array.isArray(journal.pending) || !Array.isArray(journal.project?.tracks))) throw new Error('离线操作记录无效');
      change(s => { s.journals[JSON.stringify([roomKey(descriptor), contentId])] = structuredClone(journal); });
    },
    bindHost(descriptor, deviceId) {
      read();
      if (state.revoked[roomKey(descriptor)]) throw new Error('房间已注销');
      const prior = state.hosts[roomKey(descriptor)];
      if (prior && prior.deviceId !== deviceId) throw new Error('主机设备冲突');
      if (!prior) change(s => {
        if (s.revoked[roomKey(descriptor)] || s.hosts[roomKey(descriptor)] && s.hosts[roomKey(descriptor)].deviceId !== deviceId) throw new Error('房间已注销或主机冲突');
        s.hosts[roomKey(descriptor)] ??= { deviceId, registrationKey: randomBytes(32).toString('base64url') };
      });
      return this.host(descriptor);
    },
    pendingUnregister() { read(); return Object.values(state.unregister ?? {}).map(r => structuredClone(r)); },
    beginLocalMove(descriptor, deviceId, contentId) {
      const selected = this.select(descriptor, contentId);
      if (selected.revoked || !selected.selected) throw Object.assign(new Error('Existing identity required'), { reason: 'auth' });
      const key = roomKey(descriptor); let result;
      change(s => {
        if (s.revoked[key]) throw Object.assign(new Error('Room revoked'), { reason: 'deleted' });
        if (s.moves[key] && s.moves[key].deviceId !== deviceId) throw Object.assign(new Error('Destination conflict'), { reason: 'host-conflict' });
        s.moves[key] ??= { version: 1, descriptor: structuredClone(descriptor), deviceId, identity: identityKey(selected.selected), txnId: `move_${randomBytes(16).toString('hex')}`,
          registrationKey: randomBytes(32).toString('base64url'), sourceCapability: randomBytes(32).toString('base64url') };
        result = structuredClone(s.moves[key]);
      }); return result;
    },
    pendingLocalMoves() {
      read(); return Object.values(state.moves).map(move => ({ ...structuredClone(move), record: structuredClone(state.identities[move.identity] ?? null) }));
    },
    completeLocalMove(move, authority, base) {
      const key = roomKey(move.descriptor);
      change(s => {
        const pending = s.moves[key];
        if (s.revoked[key] || !pending || pending.txnId !== move.txnId || pending.registrationKey !== move.registrationKey
          || authority.roomId !== move.descriptor.roomId || authority.txnId !== move.txnId || authority.target?.where !== 'lan'
          || authority.target.deviceId !== move.deviceId || authority.target.service !== move.descriptor.service) throw Object.assign(new Error('Move authority changed'), { reason: 'cancelled' });
        s.hosts[key] = { deviceId: move.deviceId, registrationKey: pending.registrationKey };
        for (const identity of Object.values(s.identities)) if (roomKey(identity) === key) identity.candidate = { ...identity.candidate, where: 'lan', service: move.descriptor.service, base };
        delete s.moves[key];
      });
    },
    completeUnregister(descriptor) { change(s => { delete s.unregister?.[roomKey(descriptor)]; }); },
    revoke(descriptor) { change(s => {
      s.revoked[roomKey(descriptor)] = Date.now();
      const host = s.hosts[roomKey(descriptor)];
      const pending = s.moves[roomKey(descriptor)];
      if (host || pending) { s.unregister ??= {}; s.unregister[roomKey(descriptor)] = { descriptor, registrationKey: pending?.registrationKey ?? host.registrationKey }; }
      delete s.moves[roomKey(descriptor)];
      delete s.hosts[roomKey(descriptor)];
      delete s.settings[roomKey(descriptor)];
      for (const [k, r] of Object.entries(s.identities)) if (roomKey(r) === roomKey(descriptor)) delete s.identities[k];
    }); },
  };
}
