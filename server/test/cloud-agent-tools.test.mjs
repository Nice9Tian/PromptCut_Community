/**
 * Tools implemented on server side for Cloud Agent (`server/agent/service/hosted-tools.mjs`) and
 * external service category in usage log.
 * Task brief `docs/plan/cloud-agent-task.md` J; contract `docs/plan/cloud-agent-contract.md`
 * section 9.
 * Run: node scripts/test-suite.mjs server/test/cloud-agent-tools.test.mjs
 *
 *   CA-HT-01  Pure functions: filename cleanup, recognize type by extension, read width and height
 *             of PNG / GIF / JPEG / WebP, duration of WAV
 *   CA-HT-02  Attachments: stored under attachments/ in chat workspace, returning `work:` URLs;
 *             duplicate names automatically renamed; path-bearing names cannot be written out;
 *             empty files and exceeded limits rejected; only files genuinely present in this chat
 *             workspace are spliced into prompts, small texts inlined, no disk paths given
 *   CA-HT-03  Card creation and modification (full chain, simulating model): create_card puts
 *             source code into this project's content store → recognized in same round by
 *             list_cards / add_clip → get_card_source reads back → edit_card local replacement →
 *             duplicate creation rejected; source code failing review is not stored; card
 *             definitions are only temporarily registered on lock acquire and removed on lock
 *             release; card code is not executed in service process (cross-project verified by
 *             isolation probe T5)
 *   CA-HT-03b remotion-style cards (`frameMode: "direct"`): Cloud Agent card creation follows the
 *             same checks as desktop, violations rejected with line numbers indicated, not stored;
 *             compliant cards written with the framework are stored; new violations added during
 *             card modification are likewise rejected
 *   CA-HT-04  Creativity level: "Medium" cannot create new cards, but can rewrite existing cards in
 *             this project (existence determined by project content store)
 *   CA-HT-05  Import media: returns explicit reason upfront when asset service is not configured,
 *             no download (egress gate and asset writes verified by CA-EGRESS, CA-ASSET-01, and
 *             isolation probes T1, T3)
 *   CA-HT-06  Usage: external service calls recorded in a separate category, not consuming token
 *             quota or mixed into model call counts; itemized by service and member in summary
 *   CA-HT-07  Hosted voiceover configuration: read from data directory, token persisted to disk as
 *             ciphertext; returns null if not configured
 *
 * All without egress.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { safeName, kindOfName, extOf, imageSize, wavDuration, saveAttachment, attachmentsPrompt, readHostedVoiceConfig, voiceConfigPaths } from '../agent/service/hosted-tools.mjs';
import { createWorkspaces, WorkspaceError } from '../agent/service/workspace.mjs';
import { createUsageLog, queryUsage } from '../agent/service/usage.mjs';
import { sealKey } from '../runners/config-crypt.mjs';
import { project, script, startKit } from './cloud-agent-kit.mjs';

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-tools-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Left for the system to clean */ } });
  return dir;
};
const OWNER = 'c'.repeat(32);

test('CA-HT-01 pure functions: file name, kind, image width and height, WAV duration', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('C:\\Windows\\win.ini'), 'win.ini');
  assert.equal(safeName('a<b>:c|d?.png'), 'a_b__c_d_.png');
  assert.equal(safeName('...'), 'file');
  assert.equal(safeName('  .hidden.txt. '), 'hidden.txt');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('片头 素材.MP4'), '片头 素材.MP4');
  assert.deepEqual([kindOfName('a.MP4'), kindOfName('b.jpeg'), kindOfName('c.wav'), kindOfName('d.txt'), kindOfName('noext')], ['video', 'image', 'audio', null, null]);
  assert.equal(extOf('x.tar.GZ'), 'gz');
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(640, 16); png.writeUInt32BE(360, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 360 });
  const gif = Buffer.alloc(16); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(120, 6); gif.writeUInt16LE(80, 8);
  assert.deepEqual(imageSize(gif), { width: 120, height: 80 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0x00, 0x00, 0x00]);
  assert.deepEqual(imageSize(jpeg), { width: 400, height: 300 });
  assert.deepEqual(imageSize(Buffer.from('not an image at all')), {});
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0, 'latin1'); wav.write('WAVE', 8, 'latin1'); wav.write('fmt ', 12, 'latin1'); wav.writeUInt32LE(16, 16);
  wav.writeUInt32LE(32000, 28); wav.write('data', 36, 'latin1'); wav.writeUInt32LE(64000, 40);
  assert.equal(wavDuration(wav, 44 + 64000), 2);
  assert.equal(wavDuration(Buffer.from('nope')), undefined);
});

