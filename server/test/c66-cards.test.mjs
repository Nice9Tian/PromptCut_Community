/**
 * C6.6 card source synchronization (`docs/plan/c66-design.md` section 5; single-process portion
 * of acceptance check T8).
 * Run: node --test server/test/c66-cards.test.mjs
 *
 * Written strictly according to the design draft without inspecting the implementation. Sync
 * module name and dependency injection shape follow Assumption K5 (see header of `c66-kit.mjs`).
 * Content store uses a mock (`fakeContentService`, behaving per
 * `server/docservice/modules/content.mjs`: card-source assigns rev by key, increments on each put,
 * last write wins); A and B each hold a view written under their own identity, sharing the same
 * storage. Local files, card installation (`/api/cards/install`), backups, and overwrite notices
 * are all recorded by `fakeCardHost`. "Retest after install, reschedule prerender" follows
 * existing rules, not in this file.
 *
 * Basis for conflict determination: section 5 of the design draft, "modified locally and on
 * service → last write wins; back up locally before installing, display notice", and semantics
 * `document-service.md` "Conflict": "the overwritten party saves a local backup before switching
 * to the latest version".
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, fakeContentService, fakeCardHost, loadCardSync, waitFor, sleep } from './c66-kit.mjs';

const DIR = tempDir('pc-c66-cards-');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let seq = 0;
const stateFile = () => path.join(DIR, `card-sync-${++seq}.json`);

const KIND = 'card-source';
const USER = 'src/cards/user/lower-third.tsx';
const USER2 = 'src/cards/user/title-bar.tsx';
const BUILTIN = 'src/cards/builtin/punch-pill.tsx';
const src = (tag) => `export default function Card() { return <div>${tag}</div>; }\n`;

const ofType = (host, type) => host.events.filter((e) => e.type === type);

// ------------------------------------------------------------------ Write

test('C66-T8-01 saving a user card → content.put(card-source, repo-relative path, source), cardRev increments by one on each save', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const host = fakeCardHost({ stateFile: stateFile() });
  const sync = create({ content: svc.as('B'), host });
  await sync.open();
  await sync.save(USER, src('v1'));
  await sync.save(USER, src('v2'));
  const puts = svc.puts.filter((p) => p.key === USER);
  assert.deepEqual(puts.map((p) => [p.kind, p.body, p.rev]), [[KIND, src('v1'), 1], [KIND, src('v2'), 2]]);
  await sync.close();
});

test('C66-T8-02 scope: user cards and modified built-in cards sync; unmodified built-in cards do not', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const MOD = 'src/cards/builtin/glass-card.tsx';
  const host = fakeCardHost({ stateFile: stateFile(), scopes: { [BUILTIN]: 'builtin', [MOD]: 'builtin-modified', [USER]: 'user' } });
  const sync = create({ content: svc.as('B'), host });
  await sync.open();
  await sync.save(USER, src('u'));
  await sync.save(MOD, src('m'));
  await sync.save(BUILTIN, src('b'));
  const keys = svc.puts.map((p) => p.key);
  assert.ok(keys.includes(USER), 'user cards must sync');
  assert.ok(keys.includes(MOD), 'modified built-in cards (present in the overlay layer) must sync');
  assert.ok(!keys.includes(BUILTIN), 'unmodified built-in cards do not sync');
  await sync.close();
});

// ------------------------------------------------------------------ Read: open project

test('C66-T8-03 open project: cards missing on this machine → pulled down and installed (with cardRev), no backup, no notice', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  await svc.as('A').put(KIND, USER, src('A1'));
  await svc.as('A').put(KIND, USER2, src('A-title'));
  const host = fakeCardHost({ stateFile: stateFile() });
  const sync = create({ content: svc.as('B'), host });
  await sync.open();
  await waitFor(() => ofType(host, 'install').length >= 2, { what: 'both cards to be installed' });
  const inst = Object.fromEntries(ofType(host, 'install').map((e) => [e.key, e]));
  assert.equal(inst[USER].body, src('A1'));
  assert.equal(inst[USER].rev, 1);
  assert.equal(inst[USER2].body, src('A-title'));
  assert.deepEqual(ofType(host, 'backup'), [], 'cards missing on this machine need no backup');
  assert.deepEqual(ofType(host, 'notify'), [], 'no overwrite notice either');
  await sync.close();
});

test('C66-T8-04 not modified on this machine and cardRev on the service is newer → install the new version, no backup; "last synced cardRev and hash" survive a restart', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const sf = stateFile();
  const host = fakeCardHost({ stateFile: sf });
  // B saved once (rev 1), closed
  const b1 = create({ content: svc.as('B'), host });
  await b1.open();
  await b1.save(USER, src('B1'));
  await b1.close();
  // In the meantime, A modified based on B's version (rev 2); B's local file remained untouched
  await svc.as('A').put(KIND, USER, src('A2'));
  // B reopens (new instance, same state file)
  const b2 = create({ content: svc.as('B'), host });
  await b2.open();
  await waitFor(() => ofType(host, 'install').length >= 1, { what: 'A\'s new version to be installed' });
  const inst = ofType(host, 'install');
  assert.equal(inst.length, 1);
  assert.equal(inst[0].body, src('A2'));
  assert.equal(inst[0].rev, 2);
  assert.equal(host.local.get(USER), src('A2'));
  // The local copy has not been modified: not a conflict
  assert.deepEqual(ofType(host, 'backup').filter((e) => e.key === USER && e.body !== src('B1')), [], 'no extra backups');
  // Open again: already up to date, do not reinstall
  await b2.close();
  const b3 = create({ content: svc.as('B'), host });
  await b3.open();
  await sleep(100);
  assert.equal(ofType(host, 'install').length, 1, 'a card already synced to the latest is not reinstalled');
  await b3.close();
});

// (user decision, 2026-10-22) (`workflow/editing.md` "Undo, redo", `product/document-service.md` "Conflict"):
// when offline changes conflict with the cloud, enter "conflict merge", one entry per card.
// Changed from original "last write wins + overwrite notice" to: first back up the local copy,
// install the one on the service, and send conflict (with both sets of source code) to the
// conflict merge window (conflict-merge report)
test('C66-T8-05 modified on this machine (not synced out) and also modified on the service → back up the local copy first, then install the service\'s copy, and hand over to conflict merge (with both copies of the source)', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const sf = stateFile();
  const host = fakeCardHost({ stateFile: sf });
  const b1 = create({ content: svc.as('B'), host });
  await b1.open();
  await b1.save(USER, src('base'));
  await b1.close();
  // B modified the local file offline (without sync), while A simultaneously modified the one on
  // the service (rev 2)
  host.local.set(USER, src('B-local'));
  await svc.as('A').put(KIND, USER, src('A-remote'));
  const b2 = create({ content: svc.as('B'), host });
  await b2.open();
  await waitFor(() => ofType(host, 'install').length >= 1, { what: 'the service\'s version to be installed' });
  const seqOf = (type) => host.events.findIndex((e) => e.type === type && e.key === USER);
  const bi = seqOf('backup'), ii = seqOf('install');
  assert.ok(bi >= 0, 'the local copy must be backed up');
  assert.equal(host.events[bi].body, src('B-local'), 'what is backed up is the locally modified copy');
  assert.ok(bi < ii, 'back up first, then install');
  assert.equal(host.events[ii].body, src('A-remote'), 'this machine is first switched to the service\'s copy (mine is in the conflict merge)');
  const c = ofType(host, 'notify').find((e) => e.key === USER);
  assert.ok(c, 'a notice is shown');
  assert.equal(c.notifyType, 'card-conflict', 'it is a conflict (goes to conflict merge), not "overwritten"');
  assert.equal(c.mine, src('B-local'));
  assert.equal(c.cloud, src('A-remote'));
  await b2.close();
});

test('C66-T8-06 subscription: A modifies a card, and B installs it on the spot per the rules within 5 s (not modified locally → install directly)', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const host = fakeCardHost({ stateFile: stateFile() });
  const b = create({ content: svc.as('B'), host });
  await b.open();
  await b.save(USER, src('B1'));
  const t0 = Date.now();
  await svc.as('A').put(KIND, USER, src('A2'));
  await waitFor(() => ofType(host, 'install').some((e) => e.body === src('A2')), { timeoutMs: 5000, what: 'B to install A\'s new version' });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(host.local.get(USER), src('A2'));
  await b.close();
});

test('C66-T8-07 both sides modify the same card at the same time: the later write wins, and the side that wrote first gets a backup and a notice before being overwritten (semantics "conflict")', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const hostA = fakeCardHost({ stateFile: stateFile() });
  const hostB = fakeCardHost({ stateFile: stateFile() });
  const a = create({ content: svc.as('A'), host: hostA });
  const b = create({ content: svc.as('B'), host: hostB });
  await a.open();
  await b.open();
  // B wrote first, A wrote later (A did not first install B's version: each side modified independently)
  await b.save(USER, src('B-first'));
  await a.save(USER, src('A-last'));
  await waitFor(() => ofType(hostB, 'install').some((e) => e.body === src('A-last')), { timeoutMs: 5000, what: 'B to install the version A wrote last' });
  const bi = hostB.events.findIndex((e) => e.type === 'backup' && e.body === src('B-first'));
  const ii = hostB.events.findIndex((e) => e.type === 'install' && e.body === src('A-last'));
  assert.ok(bi >= 0, 'the side that wrote first (B) must save its own copy as a backup');
  assert.ok(bi < ii, 'B backs up first, then switches to A\'s version');
  assert.ok(ofType(hostB, 'notify').some((e) => e.key === USER), 'B receives the overwrite notice');
  assert.equal(hostB.local.get(USER), src('A-last'), 'the later write wins');
  // The version on the service is finally A's
  assert.equal((await svc.as('X').get(KIND, USER)).body, src('A-last'));
  // A is the later writer: notification of B's version may reach A first (A had not saved yet at that
  // time, so installing it is also valid), but ultimately A's local copy must be its own later-written
  // version
  await sleep(150);
  assert.equal(hostA.local.get(USER), src('A-last'), 'A is not rolled back by B\'s earlier-written version');
  await a.close();
  await b.close();
});

test('C66-T8-08 modified on this machine, no update on the service → no install, no backup (the local copy stays)', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const sf = stateFile();
  const host = fakeCardHost({ stateFile: sf });
  const b1 = create({ content: svc.as('B'), host });
  await b1.open();
  await b1.save(USER, src('B1'));
  await b1.close();
  host.local.set(USER, src('B-local-edit'));
  const b2 = create({ content: svc.as('B'), host });
  await b2.open();
  await sleep(150);
  assert.deepEqual(ofType(host, 'install'), [], 'no new version on the service, so no install');
  assert.deepEqual(ofType(host, 'backup'), [], 'no backup either');
  assert.equal(host.local.get(USER), src('B-local-edit'));
  await b2.close();
});
