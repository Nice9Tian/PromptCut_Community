/**
 * Credential store for shared projects (contract `docs/plan/auth-contract.md` Section 3).
 *
 * The directory is `auth/` under the document service data directory:
 * - `auth/server.json`: `{ v: 1, secret }`, server key (32 bytes base64url), generated on first
 *   open. Only used to generate pseudo-salts for usernames not on the list (Section 4); does not
 *   sign tickets;
 * - `auth/projects/<projectId>.json`: one record per shared project; writes use a temporary file
 *   plus rename.
 *
 * On open, all records are read into memory; subsequent reads only access memory, while writes flush
 * to disk before updating memory. Throws if unable to open (directory unwritable, file corrupted):
 * `main.mjs` in standalone mode shuts down on failure based on this (Section 10).
 *
 * The `K` stored in records is equivalent to a passphrase for this protocol (plan Section 12.2), so
 * this directory is never exposed via any static service. When the document service and asset service
 * share the same process, they share the same in-memory state (ticket generation, signing key, Section 8):
 * use `credentialStoreFor(dir)` to get the in-process singleton by directory.
 *
 * Uses Node built-in modules only (D2 gatekeeper).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { b64urlEncode, nameKey, isProjectId } from './protocol.mjs';
import { inviteDigest } from './invite.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `sp_<26 lowercase base32 chars>`: 130-bit random number */
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

/** Signing key ID: first 8 base64url characters of key's sha256 (not stored separately in records) */
export const kidOf = (ticketKey) => b64urlEncode(createHash('sha256').update(String(ticketKey), 'utf8').digest()).slice(0, 8);

let tmpSeq = 0;

/**
 * Writes to a temporary file, flushes to disk, then renames over target; on Windows, renaming
 * may hit EPERM while target is being read, retries briefly.
 */
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
    try { fs.unlinkSync(tmp); } catch { /* Not created */ }
    throw err;
  }
}

const clone = (v) => structuredClone(v);

/**
 * Opens (creating if necessary) the credential store.
 * @param {object} options
 * @param {string} options.dir The `auth/` directory itself
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function openCredentialStore({ dir, now = Date.now, log = () => {} } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('openCredentialStore: dir must be a non-empty string');
  const root = path.resolve(dir);
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  // Server key: read if present, generate if not
  const serverFile = path.join(root, 'server.json');
  let secret;
  if (fs.existsSync(serverFile)) {
    const j = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
    if (!j || j.v !== 1 || typeof j.secret !== 'string' || j.secret.length < 32) throw new Error('Invalid auth/server.json format');
    secret = j.secret;
  } else {
    secret = b64urlEncode(randomBytes(32));
    writeAtomic(serverFile, `${JSON.stringify({ v: 1, secret, createdAt: now() })}\n`);
  }
  // Test writability here: when server.json already exists in a read-only directory, above won't write
  fs.accessSync(projectsDir, fs.constants.W_OK);

  /** projectId → record */
  const records = new Map();
  /** Name key → projectId */
  const names = new Map();
  /**
   * Invite code digest → projectId (C10a contract Section 5). Only records the digest of each project's
   * current invite code: updated when issuing a new one or deleting a project; invalidated records
   * remain, with expiration checked by `inviteActive` in `invite.mjs`. Looking up projects by digest
   * avoids computing HMAC for each project.
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
      throw new Error(`Invalid auth/projects/${entry} format`);
    }
    records.set(id, rec);
    names.set(nameKey(rec.name), id);
    indexInvite(rec, null);
  }
  log('auth.store.open', { projects: records.size });

  /**
   * Record change listener (used by hosted-side catalog module, `docs/plan/hosted-render-contract.md`
   * Section 2): called once after each create, update, remove, or install on move.
   */
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
    /** Server key (bytes) */
    serverSecret: Buffer.from(secret, 'base64url'),

    count: () => records.size,

    /**
     * Subscribe to record changes: `fn({ type: 'create' | 'update' | 'remove' | 'install', projectId })`,
     * called after persisting to disk and swapping into memory. Returns an unsubscribe function.
     */
    onChange(fn) {
      if (typeof fn !== 'function') throw new TypeError('onChange: a function is required');
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },

    /** Replica of the record; returns null if none */
    get(projectId) {
      const rec = records.get(projectId);
      return rec ? clone(rec) : null;
    },

    /** Internal use: no copy, read-only (hot paths like handshake and ticket verification) */
    peek(projectId) {
      return records.get(projectId) ?? null;
    },

    byName(name) {
      const id = names.get(nameKey(name));
      return id ? clone(records.get(id)) : null;
    },

    nameTaken: (name) => names.has(nameKey(name)),

    /** Find project by invite code digest (C10a): internal use, no copy, read-only; returns null if none */
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
     * Creates a project. Fields are validated by caller; generates projectId and ticketKey here, with
     * generation starting from 1. Throws `code: 'name-taken'` if the name is already taken.
     * @returns Replica of the record
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
      else rec.list = list.map((e) => ({ username: e.username, salt: e.salt, key: e.key, ...(e.access === 'r' ? { access: 'r' } : {}) }));
      persist(rec);
      records.set(projectId, rec);
      names.set(nameKey(name), projectId);
      changed('create', projectId);
      return clone(rec);
    },

    /**
     * Updates a project: `mutate(draft)` modifies the draft, flushes to disk after edits, and swaps
     * into memory. Returns null if the project does not exist.
     * @returns Replica of the new record
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

    /** Deletes the project record and releases the name. Returns whether it was deleted */
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
      indexInvite(null, rec); // Delete project: invite codes are deleted together (C10a Section 5)
      changed('remove', projectId);
      return true;
    },

    /** `{ projectId, name, mode }` for all projects */
    list() {
      return [...records.values()].map((r) => ({ projectId: r.projectId, name: r.name, mode: r.mode }));
    },
  };
}

/** In-process singleton: keyed by absolute path of the `auth/` directory */
const singletons = new Map();

/**
 * Gets the unique in-process credential store by directory (shared when document service and asset
 * service run in the same process, contract Section 8). Opens on first call; throws if unable to
 * open, retrying on subsequent calls.
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

/** Only gets an already-opened singleton, returns null if not opened (does not create directory) */
export function existingCredentialStore(dir) {
  return singletons.get(path.resolve(dir)) ?? null;
}

/** Forgets the singleton for a directory (used for test cleanup) */
export function forgetCredentialStore(dir) {
  singletons.delete(path.resolve(dir));
}