test('CA-HT-02 attachments: go only into the chat workspace and return a work: address; the prompt lists only files that really exist', async (t) => {
  const ws = createWorkspaces({ dataDir: tmpDir(t) });
  const w = ws.open({ projectId: 'p-a', ownerKey: OWNER, conversationId: 'c1' });
  const other = ws.open({ projectId: 'p-a', ownerKey: OWNER, conversationId: 'c2' });
  const a = await saveAttachment(w, '字幕.srt', Readable.from([Buffer.from('1\n00:00:01 --> 00:00:02\n你好\n')]));
  assert.deepEqual({ name: a.name, url: a.url, kind: a.kind }, { name: '字幕.srt', url: 'work:attachments/字幕.srt', kind: 'text' });
  assert.match(a.text, /你好/);
  const b = await saveAttachment(w, '字幕.srt', Readable.from([Buffer.from('second')]));
  assert.equal(b.url, 'work:attachments/字幕-1.srt', 'A duplicate name is renamed automatically, not overwritten');
  const v = await saveAttachment(w, 'clip.mp4', Readable.from([Buffer.alloc(2048, 1)]));
  assert.deepEqual({ kind: v.kind, size: v.size, text: v.text }, { kind: 'video', size: 2048, text: undefined });
  // Names with paths: keep only the last segment, landing under attachments/
  for (const name of ['../../../evil.txt', '..\\..\\evil2.txt', '/etc/evil3.txt', 'C:\\x\\evil4.txt']) {
    const r = await saveAttachment(w, name, Readable.from([Buffer.from('x')]));
    assert.match(r.url, /^work:attachments\/evil\d?\.txt$/);
  }
  assert.equal(fs.readdirSync(path.join(ws.root, 'p-a', OWNER)).sort().join(','), 'c1', 'Nothing extra appears anywhere else');
  await assert.rejects(saveAttachment(w, 'nul', Readable.from([Buffer.from('x')])), (err) => err instanceof WorkspaceError);
  await assert.rejects(saveAttachment(w, 'empty.txt', Readable.from([])), /empty/);
  await assert.rejects(saveAttachment(w, 'big.bin', Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), { maxBytes: 1000 }), /too large/);
  assert.equal(w.exists('attachments/big.bin'), false, 'An over-limit upload leaves no partial file');
  // Prompts: only recognize files genuinely present in this chat workspace; those from other chats,
  // invalid ones, or traversing upward are excluded
  await saveAttachment(other, 'secret.txt', Readable.from([Buffer.from('FAKE-CREDENTIAL-other')]));
  const text = attachmentsPrompt(w, [
    { url: a.url }, { url: v.url }, { url: 'work:attachments/secret.txt' }, { url: 'work:attachments/../../c2/attachments/secret.txt' },
    { url: 'work:../c2/attachments/secret.txt' }, { url: '/etc/passwd' }, { url: 42 }, null,
  ]);
  assert.match(text, /字幕\.srt · URL work:attachments\/字幕\.srt/);
  assert.match(text, /你好/);
  assert.match(text, /\[Video\] clip\.mp4/);
  assert.equal(text.includes('FAKE-CREDENTIAL'), false);
  assert.equal(text.includes('secret.txt'), false);
  assert.equal(text.includes(ws.root), false, 'No disk path is given');
  assert.equal(attachmentsPrompt(w, []), '');
  // Already added to media library when sent from page (user decision, 2026-10-18): specify which
  // one and tell it not to import_media again; state the reason if it could not be added
  const lib = attachmentsPrompt(w, [{ url: v.url, library: { mediaId: 'm-abc', url: '/@media/abc.mp4' } }]);
  assert.match(lib, /clip\.mp4 · URL work:attachments\/clip\.mp4 · Already in the media library: mediaId m-abc · cardUrl \/@media\/abc\.mp4 \(use this one directly, do not import_media again\)/);
  assert.match(lib, /^\n\nAttachment \(the page has put it into the media library/);
  const mixed = attachmentsPrompt(w, [{ url: v.url, library: { mediaId: 'm-abc', url: '/@media/abc.mp4' } }, { url: a.url, libraryError: 'upload timed out' }]);
  assert.match(mixed, /for those marked "Already in the media library", use that entry directly/);
  assert.match(mixed, /字幕\.srt · URL work:attachments\/字幕\.srt · The page could not put it into the media library: upload timed out/);
});

