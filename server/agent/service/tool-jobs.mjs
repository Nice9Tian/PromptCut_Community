import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CONTEXT_KEYS = Object.freeze([
  'projectId', 'conversationId', 'runId', 'runGrantId', 'instanceId', 'instanceGeneration', 'senderAccountId', 'messageId',
]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const KIND_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{8,128}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const STAGE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ERROR_RE = /^[A-Z][A-Z0-9_-]{1,63}$/;
const OUTPUT_KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const OUTPUT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const STATES = new Set(['queued', 'running', 'done', 'error', 'cancelled', 'interrupted']);
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

export class ToolJobsError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ToolJobsError';
    this.code = code;
  }
}

function fail(code) { throw new ToolJobsError(code); }

function canonicalContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('bad-context');
  const keys = Object.keys(value);
  if (keys.length !== CONTEXT_KEYS.length || keys.some((key) => !CONTEXT_KEYS.includes(key))) fail('bad-context');
  const context = {};
  for (const key of CONTEXT_KEYS) {
    if (key === 'instanceGeneration') {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail('bad-context');
      context[key] = value[key];
    } else {
      if (typeof value[key] !== 'string' || !ID_RE.test(value[key])) fail('bad-context');
      context[key] = value[key];
    }
  }
  return Object.freeze(context);
}

function checkedKind(value) {
  if (typeof value !== 'string' || !KIND_RE.test(value)) fail('bad-kind');
  return value;
}

function checkedDigest(value) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail('bad-input-digest');
  return value;
}

function checkedRequestId(value) {
  if (typeof value !== 'string' || !REQUEST_RE.test(value)) fail('bad-request-id');
  return value;
}

function checkedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('bad-revision');
  return value;
}

function checkedFenceRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('bad-fence');
  return value;
}

function checkedOutputRefs(value) {
  if (!Array.isArray(value) || value.length > 64) fail('bad-output-refs');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2 ||
        Object.keys(item).some((key) => key !== 'kind' && key !== 'id') ||
        typeof item.kind !== 'string' || !OUTPUT_KIND_RE.test(item.kind) ||
        typeof item.id !== 'string' || !OUTPUT_ID_RE.test(item.id)) fail('bad-output-refs');
    return { kind: item.kind, id: item.id };
  });
}

function checkedPatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('bad-patch');
  const keys = Object.keys(value);
  const allowed = new Set(['state', 'stage', 'progress', 'outputRefs', 'errorCode']);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) fail('bad-patch');
  const patch = {};
  if (Object.hasOwn(value, 'state')) {
    if (typeof value.state !== 'string' || !STATES.has(value.state)) fail('bad-state');
    patch.state = value.state;
  }
  if (Object.hasOwn(value, 'stage')) {
    if (typeof value.stage !== 'string' || !STAGE_RE.test(value.stage)) fail('bad-stage');
    patch.stage = value.stage;
  }
  if (Object.hasOwn(value, 'progress')) {
    if (typeof value.progress !== 'number' || !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1) fail('bad-progress');
    patch.progress = value.progress;
  }
  if (Object.hasOwn(value, 'outputRefs')) patch.outputRefs = checkedOutputRefs(value.outputRefs);
  if (Object.hasOwn(value, 'errorCode')) {
    if (value.errorCode !== null && (typeof value.errorCode !== 'string' || !ERROR_RE.test(value.errorCode))) fail('bad-error-code');
    patch.errorCode = value.errorCode;
  }
  return patch;
}

function contextColumns(context) {
  return [context.projectId, context.conversationId, context.runId, context.runGrantId,
    context.instanceId, context.instanceGeneration, context.senderAccountId, context.messageId];
}

function contextWhere() {
  return `project_id=? AND conversation_id=? AND run_id=? AND grant_id=? AND instance_id=? AND instance_generation=? AND sender_account_id=? AND message_id=?`;
}

