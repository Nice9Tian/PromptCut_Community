/**
 * `CardFrameCache.plan` 出的键的改前改后比对:同一份输入(一个项目摊出来的卡片图、源码版本、环境),在基准提交和当前工作区各跑一遍
 * `plan`,逐片段比每个键(报告 `docs/archive/agent-reports/AGENT-rr-emphasis-key.md`)。
 *
 * 项目里两类片段:
 *   plain-*  输出节点没有上游(普通卡、带框和不透明度的卡、画布卡、依赖下层的卡、remotion 式的卡、素材效果卡、素材段)——
 *            六个键(带外观的缓存键两个、共享快照的内容键与结果键、单卡流的成员键、成本键)和别的字段必须逐字相同;
 *   其余     输出节点有上游(挂强调、挂滤镜的卡,挂强调的素材段,接素材的素材效果卡)—— 只许变共享快照的内容键、结果键、
 *            单卡流的成员键这三个,带外观的缓存键和成本键不变。
 *
 * `card-table-digest-compare.mjs` 比的是内置卡逐张直接调 `cardSnapshotIdentity` 的结果;这一支比的是 `plan` 这一层(键在这里拼)。
 *
 * 用法(在仓库或工作区根目录):
 *   node scripts/probes/card-plan-key-compare.mjs [--base main]
 *
 *   --base  基准提交,缺省 main。用 `git archive` 把它的 src/ 与 server/ 解到 out/card-table-digest/<提交>/ 下
 *           (和 `card-table-digest-compare.mjs` 共用同一个目录,out/ 不入库),不动任何工作区与分支。
 *
 * 退出码:0 = 相符;1 = 有片段不符;2 = 跑不起来。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectCardGraph } from '../../src/kernel/cardGraph.mjs';

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const args = process.argv.slice(2);
const BASE_REF = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'main';
const git = (...a) => execFileSync('git', a, { cwd: HERE, windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

/** 把基准提交的 src/、server/ 解到 out/ 下;依赖向上解析到仓库的 node_modules(同 `card-table-digest-compare.mjs`) */
function checkoutBase(ref) {
  const sha = git('rev-parse', ref);
  const dir = path.join(HERE, 'out', 'card-table-digest', sha.slice(0, 12));
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

let base;
try { base = checkoutBase(BASE_REF); } catch (error) { console.error(error); process.exit(2); }
const BASE = base.dir;
const load = root => import(pathToFileURL(path.join(root, 'server/card-cache.mjs')).href);
const DEFS = { 'punch-pill': { id: 'punch-pill', defaults: { text: '' } }, 'focus-card': { id: 'focus-card', defaults: {} }, 'particles': { id: 'particles', defaults: {} }, 'odometer': { id: 'odometer', defaults: {} },
  'fx-tint': { id: 'fx-tint', kind: 'filter', defaults: {}, card() {} }, 'av-pulse': { id: 'av-pulse', frameMode: 'direct', defaults: {} } };
const E = { kind: 'outline', color: '#ffd400', size: 8 };
const c = (id, extra) => ({ id, start: 1, end: 3, params: {}, ...extra });
const clips = [
  c('plain-pill', { cardId: 'punch-pill', params: { text: 'a' } }), c('plain-pill-framed', { cardId: 'punch-pill', start: 0.505, end: 2.2, frame: { x: 3, y: 4, w: 640, h: 360 }, opacity: 0.5 }),
  c('plain-focus', { cardId: 'focus-card' }), c('plain-particles', { cardId: 'particles' }), c('plain-odometer', { cardId: 'odometer' }), c('plain-direct', { cardId: 'av-pulse' }),
  c('plain-graphcard', { cardId: 'fx-tint' }), c('plain-media', { mediaId: 'm-a', mediaOffset: 1 }),
  c('emph-pill', { cardId: 'punch-pill', params: { text: 'a' }, emphasis: E }), c('filter-pill', { cardId: 'punch-pill', filter: { id: 'f', params: {} } }),
  c('emph-media', { mediaId: 'm-a', emphasis: E }), c('fx-on-media', { mediaId: 'm-a', nodeId: 'n1' }),
];
const project = { id: 'p', width: 1920, height: 1080, fps: 30, duration: 4, themeId: 'dark', style: { accent: '#f00' },
  media: [{ id: 'm-a', kind: 'video', path: 'a.mp4', duration: 9 }], filters: [{ id: 'f', ops: [] }], audioFx: [],
  cardNodes: [{ id: 'n1', adapter: 'card', cardId: 'fx-tint', kind: 'filter', params: {}, inputs: { source: '@clip/fx-on-media/source' } }],
  tracks: clips.map((clip, i) => ({ id: `t${i}`, clips: [clip] })) };
const value = { graph: projectCardGraph(project, id => DEFS[id]), sourceVersions: Object.fromEntries(Object.keys(DEFS).map(id => [id, `builtin:${id}-v1`])), environment: { width: 1920, height: 1080, fps: 30, theme: 'dark', fontFingerprint: 'ff' } };
const run = async root => { const { CardFrameCache } = await load(root); return new CardFrameCache({ root: 'unused', project, envFingerprint: '0123456789abcdef' }).plan(structuredClone(value)); };
const before = await run(BASE), after = await run(HERE);
console.log(`基准 ${BASE_REF} = ${base.sha.slice(0, 12)};当前 HEAD = ${git('rev-parse', 'HEAD').slice(0, 12)}${git('status', '--porcelain', '--', 'src', 'server') ? '(src/ 或 server/ 有未提交的改动,算的是工作区)' : ''}`);
const KEYS = ['key', 'cacheContentKey', 'contentKey', 'snapshotKey', 'streamMemberKey', 'costKey'];
let bad = 0;
for (const a of after) {
  const b = before.find(x => x.clipId === a.clipId);
  const changed = KEYS.filter(k => a[k] !== b[k]);
  const rest = JSON.stringify({ ...a, ...Object.fromEntries(KEYS.map(k => [k, 0])) }) === JSON.stringify({ ...b, ...Object.fromEntries(KEYS.map(k => [k, 0])) });
  const wrapped = !a.clipId.startsWith('plain-');
  const ok = rest && (wrapped ? changed.join() === 'contentKey,snapshotKey,streamMemberKey' : changed.length === 0);
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✖'} ${a.clipId.padEnd(18)} 输出节点 ${a.nodeId.padEnd(28)} 档位 ${a.tier.padEnd(6)} 变了的键: ${changed.join(', ') || '无'}${rest ? '' : ' (别的字段也变了!)'}`);
}
console.log(before.length === after.length && !bad ? `✔ ${after.length} 个片段:没有上游的 6 个键逐字相同;有上游的只变 contentKey / snapshotKey / streamMemberKey` : `✖ ${bad} 个不符`);
process.exit(bad ? 1 : 0);