const CARD = (id, marker = '') => [
  'import type { CardDef, CardProps } from "../../kernel/types";',
  marker ? `console.log(${JSON.stringify(marker)}); (globalThis as any).__PC_TEST_CARD_RAN = true;` : '',
  'interface Params { text: string; size: number }',
  'function C({ params }: CardProps<Params>) { return <div style={{ fontSize: params.size }}>{params.text}</div>; }',
  'export const probeCard: CardDef<Params> = {',
  `  id: "${id}", name: "Test card", description: "Card created by a unit test", source: "user",`,
  '  frameMode: "stateless",',
  '  defaults: { text: "你好", size: 48 },',
  '  controls: [{ key: "text", label: "Text", type: "text" }, { key: "size", label: "Font size", type: "number" }],',
  '  Component: C,',
  '};',
  '',
].join('\n');

const A = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice' };
const toolResults = (events) => events.filter((e) => e.type === 'tool_result').map((e) => ({ name: e.name, ok: e.ok === true, summary: String(e.summary ?? '') }));

test('CA-HT-03 / CA-HT-04 / CA-HT-05 preconditions for creating and editing cards, creativity level, and importing media (full chain, simulated model)', { timeout: 240_000 }, async (t) => {
  const kit = await startKit(t);
  await kit.doc.seed(project('p-a', 'A'));
  const svc = kit.service;
  const id = 'unit-probe-card';
  const key = `src/cards/user/${id}.tsx`;
  const marker = 'PC-UNIT-CARD-EXECUTED-7f3a';
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); realLog(...args); };
  t.after(() => { console.log = realLog; });

  await t.test('CA-HT-03 create card → recognized → read back → edit → duplicate create rejected; registration is temporary; the card code was not executed', async () => {
    await svc.send(A, 'c-card', { creativity: 'high', prompt: script([
      { tool: 'create_card', input: { id, source: CARD(id, marker) } },
      { tool: 'list_cards', input: { cardId: id } },
      { tool: 'add_clip', input: { cardId: id, start: 5, duration: 2, params: { text: '单测', size: 30 } } },
      { tool: 'get_card_source', input: { cardId: id } },
      { tool: 'edit_card', input: { cardId: id, find: 'size: 48', replace: 'size: 72' } },
      { tool: 'create_card', input: { id, source: CARD(id) } },
      { tool: 'create_card', input: { id: 'bad-card', source: 'export const x = 1;' } },
      { tool: 'create_card', input: { id: 'timer-card', source: CARD('timer-card').replace('return <div', 'setTimeout(() => {}, 1); return <div') } },
      { tool: 'get_card_source', input: { cardId: 'title' } },
      { tool: 'card_authoring_guide', input: {} },
      { say: 'Done' },
    ]) });
    const r = toolResults(await kit.finished(A, 'c-card', 120_000));
    assert.deepEqual(r.map((x) => `${x.name}:${x.ok}`), [
      'create_card:true', 'list_cards:true', 'add_clip:true', 'get_card_source:true', 'edit_card:true',
      'create_card:false', 'create_card:false', 'create_card:false', 'get_card_source:true', 'card_authoring_guide:true',
    ], JSON.stringify(r.filter((x) => !x.ok).map((x) => x.summary.slice(0, 160))));
    assert.match(r[5].summary, /already exists/);
    assert.match(r[7].summary, /setTimeout/);
    // Source code is in this project's content store (other members and render nodes fetch from here);
    // the modified part has arrived
    const pa = await kit.doc.stateOf('p-a');
    const clip = pa.project.tracks.flatMap((tr) => tr.clips).find((c) => c.cardId === id);
    assert.ok(clip, 'The clip added with the new card has landed');
    assert.deepEqual(clip.params, { text: '单测', size: 30 });
    const inst = svc._instance(A);
    const stored = await inst.callTool('get_card_source', { cardId: id }, 'c-card');
    assert.ok(stored.source.includes('size: 72') && stored.source.includes(marker));
    assert.equal(stored.builtin, false);
    // "Chats from another project do not recognize this card" is not tested here: document service in
    // this test suite is local tier, and two projects share one space and a content store;
    // on the hosted side, each project is its own space, verified by isolation probe T5 and auth probe
    // P3 against the real hosted suite. Here, tests that registration is temporary:
    // after a call without project cards (another instance enters lock), this project still recognizes
    // it, whereas it is normally absent from the card table
    const host = await (await import('../agent/ssr-host.mjs')).loadSsrHost((m) => kit.vite.ssrLoadModule(m));
    assert.equal(host.cardIds().includes(id), false, 'After the lock is released, the card table keeps none of the project\'s cards');
    assert.equal((await inst.callTool('list_cards', { cardId: id }, 'c-card'))[0].id, id);
    assert.equal(host.cardIds().includes(id), false);
    // Card code did not execute in the service process
    assert.equal(logged.some((l) => l.includes(marker)), false);
    assert.equal(globalThis.__PC_TEST_CARD_RAN, undefined);
    assert.equal(fs.existsSync(path.join(kit.vite.config.root, key)), false, 'The checkout directory has no extra file for this card');
  });

  await t.test('CA-HT-03b remotion-style card: violating ones are rejected with the line number and not stored; ones written with the framework are stored; adding a violation when editing a card is rejected', async () => {
    const FIX = path.join(kit.vite.config.root, 'server', 'test', 'fixtures', 'remotion-style');
    const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n');
    const lineOf = (source, needle) => source.slice(0, source.indexOf(needle)).split('\n').length;
    const inst = svc._instance(A);
    await svc.send(A, 'c-rs', { creativity: 'high', prompt: script([{ sleepMs: 60_000 }]) });
    const call = (tool, args) => inst.callTool(tool, args, 'c-rs').catch((err) => ({ ok: false, error: String(err?.message ?? err), errors: err?.errors }));
    // Violation examples for each rule: the cloud path also rejects, error includes line numbers,
    // source code does not enter content store
    const cases = [
      ['random.tsx', 'Math.random()', /unseeded randomness/], ['real-time.tsx', 'performance.now()', /real time/], ['timer.tsx', 'setTimeout(', /timer/],
      ['frame-callback.tsx', 'requestAnimationFrame(', /per-frame callback/], ['motion.tsx', '<motion.div', /Motion/], ['presence.tsx', '<AnimatePresence>', /presence components/],
      ['css-animation.tsx', 'transition: "opacity', /CSS animations and transitions/], ['state.tsx', 'useState(0)', /outlives a single frame/], ['top-level.tsx', 'let frames = 0', /Top level contains let/],
      ['import.tsx', 'from "lottie-web"', /remotion-style cards may only import the framework/],
    ];
    for (const [file, needle, says] of cases) {
      const source = fixture(`violations/${file}`);
      const id = /\bid:\s*"([^"]+)"/.exec(source)[1];
      const r = await call('create_card', { id, source });
      assert.equal(r.ok, false, file);
      const text = String(r.error ?? '');
      assert.match(text, new RegExp(`\\[remotion-style\\] Line ${lineOf(source, needle)}:`), `${file}: ${text.slice(0, 400)}`);
      assert.match(text, says, file);
      assert.doesNotMatch(text, /hand off to motion|use motion\/react|switch to motion|initial \+ animate/, file);
      const stored = await call('get_card_source', { cardId: id });
      assert.equal(stored.ok, false, `${file} rejected source should not be stored`);
    }
    // Example card written with framework: stored, recognized in the same round
    for (const file of ['rs-title-reveal.tsx', 'rs-bar-race.tsx', 'rs-orbit-canvas.tsx']) {
      const source = fixture(file);
      const id = /\bid:\s*"([^"]+)"/.exec(source)[1];
      const r = await call('create_card', { id, source });
      assert.equal(r.ok, true, `${file}: ${String(r.error ?? '').slice(0, 400)}`);
      const stored = await call('get_card_source', { cardId: id });
      assert.equal(stored.source, source, 'The stored source matches the submitted source character for character');
      assert.equal((await call('list_cards', { cardId: id }))[0].id, id);
    }
    // Edit card: adding a new violation to a compliant card is rejected with line number indicated;
    // copy edits work as usual
    const edit = await call('edit_card', { cardId: 'rs-bar-race', find: '  const count = Math.max(', replace: '  const jitter = Math.random();\n  const count = Math.max(' });
    assert.equal(edit.ok, false);
    assert.match(String(edit.error), /\[remotion-style\] Line \d+: Used unseeded randomness \(Math\.random\)/);
    const rename = await call('edit_card', { cardId: 'rs-bar-race', find: 'name: "Random fluctuating bars"', replace: 'name: "Random bars"' });
    assert.equal(rename.ok, true, String(rename.error ?? ''));
    assert.equal(fs.existsSync(path.join(kit.vite.config.root, 'src/cards/user/rs-bar-race.tsx')), false, 'The checkout directory has no extra files');
    svc.abort(A, 'c-rs');
  });

  await t.test('CA-HT-04 creativity "medium": cannot create new cards, can rewrite cards that already exist in this project', async () => {
    const inst = svc._instance(A);
    await svc.send(A, 'c-mid', { creativity: 'medium', prompt: script([{ sleepMs: 30_000 }]) });
    const fresh = await inst.callTool('create_card', { id: 'another-new-card', source: CARD('another-new-card') }, 'c-mid');
    assert.equal(fresh.ok, false);
    assert.ok(fresh.creativity, 'Blocked by the creativity level gate');
    const rewrite = await inst.callTool('create_card', { id, source: CARD(id), overwrite: true }, 'c-mid');
    assert.equal(rewrite.ok, true, JSON.stringify(rewrite).slice(0, 300));
    assert.equal(rewrite.overwritten, true);
    svc.abort(A, 'c-mid');
  });

  await t.test('CA-HT-05 import media: with no asset service configured, return a clear reason up front', async () => {
    const inst = svc._instance(A);
    await svc.send(A, 'c-net', { prompt: script([{ sleepMs: 30_000 }]) });
    // Services in this test suite have no asset service configured: import states this explicitly
    // upfront
    const none = await inst.callTool('import_media', { url: 'https://example.com/a.png' }, 'c-net').catch((err) => ({ ok: false, error: err.message }));
    assert.equal(none.ok, false);
    assert.match(none.error, /has no asset service address configured/);
    svc.abort(A, 'c-net');
  });
});

