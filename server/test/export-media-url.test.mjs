// 导出页拿到的素材地址:有哈希按哈希、没哈希才按路径(`server/vite-plugin-export.ts` 的 normalizeExportMedia)。
// 跑:node --test server/test/export-media-url.test.mjs
//
//   MP-E1  有合法哈希:一律 `/@media/<哈希>`,不看 path(换了机器,path 指着别人的目录)
//   MP-E2  没有哈希:照旧按 path 走 `/api/media/file?path=…`(素材目录里、文件在的用解析后的绝对路径)
//   MP-E3  没有哈希、没有 path、浏览器上传进暂存区的:换成这次导出目录里的地址;别的原样
//   MP-E4  没有哈希、地址为空(已标「(缺失)」):地址留空、不按 path 读,回在 skipped 里;上传中的不算
//   MP-E5  dropSkippedMediaClips:去掉引用缺失素材的片段,别的片段原样;只列真有片段被去掉的素材
//   MP-E6  导出完成时的提示(exportSkippedMessage / parseExportSkipped):列出名字、去掉标记、去重、太多时截断
//
// 导出插件用 node 的类型剥离直接 import(同 c66-integ.test.mjs)。
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

test('MP-E1 有合法哈希的素材导出时走按哈希地址,不按 path 读(另一台机器的路径)', async () => {
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
  assert.equal(url('v'), `/@media/${H('a')}`, '地址本来就是这份哈希的:原样');
  assert.equal(url('v2'), `/@media/${H('b')}`, '带哈希、地址却是按路径的:改成按哈希');
  assert.equal(url('a'), `/@media/${H('c')}.mp3`, '带扩展名的哈希地址也认');
  assert.equal(url('t'), `/@media/${H('e')}`, '两档素材按素材原尺寸的哈希');
  assert.equal(url('x'), `/@media/${H('1')}`, '有哈希就不用暂存区的地址');
  assert.equal(url('u'), `/@media/${H('2')}`, '大写哈希按小写认');
  assert.equal(asked, 0, '带哈希的素材一次都不去看 path 那个文件在不在');
});

test('MP-E2 没有哈希的素材才按路径读:素材目录里、文件在的用解析后的路径;不在素材目录或文件不在的照旧用原路径', async () => {
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
  assert.equal(url('bad'), `/api/media/file?path=${encodeURIComponent(path.resolve(inMedia))}`, '哈希不合法按没有哈希办');
});

test('MP-E3 没有哈希也没有 path:暂存区地址换成这次导出目录里的,其余原样', async () => {
  const project = { media: [
    { id: 's', kind: 'video', url: '/@export/media/up.mp4' },
    { id: 'n', kind: 'image', url: 'https://example.com/a.png' },
    { id: 'e', kind: 'audio', url: '', pending: true },
  ] };
  const r = await normalizeExportMedia(project, ROOT, 'job3', { roots: ROOTS, exists: async () => true });
  assert.deepEqual(project.media.map((m) => m.url), ['/@export/job3/media/up.mp4', 'https://example.com/a.png', '']);
  assert.deepEqual(r.skipped, [], '上传中的不算缺失');
  assert.deepEqual(await normalizeExportMedia({}, ROOT, 'job3'), { skipped: [] });
  assert.deepEqual(await normalizeExportMedia({ media: null }, ROOT, 'job3'), { skipped: [] });
});

test('MP-E4 没有哈希、地址为空(已标缺失)的老素材:地址留空、不按 path 读,回在 skipped 里', async () => {
  const project = { media: [
    { id: 'gone', kind: 'video', name: '(缺失) old.mp4', url: '', path: elsewhere },
    { id: 'gone2', kind: 'audio', name: '(缺失) voice.mp3', url: '' },
    { id: 'ok', kind: 'audio', name: 'voice.mp3', url: '/@media/voice.mp3', path: inMedia },
    { id: 'hashed', kind: 'video', name: '(缺失) h.mp4', url: '', hash: H('9') },
  ] };
  let asked = 0;
  const r = await normalizeExportMedia(project, ROOT, 'job4', { roots: ROOTS, exists: async () => { asked++; return true; } });
  const url = (id) => project.media.find((m) => m.id === id).url;
  assert.equal(url('gone'), '', '不改成按路径的地址(那台机器的路径在这里读不到)');
  assert.equal(url('gone2'), '');
  assert.equal(url('ok'), `/api/media/file?path=${encodeURIComponent(path.resolve(inMedia))}`, '有地址、没哈希的照旧按路径');
  assert.equal(url('hashed'), `/@media/${H('9')}`, '带哈希的照旧按哈希(不在本条范围)');
  assert.deepEqual(r.skipped, [{ id: 'gone', name: '(缺失) old.mp4' }, { id: 'gone2', name: '(缺失) voice.mp3' }]);
  assert.equal(asked, 1, '只为有地址的那条看了文件在不在');
});

test('MP-E5 dropSkippedMediaClips:去掉引用缺失素材的片段,别的原样;只列真有片段被去掉的', () => {
  const project = { tracks: [
    { id: 't1', clips: [{ id: 'c1', mediaId: 'gone', start: 0, end: 1 }, { id: 'c2', mediaId: 'ok', start: 1, end: 2 }, { id: 'c3', cardId: 'x', start: 0, end: 3 }] },
    { id: 't2', clips: [{ id: 'c4', mediaId: 'gone', start: 2, end: 3 }] },
    { id: 't3' },
  ] };
  const out = dropSkippedMediaClips(project, [{ id: 'gone', name: '(缺失) old.mp4' }, { id: 'unused', name: 'u.mp3' }]);
  assert.deepEqual(out, [{ id: 'gone', name: '(缺失) old.mp4', clips: 2 }]);
  assert.deepEqual(project.tracks[0].clips.map((c) => c.id), ['c2', 'c3']);
  assert.deepEqual(project.tracks[1].clips, []);
  assert.deepEqual(dropSkippedMediaClips(project, []), []);
  assert.deepEqual(dropSkippedMediaClips({}, [{ id: 'gone', name: '' }]), []);
});

