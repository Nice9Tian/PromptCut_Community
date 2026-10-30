import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createToolJobs, ToolJobsError } from '../agent/service/tool-jobs.mjs';

const context = (overrides = {}) => ({
  projectId: 'project-alpha',
  conversationId: 'conversation-a',
  runId: 'run-1',
  runGrantId: 'grant-1',
  instanceId: 'instance-1',
  instanceGeneration: 1,
  senderAccountId: 'account-1',
  messageId: 'message-1',
  ...overrides,
});

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-tool-jobs-'));
  const databasePath = path.join(directory, 'jobs.sqlite');
  const opened = [];
  const fence = { revision: 4, grantState: 'active', allowed: true };
  const calls = { authorize: [], verifyFence: [] };
  const authorize = options.authorize ?? (async (ctx, action) => {
    calls.authorize.push({ ctx, action });
    const override = options.readOnly === true && action === 'write'
      ? { allowed: false, fenceRevision: fence.revision, grantState: fence.grantState }
      : null;
    return override ?? { allowed: fence.allowed, fenceRevision: fence.revision, grantState: fence.grantState };
  });
  const verifyFence = options.verifyFence ?? (async (ctx, revision) => {
    calls.verifyFence.push({ ctx, revision });
    return fence.allowed && revision === fence.revision;
  });
  const open = (overrides = {}) => {
    const jobs = createToolJobs({ databasePath, authorize, verifyFence, ...overrides });
    opened.push(jobs);
    return jobs;
  };
  t.after(async () => {
    await Promise.all(opened.map((jobs) => jobs.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, databasePath, fence, calls, open };
}

const digest = (value = 'input') => createHash('sha256').update(value).digest('hex');
const code = (expected) => (error) => error instanceof ToolJobsError && error.code === expected;

test('ToolJobs requires an explicit durable path and both authorization callbacks', () => {
  assert.throws(() => createToolJobs(), code('database-path-required'));
  assert.throws(() => createToolJobs({ databasePath: ':memory:', authorize: () => true, verifyFence: () => true }), code('database-path-required'));
  assert.throws(() => createToolJobs({ databasePath: 'jobs.sqlite', authorize: () => true }), code('authorization-required'));
  assert.throws(() => createToolJobs({ databasePath: 'jobs.sqlite', verifyFence: () => true }), code('authorization-required'));
});

test('POSIX database and parent-directory permissions stay private without changing existing shared directories', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows filesystem mode bits are not POSIX permission evidence');
  const f = fixture(t);
  const sharedDirectory = path.join(f.directory, 'shared');
  fs.mkdirSync(sharedDirectory, { mode: 0o755 });
  fs.chmodSync(sharedDirectory, 0o755);
  assert.throws(() => createToolJobs({
    databasePath: path.join(sharedDirectory, 'jobs.sqlite'),
    authorize: async () => ({ allowed: true, fenceRevision: 1, grantState: 'active' }),
    verifyFence: async () => true,
  }), code('database-directory-not-private'));
  assert.equal(fs.statSync(sharedDirectory).mode & 0o777, 0o755);

  const privatePath = path.join(f.directory, 'new-private-parent', 'jobs.sqlite');
  const jobs = createToolJobs({
    databasePath: privatePath,
    authorize: async () => ({ allowed: true, fenceRevision: 1, grantState: 'active' }),
    verifyFence: async () => true,
  });
  await jobs.close();
  assert.equal(fs.statSync(path.dirname(privatePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(privatePath).mode & 0o777, 0o600);
});

test('start is idempotent only for the exact immutable context, kind, request and digest', async (t) => {
  const f = fixture(t);
  const jobs = f.open();
  t.after(() => jobs.close());
  const ctx = context();
  const first = await jobs.start(ctx, 'image.search', digest('same body'), 'request_12345678');
  assert.equal(first.state, 'queued');
  const duplicate = await jobs.start(ctx, 'image.search', digest('same body'), 'request_12345678');
  assert.deepEqual(duplicate, first);
  await assert.rejects(jobs.start(ctx, 'image.search', digest('different body'), 'request_12345678'), code('idempotency-conflict'));
  assert.notEqual((await jobs.start(context({ runId: 'run-2', runGrantId: 'grant-2' }), 'image.search', digest('same body'), 'request_12345678')).jobId, first.jobId);
  assert.notEqual((await jobs.start(context({ instanceId: 'instance-2' }), 'image.search', digest('same body'), 'request_12345678')).jobId, first.jobId);
  const differentSender = context({ senderAccountId: 'account-2' });
  const senderBound = await jobs.start(differentSender, 'image.search', digest('same body'), 'request_12345678');
  assert.notEqual(senderBound.jobId, first.jobId);
  assert.deepEqual(await jobs.start(differentSender, 'image.search', digest('same body'), 'request_12345678'), senderBound);
  const differentMessage = context({ messageId: 'message-2' });
  const messageBound = await jobs.start(differentMessage, 'image.search', digest('same body'), 'request_12345678');
  assert.notEqual(messageBound.jobId, first.jobId);
  assert.deepEqual(await jobs.start(differentMessage, 'image.search', digest('same body'), 'request_12345678'), messageBound);
  assert.notEqual((await jobs.start(ctx, 'asset.fetch', digest('same body'), 'request_12345678')).jobId, first.jobId);
});

test('job updates require exact scope and revision, validated state transitions, and safe output references', async (t) => {
  const f = fixture(t);
  const jobs = f.open();
  t.after(() => jobs.close());
  const ctx = context();
  const { jobId } = await jobs.start(ctx, 'asset.inspect', digest(), 'request_12345678');
  await jobs.update(ctx, jobId, 0, { state: 'running', stage: 'download', progress: 0.25 });
  await assert.rejects(jobs.update(ctx, jobId, 0, { progress: 0.5 }), code('stale-revision'));
  await assert.rejects(jobs.update(context({ instanceGeneration: 2 }), jobId, 1, { progress: 0.5 }), code('job-scope-mismatch'));
  await assert.rejects(jobs.update(ctx, jobId, 1, { progress: 0.2 }), code('progress-regression'));
  await assert.rejects(jobs.update(ctx, jobId, 1, { state: 'done', progress: 0.5 }), code('done-requires-complete-progress'));
  await assert.rejects(jobs.update(ctx, jobId, 1, { state: 'error' }), code('error-code-required'));
  assert.throws(() => jobs.update(ctx, jobId, 1, { outputRefs: [{ kind: 'file', id: 'C:\\secret\\path' }] }), code('bad-output-refs'));
  await assert.rejects(jobs.update(ctx, jobId, 1, { state: 'queued', stage: 'download', progress: 0.5 }), code('invalid-transition'));
  await jobs.update(ctx, jobId, 1, { progress: 1, state: 'done', outputRefs: [{ kind: 'asset', id: 'asset_abc-123' }] });
  const job = await jobs.get(ctx, jobId);
  assert.equal(job.state, 'done');
  assert.equal(job.revision, 2);
  assert.deepEqual(job.outputRefs, [{ kind: 'asset', id: 'asset_abc-123' }]);
  await assert.rejects(jobs.update(ctx, jobId, 2, { state: 'cancelled' }), code('terminal-job'));
});

test('reads follow current conversation authorization while cross-project and cross-conversation reads fail', async (t) => {
  const f = fixture(t);
  const jobs = f.open();
  t.after(() => jobs.close());
  const originalContext = context();
  const { jobId } = await jobs.start(originalContext, 'document.lookup', digest(), 'request_12345678');
  const laterRunSameConversation = context({ runId: 'run-later', runGrantId: 'grant-later', messageId: 'message-later' });
  assert.equal((await jobs.get(laterRunSameConversation, jobId)).jobId, jobId);
  await assert.rejects(jobs.get(context({ projectId: 'project-other' }), jobId), code('job-not-found'));
  await assert.rejects(jobs.get(context({ conversationId: 'conversation-other' }), jobId), code('job-not-found'));
});

test('read-only authorization blocks writes and write authorization gaps roll back inserts', async (t) => {
  const f = fixture(t, { readOnly: true });
  const jobs = f.open();
  t.after(() => jobs.close());
  await assert.rejects(jobs.start(context(), 'image.search', digest(), 'request_12345678'), code('forbidden'));

  let authorizationCount = 0;
  const raceJobs = f.open({ authorize: async (_ctx, action) => {
    authorizationCount += 1;
    return { allowed: authorizationCount === 1 || action === 'read', fenceRevision: f.fence.revision, grantState: f.fence.grantState };
  } });
  t.after(() => raceJobs.close());
  await assert.rejects(raceJobs.start(context({ runId: 'gap-run', runGrantId: 'gap-grant' }), 'image.search', digest(), 'request_87654321'), code('forbidden'));
  assert.equal(authorizationCount, 2);
});

test('fence changes across an asynchronous authorization gap prevent stale writes', async (t) => {
  const f = fixture(t);
  let verificationCount = 0;
  const jobs = f.open({ verifyFence: async (_ctx, revision) => {
    verificationCount += 1;
    if (verificationCount === 2) f.fence.revision += 1;
    return revision === f.fence.revision;
  } });
  t.after(() => jobs.close());
  const ctx = context();
  await assert.rejects(jobs.start(ctx, 'image.search', digest(), 'request_12345678'), code('fence-rejected'));
  assert.equal(verificationCount, 2);
});

test('cancelForFence needs the trusted exact fence and cancels only matching active records', async (t) => {
  const f = fixture(t);
  const jobs = f.open();
  t.after(() => jobs.close());
  const ctx = context();
  const matching = await jobs.start(ctx, 'image.search', digest(), 'request_12345678');
  const otherFence = await jobs.start(context({ runId: 'run-2', runGrantId: 'grant-2' }), 'image.search', digest(), 'request_23456789');
  await assert.rejects(jobs.cancelForFence(ctx, 999), code('fence-rejected'));
  f.fence.allowed = false;
  await assert.rejects(jobs.cancelForFence(ctx, 4), code('fence-rejected'));
  f.fence.allowed = true;
  await jobs.cancelForFence(ctx, 4);
  assert.equal((await jobs.get(ctx, matching.jobId)).state, 'cancelled');
  assert.equal((await jobs.get(context({ runId: 'run-2', runGrantId: 'grant-2' }), otherFence.jobId)).state, 'queued');
});

// 0.7.18 工具表接线起:排着的作业在重开时也标成被中断(上一个进程里排着的,这个进程里没有任何东西会去做它)。
// 原来这条断言的是「排着的原样留着」。
test('reopening preserves terminal rows and marks queued and running work interrupted', async (t) => {
  const f = fixture(t);
  let jobs = f.open();
  const ctx = context();
  const queued = await jobs.start(ctx, 'image.search', digest('queued'), 'request_12345678');
  const running = await jobs.start(ctx, 'asset.inspect', digest('running'), 'request_23456789');
  await jobs.update(ctx, running.jobId, 0, { state: 'running', stage: 'inspect' });
  const done = await jobs.start(ctx, 'asset.inspect', digest('done'), 'request_34567890');
  await jobs.update(ctx, done.jobId, 0, { state: 'running', stage: 'finish' });
  await jobs.update(ctx, done.jobId, 1, { state: 'done', progress: 1 });
  await jobs.close();

  jobs = f.open({ now: () => 500 });
  t.after(() => jobs.close());
  const queuedRecord = await jobs.get(ctx, queued.jobId);
  assert.equal(queuedRecord.state, 'interrupted');
  assert.equal(queuedRecord.errorCode, 'INTERRUPTED_ON_RESTART');
  assert.equal(queuedRecord.revision, 1);
  const resumedRecord = await jobs.get(ctx, running.jobId);
  assert.equal(resumedRecord.state, 'interrupted');
  assert.equal(resumedRecord.errorCode, 'INTERRUPTED_ON_RESTART');
  assert.equal(resumedRecord.revision, 2);
  assert.equal((await jobs.get(ctx, done.jobId)).state, 'done');
});

test('the durable record stores only digests, scoped identifiers and validated references', async (t) => {
  const f = fixture(t);
  const jobs = f.open();
  const ctx = context();
  const secretBody = 'model prompt with sensitive user text';
  const secretPath = 'C:\\Users\\person\\private-file.png';
  const secret = 'do-not-store-this-credential';
  const started = await jobs.start(ctx, 'asset.inspect', digest(secretBody), 'request_12345678');
  await jobs.update(ctx, started.jobId, 0, { outputRefs: [{ kind: 'asset', id: 'asset_safe-ref' }] });
  await jobs.close();
  const dbBytes = fs.readFileSync(f.databasePath).toString('utf8');
  assert.equal(dbBytes.includes(secretBody), false);
  assert.equal(dbBytes.includes(secretPath), false);
  assert.equal(dbBytes.includes(secret), false);
  assert.equal(dbBytes.includes('request_12345678'), false);
  assert.equal(dbBytes.includes(digest(secretBody)), true);
  assert.equal(dbBytes.includes('asset_safe-ref'), true);

  const raw = new DatabaseSync(f.databasePath, { readOnly: true });
  try {
    const columns = raw.prepare('PRAGMA table_info(tool_jobs)').all().map((row) => row.name);
    assert.deepEqual(columns, [
      'job_id', 'kind', 'project_id', 'conversation_id', 'run_id', 'grant_id', 'instance_id', 'instance_generation',
      'sender_account_id', 'message_id', 'request_key', 'input_digest', 'fence_revision', 'revision',
      'state', 'stage', 'progress', 'output_refs', 'error_code', 'created_at', 'updated_at',
    ]);
  } finally { raw.close(); }
});

test('close drains accepted operations and rejects later writes', async (t) => {
  const f = fixture(t);
  const jobs = f.open();
  const operation = jobs.start(context(), 'image.search', digest(), 'request_12345678');
  const closing = jobs.close();
  const result = await operation;
  await closing;
  assert.equal(result.state, 'queued');
  await assert.rejects(jobs.start(context(), 'image.search', digest(), 'request_23456789'), code('closed'));
});