test('CA-HT-06 usage: external service calls are recorded as their own kind and do not count against the token quota', (t) => {
  const dir = tmpDir(t);
  const usage = createUsageLog({ dir });
  t.after(() => usage.close());
  const base = { projectId: 'p-a', userId: 'alice@dev-a', username: 'alice', conversationId: 'c1', runId: 'r1' };
  usage.append({ ...base, vendor: 'mock', model: 'mock-1', input: 100, output: 20, ms: 5 });
  const row = usage.append({ ...base, kind: 'service', service: 'voice', vendor: 'minimax', model: 'speech-2.8-hd', units: 12, unit: 'chars', ms: 300, prompt: 'Body text that must not be written to disk' });
  usage.append({ ...base, userId: 'bob@dev-b', username: 'bob', kind: 'service', service: 'voice', vendor: 'minimax', model: 'speech-2.8-hd', units: 8, unit: 'chars', ok: false });
  assert.deepEqual({ kind: row.kind, service: row.service, units: row.units, unit: row.unit, input: row.input }, { kind: 'service', service: 'voice', units: 12, unit: 'chars', input: 0 });
  assert.equal('prompt' in row, false, 'Extra fields are not written to disk');
  assert.equal(usage.used('p-a'), 120, 'External service calls do not count against the token quota');
  const s = usage.summary('p-a');
  assert.deepEqual(s.project, { tokens: 120, calls: 1 }, 'Not mixed into the model call count');
  assert.deepEqual(s.services, [{ service: 'voice', vendor: 'minimax', calls: 2, units: 20, unit: 'chars', members: [
    { userId: 'alice@dev-a', username: 'alice', calls: 1, units: 12 }, { userId: 'bob@dev-b', username: 'bob', calls: 1, units: 8 },
  ] }]);
  const q = queryUsage(dir, { projectId: 'p-a' });
  assert.equal(q.rows.length, 3);
  assert.equal(q.rows.filter((r) => r.kind === 'service').length, 2);
  assert.equal(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'))), 'utf8').includes('must not be written to disk'), false);
  // Rebuilt from journal after restart: same result
  usage.close();
  const again = createUsageLog({ dir });
  t.after(() => again.close());
  assert.equal(again.used('p-a'), 120);
  assert.equal(again.summary('p-a').services[0].units, 20);
});

// Voiceover configuration requires service-keys extension on closed source side
// (cloud/agent/manifest.mjs); community edition has no cloud/,
// readHostedVoiceConfig inherently returns null
test('CA-HT-07 host\'s voiceover configuration: read from the data directory, token ciphertext is written to disk', { skip: fs.existsSync(new URL('../../cloud', import.meta.url)) ? false : 'The current checkout has no cloud/ directory (community edition)' }, async (t) => {
  const dataDir = tmpDir(t);
  assert.equal(await readHostedVoiceConfig(dataDir), null, 'Not configured returns null');
  assert.equal(await readHostedVoiceConfig(null), null);
  const { file, keyFile } = voiceConfigPaths(dataDir);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, baseUrl: 'http://127.0.0.1:9/', provider: 'kling' }));
  const noKey = await readHostedVoiceConfig(dataDir);
  assert.deepEqual([noKey.provider, noKey.effectiveBaseUrl, noKey.apiKey], ['kling', 'http://127.0.0.1:9', '']);
  const FAKE = 'FAKE-VOICE-KEY-unit';
  fs.writeFileSync(keyFile, `${sealKey(FAKE, 'voice')}\n`);
  assert.equal(fs.readFileSync(keyFile, 'utf8').includes(FAKE), false, 'What is written to disk is ciphertext');
  assert.equal((await readHostedVoiceConfig(dataDir)).apiKey, FAKE);
  // Other types of ciphertext (model Key) in wrong location are not recognized
  fs.writeFileSync(keyFile, `${sealKey(FAKE, 'custom')}\n`);
  assert.equal((await readHostedVoiceConfig(dataDir)).apiKey, '');
});
