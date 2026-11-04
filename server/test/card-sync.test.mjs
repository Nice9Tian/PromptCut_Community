/**
 * Card source sync (C6.6 design doc `docs/plan/c66-design.md` Section 5, acceptance check T8;
 * `cloud-task.md` A6, B2).
 *
 * Two "editor processes" each have their own project root (temporary directory), each running a
 * sync instance of `server/card-sync.mjs`. File operations use the real card installation path
 * (installSyncedFile: review, write file) and backup (backupBeforeEdit) from
 * `server/vite-plugin-cards.ts`, connecting to the same document service content store
 * (`contentModule`) via real WebSocket. The trigger point for "retest, rearrange prerender" is the
 * card source change notification emitted after installing the card in the editor
 * (emitCardSourceChange in `card-overrides.mjs`; render worker drops standby page accordingly, and
 * page rearranges probes according to HMR hints). The card installation adapter here emits it as
 * usual, and the test case watches for this notification.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.PROMPTCUT_CARD_OVERRIDES;
delete process.env.PROMPTCUT_DATA_DIR;

const { createDocService } = await import('../docservice/service.mjs');
const { contentModule } = await import('../docservice/modules/content.mjs');
const { createMemoryStore } = await import('../docservice/store/index.mjs');
const { createWsEndpoint } = await import('../render-node/ws-transport.mjs');
const { createCardSync, sourceHash, isSyncablePath } = await import('../card-sync.mjs');
const { emitCardSourceChange, onCardSourceChange } = await import('../card-overrides.mjs');
const cards = await import('../vite-plugin-cards.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what} (${ms} ms)`);
    await sleep(20);
  }
}

const cardSource = (text) => `import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "Price", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
`;
const USER_KEY = 'src/cards/user/price-tag.tsx';
const BUILTIN_KEY = 'src/cards/native/odo.tsx';
const BUILTIN = `import type { CardDef } from "../../kernel/types";
export const odo: CardDef<{ n: number }> = {
  id: "odo", name: "odo", description: "d", source: "native",
  frameMode: "direct",
  defaults: { n: 1 },
  controls: [],
  Component: () => null,
};
`;

/** Document service (a content store module); identity given via query string: ?user=&dev= → page role */
async function startDoc(t) {
  const service = createDocService({
    log: () => {},
    authenticate: (req) => {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      return { userId: q.get('user') ?? 'u', deviceId: q.get('dev') ?? 'd', role: 'page', tenantId: 't-c66' };
    },
    modules: [contentModule({ store: createMemoryStore() })],
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { port, url: (user) => `ws://127.0.0.1:${port}/?user=${user}&dev=dev-${user}` };
}

/** An "editor process": its own project root, sync instance, received notifications and change notifications */
function editor(t, name, { builtin = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pc-c66-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'cards', 'user'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'cards', 'native'), { recursive: true });
  if (builtin) fs.writeFileSync(path.join(root, BUILTIN_KEY), BUILTIN);
  const notices = [];
  const changes = [];
  const off = onCardSourceChange((file) => {
    if (path.resolve(file).startsWith(path.resolve(root) + path.sep)) changes.push({ at: Date.now(), rel: path.relative(root, file).split(path.sep).join('/') });
  });
  t.after(off);
  const edited = new Set();
  const sync = createCardSync({
    stateDir: path.join(root, '.pc-work', 'card-sync'),
    files: {
      read: (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
      changed: (rel) => rel.startsWith('src/cards/user/') ? fs.existsSync(path.join(root, rel)) : edited.has(rel),
      backup: (rel, content) => cards.backupBeforeEdit(root, rel, content),
      install: (rel, source) => {
        const r = cards.installSyncedFile({ root, historyDir: path.join(root, '.pc-work', 'card-history'), rel, source, existingIds: ['odo'] });
        // After installation in editor, emit change notification following edit_card (hot reload,
        // render worker drops standby page, page rearranges probes)
        if (r.ok && r.abs && r.status !== 'unchanged') emitCardSourceChange(r.abs);
        return { ok: r.ok, error: r.error };
      },
    },
    connect: ({ url, protocols }) => createWsEndpoint({ url, protocols, backoff: { baseMs: 50, maxMs: 200 } }),
    notify: (e) => notices.push(e),
    retryMs: 200,
  });
  t.after(() => sync.close());
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  return {
    name, root, sync, notices, changes, edited, write,
    read: (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
    /** Save once locally (plugin calls saved after edit_card / create_card persists to disk) */
    save(rel, content) {
      write(rel, content);
      if (!rel.startsWith('src/cards/user/')) edited.add(rel);
      return sync.saved(rel);
    },
    bindShared(doc, projectId, keys = []) {
      return sync.bind({ projectId, url: doc.url(name), local: false, keys, protocols: () => ['promptcut.v1'] });
    },
  };
}

/** Open another connection to inspect the content store directly */
async function peek(doc, kind, key) {
  const ws = new WebSocket(doc.url('peek'), ['promptcut.v1']);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const reply = await new Promise((resolve) => {
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.reqId === 'p1') resolve(m); });
    ws.send(JSON.stringify(key ? { type: 'content.get', kind, key, reqId: 'p1' } : { type: 'content.list', kind, reqId: 'p1' }));
  });
  ws.close();
  return reply;
}

