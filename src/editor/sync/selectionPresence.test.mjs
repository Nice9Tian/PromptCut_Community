import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setSelectionLink, selectionPresenceStatus } from './selectionPresence.ts';
import { createServer } from 'vite';

test('018 account selection publisher: empty first, multi-select revisions, detach and legacy isolation', async () => {
  const sent = [];
  const link = { request: async message => { sent.push(message); return { type: 'selection.ok',
    projectId: message.projectId, pageId: message.pageId, selectionRevision: message.revision }; } };
  let selection = [];
  const listeners = new Set();
  const source = { readSelection: () => selection, subscribe: listener => {
    listeners.add(listener); return () => listeners.delete(listener);
  } };
  const select = ids => { selection = ids; for (const listener of listeners) listener(); };
  try {
    setSelectionLink(link, 'p1', source);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].selection.clipIds, []);
    assert.equal(sent[0].revision, 1);
    assert.equal(sent[0].projectId, 'p1');
    const pageId = sent[0].pageId;
    assert.equal(typeof pageId, 'string');
    select(['c1', 'c2']);
    assert.deepEqual(sent.at(-1).selection.clipIds, ['c1', 'c2']);
    assert.equal(sent.at(-1).revision, 2);
    select(['c1', 'c2']);
    assert.equal(sent.length, 2, 'same selection does not republish');
    select([]);
    assert.deepEqual(sent.at(-1).selection.clipIds, []);
    assert.equal(sent.at(-1).revision, 3);
    setSelectionLink(null, null);
    assert.deepEqual({ type: sent.at(-1).type, revision: sent.at(-1).revision },
      { type: 'selection.clear', revision: 4 });
    assert.equal(selectionPresenceStatus().linked, false);
    setSelectionLink(link, 'p2', source);
    assert.notEqual(sent.at(-1).pageId, pageId, 'new page binding gets a distinct page ID');
    assert.equal(sent.at(-1).projectId, 'p2');
  } finally { setSelectionLink(null, null); }
});

test('018 publisher retries transient failure and isolates late requests across bindings', async () => {
  const waitFor = async (predicate, loops = 200) => {
    for (let i = 0; i < loops; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('retry did not arrive');
  };
  let selection = [];
  const listeners = new Set();
  const source = { readSelection: () => selection, subscribe: listener => {
    listeners.add(listener); return () => listeners.delete(listener);
  } };
  const sent = [];
  let rejectFirst = true;
  const pending = [];
  const link = { request: message => {
    sent.push(message);
    if (message.type === 'selection.clear') return Promise.resolve({ type: 'selection.ok' });
    if (rejectFirst) { rejectFirst = false; return Promise.reject(new Error('timeout')); }
    return new Promise(resolve => pending.push({ message, resolve }));
  } };
  try {
    setSelectionLink(link, 'p1', source);
    await waitFor(() => pending.length === 1);
    assert.equal(sent[0].revision, sent[1].revision, 'retry keeps the same revision');
    const firstPage = sent[0].pageId;
    selection = ['c1']; for (const listener of listeners) listener();
    assert.equal(pending.length, 2, 'newer selection is sent without waiting for old response');
    pending[0].resolve({ type: 'selection.ok', projectId: 'p1', pageId: firstPage,
      selectionRevision: pending[0].message.revision });
    await waitFor(() => pending.length === 3, 700);
    assert.equal(pending[2].message.revision, pending[1].message.revision,
      'late old ACK does not cancel current hard timeout and retry');
    setSelectionLink(link, 'p1', source);
    assert.equal(sent.at(-1).pageId, firstPage, 'same link/project keeps page identity');
    assert.ok(sent.at(-1).revision > pending[2].message.revision, 'rebinding advances past prior clear');
    const newest = pending.at(-1);
    pending[1].resolve({ type: 'selection.ok', projectId: 'p1', pageId: firstPage,
      selectionRevision: pending[1].message.revision });
    pending[2].resolve({ type: 'selection.ok', projectId: 'p1', pageId: firstPage,
      selectionRevision: pending[2].message.revision });
    newest.resolve({ type: 'selection.ok', projectId: 'p1', pageId: firstPage,
      selectionRevision: newest.message.revision });
  } finally { setSelectionLink(null, null); }
});

test('018 browser module binding reads the real editor store through Vite', async () => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const publisher = await vite.ssrLoadModule('/src/editor/sync/selectionPresence.ts');
    const { actions } = await vite.ssrLoadModule('/src/store/project.ts');
    const sent = [];
    const link = { request: async message => { sent.push(message); return { type: 'selection.ok',
      projectId: message.projectId, pageId: message.pageId, selectionRevision: message.revision }; } };
    publisher.setSelectionLink(link, 'p1');
    for (let i = 0; i < 20 && !sent.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(sent[0]?.selection.clipIds, []);
    actions.select(['c1', 'c2']);
    assert.deepEqual(sent.at(-1).selection.clipIds, ['c1', 'c2']);
    publisher.setSelectionLink(null, null);
    actions.select([]);
  } finally { await vite.close(); }
});