function decodeRow(row) {
  return {
    jobId: row.job_id,
    kind: row.kind,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    runGrantId: row.grant_id,
    instanceId: row.instance_id,
    instanceGeneration: row.instance_generation,
    senderAccountId: row.sender_account_id,
    messageId: row.message_id,
    inputDigest: row.input_digest,
    fenceRevision: row.fence_revision,
    revision: row.revision,
    state: row.state,
    stage: row.stage,
    progress: row.progress,
    outputRefs: JSON.parse(row.output_refs),
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sameFence(a, b) {
  return b?.allowed === true && b.fenceRevision === a.fenceRevision &&
    b.grantState === a.grantState;
}

/**
 * Create the durable F0 job ledger. This factory tracks work state only; it does not start, stop,
 * resume, or attest to any child process. `verifyFence` must independently recognize the exact
 * trusted context/fence supplied by the host. For cancellation it is the authority; `authorize`
 * is deliberately not consulted so a revoked run can still have its matching rows marked cancelled.
 */
export function createToolJobs({ databasePath, authorize, verifyFence, now = Date.now } = {}) {
  if (typeof databasePath !== 'string' || databasePath.trim() === '' || databasePath === ':memory:') fail('database-path-required');
  if (typeof authorize !== 'function' || typeof verifyFence !== 'function') fail('authorization-required');
  if (typeof now !== 'function') fail('bad-clock');
  const file = path.resolve(databasePath);
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && (fs.statSync(directory).mode & 0o077) !== 0) fail('database-directory-not-private');
  const existed = fs.existsSync(file);
  if (existed && process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) fail('database-file-not-private');
  const db = new DatabaseSync(file);
  if (!existed && process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { db.close(); fail('database-permissions'); }
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      grant_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      instance_generation INTEGER NOT NULL,
      sender_account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      fence_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','done','error','cancelled','interrupted')),
      stage TEXT,
      progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 1),
      output_refs TEXT NOT NULL,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS tool_job_grant_states (
      job_id TEXT PRIMARY KEY REFERENCES tool_jobs(job_id) ON DELETE CASCADE,
      grant_state TEXT NOT NULL CHECK (grant_state IN ('active','retained'))
    );`);
    db.exec('DROP INDEX IF EXISTS tool_jobs_idempotency;');
    db.exec(`CREATE UNIQUE INDEX tool_jobs_idempotency ON tool_jobs (
      project_id, conversation_id, run_id, grant_id, instance_id, instance_generation,
      sender_account_id, message_id, kind, request_key
    );`);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    db.close();
    throw error;
  }
  db.exec('BEGIN IMMEDIATE;');
  try {
    const at = Number(now());
    if (!Number.isSafeInteger(at) || at < 0) fail('bad-clock');
    // 排着的(queued)和在跑的(running)都是上一个进程里的事:这个进程里没有任何东西会去做它,两种都如实标成被中断。
    // 被中断是终态:这一行不会再动。要重做就重新发起一次(新的一次工具调用,请求号不同,得到新作业;各工具包都按「已中断的可以重新发起」处理),
    // 不会凭一行排着的记录一直等下去。同一个请求号原样重发拿到的仍是这条被中断的记录,不会悄悄开第二份工。
    db.prepare(`UPDATE tool_jobs SET state='interrupted', revision=revision+1,
      error_code='INTERRUPTED_ON_RESTART', updated_at=? WHERE state IN ('queued','running')`).run(at);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    db.close();
    throw error;
  }

  let tail = Promise.resolve();
  let closed = false;
  let closing = false;
  let closePromise = null;

  const enqueue = (operation) => {
    if (closed || closing) return Promise.reject(new ToolJobsError('closed'));
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };

  const callAuthorize = async (context, action) => {
    let result;
    try { result = await authorize(context, action); } catch { fail('authorization-unavailable'); }
    if (!result || result.allowed !== true || !Number.isSafeInteger(result.fenceRevision) || result.fenceRevision < 0 ||
        !['active', 'retained'].includes(result.grantState)) fail('forbidden');
    return { allowed: true, fenceRevision: result.fenceRevision, grantState: result.grantState };
  };

  const callVerifyFence = async (context, revision) => {
    let result;
    try { result = await verifyFence(context, revision); } catch { fail('fence-unavailable'); }
    if (result !== true) fail('fence-rejected');
  };

  const nextTime = (previous = 0) => {
    const value = Number(now());
    if (!Number.isSafeInteger(value) || value < 0) fail('bad-clock');
    return Math.max(value, previous);
  };

  const authorizedWrite = async (context, operation) => {
    const before = await callAuthorize(context, 'write');
    await callVerifyFence(context, before.fenceRevision);
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation(before.fenceRevision, before.grantState);
      const after = await callAuthorize(context, 'write');
      if (!sameFence(before, after)) fail('fence-changed');
      await callVerifyFence(context, before.fenceRevision);
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* Preserve the original authorization or storage error. */ }
      if (error instanceof ToolJobsError) throw error;
      fail('storage-error');
    }
  };

  const authorizedRead = async (context, operation) => {
    const before = await callAuthorize(context, 'read');
    await callVerifyFence(context, before.fenceRevision);
    const result = operation();
    const after = await callAuthorize(context, 'read');
    if (!sameFence(before, after)) fail('fence-changed');
    await callVerifyFence(context, before.fenceRevision);
    return result;
  };

  const publicApi = {
    start(contextValue, kindValue, digestValue, requestIdValue) {
      const context = canonicalContext(contextValue);
      const kind = checkedKind(kindValue);
      const inputDigest = checkedDigest(digestValue);
      const requestId = checkedRequestId(requestIdValue);
      const requestKey = createHash('sha256').update(requestId).digest('hex');
      return enqueue(() => authorizedWrite(context, (fenceRevision, grantState) => {
        const key = [context.projectId, context.conversationId, context.runId, context.runGrantId,
          context.instanceId, context.instanceGeneration, context.senderAccountId, context.messageId, kind, requestKey];
        const existing = db.prepare(`SELECT j.job_id, j.state, j.input_digest, j.fence_revision,
          g.grant_state FROM tool_jobs j LEFT JOIN tool_job_grant_states g ON g.job_id=j.job_id WHERE
          project_id=? AND conversation_id=? AND run_id=? AND grant_id=? AND instance_id=? AND
          instance_generation=? AND sender_account_id=? AND message_id=? AND kind=? AND request_key=?`).get(...key);
        if (existing) {
          if (existing.input_digest !== inputDigest) fail('idempotency-conflict');
          if (existing.fence_revision !== fenceRevision || existing.grant_state !== grantState)
            fail('job-scope-mismatch');
          return { jobId: existing.job_id, state: existing.state };
        }
        const jobId = `job_${randomUUID()}`;
        const at = nextTime();
        db.prepare(`INSERT INTO tool_jobs (
          job_id, kind, project_id, conversation_id, run_id, grant_id, instance_id, instance_generation,
          sender_account_id, message_id, request_key, input_digest, fence_revision, revision,
          state, stage, progress, output_refs, error_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'queued', NULL, 0, '[]', NULL, ?, ?)`).run(
          jobId, kind, ...contextColumns(context), requestKey, inputDigest, fenceRevision, at, at,
        );
        db.prepare('INSERT INTO tool_job_grant_states (job_id, grant_state) VALUES (?, ?)').run(jobId, grantState);
        return { jobId, state: 'queued' };
      }));
    },

    update(contextValue, jobId, expectedRevisionValue, patchValue) {
      const context = canonicalContext(contextValue);
      if (typeof jobId !== 'string' || !/^job_[0-9a-f-]{36}$/.test(jobId)) fail('bad-job-id');
      const expectedRevision = checkedRevision(expectedRevisionValue);
      const patch = checkedPatch(patchValue);
      return enqueue(() => authorizedWrite(context, (fenceRevision) => {
        const row = db.prepare(`SELECT * FROM tool_jobs WHERE job_id=? AND ${contextWhere()}`).get(jobId, ...contextColumns(context));
        if (!row || row.fence_revision !== fenceRevision) fail('job-scope-mismatch');
        if (row.revision !== expectedRevision) fail('stale-revision');
        if (TERMINAL.has(row.state)) fail('terminal-job');
        const state = patch.state ?? row.state;
        const transitions = {
          queued: new Set(['queued', 'running', 'error', 'cancelled', 'interrupted']),
          running: new Set(['running', 'done', 'error', 'cancelled', 'interrupted']),
        };
        if (!transitions[row.state]?.has(state)) fail('invalid-transition');
        const progress = patch.progress ?? row.progress;
        if (progress < row.progress) fail('progress-regression');
        const errorCode = Object.hasOwn(patch, 'errorCode') ? patch.errorCode : row.error_code;
        if (state === 'done' && progress !== 1) fail('done-requires-complete-progress');
        if (state === 'error' && !errorCode) fail('error-code-required');
        const stage = Object.hasOwn(patch, 'stage') ? patch.stage : row.stage;
        const outputRefs = Object.hasOwn(patch, 'outputRefs') ? patch.outputRefs : JSON.parse(row.output_refs);
        const at = nextTime(row.updated_at);
        db.prepare(`UPDATE tool_jobs SET revision=?, state=?, stage=?, progress=?, output_refs=?, error_code=?, updated_at=?
          WHERE job_id=? AND revision=?`).run(expectedRevision + 1, state, stage, progress,
          JSON.stringify(outputRefs), errorCode, at, jobId, expectedRevision);
        return undefined;
      }));
    },

    checkpointRetained(contextValue, jobId, expectedRevisionValue) {
      const context = canonicalContext(contextValue);
      if (typeof jobId !== 'string' || !/^job_[0-9a-f-]{36}$/.test(jobId)) fail('bad-job-id');
      const expectedRevision = checkedRevision(expectedRevisionValue);
      return enqueue(async () => {
        const before = await callAuthorize(context, 'write');
        if (before.grantState !== 'retained') fail('retained-grant-required');
        await callVerifyFence(context, before.fenceRevision);
        db.exec('BEGIN IMMEDIATE;');
        try {
          const row = db.prepare(`SELECT j.*, g.grant_state FROM tool_jobs j
            LEFT JOIN tool_job_grant_states g ON g.job_id=j.job_id
            WHERE j.job_id=? AND ${contextWhere()}`).get(jobId, ...contextColumns(context));
          if (!row) fail('job-scope-mismatch');
          if (row.revision !== expectedRevision) fail('stale-revision');
          if (!['active', 'retained'].includes(row.grant_state) || TERMINAL.has(row.state) ||
              row.fence_revision >= before.fenceRevision) fail('retained-checkpoint-denied');
          const at = nextTime(row.updated_at);
          db.prepare('UPDATE tool_jobs SET fence_revision=?, revision=?, updated_at=? WHERE job_id=? AND revision=?')
            .run(before.fenceRevision, expectedRevision + 1, at, jobId, expectedRevision);
          db.prepare("UPDATE tool_job_grant_states SET grant_state='retained' WHERE job_id=? AND grant_state IN ('active','retained')")
            .run(jobId);
          const after = await callAuthorize(context, 'write');
          if (!sameFence(before, after) || after.grantState !== 'retained') fail('fence-changed');
          await callVerifyFence(context, before.fenceRevision);
          db.exec('COMMIT;');
          return Object.freeze({ revision: expectedRevision + 1, fenceRevision: before.fenceRevision,
            grantState: 'retained' });
        } catch (error) {
          try { db.exec('ROLLBACK;'); } catch { /* Preserve the first failure. */ }
          if (error instanceof ToolJobsError) throw error;
          fail('storage-error');
        }
      });
    },

    get(contextValue, jobId) {
      const context = canonicalContext(contextValue);
      if (typeof jobId !== 'string' || !/^job_[0-9a-f-]{36}$/.test(jobId)) fail('bad-job-id');
      return enqueue(() => authorizedRead(context, () => {
        const row = db.prepare('SELECT * FROM tool_jobs WHERE job_id=? AND project_id=? AND conversation_id=?')
          .get(jobId, context.projectId, context.conversationId);
        return row ? decodeRow(row) : null;
      }).then((row) => {
        if (!row) fail('job-not-found');
        return row;
      }));
    },

    /** 这一轮名下还没结束的作业(排着的、在跑的)。宿主在一轮收尾前据此等后台作业做完;只看这一轮自己的。 */
    active(contextValue) {
      const context = canonicalContext(contextValue);
      return enqueue(() => authorizedRead(context, () => db.prepare(
        `SELECT job_id, kind, state FROM tool_jobs WHERE ${contextWhere()} AND state IN ('queued','running') ORDER BY created_at`)
        .all(...contextColumns(context)).map((row) => ({ jobId: row.job_id, kind: row.kind, state: row.state }))));
    },

    /**
     * 这一轮名下还没结束的作业有几个。只给宿主自己数(一轮收尾前等后台作业用):不出这个进程、不带作业的任何内容,
     * 所以这里不向文档服务问授权;这一轮还算不算数由宿主按它自己的节奏另核(`account-tools.mjs` 的 `settle`)。
     */
    pending(contextValue) {
      const context = canonicalContext(contextValue);
      return enqueue(() => Number(db.prepare(
        `SELECT COUNT(*) AS n FROM tool_jobs WHERE ${contextWhere()} AND state IN ('queued','running')`).get(...contextColumns(context))?.n ?? 0));
    },

    cancelForFence(contextValue, fenceRevisionValue) {
      const context = canonicalContext(contextValue);
      const fenceRevision = checkedFenceRevision(fenceRevisionValue);
      return enqueue(async () => {
        await callVerifyFence(context, fenceRevision);
        db.exec('BEGIN IMMEDIATE;');
        try {
          const at = nextTime();
          db.prepare(`UPDATE tool_jobs SET state='cancelled', revision=revision+1,
            error_code='FENCE_CANCELLED', updated_at=? WHERE ${contextWhere()} AND fence_revision=? AND state IN ('queued','running')`)
            .run(at, ...contextColumns(context), fenceRevision);
          await callVerifyFence(context, fenceRevision);
          db.exec('COMMIT;');
        } catch (error) {
          try { db.exec('ROLLBACK;'); } catch { /* Preserve the original authorization or storage error. */ }
          if (error instanceof ToolJobsError) throw error;
          fail('storage-error');
        }
      });
    },

    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = tail.catch(() => {}).then(() => {
        if (!closed) {
          db.close();
          closed = true;
        }
      });
      return closePromise;
    },
  };

  return Object.freeze(publicApi);
}
