// Media URLs obtained by the export page: by hash if hash exists, by path only if no hash
// (`normalizeExportMedia` in `server/vite-plugin-export.ts`).
// Run: node --test server/test/export-media-url.test.mjs
//
//   MP-E1  Valid hash exists: always `/@media/<hash>`, ignore path (on a different machine,
//          path points to someone else's directory)
//   MP-E2  No hash: follow path via `/api/media/file?path=…` as before (for existing files in the
//          asset catalog, use resolved absolute path)
//   MP-E3  No hash, no path, uploaded via browser into staging area: replace with address in
//          this export directory; others kept as is
//   MP-E4  No hash, empty address (marked "(missing)"): leave address empty, do not read by path,
//          return in skipped; uploading ones do not count
//   MP-E5  dropSkippedMediaClips: remove clips referencing missing media, leave other clips as is;
//          only list media that actually had clips removed
//   MP-E6  Notice upon export completion (exportSkippedMessage / parseExportSkipped): list names,
//          remove markers, deduplicate, truncate if too many
//
// The export plugin is imported directly using Node's type stripping (same as c66-integ.test.mjs).
import '../../src/testing/registerTs.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const { normalizeExportMedia, dropSkippedMediaClips } = await import(pathToFileURL(path.join(ROOT, 'server', 'vite-plugin-export.ts')).href);
const { exportSkippedMessage, parseExportSkipped } = await import(pathToFileURL(path.join(ROOT, 'src', 'editor', 'io', 'exportSkipped.ts')).href);

const H = (c) => c.repeat(64);
const ROOTS = [path.resolve('/pc-test/media')];
const inMedia = path.join(ROOTS[0], 'voice.mp3');
const elsewhere = 'C:\\Users\\admin\\Videos\\PromptCut\\media\\clip.mp4';

test('MP-E1 media with a valid hash is exported through its hash-based address instead of being read by path (that path belongs to another machine)', async () => {
  const project = { media: [
    { id: 'v', kind: 'video', url: `/@media/${H('a')}`, hash: H('a'), path: elsewhere },
    { id: 'v2', kind: 'video', url: `/api/media/file?path=${encodeURIComponent(elsewhere)}`, hash: H('b'), path: elsewhere },
    { id: 'a', kind: 'audio', url: `/@media/${H('c')}.mp3`, hash: H('c'), path: inMedia },
    { id: 't', kind: 'video', url: '', hash: H('d'), tiers: { original: H('e'), small: H('f') } },
    { id: 'x', kind: 'image', url: '/@export/media/pic.png', hash: H('1') },
    { id: 'u', kind: 'video', url: `/@media/${H('2').toUpperCase()}`, hash: H('2').toUpperCase() },
  ] };
  let asked = 0;
  await normalizeExportMedia(project, ROOT, 'job1', { roots: ROOTS, exists: async () => { asked++; return true; } });
  const url = (id) => project.media.find((m) => m.id === id).url;
  assert.equal(url('v'), `/@media/${H('a')}`, 'the address is already for this hash: unchanged');
  assert.equal(url('v2'), `/@media/${H('b')}`, 'has a hash but a path-based address: switched to hash-based');
  assert.equal(url('a'), `/@media/${H('c')}.mp3`, 'a hash address with an extension is also recognized');
  assert.equal(url('t'), `/@media/${H('e')}`, 'two-tier media uses the hash of the media\'s original size');
  assert.equal(url('x'), `/@media/${H('1')}`, 'with a hash, the staging-area address is not used');
  assert.equal(url('u'), `/@media/${H('2')}`, 'an uppercase hash is recognized as lowercase');
  assert.equal(asked, 0, 'media with a hash never checks whether the file at path exists');
});

test('MP-E2 only media without a hash is read by path: if it is in the asset catalog and the file exists, the resolved path is used; if it is outside the asset catalog or the file is missing, the original path is used as before', async () => {
  const missingInMedia = path.join(ROOTS[0], 'gone.mp3');
  const project = { media: [
    { id: 'p1', kind: 'audio', url: '/@media/voice.mp3', path: inMedia },
    { id: 'p2', kind: 'video', url: '/@media/clip.mp4', path: elsewhere },
    { id: 'p3', kind: 'audio', url: '/api/media/file?path=gone.mp3', path: missingInMedia },
    { id: 'bad', kind: 'audio', url: '/@media/x.mp3', hash: 'not-a-hash', path: inMedia },
  ] };
  await normalizeExportMedia(project, ROOT, 'job2', { roots: ROOTS, exists: async (f) => f === path.resolve(inMedia) });
  const url = (id) => project.media.find((m) => m.id === id).url;
  assert.equal(url('p1'), `/api/media/file?path=${encodeURIComponent(path.resolve(inMedia))}`);
  assert.equal(url('p2'), `/api/media/file?path=${encodeURIComponent(elsewhere)}`);
  assert.equal(url('p3'), `/api/media/file?path=${encodeURIComponent(missingInMedia)}`);
  assert.equal(url('bad'), `/api/media/file?path=${encodeURIComponent(path.resolve(inMedia))}`, 'an invalid hash is handled as no hash');
});