test('T8-0 scope: only source and styles under the card / part directories are recognized; test files and path traversal are not', () => {
  assert.equal(isSyncablePath(USER_KEY), true);
  assert.equal(isSyncablePath('src/parts/a/b.css'), true);
  assert.equal(isSyncablePath('src/cards/user/_scopes.json'), false);
  assert.equal(isSyncablePath('src/cards/user/x.test.ts'), false);
  assert.equal(isSyncablePath('src/kernel/project.ts'), false);
  assert.equal(isSyncablePath('src/cards/../kernel/x.ts'), false);
  assert.equal(isSyncablePath('src\\cards\\user\\x.tsx'), false);
  // Content hash uses the same algorithm as content store, and does not vary with newline style
  assert.equal(sourceHash('a\r\nb'), sourceHash('a\nb'));
});

test('T8-1 A edits a user card, B installs the new version within 5 s and re-tests it (a change notification is emitted); on first open B installs the cards brought by A', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('¥1'));
  A.bindShared(doc, 'p1', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A connected');
  await A.sync.idle();
  const first = await peek(doc, 'card-source', USER_KEY);
  assert.equal(first.rev, 1, 'when A opens a shared project, it uploads the user cards used by the project');

  // B opens the same shared project: this machine does not have this card → install it
  B.bindShared(doc, 'p1');
  await waitFor(() => B.read(USER_KEY) !== null, 5000, 'B installs the card of A');
  assert.match(B.read(USER_KEY), /¥1/);
  await B.sync.idle();
  assert.equal(B.sync.status().records[USER_KEY].rev, 1);

  // A edits card (saved after edit_card persists) → B installs new version within 5 s and emits
  // change notification (trigger point for retest, rearrange prerender)
  const changesBefore = B.changes.length;
  const t0 = Date.now();
  A.save(USER_KEY, cardSource('¥2'));
  await waitFor(() => /¥2/.test(B.read(USER_KEY) ?? ''), 5000, 'B installs the new version');
  const installedMs = Date.now() - t0;
  const change = await waitFor(() => B.changes.slice(changesBefore).find((c) => c.rel === USER_KEY), 5000, 'change notification of B');
  assert.ok(installedMs <= 5000, `B took ${installedMs} ms to install the new version`);
  assert.ok(change.at - t0 <= 5000);
  await B.sync.idle();
  assert.equal(B.sync.status().records[USER_KEY].rev, 2);
  const inst = B.notices.find((n) => n.type === 'installed' && n.rev === 2);
  assert.ok(inst, 'B has an "installed" notification');
  assert.equal(inst.backup, undefined, 'B had no local edits: replace directly, no backup');
  assert.equal(inst.actor.userId, 'a', 'the notification carries the writer');
  assert.equal(B.notices.some((n) => n.type === 'overwritten'), false);
  // A's own copy is not disturbed by its own echo
  assert.equal(A.notices.filter((n) => n.type === 'installed').length, 0);
  console.log(JSON.stringify({ case: 'T8-1', installedMs, changeMs: change.at - t0 }));
});

