import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { applyOps, parsePath, isIdArray, idSegment } from '../json-ops.mjs';

export function historyError(code, status = 409) { return Object.assign(new Error(code), { code, status }); }
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw historyError('non-json-value', 400);
}
export const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const copy = (value) => JSON.parse(canonical(value));
const escape = (key) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const valueOf = (value, present = true) => present ? { present: true, value: copy(value) } : { present: false };
export const itemKey = (itemPath, kind = 'value') => canonical({ path: itemPath, kind });

/** Full leaf values plus stable-ID array structure. Explicit equal-valued writes still advance versions. */
export function recordChanges(before, after, { ops = [], versions = {}, nextVersion } = {}) {
  const touched = ops.filter((op) => op.op === 'set' || op.op === 'remove').map((op) => op.path);
  const structures = new Set(ops.filter((op) => op.op === 'insert' || op.op === 'move').map((op) => op.op === 'insert' ? op.path : op.path.slice(0, op.path.lastIndexOf('/'))));
  const forced = (p) => touched.some((t) => t === '' || p === t || p.startsWith(`${t}/`));
  const changes = [];
  function put(p, kind, b, a) {
    const key = itemKey(p, kind);
    changes.push({ itemKey: key, path: p, kind, before: b, after: a, beforeVersion: versions[key] ?? null, afterVersion: nextVersion });
  }
  function walk(b, a, p, bPresent = true, aPresent = true) {
    if (!bPresent || !aPresent) { put(p, 'value', valueOf(b, bPresent), valueOf(a, aPresent)); return; }
    if (isIdArray(b) && isIdArray(a)) {
      const oldIds = b.map((x) => x.id); const newIds = a.map((x) => x.id);
      if (canonical(oldIds) !== canonical(newIds) || forced(p) || structures.has(p)) put(p, 'structure', valueOf(oldIds), valueOf(newIds));
      const oldMap = new Map(b.map((x) => [x.id, x])); const newMap = new Map(a.map((x) => [x.id, x]));
      for (const id of new Set([...oldIds, ...newIds])) walk(oldMap.get(id), newMap.get(id), `${p}/${idSegment(id)}`, oldMap.has(id), newMap.has(id));
    } else if (object(b) && object(a)) {
      const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
      if (!keys.size && forced(p)) put(p, 'value', valueOf(b), valueOf(a));
      for (const key of [...keys].sort()) walk(b[key], a[key], `${p}/${escape(key)}`, Object.hasOwn(b, key), Object.hasOwn(a, key));
    } else if (canonical(b) !== canonical(a) || forced(p)) put(p, Array.isArray(b) || Array.isArray(a) ? 'structure' : 'value', valueOf(b), valueOf(a));
  }
  walk(before, after, '');
  return changes;
}

