/**
 * 片段速度(`TrackClip.speed`)的改前改后键比对:同一份样例项目在基准提交和当前工作区各算一遍各处身份与取帧口径。
 *
 *   1. 不带 speed 的项目(视频段、带裁剪起点的视频段、接视频的素材效果卡、交叉溶解、剪辑段里的视频、音频段、卡片):
 *      两边**逐字相同** —— 帧服务的帧身份与轨道前缀、镜像的项目哈希、层表输入签名(含剪辑段摊出来的虚拟片段)、
 *      `CardFrameCache.plan` 的六个键(缓存键两个、共享快照内容键与结果键、单卡流成员键、成本键)与其余字段、
 *      导出混音清单、看画面的素材时刻、导出兼容旁路的 ffmpeg 参数。
 *   2. 同一份项目里把两段视频改成 2 倍和 0.5 倍:当前工作区里,该变的(含这两段的帧身份、它们与接它们的素材效果卡的
 *      签名和键、混音清单、取帧时刻)都变了,别的片段不变;基准提交上不认 speed,输入签名和卡片键**不变** —— 这就是
 *      「漏加 speed 会命中旧快照、画面错了不报错」的那种情形。
 *
 * 用法(在仓库或工作区根目录):
 *   node scripts/probes/clip-speed-key-compare.mjs [--base <提交>]   缺省 --base main
 *
 * 基准的 src/、server/ 用 `git archive` 解到 out/clip-speed-keys/<提交>/(out/ 不入库),依赖向上解析到仓库的 node_modules。
 * 退出码:0 = 相符;1 = 有不符;2 = 跑不起来。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const args = process.argv.slice(2);
const BASE_REF = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'main';
const git = (...a) => execFileSync('git', a, { cwd: HERE, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

function checkoutBase(ref) {
  const sha = git('rev-parse', ref);
  const dir = path.join(HERE, 'out', 'clip-speed-keys', sha.slice(0, 12));
  if (fs.existsSync(path.join(dir, '.done'))) return { sha, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['archive', '--format=tar', '-o', path.join(dir, 'base.tar'), sha, 'src', 'server'], { cwd: HERE, windowsHide: true });
  // 相对路径 + cwd:Git Bash 带的 GNU tar 会把 `C:` 当成远端主机名
  execFileSync('tar', ['-xf', 'base.tar'], { cwd: dir, windowsHide: true });
  fs.rmSync(path.join(dir, 'base.tar'));
  fs.writeFileSync(path.join(dir, '.done'), sha);
  return { sha, dir };
}

const DEFS = { 'fx-tint': { id: 'fx-tint', kind: 'filter', defaults: {}, card() {} }, 'punch-pill': { id: 'punch-pill', defaults: { text: '' } } };
const frame = { x: 0, y: 0, w: 1280, h: 720, anchor: [0, 0], scale: 1, rotate: 0 };
function fixture() {
  return {
    id: 'p', width: 1280, height: 720, fps: 30, duration: 20, themeId: 'dark', style: { accent: '#f00' },
    media: [
      { id: 'v1', kind: 'video', name: 'a.mp4', url: '/@media/v1.mp4', hash: 'h-v1', duration: 40 },
      { id: 'v2', kind: 'video', name: 'b.mp4', url: '/@media/v2.mp4', hash: 'h-v2', duration: 40 },
      { id: 'a1', kind: 'audio', name: 'c.mp3', url: '/@media/a1.mp3', hash: 'h-a1', duration: 60 },
    ],
    filters: [], audioFx: [],
    cardNodes: [{ id: 'n1', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: {}, inputs: { source: '@clip/v-fx/source' } }],
    transitions: [{ id: 'tr1', kind: 'crossfade', aId: 'v-a', bId: 'v-b', dur: 1 }],
    tracks: [
      { id: 't1', name: '序列 1', clips: [{ id: 'c1', cardId: 'punch-pill', start: 0, end: 2, params: { text: 'a' } }] },
      { id: 't2', name: '序列 2', clips: [
        { id: 'v-a', cardId: '', mediaId: 'v1', mediaOffset: 1.5, start: 0, end: 4.5, fadeOut: 1, params: {}, frame },
        { id: 'v-b', cardId: '', mediaId: 'v2', mediaOffset: 0.1, start: 3.5, end: 8, fadeIn: 1, params: {}, frame },
        { id: 'v-fx', cardId: '', mediaId: 'v1', mediaOffset: 0.2, start: 8, end: 12, params: {}, nodeId: 'n1', frame },
      ] },
      { id: 't3', name: '序列 3', clips: [{ id: 'seg', cardId: '', cutId: 'B', cutOffset: 1, start: 12, end: 16, params: {} }] },
      { id: 't4', name: '序列 4', clips: [{ id: 'a-1', cardId: '', mediaId: 'a1', mediaOffset: 3, start: 0, end: 10, params: {} }] },
    ],
    cuts: [{ id: 'A', name: '剪辑A' }, { id: 'B', name: '剪辑B', duration: 8, transitions: [], tracks: [{ id: 'tb', name: '序列 1', clips: [
      { id: 'b1', cardId: '', mediaId: 'v2', mediaOffset: 2.3, start: 0, end: 8, params: {}, frame },
    ] }] }],
    activeCutId: 'A',
  };
}
const withClips = (p, patches) => ({
  ...p,
  tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (patches[c.id] ? { ...c, ...patches[c.id] } : c)) })),
  cuts: p.cuts.map((cut) => (cut.tracks ? { ...cut, tracks: cut.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (patches[c.id] ? { ...c, ...patches[c.id] } : c)) })) } : cut)),
});

async function measure(root, project) {
  const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
  const { frameIdentity, trackPrefixes } = await imp('server/frame-identity.mjs');
  const { clipInputSig } = await imp('src/render/layerInputSig.mjs');
  const { projectHash } = await imp('src/render/changedClips.mjs');
  const { projectCardGraph } = await imp('src/kernel/cardGraph.mjs');
  const { flatPlanProject } = await imp('src/kernel/cutFlatten.mjs');
  const { audioPlanOf } = await imp('src/kernel/audioPlan.mjs');
  const { mediaLayersAt } = await imp('server/vision-compose.mjs');
  const { buildComposeArgs, composeLayers } = await imp('server/export-compose.mjs');
  const { CardFrameCache } = await imp('server/card-cache.mjs');
  const flat = flatPlanProject(project);
  const ids = flat.tracks.flatMap((t) => t.clips.map((c) => c.id));
  // 当前工作区里出键的几处在 projectCardGraph 之后接 withMediaRates(基准没有这个函数,原样)
  const clipTime = fs.existsSync(path.join(root, 'src/kernel/clipTime.mjs')) ? await imp('src/kernel/clipTime.mjs') : {};
  const graph = (clipTime.withMediaRates ?? ((_p, g) => g))(flat, projectCardGraph(flat, (id) => DEFS[id]));
  const plan = new CardFrameCache({ root: 'unused', project: flat, envFingerprint: '0123456789abcdef' }).plan({
    graph, sourceVersions: Object.fromEntries(Object.keys(DEFS).map((id) => [id, `builtin:${id}-v1`])), environment: { width: 1280, height: 720, fps: 30, theme: 'dark', fontFingerprint: 'ff' },
  });
  const layers = composeLayers(project).map((l) => ({ ...l, src: `/m/${l.media.id}.mp4` }));
  const compose = buildComposeArgs({ width: 1280, height: 720, fps: 30, startFrame: 0, endFrame: 599, cardsPattern: 'f/%06d.png', out: 'o.mp4', layers });
  const out = {
    'frameIdentity': frameIdentity(project, 'code'),
    'trackPrefixes': trackPrefixes(project, 'code').map((x) => x.key).join(','),
    'projectHash': projectHash(project),
    'audioPlan': JSON.stringify(audioPlanOf(project)),
    'vision@1': JSON.stringify(mediaLayersAt(project, 1).map((l) => [l.clip.id, l.mediaTime])),
    'vision@4': JSON.stringify(mediaLayersAt(project, 4).map((l) => [l.clip.id, l.mediaTime])),
    'vision@9': JSON.stringify(mediaLayersAt(project, 9).map((l) => [l.clip.id, l.mediaTime])),
    'compose.args': JSON.stringify(compose.args),
    'compose.graph': compose.graph,
  };
  for (const id of ids) out[`sig ${id}`] = clipInputSig(flat, id);
  for (const row of plan) for (const k of ['key', 'cacheContentKey', 'contentKey', 'snapshotKey', 'streamMemberKey', 'costKey']) out[`plan ${row.clipId}.${k}`] = row[k];
  for (const row of plan) out[`plan ${row.clipId}.rest`] = JSON.stringify({ ...row, key: 0, cacheContentKey: 0, contentKey: 0, snapshotKey: 0, streamMemberKey: 0, costKey: 0 });
  return out;
}

let base;
try { base = checkoutBase(BASE_REF); } catch (error) { console.error(error); process.exit(2); }
const plain = fixture();
const sped = withClips(plain, { 'v-fx': { speed: 2 }, b1: { speed: 0.5 } });
const [bPlain, cPlain, bSped, cSped] = [await measure(base.dir, plain), await measure(HERE, plain), await measure(base.dir, sped), await measure(HERE, sped)];
console.log(`基准 ${BASE_REF} = ${base.sha.slice(0, 12)};当前 HEAD = ${git('rev-parse', 'HEAD').slice(0, 12)}${git('status', '--porcelain', '--', 'src', 'server') ? '(src/ 或 server/ 有未提交的改动,算的是工作区)' : ''}`);

let bad = 0;
console.log('\n== 1. 不带 speed:基准与当前逐字相同 ==');
const keys = Object.keys(cPlain);
const same = keys.filter((k) => bPlain[k] === cPlain[k]);
const diff = keys.filter((k) => bPlain[k] !== cPlain[k]);
if (Object.keys(bPlain).length !== keys.length) { bad++; console.log(`✖ 两边的条目数不同:基准 ${Object.keys(bPlain).length},当前 ${keys.length}`); }
for (const k of diff) { bad++; console.log(`✖ ${k}\n    基准 ${String(bPlain[k]).slice(0, 160)}\n    当前 ${String(cPlain[k]).slice(0, 160)}`); }
console.log(`${diff.length ? '✖' : '✔'} ${same.length}/${keys.length} 项逐字相同`);

console.log('\n== 2. v-fx 改 2 倍、剪辑段里的 b1 改 0.5 倍 ==');
// 当前工作区里必须变的
const mustChange = ['frameIdentity', 'projectHash', 'audioPlan', 'vision@9', 'compose.args', 'compose.graph', 'sig v-fx', 'sig seg~b1', 'plan v-fx.contentKey', 'plan v-fx.snapshotKey', 'plan v-fx.streamMemberKey', 'plan seg~b1.contentKey'];
// 不碰的片段必须不变
const mustStay = ['sig c1', 'sig v-a', 'sig v-b', 'sig a-1', 'vision@1', 'vision@4', ...keys.filter((k) => /^plan (c1|v-a|v-b|a-1)\./.test(k))];
for (const k of mustChange) {
  const ok = cSped[k] !== undefined && cSped[k] !== cPlain[k];
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✖'} 当前:${k} 变了${ok ? '' : '(没变!)'}`);
}
for (const k of mustStay) {
  const ok = cSped[k] === cPlain[k];
  if (!ok) bad++;
  if (!ok) console.log(`✖ 当前:${k} 不该变却变了`);
}
console.log(`✔ 当前:没碰的片段 ${mustStay.length} 项不变`);
const blind = ['sig v-fx', 'sig seg~b1', 'plan v-fx.contentKey', 'plan v-fx.streamMemberKey', 'vision@9', 'compose.graph'].filter((k) => bSped[k] === bPlain[k]);
console.log(`基准(改前)不认 speed:${blind.length} 项改了速度却没变 —— ${blind.join('、')}`);
console.log(`\n当前:变速段的取帧时刻 vision@9 = ${cSped['vision@9']}(不变速是 ${cPlain['vision@9']})`);
console.log(`当前:混音清单里 ${JSON.parse(cSped.audioPlan).map((e) => e.clipId).join('、')}(不变速时 ${JSON.parse(cPlain.audioPlan).map((e) => e.clipId).join('、')})`);
console.log(bad ? `\n✖ ${bad} 处不符` : '\n✔ 全部相符');
process.exit(bad ? 1 : 0);