test('T8-2 both ends edit the same card at the same time: the last write wins, the earlier writer gets a backup and a notice, and the later writer knows who it overwrote', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('v1'));
  A.bindShared(doc, 'p2', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A connected');
  await A.sync.idle();
  B.bindShared(doc, 'p2');
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? ''), 5000, 'B syncs to v1');
  await B.sync.idle();

  // Concurrent edits: both sides persist to disk and upload almost simultaneously
  A.save(USER_KEY, cardSource('from-A'));
  B.save(USER_KEY, cardSource('from-B'));
  await waitFor(async () => {
    const it = await peek(doc, 'card-source', USER_KEY);
    return it.rev === 3;
  }, 5000, 'both uploads landed');
  const final = await peek(doc, 'card-source', USER_KEY);
  const winner = /from-A/.test(final.body) ? A : B;
  const loser = winner === A ? B : A;
  const winText = winner === A ? 'from-A' : 'from-B';
  const loseText = winner === A ? 'from-B' : 'from-A';

  // Both ends ultimately have the version written later
  await waitFor(() => new RegExp(winText).test(loser.read(USER_KEY) ?? ''), 5000, 'the earlier writer switches to the version of the later writer');
  await A.sync.idle();
  await B.sync.idle();
  assert.match(winner.read(USER_KEY), new RegExp(winText));
  assert.match(loser.read(USER_KEY), new RegExp(winText));

  // Earlier writer: overwrite prompt + backup contains its own copy
  const ow = loser.notices.find((n) => n.type === 'overwritten');
  assert.ok(ow, `First writer (${loser.name}) has an overwrite notice; notices: ${JSON.stringify(loser.notices)}`);
  assert.equal(ow.actor.userId, winner.name, 'The notice names the overwriter');
  assert.ok(ow.backup && fs.existsSync(path.join(loser.root, ow.backup)), 'Backup file exists');
  assert.match(fs.readFileSync(path.join(loser.root, ow.backup), 'utf8'), new RegExp(loseText), 'The backup holds the first writer\'s own copy');
  // Later writer: not overwritten, knows whom it overwrote
  assert.equal(winner.notices.some((n) => n.type === 'overwritten'), false);
  const wrote = await waitFor(() => winner.notices.find((n) => n.type === 'overwrote' && n.rev === 3), 3000, 'Overwriter\'s receipt');
  assert.equal(wrote.previousActor.userId, loser.name);
  console.log(JSON.stringify({ case: 'T8-2', winner: winner.name, backup: ow.backup }));
});

test('T8-3 unmodified built-in cards are not synced; modified built-in cards and user cards are synced', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('¥1'));
  // Project uses one built-in card (unmodified) and one user card: only the user card is included
  const changed = (rel) => rel.startsWith('src/cards/user/') ? fs.existsSync(path.join(A.root, rel)) : A.edited.has(rel);
  const keys = cards.cardSyncKeys(A.root, ['odo', 'price-tag', 'no-such-card'], changed);
  assert.deepEqual(keys, [USER_KEY]);
  A.bindShared(doc, 'p3', keys);
  B.bindShared(doc, 'p3', cards.cardSyncKeys(B.root, ['odo'], (rel) => rel.startsWith('src/cards/user/')));
  await waitFor(() => A.sync.status().connected && B.sync.status().connected, 3000, 'Connected');
  await A.sync.idle();
  await B.sync.idle();
  let listing = await peek(doc, 'card-source');
  assert.deepEqual(listing.items.map((i) => i.key), [USER_KEY], 'Only the user card is in the content store; neither side uploaded the unmodified built-in card');

  // A modified built-in card (edit_card modifies built-in file) → sync; B's local copy is
  // unmodified base version, replaced directly without backup or prompt
  const edited = BUILTIN.replace('n: 1', 'n: 2');
  A.save(BUILTIN_KEY, edited);
  await waitFor(() => /n: 2/.test(B.read(BUILTIN_KEY) ?? ''), 5000, 'B installs the modified built-in card');
  await B.sync.idle();
  listing = await peek(doc, 'card-source');
  assert.deepEqual(listing.items.map((i) => i.key).sort(), [BUILTIN_KEY, USER_KEY].sort());
  assert.equal(B.notices.some((n) => n.type === 'overwritten'), false);
  assert.equal(fs.existsSync(path.join(B.root, 'out', 'card-edits')), false, 'The unmodified base version does not count as a local change, no backup');
  // After modification it counts as a "modified built-in card": recomputing files to include shows
  // it is included
  assert.deepEqual(cards.cardSyncKeys(A.root, ['odo', 'price-tag'], changed), [BUILTIN_KEY, USER_KEY].sort());
});

