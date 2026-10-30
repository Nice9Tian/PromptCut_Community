import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, digestOf } from './run-asset-client.mjs';

export { canonicalJson, digestOf };

const fail = code => { throw Object.assign(new Error(code), { code, status: 503 }); };
const clone = x => structuredClone(x);
const fields = ['projectId', 'conversationId', 'messageId', 'runId', 'runGrantId'];

/** Agent-local evidence before the first model/tool call. SQLite FULL commit is the
 * durable read-intent boundary. An execution-started record is never automatically
 * retried after restart: a crash leaves an explicit uncertain external effect.
 */
export function openReadIntents({ file, failpoint = () => {}, now = Date.now } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('read-intent-configuration');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS read_intents (id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)');
  fs.chmodSync(file, 0o600);
  const row = id => {
    const result = db.prepare('SELECT payload FROM read_intents WHERE id=?').get(id);
    if (!result) fail('read-intent-not-found'); return JSON.parse(result.payload);
  };
  const transaction = (point, fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); failpoint(`${point}-before-commit`); db.exec('COMMIT');
      failpoint(`${point}-after-commit`); return clone(result);
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  };
  const save = value => db.prepare('UPDATE read_intents SET payload=? WHERE id=?').run(JSON.stringify(value), value.readIntentId);
  function prepare({ requestId, binding, prompt, inputDigest = null }) {
    if (typeof requestId !== 'string' || !requestId || fields.some(k => typeof binding?.[k] !== 'string' || !binding[k])) fail('read-intent-binding');
    const payload = { ...Object.fromEntries(fields.map(k => [k, binding[k]])), prompt: clone(prompt), inputDigest };
    const digest = digestOf(payload);
    return transaction('read-intent', () => {
      const prior = db.prepare('SELECT payload FROM read_intents WHERE request_id=?').get(requestId);
      if (prior) { const value = JSON.parse(prior.payload); if (value.digest !== digest) fail('read-intent-request-mismatch'); return value; }
      const value = { ...payload, readIntentId: `intent_${randomUUID()}`, requestId, promptDigest: digestOf(prompt), digest,
        state: 'prepared', readAt: now(), receipt: null };
      db.prepare('INSERT INTO read_intents VALUES(?,?,?)').run(value.readIntentId, requestId, JSON.stringify(value)); return value;
    });
  }
  const requestOf = value => ({ ...Object.fromEntries(fields.map(k => [k, value[k]])),
    requestId: value.requestId, readIntentId: value.readIntentId, promptDigest: value.promptDigest, prompt: clone(value.prompt) });
  function accept(readIntentId, answer) {
    return transaction('read-confirmation', () => {
      const value = row(readIntentId), receipt = answer?.receipt;
      if (answer?.confirmed !== true || fields.some(k => receipt?.[k] !== value[k]) ||
        receipt.requestId !== value.requestId || receipt.readIntentId !== value.readIntentId || receipt.promptDigest !== value.promptDigest ||
        !Number.isSafeInteger(receipt.authoritySeq) || receipt.authoritySeq < 1 || typeof receipt.receiptId !== 'string') fail('read-confirmation-invalid');
      if (value.receipt && canonicalJson(value.receipt) !== canonicalJson(receipt)) fail('read-confirmation-conflict');
      if (value.state === 'prepared') { value.state = 'confirmed'; value.receipt = clone(receipt); save(value); }
      return value;
    });
  }
  async function confirm(readIntentId, transport) {
    if (typeof transport?.confirmRead !== 'function' || typeof transport?.queryRead !== 'function') fail('read-transport-unavailable');
    const value = row(readIntentId);
    if (value.state !== 'prepared') return value;
    let answer;
    try { answer = await transport.confirmRead(requestOf(value)); }
    catch {
      // Unknown ACK is resolved by the original request, never by another model call.
      try { answer = await transport.queryRead(requestOf(value)); } catch { fail('read-confirmation-unknown'); }
      if (answer?.confirmed !== true) fail('read-confirmation-unknown');
    }
    return accept(readIntentId, answer);
  }
  async function executeOnce(readIntentId, { authorize, execute } = {}) {
    if (typeof authorize !== 'function' || typeof execute !== 'function') fail('read-execution-unavailable');
    let value = row(readIntentId);
    if (value.state !== 'confirmed') fail('read-execution-not-confirmed');
    // A replayed read receipt proves a past read, not current permission after private/stop.
    if ((await authorize(clone(value)))?.allowed !== true) fail('read-execution-revoked');
    value = transaction('read-execution', () => {
      const current = row(readIntentId);
      if (current.state !== 'confirmed') fail('read-execution-already-started');
      current.state = 'execution-started'; current.startedAt = now(); save(current); return current;
    });
    const result = await execute(clone(value));
    transaction('read-finished', () => { const current = row(readIntentId); current.state = 'finished'; current.finishedAt = now(); save(current); return current; });
    return result;
  }
  /** 对话被删：这个对话的已读意向(含提示词原文)全部删掉 */
  function purgeConversation({ projectId, conversationId }) {
    return transaction('read-intent-purge', () => ({ rows: db.prepare(
      "DELETE FROM read_intents WHERE json_extract(payload,'$.projectId')=? AND json_extract(payload,'$.conversationId')=?").run(projectId, conversationId).changes }));
  }
  return { prepare, confirm, executeOnce, get: row, purgeConversation,
    pending: () => db.prepare('SELECT payload FROM read_intents').all().map(r => JSON.parse(r.payload)).filter(r => r.state !== 'finished'),
    inspect: () => ({ journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: db.prepare('PRAGMA synchronous').get().synchronous, integrity: db.prepare('PRAGMA integrity_check').get().integrity_check }),
    close: () => db.close() };
}