test('MP-E3 no hash and no path: a staging-area address is replaced by one in this export\'s directory, and the rest stays unchanged', async () => {
  const project = { media: [
    { id: 's', kind: 'video', url: '/@export/media/up.mp4' },
    { id: 'n', kind: 'image', url: 'https://example.com/a.png' },
    { id: 'e', kind: 'audio', url: '', pending: true },
  ] };
  const r = await normalizeExportMedia(project, ROOT, 'job3', { roots: ROOTS, exists: async () => true });
  assert.deepEqual(project.media.map((m) => m.url), ['/@export/job3/media/up.mp4', 'https://example.com/a.png', '']);
  assert.deepEqual(r.skipped, [], 'media being uploaded does not count as missing');
  assert.deepEqual(await normalizeExportMedia({}, ROOT, 'job3'), { skipped: [] });
  assert.deepEqual(await normalizeExportMedia({ media: null }, ROOT, 'job3'), { skipped: [] });
});

test('MP-E4 old media with no hash and an empty address (already marked missing): the address stays empty, it is not read by path, and it is returned in skipped', async () => {
  const project = { media: [
    { id: 'gone', kind: 'video', name: '(missing) old.mp4', url: '', path: elsewhere },
    { id: 'gone2', kind: 'audio', name: '(missing) voice.mp3', url: '' },
    { id: 'ok', kind: 'audio', name: 'voice.mp3', url: '/@media/voice.mp3', path: inMedia },
    { id: 'hashed', kind: 'video', name: '(missing) h.mp4', url: '', hash: H('9') },
  ] };
  let asked = 0;
  const r = await normalizeExportMedia(project, ROOT, 'job4', { roots: ROOTS, exists: async () => { asked++; return true; } });
  const url = (id) => project.media.find((m) => m.id === id).url;
  assert.equal(url('gone'), '', 'not changed to a path-based address (the path on that machine cannot be read here)');
  assert.equal(url('gone2'), '');
  assert.equal(url('ok'), `/api/media/file?path=${encodeURIComponent(path.resolve(inMedia))}`, 'with an address but no hash: still by path');
  assert.equal(url('hashed'), `/@media/${H('9')}`, 'with a hash: still by hash (outside the scope of this item)');
  assert.deepEqual(r.skipped, [{ id: 'gone', name: '(missing) old.mp4' }, { id: 'gone2', name: '(missing) voice.mp3' }]);
  assert.equal(asked, 1, 'only the item that has an address was checked for whether its file exists');
});

test('MP-E5 dropSkippedMediaClips: removes clips that reference missing media and leaves the rest unchanged; lists only media that actually had clips removed', () => {
  const project = { tracks: [
    { id: 't1', clips: [{ id: 'c1', mediaId: 'gone', start: 0, end: 1 }, { id: 'c2', mediaId: 'ok', start: 1, end: 2 }, { id: 'c3', cardId: 'x', start: 0, end: 3 }] },
    { id: 't2', clips: [{ id: 'c4', mediaId: 'gone', start: 2, end: 3 }] },
    { id: 't3' },
  ] };
  const out = dropSkippedMediaClips(project, [{ id: 'gone', name: '(missing) old.mp4' }, { id: 'unused', name: 'u.mp3' }]);
  assert.deepEqual(out, [{ id: 'gone', name: '(missing) old.mp4', clips: 2 }]);
  assert.deepEqual(project.tracks[0].clips.map((c) => c.id), ['c2', 'c3']);
  assert.deepEqual(project.tracks[1].clips, []);
  assert.deepEqual(dropSkippedMediaClips(project, []), []);
  assert.deepEqual(dropSkippedMediaClips({}, [{ id: 'gone', name: '' }]), []);
});

test('MP-E6 message shown when the export completes: lists names, strips "(missing) ", deduplicates, truncates when there are too many; an empty string if there are none', () => {
  assert.equal(exportSkippedMessage([]), '');
  const msg = exportSkippedMessage([{ id: 'a', name: '(missing) old.mp4' }, { id: 'b', name: '(missing) old.mp4' }, { id: 'c', name: '' }]);
  assert.match(msg, /The following 2 media files were not found on this machine/);
  assert.match(msg, /· old.mp4/);
  assert.match(exportSkippedMessage([{ id: 'z', name: '(缺失) legacy.mp4' }]), /· legacy.mp4/, 'The Chinese marker from old projects is removed too');
  assert.match(msg, /· c$/m, 'those without a name use the id');
  assert.doesNotMatch(msg, /· \(missing\)/);
  const many = exportSkippedMessage(Array.from({ length: 15 }, (_, i) => ({ id: String(i), name: `m${i}.mp4` })), 12);
  assert.match(many, /and 3 more/);
  assert.deepEqual(parseExportSkipped([{ id: 'a', name: 'x', clips: 2 }, null, 5, { id: '', name: '' }, { name: 'y' }]),
    [{ id: 'a', name: 'x', clips: 2 }, { id: '', name: 'y' }]);
  assert.deepEqual(parseExportSkipped(undefined), []);
});