test('T8-4 local project (local space): upload only, cardRev still increments as usual; the sync half is a no-op', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  A.write(USER_KEY, cardSource('¥1'));
  A.sync.bind({ local: true, url: doc.url('a'), protocols: () => ['promptcut.v1'] });
  await waitFor(() => A.sync.status().connected, 3000, 'Connected');
  A.save(USER_KEY, cardSource('¥2'));
  await A.sync.idle();
  A.save(USER_KEY, cardSource('¥3'));
  await A.sync.idle();
  const it = await peek(doc, 'card-source', USER_KEY);
  assert.equal(it.rev, 2, 'cardRev increments by one on every save');
  assert.match(it.body, /¥3/);
  assert.equal(A.sync.status().records[USER_KEY].rev, 2);
  assert.equal(A.sync.status().spaceId, 'local');

  // Someone else wrote a version to this space: local project does not install (no subscription,
  // no reconciliation)
  const ws = new WebSocket(doc.url('other'), ['promptcut.v1']);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ type: 'content.put', kind: 'card-source', key: USER_KEY, body: cardSource('¥9'), reqId: 'x' }));
  await sleep(300);
  ws.close();
  assert.match(A.read(USER_KEY), /¥3/);
  assert.equal(A.notices.length, 0);
});

test('T8-5 saves made while disconnected stay in the pending uploads and are sent as a catch-up upload after reconnecting; if this machine changed a card after the last sync while the service copy stayed the same, upload it on open', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  // Saved before connecting: marked as pending upload
  A.write(USER_KEY, cardSource('¥1'));
  A.bindShared(doc, 'p5', []);
  A.save(USER_KEY, cardSource('offline'));
  await waitFor(() => A.sync.status().connected, 3000, 'Connected');
  await A.sync.idle();
  let it = await peek(doc, 'card-source', USER_KEY);
  assert.match(it.body, /offline/);
  assert.deepEqual(A.sync.status().pending, []);

  // Modified file directly without going through saved (e.g. when editor was not open): next time this
  // shared project is opened, reconciliation finds local changes while service unchanged → upload
  A.sync.unbind();
  A.write(USER_KEY, cardSource('edited-while-away'));
  A.bindShared(doc, 'p5', []);
  await waitFor(async () => /edited-while-away/.test((await peek(doc, 'card-source', USER_KEY)).body), 5000, 'Catch-up upload');
  it = await peek(doc, 'card-source', USER_KEY);
  assert.equal(it.rev, 2);
});

test('T8-6 a version that cannot be installed (fails review) is not installed, the local copy stays as is, a notice is shown; the same version is not retried repeatedly', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('ok'));
  A.bindShared(doc, 'p6', [USER_KEY]);
  B.bindShared(doc, 'p6');
  await waitFor(() => /ok/.test(B.read(USER_KEY) ?? ''), 5000, 'B installs it');
  await B.sync.idle();
  // A breaks the card (id changed: user card review rejects it)
  A.save(USER_KEY, cardSource('bad').replace('id: "price-tag"', 'id: "other-id"'));
  const rej = await waitFor(() => B.notices.find((n) => n.type === 'rejected'), 5000, 'B\'s rejection notice');
  assert.ok(rej.error);
  assert.match(B.read(USER_KEY), /ok/, 'B\'s local copy unchanged');
  await B.sync.idle();
  assert.equal(B.sync.status().records[USER_KEY].rejected, true);
});

