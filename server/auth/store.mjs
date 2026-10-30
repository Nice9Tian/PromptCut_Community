/**
 * 共享项目的凭证存储（契约 `docs/plan/auth-contract.md` 第 3 节）。
 *
 * 目录是文档服务数据目录下的 `auth/`：
 * - `auth/server.json`：`{ v: 1, secret }`，服务端密钥（32 字节 base64url），首次打开时生成。
 *   只用来给名单外的用户名造伪盐（第 4 节），不签票据；
 * - `auth/projects/<projectId>.json`：每个共享项目一份记录，写入走临时文件加改名。
 *
 * 打开时把全部记录读进内存，之后读只读内存，写先落盘再改内存。打不开（目录不可写、文件坏了）就抛错：
 * 独立模式的 `main.mjs` 据此失败即关（第 10 节）。
 *
 * 记录里存的 `K` 对本协议等同于口令（计划第 12.2 节），所以这个目录不经任何静态服务暴露。
 * 文档服务与素材服务同进程时共用同一份内存状态（票据的代数、签名密钥，第 8 节）：用 `credentialStoreFor(dir)`
 * 按目录取进程内的单例。
 *
 * 只用 Node 内置模块（D2 守门）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { b64urlEncode, nameKey, isProjectId } from './protocol.mjs';
import { inviteDigest } from './invite.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `sp_<26 位小写 base32>`：130 位随机数 */
export function newProjectId() {
  const bytes = randomBytes(17);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return `sp_${out}`;
}

/** 签名密钥的编号：密钥 sha256 的前 8 个 base64url 字符（记录里不另存） */
export const kidOf = (ticketKey) => b64urlEncode(createHash('sha256').update(String(ticketKey), 'utf8').digest()).slice(0, 8);

let tmpSeq = 0;

/** 先写临时文件、刷盘，再改名盖过目标；Windows 上目标正被读时改名可能 EPERM，短暂重试 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${(tmpSeq += 1)}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 没建成 */ }
    throw err;
  }
}

const clone = (v) => structuredClone(v);