test('MP-E7 media that has been marked "confirmed missing": the address is kept as is, it does not go into skipped, and clips that reference it are not removed (a placeholder is produced at the original position on export)', async () => {
  const record = (m) => ({ v: 1, mediaId: m.id, reason: 'confirmed-missing', original: { kind: m.kind, name: m.name, url: m.url, ...(m.hash ? { hash: m.hash } : {}) }, visual: m.kind !== 'audio', audio: m.kind !== 'image' });
  const media = [
    { id: 'h', kind: 'video', name: '(missing) h.mp4', url: `/@media/${H('9')}`, hash: H('9'), path: elsewhere },
    { id: 'p', kind: 'audio', name: '(missing) voice.mp3', url: '/@media/voice.mp3', path: elsewhere },
    { id: 'n', kind: 'image', name: '(missing) cover.png', url: '/@media/__missing__' },
  ].map((m) => ({ ...m, missingMaterial: record(m) }));
  // Those where records do not match the current state of media (address was modified) are not
  // considered confirmed; follow the old rules
  const stale = { id: 's', kind: 'video', name: '(missing) s.mp4', url: '', missingMaterial: { ...record({ id: 's', kind: 'video', name: '(missing) s.mp4', url: '/@media/x' }) } };
  const project = { media: [...media.map((m) => structuredClone(m)), stale], tracks: [{ id: 't', clips: [{ id: 'c1', mediaId: 'h', start: 0, end: 1 }, { id: 'c2', mediaId: 'p', start: 1, end: 2 }, { id: 'c3', mediaId: 'n', start: 2, end: 3 }, { id: 'c4', mediaId: 's', start: 3, end: 4 }] }] };
  let asked = 0;
  const r = await normalizeExportMedia(project, ROOT, 'job7', { roots: ROOTS, exists: async () => { asked++; return true; } });
  assert.deepEqual(project.media.slice(0, 3), media, 'not a single field of the three confirmed-missing media items changed');
  assert.equal(asked, 0, 'does not check whether their files exist');
  assert.deepEqual(r.skipped, [{ id: 's', name: '(missing) s.mp4' }]);
  assert.deepEqual(dropSkippedMediaClips(project, r.skipped), [{ id: 's', name: '(missing) s.mp4', clips: 1 }]);
  assert.deepEqual(project.tracks[0].clips.map((c) => c.id), ['c1', 'c2', 'c3'], 'clips of confirmed-missing media stay at their original positions');
});

test('MP-E8 export and the on-screen display use the same check: if any of the name, kind or hash in the record does not match the media, it does not count as confirmed missing (it is handled as ordinary media, and a stale address is not kept as a placeholder)', async () => {
  const base = { id: 'h', kind: 'video', name: '(missing) h.mp4', url: `/@media/${H('9')}.mp4`, hash: H('9') };
  const record = { v: 1, mediaId: 'h', reason: 'confirmed-missing', original: { kind: 'video', name: base.name, url: base.url, hash: base.hash }, visual: true, audio: true };
  const { confirmedMissing } = await import('../../src/audio/missingMaterialRecord.ts');
  for (const [label, media, confirmed] of [
    ['matches', { ...base, missingMaterial: record }, true],
    ['name mismatch', { ...base, name: 'renamed.mp4', missingMaterial: record }, false],
    ['kind mismatch', { ...base, kind: 'image', missingMaterial: record }, false],
    ['hash mismatch', { ...base, hash: H('8'), url: base.url, missingMaterial: record }, false],
  ]) {
    assert.equal(confirmedMissing(media), confirmed, label);
    const project = { media: [structuredClone(media)] };
    await normalizeExportMedia(project, ROOT, 'job8', { roots: ROOTS, exists: async () => true });
    // Confirmed missing: do not change a single character of the address (keep syntax with extension
    // as well); those that do not count: follow the old rule of "by hash if hash exists"
    assert.equal(project.media[0].url === media.url, confirmed || media.hash === H('9'), label);
    assert.equal(confirmedMissing(project.media[0]), confirmed, `${label}: after the export rewrites the address, the check on the on-screen side agrees with the export side`);
  }
});