test('T8-7 the version written on this machine is later changed by someone else (not edited at the same time): before installing their new version, first back up the local copy and show a notice; if this machine never wrote it, install directly', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  const C = editor(t, 'c');
  A.write(USER_KEY, cardSource('v1'));
  A.bindShared(doc, 'p7', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A connected');
  await A.sync.idle();
  B.bindShared(doc, 'p7');
  C.bindShared(doc, 'p7');
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? '') && /v1/.test(C.read(USER_KEY) ?? ''), 5000, 'B and C sync to v1');
  await B.sync.idle();
  await C.sync.idle();

  // A writes v2, waits for both B and C to install (clear sequential order, not concurrent edits)
  A.save(USER_KEY, cardSource('v2-from-A'));
  await waitFor(() => /v2-from-A/.test(B.read(USER_KEY) ?? '') && /v2-from-A/.test(C.read(USER_KEY) ?? ''), 5000, 'B and C install v2');
  await B.sync.idle();
  await C.sync.idle();
  assert.equal(A.sync.status().records[USER_KEY].mine, true);

  // B then modifies to v3: the version whose last writer was A is overwritten → A first backs up
  // v2-from-A then installs v3, with a prompt; C never wrote to this card, installs directly
  B.save(USER_KEY, cardSource('v3-from-B'));
  await waitFor(() => /v3-from-B/.test(A.read(USER_KEY) ?? '') && /v3-from-B/.test(C.read(USER_KEY) ?? ''), 5000, 'A and C install v3');
  await A.sync.idle();
  await C.sync.idle();
  const ow = A.notices.find((n) => n.type === 'overwritten');
  assert.ok(ow, `A has an overwrite notice; notices: ${JSON.stringify(A.notices)}`);
  assert.equal(ow.actor.userId, 'b');
  assert.match(fs.readFileSync(path.join(A.root, ow.backup), 'utf8'), /v2-from-A/, 'The backup holds the version A wrote');
  assert.equal(C.notices.some((n) => n.type === 'overwritten'), false, 'C never wrote it: install directly, no notice');
  assert.equal(fs.existsSync(path.join(C.root, 'out', 'card-edits')), false, 'C makes no backup');
  // A now holds B's version (no longer written by itself): when modified by C again, installs
  // directly
  assert.equal(A.sync.status().records[USER_KEY].mine, false);
  const before = A.notices.length;
  C.save(USER_KEY, cardSource('v4-from-C'));
  await waitFor(() => /v4-from-C/.test(A.read(USER_KEY) ?? ''), 5000, 'A installs v4');
  await A.sync.idle();
  assert.equal(A.notices.slice(before).some((n) => n.type === 'overwritten'), false);
  // B's v3 is overwritten by C → B backs up and prompts
  await waitFor(() => B.notices.find((n) => n.type === 'overwritten'), 5000, 'B\'s overwrite notice');
});

test('T8-8 a card edited while offline and also edited by someone else in the cloud: no last-write-wins, emit a conflict (carrying both sources) and hand it to conflict merge; "Merge" writes back my version and uploads it', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('v1'));
  A.bindShared(doc, 'p8', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A connected');
  await A.sync.idle();
  B.bindShared(doc, 'p8');
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? ''), 5000, 'B syncs to v1');
  await B.sync.idle();
  // A modified this card while disconnected; B concurrently modified it online
  A.sync.unbind('offline');
  A.write(USER_KEY, cardSource('A-offline'));
  B.save(USER_KEY, cardSource('B-online'));
  await waitFor(async () => /B-online/.test((await peek(doc, 'card-source', USER_KEY)).body), 5000, 'B\'s version lands');
  // A reconnects
  A.bindShared(doc, 'p8', [USER_KEY]);
  const c = await waitFor(() => A.notices.find((n) => n.type === 'conflict'), 5000, 'A received conflict');
  await A.sync.idle();
  assert.equal(c.key, USER_KEY);
  assert.match(c.mine, /A-offline/, 'Carries my side\'s source');
  assert.match(c.cloud, /B-online/, 'Carries the cloud\'s source');
  assert.ok(c.backup && fs.existsSync(path.join(A.root, c.backup)), 'The local copy also has a backup');
  assert.equal(A.notices.some((n) => n.type === 'overwritten'), false, 'No longer says "overwritten" under last-write-wins');
  assert.match(A.read(USER_KEY), /B-online/, 'This machine first switches to the cloud version (mine is in the conflict merge)');
  assert.match((await peek(doc, 'card-source', USER_KEY)).body, /B-online/, 'Mine was not silently uploaded');
  // "Merge": write back as on my side, upload, B installs
  const r = await A.sync.takeMine(USER_KEY, c.mine);
  assert.equal(r.ok, true, JSON.stringify(r));
  await waitFor(async () => /A-offline/.test((await peek(doc, 'card-source', USER_KEY)).body), 5000, 'My version is uploaded');
  await waitFor(() => /A-offline/.test(B.read(USER_KEY) ?? ''), 5000, 'B installs my version');
  // Source code failing review: neither written nor uploaded
  const bad = await A.sync.takeMine(USER_KEY, 'not a card');
  assert.equal(bad.ok, false);
  // "Delete selected" = do nothing: cloud status quo preserved (already verified above)
});