/** SQLite FULL commits are the prepared/accepted fsync boundaries. An OS SQLite lock excludes another writer process. */
export function openOperationHistory(file, { failpoint = () => {}, maxBytes = 256 * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const owner = new DatabaseSync(`${file}.owner`);
  let db;
  try {
    owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(singleton INTEGER);');
    db = new DatabaseSync(file);
    if (db.prepare('PRAGMA user_version').get().user_version > 2) throw historyError('unsupported-history-version');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,rev INTEGER NOT NULL,snapshot TEXT NOT NULL,versions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(project_id TEXT NOT NULL,op_id TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,input_digest TEXT NOT NULL,prepared_digest TEXT NOT NULL,payload_digest TEXT NOT NULL,prepared TEXT NOT NULL,witness TEXT,PRIMARY KEY(project_id,op_id),UNIQUE(request_id));
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fences(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
      PRAGMA user_version=2;`);
  } catch (error) { try { db?.close(); owner.close(); } catch {} throw error; }
  const q = (sql) => db.prepare(sql);
  function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  const append = (projectId, kind, payload) => Number(q('INSERT INTO journal(project_id,kind,payload) VALUES(?,?,?)').run(projectId, kind, canonical(payload)).lastInsertRowid);
  const decode = (row) => row ? { ...JSON.parse(row.prepared), state: row.state, preparedDigest: row.prepared_digest, payloadDigest: row.payload_digest, ...(row.witness ? { witness: JSON.parse(row.witness) } : {}) } : null;
  function get(projectId, opId) { return decode(q('SELECT * FROM operations WHERE project_id=? AND op_id=?').get(projectId, opId)); }
  function snapshot(projectId) { const row = q('SELECT * FROM projects WHERE id=?').get(projectId); if (!row) throw historyError('project-not-found', 404); return { projectRev: row.rev, value: JSON.parse(row.snapshot), versions: JSON.parse(row.versions) }; }
  function verifyPrepared(op) {
    const raw = q('SELECT prepared,prepared_digest FROM operations WHERE project_id=? AND op_id=?').get(op.projectId, op.opId);
    if (!raw || digest(JSON.parse(raw.prepared)) !== raw.prepared_digest) throw historyError('needs-reconciliation');
    return JSON.parse(raw.prepared);
  }
  function prepareOperation(spec) {
    const input = copy(spec); const inputDigest = digest(input);
    const prior = q('SELECT * FROM operations WHERE request_id=? OR (project_id=? AND op_id=?)').get(spec.requestId, spec.projectId, spec.opId);
    if (prior) { if (prior.input_digest !== inputDigest) throw historyError('operation-id-mismatch'); return decode(prior); }
    return tx(() => {
      if (q("SELECT 1 FROM operations WHERE project_id=? AND state IN ('prepared','reserved','accepted')").get(spec.projectId)) throw historyError('pending-operation');
      const current = snapshot(spec.projectId);
      if (spec.expectedRev !== current.projectRev) throw historyError('stale');
      const applied = applyOps(current.value, spec.ops);
      const after = applied.root;
      const projectRev = current.projectRev + 1;
      const changes = recordChanges(current.value, after, { ops: spec.ops, versions: current.versions, nextVersion: `${projectRev}:${spec.opId}` });
      const dependencies = [...(spec.dependencies ?? [])];
      for (const change of changes) {
        const segments = parsePath(change.path);
        for (let i = 0; i < segments.length; i++) if (segments[i].id !== null) {
          const arrayPath = change.path.split('/').slice(0, i + 1).join('/'); const key = itemKey(arrayPath, 'structure');
          if (!dependencies.some((d) => d.itemKey === key)) dependencies.push({ itemKey: key, version: current.versions[key] ?? null });
        }
      }
      const prepared = { ...input, v: 2, projectRev, before: current.value, after, changes, dependencies };
      const serialized = canonical(prepared);
      const used = q('SELECT COALESCE(SUM(length(CAST(prepared AS BLOB))),0) AS bytes FROM operations').get().bytes;
      if (Buffer.byteLength(serialized) + used > maxBytes) throw historyError('history-capacity', 507);
      const preparedDigest = digest(prepared); const payloadDigest = digest({ ops: prepared.ops, changes, after, result: prepared.result ?? null });
      q("INSERT INTO operations VALUES(?,?,?,'prepared',?,?,?,?,NULL)").run(spec.projectId, spec.opId, spec.requestId, inputDigest, preparedDigest, payloadDigest, serialized);
      append(spec.projectId, 'prepared-op', { ...prepared, preparedDigest, payloadDigest });
      failpoint('prepared-before-commit'); return get(spec.projectId, spec.opId);
    });
  }
  function recordWitness(op, witness) {
    return tx(() => {
      const current = get(op.projectId, op.opId); verifyPrepared(current);
      if (current.state === 'cancelled') throw historyError('operation-cancelled');
      if (current.witness && current.witness.witnessId !== witness.witnessId) throw historyError('witness-id-mismatch');
      if (current.state === 'materialized' || current.state === 'accepted') return current;
      q("UPDATE operations SET state='reserved',witness=? WHERE project_id=? AND op_id=?").run(canonical(witness), op.projectId, op.opId);
      append(op.projectId, 'reserved-op', { opId: op.opId, witness }); failpoint('reserved-before-commit'); return get(op.projectId, op.opId);
    });
  }
  function recordAcceptedOperation(op, witness) {
    return tx(() => {
      const current = get(op.projectId, op.opId); verifyPrepared(current);
      if (['accepted', 'materialized'].includes(current.state)) { if (canonical(current.witness) !== canonical(witness)) throw historyError('accepted-witness-mismatch'); return current; }
      if (current.state === 'cancelled' || witness.state !== 'sealed') throw historyError('not-accepted');
      // 顺序号按见证的签发方（域）各自单调：账号服务的一条序列，游客见证（文档服务自己签，`password-order.mjs` 的 GUEST_ORDER_DOMAIN）另一条
      const last = lastOrderSeq(op.projectId, witness.domain);
      if (last >= witness.orderSeq) throw historyError('order-regression');
      q("UPDATE operations SET state='accepted',witness=? WHERE project_id=? AND op_id=?").run(canonical(witness), op.projectId, op.opId);
      append(op.projectId, 'accepted-op', { opId: op.opId, witness }); failpoint('accepted-before-commit'); return get(op.projectId, op.opId);
    });
  }
  /** 这个项目里这个域的见证最后一个被接受的顺序号；没有回 0。没写域的老见证（只在测试里）按同一条算 */
  function lastOrderSeq(projectId, domain = null) {
    const row = q("SELECT witness FROM operations WHERE project_id=? AND state IN ('accepted','materialized') AND json_extract(witness,'$.domain') IS ? ORDER BY json_extract(prepared,'$.projectRev') DESC LIMIT 1").get(projectId, domain ?? null);
    return row ? JSON.parse(row.witness).orderSeq : 0;
  }
  function materialize(op) {
    return tx(() => {
      const current = get(op.projectId, op.opId); const prepared = verifyPrepared(current);
      if (current.state === 'materialized') return current;
      if (current.state !== 'accepted') throw historyError('not-accepted');
      const view = snapshot(op.projectId);
      if (view.projectRev !== prepared.expectedRev || digest(view.value) !== digest(prepared.before)) throw historyError('needs-reconciliation');
      const versions = { ...view.versions };
      for (const change of prepared.changes) versions[change.itemKey] = change.afterVersion;
      q('UPDATE projects SET rev=?,snapshot=?,versions=? WHERE id=?').run(prepared.projectRev, canonical(prepared.after), canonical(versions), op.projectId);
      q("UPDATE operations SET state='materialized' WHERE project_id=? AND op_id=?").run(op.projectId, op.opId);
      append(op.projectId, 'materialized-op', { opId: op.opId, projectRev: prepared.projectRev }); failpoint('materialize-before-commit'); return get(op.projectId, op.opId);
    });
  }
  function cancelOperation(op, witness = null) {
    return tx(() => {
      const current = get(op.projectId, op.opId);
      if (['accepted', 'materialized'].includes(current.state) || witness?.state === 'sealed') throw historyError('already-accepted');
      q("UPDATE operations SET state='cancelled',witness=? WHERE project_id=? AND op_id=?").run(witness ? canonical(witness) : null, op.projectId, op.opId);
      append(op.projectId, 'cancelled-op', { opId: op.opId }); failpoint('cancelled-before-commit'); return get(op.projectId, op.opId);
    });
  }
  function requestFence(fence) {
    return tx(() => {
      const prior = q('SELECT * FROM fences WHERE id=?').get(fence.id);
      if (prior) { if (prior.payload !== canonical(fence)) throw historyError('fence-id-mismatch'); return JSON.parse(prior.payload); }
      q("INSERT INTO fences VALUES(?,?,'requested',?)").run(fence.id, fence.projectId, canonical(fence)); append(fence.projectId, 'fence-requested', fence); failpoint('fence-request-before-commit'); return copy(fence);
    });
  }
  function commitFence(fence) {
    return tx(() => {
      if (q("SELECT 1 FROM operations WHERE project_id=? AND state IN ('prepared','reserved','accepted')").get(fence.projectId)) throw historyError('pending-operation');
      const prior = q('SELECT state FROM fences WHERE id=?').get(fence.id);
      if (!prior) throw historyError('fence-not-found');
      if (prior.state === 'committed') return copy(fence);
      q("UPDATE fences SET state='committed' WHERE id=?").run(fence.id); append(fence.projectId, 'fence-committed', fence); failpoint('fence-before-commit'); return copy(fence);
    });
  }
  function validate(projectId) {
    const genesis = q("SELECT payload FROM journal WHERE project_id=? AND kind='project-created' ORDER BY seq LIMIT 1").get(projectId);
    if (!genesis) throw historyError('needs-reconciliation');
    const baseline = JSON.parse(genesis.payload);
    let value = baseline.snapshot; let rev = baseline.projectRev ?? 0; const orderSeqs = new Map(); const versions = {};
    const rows = q("SELECT * FROM operations WHERE project_id=? AND state IN ('accepted','materialized') ORDER BY json_extract(prepared,'$.projectRev')").all(projectId);
    for (const row of rows) {
      const op = decode(row); const prepared = verifyPrepared(op);
      const domain = op.witness?.domain ?? null;
      if (op.expectedRev !== rev || op.projectRev !== rev + 1 || digest(op.before) !== digest(value) || !Number.isSafeInteger(op.witness?.orderSeq) || op.witness.orderSeq <= (orderSeqs.get(domain) ?? 0)) throw historyError('needs-reconciliation');
      const accepted = q("SELECT payload FROM journal WHERE project_id=? AND kind='accepted-op' AND json_extract(payload,'$.opId')=?").get(projectId, op.opId);
      const preparedLog = q("SELECT payload FROM journal WHERE project_id=? AND kind='prepared-op' AND json_extract(payload,'$.opId')=?").get(projectId, op.opId);
      if (!accepted || canonical(JSON.parse(accepted.payload).witness) !== canonical(op.witness) || !preparedLog || canonical(JSON.parse(preparedLog.payload)) !== canonical({ ...prepared, preparedDigest: op.preparedDigest, payloadDigest: op.payloadDigest })) throw historyError('needs-reconciliation');
      orderSeqs.set(domain, op.witness.orderSeq);
      if (op.state === 'materialized') { rev = op.projectRev; value = op.after; for (const change of op.changes) versions[change.itemKey] = change.afterVersion; }
    }
    const acceptedCount = q("SELECT COUNT(*) AS n FROM journal WHERE project_id=? AND kind='accepted-op'").get(projectId).n;
    const current = snapshot(projectId);
    if (acceptedCount !== rows.length || current.projectRev !== rev || digest(current.value) !== digest(value) || canonical(current.versions) !== canonical(versions)) throw historyError('needs-reconciliation');
    return current;
  }
  const fenceReceipt = (id) => { const row = q("SELECT payload FROM journal WHERE kind='fence-acknowledged' AND json_extract(payload,'$.id')=?").get(id); return row ? JSON.parse(row.payload).receipt : null; };
  return { prepareOperation, recordWitness, recordAcceptedOperation, materialize, cancelOperation, requestFence, commitFence, get, snapshot, verifyPrepared,
    validate, fenceReceipt, lastOrderSeq,
    recordFenceReceipt(fence, receipt) { return tx(() => { if (receipt?.durable !== true || q('SELECT state FROM fences WHERE id=?').get(fence.id)?.state !== 'committed') throw historyError('fence-not-acknowledged'); const prior = fenceReceipt(fence.id); if (prior) return prior; append(fence.projectId, 'fence-acknowledged', { id: fence.id, receipt }); failpoint('fence-ack-before-commit'); return copy(receipt); }); },
    createProject(projectId, initial = {}, { projectRev = 0 } = {}) { tx(() => {
      if (!Number.isSafeInteger(projectRev) || projectRev < 0) throw historyError('bad-project-baseline');
      if (!q('SELECT 1 FROM projects WHERE id=?').get(projectId)) {
        q('INSERT INTO projects VALUES(?,?,?,?)').run(projectId, projectRev, canonical(initial), '{}');
        append(projectId, 'project-created', { snapshot: initial, projectRev });
      }
    }); },
    pending: (projectId) => q("SELECT * FROM operations WHERE project_id=? AND state IN ('prepared','reserved','accepted')").all(projectId).map(decode),
    accepted: (projectId) => q("SELECT * FROM operations WHERE project_id=? AND state IN ('accepted','materialized') ORDER BY json_extract(prepared,'$.projectRev')").all(projectId).map(decode),
    /** 这些登录在所有项目里留下的操作(只读):退出确认用它判「旧登录有没有还没定序的操作」并取各项目的结束位置。 */
    byLogins(loginIds) {
      const ids = new Set(loginIds);
      if (!ids.size) return [];
      return q("SELECT o.*, p.rev AS project_rev FROM operations o JOIN projects p ON p.id=o.project_id").all()
        .map((row) => ({ ...decode(row), currentProjectRev: row.project_rev })).filter((op) => ids.has(op.actor?.loginId));
    },
    fences: (projectId) => q('SELECT * FROM fences WHERE project_id=?').all(projectId).map((row) => ({ ...JSON.parse(row.payload), state: row.state })),
    journal: (projectId) => q('SELECT * FROM journal WHERE project_id=? ORDER BY seq').all(projectId).map((row) => ({ ...JSON.parse(row.payload), seq: row.seq, kind: row.kind })),
    checkpoint: () => db.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
    close() { db.close(); owner.close(); },
  };
}