test('MP-E6 导出完成时的提示:列出名字、去掉「(缺失) 」、去重、太多截断;没有就空串', () => {
  assert.equal(exportSkippedMessage([]), '');
  const msg = exportSkippedMessage([{ id: 'a', name: '(缺失) old.mp4' }, { id: 'b', name: '(缺失) old.mp4' }, { id: 'c', name: '' }]);
  assert.match(msg, /下面 2 条素材本机找不到文件/);
  assert.match(msg, /· old.mp4/);
  assert.match(msg, /· c$/m, '没有名字的用 id');
  assert.doesNotMatch(msg, /· (缺失)/);
  const many = exportSkippedMessage(Array.from({ length: 15 }, (_, i) => ({ id: String(i), name: `m${i}.mp4` })), 12);
  assert.match(many, /另有 3 条/);
  assert.deepEqual(parseExportSkipped([{ id: 'a', name: 'x', clips: 2 }, null, 5, { id: '', name: '' }, { name: 'y' }]),
    [{ id: 'a', name: 'x', clips: 2 }, { id: '', name: 'y' }]);
  assert.deepEqual(parseExportSkipped(undefined), []);
});

test('MP-E7 认定过「确认缺失」的素材:地址原样留着、不进 skipped,引用它的片段不被去掉(导出时照原位置出占位)', async () => {
  const record = (m) => ({ v: 1, mediaId: m.id, reason: 'confirmed-missing', original: { kind: m.kind, name: m.name, url: m.url, ...(m.hash ? { hash: m.hash } : {}) }, visual: m.kind !== 'audio', audio: m.kind !== 'image' });
  const media = [
    { id: 'h', kind: 'video', name: '(缺失) h.mp4', url: `/@media/${H('9')}`, hash: H('9'), path: elsewhere },
    { id: 'p', kind: 'audio', name: '(缺失) voice.mp3', url: '/@media/voice.mp3', path: elsewhere },
    { id: 'n', kind: 'image', name: '(缺失) cover.png', url: '/@media/__missing__' },
  ].map((m) => ({ ...m, missingMaterial: record(m) }));
  // 记录与素材现状对不上的(地址被改过)不算认定过,照老规矩办
  const stale = { id: 's', kind: 'video', name: '(缺失) s.mp4', url: '', missingMaterial: { ...record({ id: 's', kind: 'video', name: '(缺失) s.mp4', url: '/@media/x' }) } };
  const project = { media: [...media.map((m) => structuredClone(m)), stale], tracks: [{ id: 't', clips: [{ id: 'c1', mediaId: 'h', start: 0, end: 1 }, { id: 'c2', mediaId: 'p', start: 1, end: 2 }, { id: 'c3', mediaId: 'n', start: 2, end: 3 }, { id: 'c4', mediaId: 's', start: 3, end: 4 }] }] };
  let asked = 0;
  const r = await normalizeExportMedia(project, ROOT, 'job7', { roots: ROOTS, exists: async () => { asked++; return true; } });
  assert.deepEqual(project.media.slice(0, 3), media, '三条认定过的素材一个字段都没动');
  assert.equal(asked, 0, '不去看它们的文件在不在');
  assert.deepEqual(r.skipped, [{ id: 's', name: '(缺失) s.mp4' }]);
  assert.deepEqual(dropSkippedMediaClips(project, r.skipped), [{ id: 's', name: '(缺失) s.mp4', clips: 1 }]);
  assert.deepEqual(project.tracks[0].clips.map((c) => c.id), ['c1', 'c2', 'c3'], '认定过的素材的片段留在原位置');
});

test('MP-E8 导出与画面用同一个判定:记录里的名字、类别、哈希任一项和素材对不上,就不算确认缺失(照普通素材办,不留着失效的地址当占位)', async () => {
  const base = { id: 'h', kind: 'video', name: '(缺失) h.mp4', url: `/@media/${H('9')}.mp4`, hash: H('9') };
  const record = { v: 1, mediaId: 'h', reason: 'confirmed-missing', original: { kind: 'video', name: base.name, url: base.url, hash: base.hash }, visual: true, audio: true };
  const { confirmedMissing } = await import('../../src/audio/missingMaterialRecord.ts');
  for (const [label, media, confirmed] of [
    ['对得上', { ...base, missingMaterial: record }, true],
    ['名字对不上', { ...base, name: '改过名.mp4', missingMaterial: record }, false],
    ['类别对不上', { ...base, kind: 'image', missingMaterial: record }, false],
    ['哈希对不上', { ...base, hash: H('8'), url: base.url, missingMaterial: record }, false],
  ]) {
    assert.equal(confirmedMissing(media), confirmed, label);
    const project = { media: [structuredClone(media)] };
    await normalizeExportMedia(project, ROOT, 'job8', { roots: ROOTS, exists: async () => true });
    // 确认缺失的:地址一个字不动(带扩展名的写法也留着);不算的:照「有哈希就按哈希」的老规矩办
    assert.equal(project.media[0].url === media.url, confirmed || media.hash === H('9'), label);
    assert.equal(confirmedMissing(project.media[0]), confirmed, `${label}:导出改完地址之后,画面那一侧的判定与导出这一侧一致`);
  }
});