/**
 * 打开（必要时建出）凭证存储。
 * @param {object} options
 * @param {string} options.dir `auth/` 目录本身
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function openCredentialStore({ dir, now = Date.now, log = () => {} } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('openCredentialStore: dir 必须是非空字符串');
  const root = path.resolve(dir);
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  // 服务端密钥：有就读，没有就生成
  const serverFile = path.join(root, 'server.json');
  let secret;
  if (fs.existsSync(serverFile)) {
    const j = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    if (!j || j.v !== 1 || typeof j.secret !== 'string' || j.secret.length < 32) throw new Error('auth/server.json 格式不对');
    secret = j.secret;
  } else {
    secret = b64urlEncode(randomBytes(32));
    writeAtomic(serverFile, `${JSON.stringify({ v: 1, secret, createdAt: now() })}\n`);
  }
  // 可写性在这里就试一次：只读目录下 server.json 已存在时，上面不会写
  fs.accessSync(projectsDir, fs.constants.W_OK);

  /** projectId → 记录 */
  const records = new Map();
  /** 名字键 → projectId */
  const names = new Map();
  /**
   * 邀请码摘要 → projectId（C10a 契约第 5 节）。只记每个项目当前那一条邀请码的摘要：签发新的、删项目时跟着改；
   * 作废的记录还在，由 `invite.mjs` 的 `inviteActive` 判失效。按摘要找项目，不必逐个项目算 HMAC。
   */
  const invites = new Map();
  const indexInvite = (rec, prev) => {
    if (prev?.invite?.digest && invites.get(prev.invite.digest) === prev.projectId) invites.delete(prev.invite.digest);
    if (rec?.invite?.digest) invites.set(rec.invite.digest, rec.projectId);
  };
  for (const entry of fs.readdirSync(projectsDir)) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -5);
    if (!isProjectId(id)) continue;
    const rec = JSON.parse(fs.readFileSync(path.join(projectsDir, entry), 'utf8'));
    if (!rec || rec.v !== 1 || rec.projectId !== id || typeof rec.name !== 'string' || typeof rec.ticketKey !== 'string') {
      throw new Error(`auth/projects/${entry} 格式不对`);
    }
    records.set(id, rec);
    names.set(nameKey(rec.name), id);
    indexInvite(rec, null);
  }
  log('auth.store.open', { projects: records.size });

  /** 记录变化的监听（托管端的目录模块用，`docs/plan/hosted-render-contract.md` 第 2 节）：建、改、删、搬迁装入之后各调一次 */
  const listeners = new Set();
  const changed = (type, projectId) => {
    for (const fn of [...listeners]) {
      try { fn({ type, projectId }); } catch (err) { log('auth.store.listener-error', { message: String(err?.message ?? err) }); }
    }
  };

  const fileOf = (projectId) => path.join(projectsDir, `${projectId}.json`);
  const persist = (rec) => writeAtomic(fileOf(rec.projectId), `${JSON.stringify(rec, null, 2)}\n`);

  return {
    dir: root,
    /** 服务端密钥（字节） */
    serverSecret: Buffer.from(secret, 'base64url'),

    count: () => records.size,

    /** 订阅记录变化：`fn({ type: 'create' | 'update' | 'remove' | 'install', projectId })`，落盘并换进内存之后调。回退订函数 */
    onChange(fn) {
      if (typeof fn !== 'function') throw new TypeError('onChange: 要给函数');
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    /** 记录的副本；没有回 null */
    get(projectId) {
      const rec = records.get(projectId);
      return rec ? clone(rec) : null;
    },

    /** 内部用：不拷贝，只读（握手、核票据这些热路径） */
    peek(projectId) {
      return records.get(projectId) ?? null;
    },

    byName(name) {
      const id = names.get(nameKey(name));
      return id ? clone(records.get(id)) : null;
    },

    nameTaken: (name) => names.has(nameKey(name)),

    /** 按邀请码摘要找项目（C10a）：内部用，不拷贝、只读；没有回 null */
    peekByInviteDigest(digest) {
      const id = typeof digest === 'string' ? invites.get(digest) : undefined;
      return id ? records.get(id) ?? null : null;
    },
    /** A relocated invitation retains its original verifier; no invitation is regenerated. */
    peekByInviteCode(code) {
      const found = this.peekByInviteDigest(inviteDigest(Buffer.from(secret, 'base64url'), code));
      if (found) return found;
      for (const rec of records.values()) {
        if (typeof rec.inviteDigestSecret === 'string' && rec.invite?.digest === inviteDigest(Buffer.from(rec.inviteDigestSecret, 'base64url'), code)) return rec;
      }
      return null;
    },

    /** Server-internal verified import. Staging is inaccessible until authority publication. */
    installRelocated(rec) {
      if (!rec || rec.v !== 1 || !isProjectId(rec.projectId) || typeof rec.name !== 'string' || typeof rec.ticketKey !== 'string'
        || roomUnavailableReason(rec) !== 'relocating' || rec.relocation.phase !== 'staging' || rec.hostingEpoch !== rec.relocation.targetEpoch) {
        throw Object.assign(new Error('Invalid staged room'), { reason: 'bad-relocation' });
      }
      const prior = records.get(rec.projectId), owner = names.get(nameKey(rec.name));
      if (owner && owner !== rec.projectId) throw Object.assign(new Error('Room name occupied'), { reason: 'name-taken' });
      if (prior && !((roomUnavailableReason(prior) === 'relocated' && (prior.hostingEpoch ?? 1) < rec.hostingEpoch)
        || prior.relocation?.phase === 'staging' && prior.relocation.txnId === rec.relocation.txnId && JSON.stringify(prior) === JSON.stringify(rec))) {
        throw Object.assign(new Error('Destination room occupied'), { reason: 'relocation-conflict' });
      }
      if (prior && JSON.stringify(prior) === JSON.stringify(rec)) return clone(prior);
      const draft = clone(rec); persist(draft); records.set(rec.projectId, draft);
      if (prior) names.delete(nameKey(prior.name)); names.set(nameKey(draft.name), draft.projectId); indexInvite(draft, prior);
      changed('install', draft.projectId);
      return clone(draft);
    },

    /**
     * 建一个项目。字段由调用方校验过；这里生成 projectId、ticketKey，代数从 1 起。名字被占用抛 `code: 'name-taken'`。
     * @returns 记录的副本
     */
    create({ name, mode, kdf, creator, project, list }) {
      if (names.has(nameKey(name))) {
        const err = new Error('name-taken');
        err.code = 'name-taken';
        throw err;
      }
      let projectId;
      do projectId = newProjectId(); while (records.has(projectId));
      const rec = {
        v: 1,
        projectId,
        name,
        mode,
        createdAt: now(),
        kdf: clone(kdf),
        creator: { username: creator.username, salt: creator.salt, key: creator.key },
        generation: 1,
        userGenerations: {},
        bans: [],
        ticketKey: b64urlEncode(randomBytes(32)),
      };
      if (mode === 'free') rec.project = { salt: project.salt, key: project.key };
      else rec.list = list.map((e) => ({ username: e.username, salt: e.salt, key: e.key }));
      persist(rec);
      records.set(projectId, rec);
      names.set(nameKey(name), projectId);
      changed('create', projectId);
      return clone(rec);
    },

    /**
     * 改一个项目：`mutate(草稿)` 改草稿，改完落盘再换进内存。项目不存在回 null。
     * @returns 新记录的副本
     */
    update(projectId, mutate) {
      const cur = records.get(projectId);
      if (!cur) return null;
      const draft = clone(cur);
      mutate(draft);
      draft.projectId = projectId;
      draft.name = cur.name;
      persist(draft);
      records.set(projectId, draft);
      indexInvite(draft, cur);
      changed('update', projectId);
      return clone(draft);
    },

    /** 删掉项目记录，名字释放。回是否删了 */
    remove(projectId) {
      const rec = records.get(projectId);
      if (!rec) return false;
      try {
        fs.unlinkSync(fileOf(projectId));
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
      records.delete(projectId);
      names.delete(nameKey(rec.name));
      indexInvite(null, rec); // 删项目：邀请码一并删除（C10a 第 5 节）
      changed('remove', projectId);
      return true;
    },

    /** 全部项目的 `{ projectId, name, mode }` */
    list() {
      return [...records.values()].map((r) => ({ projectId: r.projectId, name: r.name, mode: r.mode }));
    },
  };
}

/** 进程内单例：按 `auth/` 目录的绝对路径 */
const singletons = new Map();

/**
 * 按目录取进程内唯一的一份凭证存储（文档服务与素材服务同进程时共用，契约第 8 节）。
 * 第一次调用时打开；打不开就抛错，下次再调会重试。
 */
export function credentialStoreFor(dir, options = {}) {
  const key = path.resolve(dir);
  let store = singletons.get(key);
  if (!store) {
    store = openCredentialStore({ ...options, dir: key });
    singletons.set(key, store);
  }
  return store;
}

/** 只取已经打开的单例，没打开回 null（不建目录） */
export function existingCredentialStore(dir) {
  return singletons.get(path.resolve(dir)) ?? null;
}

/** 忘掉某个目录的单例（测试清理用） */
export function forgetCredentialStore(dir) {
  singletons.delete(path.resolve(dir));
}
