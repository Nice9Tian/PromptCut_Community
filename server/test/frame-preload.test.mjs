import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FramePipeline, PRELOAD_STALE_MS } from '../frame-pipeline.mjs';

const makeService = root => new FramePipeline({ root, origin: () => '' });
const settle = async (until, rounds = 100) => { for (let i = 0; i < rounds && !until(); i++) await new Promise(resolve => setImmediate(resolve)); };

test('only generations whose owner stopped asking are aborted', () => {
  const service = makeService('.');
  const generation = seenAt => ({ key: 'k', controller: new AbortController(), seenAt });
  const gone = generation(0), open = generation(PRELOAD_STALE_MS), mine = generation(0);
  service.generations.set('gone', gone);
  service.generations.set('open', open);
  service.generations.set('mine', mine);
  service.retireStalePreloads('mine', PRELOAD_STALE_MS + 1);
  assert.equal(gone.controller.signal.aborted, true);
  assert.equal(service.generations.has('gone'), false);
  assert.equal(open.controller.signal.aborted, false, 'asked within the window');
  assert.equal(mine.controller.signal.aborted, false, 'the caller is never retired by itself');
});

test('a reloaded project does not wait for the background pass of the page that went away', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const service = makeService('.');
  const entries = new Map();
  service.entry = async project => {
    if (!entries.has(project.id)) entries.set(project.id, { key: project.id, project, html: new Map([[0, '<html>']]) });
    return entries.get(project.id);
  };
  const bakery = { reset: async () => {}, page: { setViewport: async () => {} } };
  service.acquire = async () => bakery;
  service.browserCardPlan = async () => null;
  service.fillMov = async () => {};
  const started = [];
  service.prerender = (entry, _bakery, signal) => new Promise((_resolve, reject) => {
    started.push(entry.key);
    signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
  });
  const project = id => ({ id, duration: 1 / 30, fps: 30, width: 16, height: 8 });

  await service.preload(project('before-reload'));
  await settle(() => started.length === 1);
  assert.deepEqual(started, ['before-reload']);

  // The reloaded page has a new project id and keeps asking every 2 s.
  t.mock.timers.tick(2000);
  assert.equal((await service.preload(project('after-reload'))).status, 'queued');
  for (let at = 4000; at <= PRELOAD_STALE_MS + 2000; at += 2000) {
    t.mock.timers.tick(2000);
    await service.preload(project('after-reload'));
  }
  await settle(() => started.length === 2);
  assert.deepEqual(started, ['before-reload', 'after-reload']);
  assert.equal(entries.get('before-reload').status, 'cancelled');
  assert.equal(service.generations.has('before-reload'), false);
});

test('a frame still waiting for a prerendered card reuses its placeholder until the missing cards change', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-placeholder-'));
  try {
    const service = makeService(dir);
    service.acquireUser = async () => { throw new Error('rendered again'); };
    service.acquire = async () => { throw new Error('rendered again'); };
    await fs.mkdir(path.join(dir, 'preview-frames'), { recursive: true });
    await fs.writeFile(path.join(dir, 'preview-frames', '000004.png'), Buffer.from('placeholder'));
    let missing = ['ticker'];
    const entry = {
      dir, project: { fps: 30, media: [] }, html: new Map(),
      mov: { ready: Promise.resolve(), lookup: async () => undefined },
      cardPlan: [{ key: 'k', clipId: 'ticker', sampling: { firstFrame: 0 }, end: 10 }],
      cardCache: { renderState: async () => ({ frames: {}, missing: { 4: missing } }) },
      placeholders: new Map([[4, 'ticker']]),
    };
    const frames = await service.readFramesCore(entry, [4], 'user');
    assert.equal(frames.get(4).source, 'preview');
    assert.equal(frames.get(4).incomplete, true);
    assert.deepEqual(frames.get(4).missing, ['ticker']);
    assert.equal(frames.get(4).buf.toString(), 'placeholder');
    // The agent lane never receives placeholders.
    await assert.rejects(service.readFramesCore(entry, [4], 'agent'), /rendered again/);
    // Another card is now missing too: that placeholder is out of date.
    missing = ['ticker', 'title'];
    await assert.rejects(service.readFramesCore(entry, [4], 'user'), /rendered again/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
