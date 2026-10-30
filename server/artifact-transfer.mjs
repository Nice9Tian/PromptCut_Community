/**
 * 预渲染产物的推送与拉取(C6.2,`docs/plan/artifact-transfer-contract.md` 第 3～6 节、第 11 节)。
 *
 * 队列任务的两类产物 —— HTML 快照(共享档、本地档)和轨道流(init + 分段)—— 按内容哈希推到素材服务
 * (快照进 `snap`、流进 `px`),「这一段由哪些块组成」的任务清单放进 `task.complete` 的 `result`,
 * 随 `task.done` 送到订阅方;订阅方按清单拉块,经现有的写入函数落盘,再发布进就绪索引。
 *
 *   推送端:`collectSnapshotResult` / `collectStreamResult` 从本机帧库读出清单,`pushResult` 把块逐个 `put`;
 *           `createAssetSink` 把这两步包成 `render-queue-contract.md` D.1 的产物库(`sink`)。
 *   拉取端:`applyResult` —— 快照经 `SnapshotStore.commitSnapshots` 落盘再 `pipeline.adoptResult` 发布,
 *           流经 `pipeline.streamProducer().adoptSegments` 落盘并发布。**只有这两个写入函数写文件**,
 *           否则 `index.json` / `stream.json` 会和磁盘对不上(`cloud-task.md` A3b)。
 *
 * X7(`docs/plan/m6c-contract.md`):快照清单可以另带这一段的 **PNG 缓存**帧(`pngs`,见 `collectSnapshotResult`),
 * 块推进 `px`;拉取方把它们原样写进本机 PNG 缓存(`CardFrameCache` 的 `controls/<key>/mov/frames/`),
 * `?preview=legacy` 的整帧通道因此不再给远端节点产的卡画占位符。清单里没有 `pngs` 的照旧,不在本机预渲染重试。
 *
 * C6.4(`docs/plan/manifest-contract.md` 第 1、3 节):每一段的清单另写进文档服务的内容库
 * (`snapshot-manifest` / `render-manifest`,键 `<resultKey>:<from>-<to>`);sink 开工前先查它去重。
 * 内容库客户端(`ContentClient`,`put` / `get` / `list`)同样由调用方传进来。
 *
 * 素材服务的客户端(`server/asset-store/client.mjs` 的 `createAssetClient`)由调用方传进来,这里不引它:
 * 只用它的 `put(ns, bytes, { ext })` / `get(ns, hash)` 两个方法(契约第 2 节)。
 *
 * 这个模块引 `snapshot-store.mjs`(带依赖),所以放在 `server/` 下,不放 `server/render-node/`(D1 守门)。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { rangeHas } from './snapshot-store.mjs';
import { clipInputSig } from '../src/render/layerInputSig.mjs';
import { streamInputSig } from '../src/render/streamInputSig.mjs';
import { isStreamOrigin } from '../src/render/streamSegments.mjs';
import { streamBucketManifest, streamBucketRanges, streamLastSegmentOf, STREAM_BUCKET_SEGMENTS } from '../src/render/streamBuckets.mjs';
import { snapshotTier } from './snapshot-tier.mjs';
import { MovFrameStore, signatureMatches } from './frame-mov.mjs';
import { readRenderRecord } from './png-record.mjs';
import { resultKeyOf } from './render-node/fingerprint.mjs';
import { SMALL_SUFFIX } from './bakery/small-bitmap.mjs';
import { kindOfTier, wireSnapshotKey } from './ready-index.mjs';
import { QUEUE_DEFAULTS } from './render-queue/constants.mjs';
import { isSparseStreamTask } from './render-queue/messages.mjs';
import { createExportFramesSink, isExportFramesTask } from './export-frames.mjs';

/** 清单的版本(契约第 3 节的 `v`) */
export const RESULT_VERSION = 1;
/** 清单 JSON 的体积上限:超了报错,不截断(契约第 3 节) */
export const RESULT_MAX_BYTES = 256 * 1024;
/** 素材服务的命名空间(契约第 1 节) */
export const SNAP_NS = 'snap';
export const PX_NS = 'px';
/** 并发推 / 拉的块数 */
const TRANSFER_CONCURRENCY = 4;
/** 拉快照时每攒这么多帧 `commitSnapshots` 一次(每批写一次 index.json) */
const APPLY_BATCH = 8;

const KEY_RE = /^[a-f0-9]{64}$/;
/** 目录名用得的键(共享档的结果键就是目录名):不许带路径分隔符、不许是 `.` / `..` */
const SAFE_KEY_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const safeKey = value => typeof value === 'string' && SAFE_KEY_RE.test(value) && value !== '.' && value !== '..';
const sha256 = data => createHash('sha256').update(data).digest('hex');

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/** 限并发地跑一组异步任务,回 `Promise.allSettled` 的形状(保持顺序) */
async function settleLimited(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = { status: 'fulfilled', value: await work(items[i], i) }; }
      catch (reason) { out[i] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/** 清单 JSON 的字节数;超上限就抛 `code: 'result-too-large'`(不截断,契约第 11 节第 7 条) */
export function assertResultSize(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  if (bytes > RESULT_MAX_BYTES) throw fail(`任务清单 ${bytes} 字节,超过上限 ${RESULT_MAX_BYTES}`, { code: 'result-too-large', bytes, retryable: false });
  return bytes;
}

const rangeOf = task => {
  const from = task?.range?.from, to = task?.range?.to;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) throw fail(`任务的 range 不对:${JSON.stringify(task?.range ?? null)}`, { retryable: false });
  return { from, to };
};

/* ======================================================================== *
 * 快照:任务 → 落盘位置(E.9)
 * ======================================================================== */

/**
 * 快照任务落在本机帧库的哪里:`{ tier, entryKey, dirKey }`,认不出回 null(不猜,契约第 11 节第 3 条)。
 *
 *   - 共享档:`dirKey = resultKey`;
 *   - 本地档(E.9):`dirKey = resultKeyOf(去掉 "<entryKey>/" 前缀的内容键, 任务的锁指纹)`,
 *     `entryKey = input.entryKey`,内容键是 `input.contentKey`,锁指纹是 `requires.envFingerprint`。
 *     缺任何一项(或内容键不以 `<entryKey>/` 开头)就回 null。
 */
export function snapshotLocation(task) {
  const tier = task?.tier;
  if (tier === 'shared') return safeKey(task.resultKey) ? { tier, entryKey: null, dirKey: task.resultKey } : null;
  if (tier !== 'local') return null;
  const entryKey = task.input?.entryKey;
  const contentKey = task.input?.contentKey;
  const fp = task.requires?.envFingerprint;
  if (!safeKey(entryKey) || typeof contentKey !== 'string' || typeof fp !== 'string' || !fp) return null;
  const prefix = `${entryKey}/`;
  if (!contentKey.startsWith(prefix) || contentKey.length === prefix.length) return null;
  return { tier, entryKey, dirKey: resultKeyOf(contentKey.slice(prefix.length), fp) };
}

/** 调用方直接给的落盘位置 `{ tier, entryKey, dirKey }`:形状对才认,不对回 null(退回按任务反算) */
function checkLocation(location, tier) {
  if (!location || typeof location !== 'object') return null;
  const t = location.tier ?? tier;
  if (t === 'shared') return safeKey(location.dirKey) ? { tier: t, entryKey: null, dirKey: location.dirKey } : null;
  if (t === 'local') return safeKey(location.dirKey) && safeKey(location.entryKey) ? { tier: t, entryKey: location.entryKey, dirKey: location.dirKey } : null;
  return null;
}

/* ======================================================================== *
 * 内容库里的清单(C6.4,`manifest-contract.md` 第 1 节)
 * ======================================================================== */

/** 任务 kind → 内容库 kind:快照 `snapshot-manifest`,流 `render-manifest`;别的回 null */
export function manifestKindOf(kind) {
  if (kind === 'snapshot') return 'snapshot-manifest';
  if (kind === 'stream') return 'render-manifest';
  return null;
}

/** 清单在内容库里的键:`<resultKey>:<from>-<to>`,即任务 id 去掉 `kind:` 前缀;缺东西回 null */
export function manifestKeyOf(ref) {
  const key = ref?.resultKey;
  const from = ref?.range?.from, to = ref?.range?.to;
  if (typeof key !== 'string' || !key || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  return `${key}:${from}-${to}`;
}

/**
 * 内容库取回的清单能不能当这一段用:`v`、`kind`、`resultKey`、`range` 都对得上;快照另查 `frames` 的形状、
 * 流另查 `streamAdoption` 要的那几样(`header.clipIds`、`header.originFrame`)。不认识的字段忽略(C6.2 第 3 节)。
 */
export function manifestMatches(body, ref) {
  if (!body || typeof body !== 'object' || body.v !== RESULT_VERSION) return false;
  if (body.kind !== ref?.kind || body.resultKey !== ref?.resultKey) return false;
  if (body.range?.from !== ref?.range?.from || body.range?.to !== ref?.range?.to) return false;
  if (body.kind === 'snapshot') {
    if (!Array.isArray(body.frames)) return false;
    // c10a 第 9 节:带 `small` 的,它的形状同 `frames`
    if (body.small !== undefined && !(Array.isArray(body.small) && body.small.every(item => Array.isArray(item) && Number.isInteger(item[0]) && KEY_RE.test(String(item[1]))))) return false;
    return body.frames.every(item => Array.isArray(item) && Number.isInteger(item[0]) && KEY_RE.test(String(item[1])));
  }
  if (body.kind === 'stream') {
    if (!body.header || !Array.isArray(body.header.clipIds) || !isStreamOrigin(body.header.originFrame)) return false;
    if (!body.segments || typeof body.segments !== 'object' || !body.inits || typeof body.inits !== 'object') return false;
    return true;
  }
  return false;
}

/** 清单里预渲染小尺寸那一张表(`[[localFrame, hash, bytes], …]`);没有或形状不对回空数组 */
export function smallFramesOf(result) {
  if (!Array.isArray(result?.small)) return [];
  return result.small.filter(item => Array.isArray(item) && Number.isInteger(item[0]) && KEY_RE.test(String(item[1])));
}

/* ======================================================================== *
 * c10a 第 9 节:给在线页面的层表(内容库 `snapshot-manifest` 类的一条,键 `layers:<项目 id>`)
 * ======================================================================== */

/** 层表在内容库里的键前缀。它和段清单同类(`snapshot-manifest`),键里带冒号前缀,不会和 `<resultKey>:<from>-<to>` 撞 */
export const LAYER_MAP_PREFIX = 'layers:';
/**
 * 层表的版本。v 2(C10 契约第 5 节、第 18 节第 3 条):每层加 `contentKey`(共享档的内容键,与环境无关)与
 * `envFingerprint`(产出这一层的环境的指纹)。在线页面只认 v 2 且两项齐的层;最低一档 v 1、v 2 都认(`src/render/snapshotSource.ts` 的 `usableLayer`)。
 * v 3(M7 契约 D12,第 13 节裁定):每层另带 `candidates: [{ envFingerprint, resultKey, key, dirKey }]` —— 切分方双份出键之后
 * 一层可能有两套键(切分方自己的、纯浏览器的),哪一份活着由页面按 `task.done` 与清单认定;层上的 v 2 字段等于第一个候选,
 * 读 v 2 的页面照旧能用(当作一个候选)。
 * 〔裁〕stale-layer:v 3 的层可另带 `inputSig`(生成这一层的片段输入的签名,`src/render/layerInputSig.mjs`)。不加版本号 ——
 * 旧页面不读这一项,照旧贴;新页面遇到没有这一项的层(旧节点写的)也照旧贴。
 * 轨道流(`docs/plan/browser-stream-task.md` 第五处):v 3 的层表可另带一张 `streams` 表(`layerStreamsOf`),每条流一行。同样不加版本号 ——
 * 旧页面只读 `layers`,不认识的字段忽略;没有流时不带这一项,层表与以前一字不差。
 */
export const LAYER_MAP_VERSION = 3;
export const layerMapKeyOf = projectId => (typeof projectId === 'string' && projectId ? LAYER_MAP_PREFIX + projectId : null);

/**
 * 一版 card plan 的层表:在线页面没有预渲染进程,算不出重卡的键(键里有渲染节点的环境指纹、快照代码的哈希),
 * 由渲染节点按它认下的这一版写出来(页面不算键,C10 契约第 5 节)。每项:
 *   `{ clipId, kind: 'html' | 'local', key(就绪索引线上的键), tier, resultKey(清单键的前半), dirKey, entryKey, firstFrame, count,
 *      contentKey(共享档的内容键), envFingerprint(产出这一层的环境) }`
 * 本层表是 `contentKey` 与 `envFingerprint` 唯一定形的地方(C10 契约第 18 节第 3 条)。取不到这两项的层照旧列出,
 * 在线页面按「没有预渲染结果」处理。
 * 段与推送、与队列细任务同一种切法:本地帧 0 起每 `span` 帧一段,最后一段到 `count - 1`,清单键
 * `<resultKey>:<from>-<to>`。只列在预渲染集合里、产快照的卡(`picked` 由调用方给)。
 *
 * v 3 的候选(M7 D12):`candidatesOf(control)` 回这张卡最近一次切分实际出键的指纹(按发布顺序,`splitCandidatesOf` 收集),
 * 共享档的候选 = 这些指纹,再补上这一层自己的指纹(没出现过的排在最后);层上的 v 2 字段取第一个候选。
 * 不给 `candidatesOf` 或它回空时只有自己一个候选,与 v 2 相同。本地档只有自己一个候选(纯浏览器不做本地档)。
 */
export function layerMapOf(entry, { picked = () => true, fingerprint = null, span = QUEUE_DEFAULTS.SNAPSHOT_SPAN, now = Date.now(), candidatesOf = null,
  streams = null, streamCandidatesOf = null, streamSegments = QUEUE_DEFAULTS.STREAM_SEGMENTS } = {}) {
  const project = entry?.project ?? {};
  const layers = [];
  for (const control of entry?.cardPlan ?? []) {
    if (!control?.clipId || !control.snapshotKey || !picked(control.clipId)) continue;
    const tier = control.tier || null;
    const kind = kindOfTier(tier);
    if (!kind) continue;
    const key = wireSnapshotKey(tier, entry.key, control.snapshotKey);
    if (!key) continue;
    let resultKey = control.snapshotKey;
    const fp = typeof (control.envFingerprint ?? fingerprint) === 'string' && (control.envFingerprint ?? fingerprint) ? (control.envFingerprint ?? fingerprint) : null;
    if (tier === 'local') {
      if (!fp) continue;
      resultKey = resultKeyOf(`${entry.key}/${control.contentKey ?? control.snapshotKey}`, fp);
    }
    const firstFrame = Number(control.sampling?.firstFrame);
    const count = Number(control.count);
    if (!Number.isInteger(firstFrame) || !Number.isInteger(count) || count < 1) continue;
    const contentKey = typeof control.contentKey === 'string' && control.contentKey ? control.contentKey : null;
    const own = fp ? { envFingerprint: fp, resultKey, key, dirKey: control.snapshotKey } : null;
    let candidates = own ? [own] : [];
    if (tier === 'shared' && contentKey && typeof candidatesOf === 'function') {
      let listed = [];
      try { listed = candidatesOf(control) ?? []; } catch { listed = []; }
      const fps = [...new Set([...(Array.isArray(listed) ? listed : []), ...(fp ? [fp] : [])].filter(x => typeof x === 'string' && x))];
      candidates = fps.map(f => {
        if (own && f === fp) return own;
        const rk = resultKeyOf(contentKey, f);
        return { envFingerprint: f, resultKey: rk, key: wireSnapshotKey('shared', entry.key, rk), dirKey: rk };
      });
    }
    const primary = candidates[0] ?? { envFingerprint: fp, resultKey, key, dirKey: control.snapshotKey };
    // 〔裁〕stale-layer:输入签名(`src/render/layerInputSig.mjs`)—— 生成这一层的那一版片段输入。页面按当前项目算同一个签名,
    // 对不上就是旧参数的层,不贴(C10 契约第 9 节)。算不出(片段不在这一版项目里)不写这一项,页面照旧贴
    const inputSig = clipInputSig(project, control.clipId);
    layers.push({ clipId: control.clipId, kind, key: primary.key, tier, resultKey: primary.resultKey, dirKey: primary.dirKey,
      entryKey: tier === 'local' ? entry.key : null, firstFrame, count, contentKey, envFingerprint: primary.envFingerprint, candidates,
      ...(inputSig ? { inputSig } : {}) });
  }
  const streamRows = layerStreamsOf(entry, { streams, fingerprint, candidatesOf: streamCandidatesOf, segmentsPerTask: streamSegments });
  return {
    v: LAYER_MAP_VERSION, kind: 'layer-map', projectId: project.id ?? null, entryKey: entry?.key ?? null,
    fps: Number(project.fps) || 30, width: Number(project.width) || null, height: Number(project.height) || null,
    span, at: now, layers,
    ...(streamRows.length ? { streams: streamRows } : {}),
  };
}

/** 层表里流候选在切分候选记录(`FramePipeline.recordSplitCandidates`)里的键前缀:流的内容键与卡的内容键分开记 */
export const STREAM_CANDIDATE_PREFIX = 'stream:';
export const streamCandidateKey = contentKey => (typeof contentKey === 'string' && contentKey ? STREAM_CANDIDATE_PREFIX + contentKey : null);

/**
 * 层表的 `streams` 表(`docs/plan/browser-stream-task.md` 第五处):这一版的每条轨道流一行,在线页面按它找流清单
 * (内容库 `render-manifest`,键 `<结果键>:<起>-<止>`,分段号从 0 起每 `segmentsPerTask` 段一份,最后一份到 `lastSegment`,
 * 与 `render-node/split.mjs`、推送队列同一种切法)。每行:
 *
 *   `{ topClipId, clipIds, kind: 'card' | 'group' | 'below', plane: 'local' | 'stage', contentKey,
 *      candidates: [{ envFingerprint, resultKey }], originFrame, lastSegment, segmentsPerTask, inputSig? }`
 *
 *   - `originFrame`:这条流自己的第一帧(项目帧号)。分段从它起每 15 帧一段(`src/render/streamSegments.mjs`),页面按它把播放头的
 *     帧号换成分段号。行里**不再写 `firstSegment`**(它恒为 0)〔裁〕:改分段规则之前的页面认 `firstSegment`、按项目帧号找分段,
 *     读到新的行会把画面贴错位;不写这一项,旧页面的解析就跳过这一行(当作这张卡没有流),新页面则只认带 `originFrame` 的行;
 *
 *   - 依赖下层的流(`kind: 'below'`,`docs/plan/prerender-products-contract.md` 第 5.2 节):`clipIds` 只有目标卡一张,`plane` 是 `stage`;
 *     算进键里的下层不列在这一行里 —— 页面按当前项目自己找下层算 `inputSig`(下层多了一层也认得出)。`planStreams` 的开关关着时
 *     没有这种流,这张表与原来逐字相同;读这张表的页面遇到不认识的 `kind` 跳过那一行;
 *
 *   - `streams` 是 `frame-stream.mjs` 的 `planStreams` 的结果(调用方算好给进来:要预算、代码版本、环境指纹,这里不引它)。
 *     两个片段共用一条流(同一张卡、同参数同入点)时 `planStreams` 回两项,这里也是两行,`topClipId` 不同、键相同;
 *   - `candidates` 照快照层的做法:`candidatesOf(spec)` 回这条流最近一次切分实际出键的指纹(按发布顺序,`splitStreamCandidatesOf` 收集),
 *     再补上这条流自己的指纹(`spec.envFingerprint`,没有就用 `fingerprint`;没出现过的排在最后)。结果键 = 内容键 × 指纹。
 *     流标了 `ownCandidate: false`(切分只给别的指纹出过键、本机自己不产,在线页面的清单计划给浏览器出的那一份就是)时不补自己的指纹,
 *     候选只有切分实际出键的那些。一个候选也凑不出(没有任何指纹)的流不列;
 *   - `inputSig`:这条流的输入签名(`src/render/streamInputSig.mjs`),页面按当前项目算同一个签名,对不上就不播。算不出不写。
 * 形状不对的项跳过,不抛。
 */
export function layerStreamsOf(entry, { streams = null, fingerprint = null, candidatesOf = null, segmentsPerTask = QUEUE_DEFAULTS.STREAM_SEGMENTS } = {}) {
  const project = entry?.project ?? {};
  const per = Math.max(1, Math.floor(Number(segmentsPerTask) || 0) || QUEUE_DEFAULTS.STREAM_SEGMENTS);
  const str = x => (typeof x === 'string' && x ? x : null);
  const out = [];
  for (const spec of Array.isArray(streams) ? streams : []) {
    const contentKey = str(spec?.contentKey);
    const clipIds = Array.isArray(spec?.clipIds) ? spec.clipIds.filter(id => typeof id === 'string' && id) : [];
    if (!contentKey || !clipIds.length || clipIds.length !== spec.clipIds.length) continue;
    const topClipId = str(spec.topClipId) ?? clipIds[clipIds.length - 1];
    const kind = spec.kind === 'group' ? 'group' : spec.kind === 'card' ? 'card' : spec.kind === 'below' ? 'below' : null;
    const plane = spec.plane === 'stage' ? 'stage' : spec.plane === 'local' ? 'local' : null;
    // 依赖下层的流只有目标卡一个成员、按舞台坐标;形状不对的不列
    if (kind === 'below' && (clipIds.length !== 1 || plane !== 'stage')) continue;
    const firstSegment = Number(spec.firstSegment), lastSegment = Number(spec.lastSegment), originFrame = spec.originFrame;
    // 分段从这条流自己的第一帧起数,`firstSegment` 恒为 0;不是这样的(改分段规则之前的计划)不列
    if (!kind || !plane || !isStreamOrigin(originFrame) || firstSegment !== 0 || !Number.isInteger(lastSegment) || lastSegment < 0) continue;
    // `ownCandidate: false`:切分给别的指纹出过键、本机自己不产的流(`FramePipeline.issuedStreamSpecs`),候选只列切分实际出键的指纹
    const own = spec.ownCandidate === false ? null : str(spec.envFingerprint) ?? str(fingerprint);
    let listed = [];
    if (typeof candidatesOf === 'function') {
      try { listed = candidatesOf(spec) ?? []; } catch { listed = []; }
    }
    const fps = [...new Set([...(Array.isArray(listed) ? listed : []), ...(own ? [own] : [])].filter(x => typeof x === 'string' && x))];
    if (!fps.length) continue;
    const candidates = fps.map(f => ({ envFingerprint: f, resultKey: resultKeyOf(contentKey, f) }));
    const inputSig = streamInputSig(project, { clipIds, kind });
    out.push({ topClipId, clipIds, kind, plane, contentKey, candidates, originFrame, lastSegment, segmentsPerTask: per, ...(inputSig ? { inputSig } : {}) });
  }
  return out;
}

/**
 * 一次切分最终发布成功的细任务 → 每张共享档卡实际出键的指纹(M7 D12,写层表 v 3 的候选用):
 * `Map<contentKey, envFingerprint[]>`,指纹按发布顺序(切分方自己的在前)。只收共享档快照、带内容键与指纹的任务。
 */
export function splitCandidatesOf(tasks) {
  const out = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.kind !== 'snapshot' || t.tier !== 'shared') continue;
    const ck = t.input?.contentKey;
    const fp = t.requires?.envFingerprint;
    if (typeof ck !== 'string' || !ck || typeof fp !== 'string' || !fp) continue;
    const list = out.get(ck) ?? [];
    if (!list.includes(fp)) list.push(fp);
    out.set(ck, list);
  }
  return out;
}

/**
 * 同 `splitCandidatesOf`,收的是轨道流任务(层表 `streams` 表的候选用):`Map<流的内容键, envFingerprint[]>`,指纹按发布顺序
 * (切分方自己的在前)。只看流任务通用的字段:`kind: 'stream'`、`input.contentKey`、`requires.envFingerprint`。
 */
export function splitStreamCandidatesOf(tasks) {
  const out = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.kind !== 'stream') continue;
    const ck = t.input?.contentKey;
    const fp = t.requires?.envFingerprint;
    if (typeof ck !== 'string' || !ck || typeof fp !== 'string' || !fp) continue;
    const list = out.get(ck) ?? [];
    if (!list.includes(fp)) list.push(fp);
    out.set(ck, list);
  }
  return out;
}

/** `[from, to]` 闭区间:first .. last 每 span 一段,最后一段到 last(与 `render-node/split.mjs` 的 `spans` 同一个式子) */
export function spansOf(first, last, span) {
  const out = [];
  const step = Math.max(1, Math.floor(Number(span) || 0));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return out;
  for (let from = first; from <= last; from += step) out.push([from, Math.min(last, from + step - 1)]);
  return out;
}

/** `canvasHeavy`:依次取 `opts.canvasHeavy`、`task.input.canvasHeavy`(是布尔值时),都没有就是 false(第 11 节第 2 条) */
function canvasHeavyOf(task, opts) {
  if (typeof opts?.canvasHeavy === 'boolean') return opts.canvasHeavy;
  if (typeof task?.input?.canvasHeavy === 'boolean') return task.input.canvasHeavy;
  return false;
}

/* ======================================================================== *
 * 推送端
 * ======================================================================== */

/** 按「哈希 → 文件」读块:给 `pushResult` 的 `readBlob` */
const blobReader = files => async hash => {
  const file = files.get(hash);
  if (!file) throw fail(`清单里没有块 ${hash}`);
  // 轨道流的块在列清单时已经读进内存(见 `collectStreamResult`):推的就是列清单那一刻的字节
  if (Buffer.isBuffer(file)) return file;
  return fs.readFile(file);
};

/**
 * 快照任务的清单(契约第 3 节 `SnapshotResult`):读 `index.json` 的 `frames` 与 `oversize`,
 * 再读对应帧文件算哈希。只列这一任务范围里已经落盘的帧(超体积的也在内),按帧升序。
 * 回 `{ result, readBlob }`(第 11 节第 1 条)。
 */
export async function collectSnapshotResult(pipeline, task, opts = {}) {
  if (task?.kind !== undefined && task.kind !== 'snapshot') throw fail(`不是快照任务:${task.kind}`, { retryable: false });
  // C6.4:推送队列的段自带落盘位置(`unit.dirKey` / `unit.entryKey`),经 `opts.location` 给进来,不再按 E.9 反算
  const loc = checkLocation(opts?.location, task?.tier) ?? snapshotLocation(task);
  if (!loc) throw fail(`认不出快照任务的落盘位置:${task?.resultKey}(本地档要 input.entryKey、input.contentKey、requires.envFingerprint)`, { code: 'unknown-location', retryable: false });
  const { from, to } = rangeOf(task);
  // c10a 第 9 节:这一批的预渲染小尺寸可能还在生成(`frame-pipeline.mjs` 的 `writeSmallSnapshots`),等它落定再列清单 ——
  // 两档一起推才算这一段做完。这里只是等,不渲染(没有在生成的就立刻往下走)
  try { await pipeline.whenSmallSettled?.(); } catch { /* 小尺寸失败不挡原尺寸 */ }
  const store = pipeline.snapshots();
  const target = { tier: loc.tier, entryKey: loc.entryKey, key: loc.dirKey };
  const index = await store.snapshotIndex(target);
  const dir = store.dir(target);
  const files = new Map();
  const frames = [];
  for (let f = from; f <= to; f++) {
    if (!rangeHas(index.frames, f) && !rangeHas(index.oversize, f)) continue;
    const file = path.join(dir, `${f}.html`);
    let buf;
    try { buf = await fs.readFile(file); } catch { continue; }
    const hash = sha256(buf);
    frames.push([f, hash, buf.length]);
    files.set(hash, file);
  }
  /*
   * c10a 第 9 节:预渲染小尺寸的哈希表(`<localFrame>.small.webp`,WebP),与原尺寸的 `frames` 分开记 ——
   * 小尺寸就绪不能当作原尺寸就绪。只列原尺寸也在这一段里的帧;一张都没有就不带这一项(清单与 C6.4 一字不差)。
   */
  const small = [];
  for (const [f] of frames) {
    const file = path.join(dir, `${f}${SMALL_SUFFIX}`);
    let buf;
    try { buf = await fs.readFile(file); } catch { continue; }
    if (!buf.length) continue;
    const hash = sha256(buf);
    small.push([f, hash, buf.length]);
    files.set(hash, file);
  }
  let result = {
    v: RESULT_VERSION, kind: 'snapshot', tier: loc.tier,
    resultKey: task.resultKey, dirKey: loc.dirKey, entryKey: loc.tier === 'local' ? loc.entryKey : null,
    range: { from, to },
    canvasHeavy: canvasHeavyOf(task, opts),
    frames,
    ...(small.length ? { small } : {}),
  };
  assertResultSize(result);
  // X7:这一段的 PNG 缓存帧。它只是给 legacy 整帧通道的附带件 —— 带上它会让清单超限时就不带,快照照常交付
  const pngs = await collectPngFrames(pipeline, loc, from, to, files);
  if (pngs.length) {
    const withPngs = { ...result, pngs };
    try { assertResultSize(withPngs); result = withPngs; } catch { /* 超限:不带 PNG */ }
  }
  return { result, readBlob: blobReader(files) };
}

/* ======================================================================== *
 * X7:快照段附带的 PNG 缓存帧
 * ======================================================================== */

const pad6 = n => String(n).padStart(6, '0');
/** 卡的 PNG 缓存键(`CardFrameCache.plan` 的 `key`,结果键,64 位十六进制) */
const PNG_KEY_RE = KEY_RE;

/**
 * 本机哪些卡的 PNG 缓存属于这个快照落盘位置:活着的 entry 里,`cacheable`(只有它们有 PNG 缓存)、档位相同、
 * 共享键是这个目录键(锁换过键的也认它自己的 `ownSnapshotKey`)的 control。回 `[{ key, cache, fps }]`,按键去重。
 * 同一张卡在工程里摆了几次时共用一份快照,但每个摆放各有一份 PNG(键里带位置画幅和 clipId),都列上。
 */
function pngSourcesFor(pipeline, loc) {
  const out = new Map();
  const entries = pipeline?.entries instanceof Map ? pipeline.entries.values() : [];
  for (const entry of entries) {
    if (!entry?.cardCache || !Array.isArray(entry.cardPlan)) continue;
    if (loc.tier === 'local' && entry.key !== loc.entryKey) continue;
    for (const control of entry.cardPlan) {
      if (!control?.cacheable || !PNG_KEY_RE.test(String(control.key))) continue;
      if ((control.tier || snapshotTier(control.capabilities)) !== loc.tier) continue;
      if (control.snapshotKey !== loc.dirKey && control.ownSnapshotKey !== loc.dirKey) continue;
      if (!out.has(control.key)) out.set(control.key, { key: control.key, cache: entry.cardCache, fps: Number(entry.project?.fps) || 30 });
    }
  }
  return [...out.values()];
}

/**
 * 清单的 `pngs`:`[{ key, fps, frames: [[localFrame, hash, bytes], …] }]`。只列本机 PNG 缓存里**有效**的帧
 * (`MovFrameStore.valid`:产出方的 capture 与卡键对得上、全透明帧已二次确认),按帧升序;字节是盘上的原样
 * (含 PNG 里的产出记录),哈希按原样算,文件记进 `files` 给 `readBlob`。读完再按字节里的记录核一遍 ——
 * 编辑器与预渲染进程共用这个目录,文件可能在 `valid` 之后被换过。
 */
async function collectPngFrames(pipeline, loc, from, to, files) {
  const out = [];
  for (const { key, cache, fps } of pngSourcesFor(pipeline, loc)) {
    let store, expected;
    try {
      store = await cache.store(key);
      expected = cache.expected(key);
      const wanted = [];
      for (let f = from; f <= to; f++) wanted.push(f);
      await store.hydrate(wanted);
    } catch { continue; }
    const frames = [];
    for (let f = from; f <= to; f++) {
      if (!store.valid(f, expected)) continue;
      const file = path.join(store.frameDir, `${pad6(f)}.png`);
      let buf;
      try { buf = await fs.readFile(file); } catch { continue; }
      const record = readRenderRecord(buf);
      if (!record?.signature || !signatureMatches(record.signature, expected)) continue;
      const hash = sha256(buf);
      frames.push([f, hash, buf.length]);
      files.set(hash, file);
    }
    if (frames.length) out.push({ key, fps, frames });
  }
  return out;
}

/** 流库目录的形状同 `frame-stream.mjs` 的 `StreamStore`:`<库根>/streams/<streamKey>/` */
const streamDir = (pipeline, key) => path.join(pipeline.root, 'streams', key);

/** 流库里某条流的清单:直接读盘上的 `stream.json`(生产者每写一个分段存一次) */
async function readStreamManifest(pipeline, key) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(streamDir(pipeline, key), 'stream.json'), 'utf8'));
    return manifest?.streamKey === key ? manifest : null;
  } catch { return null; }
}

/**
 * 轨道流任务的清单(契约第 3 节 `StreamResult`):读 `stream.json`,列这一任务范围里已产出的分段,
 * 以及它们用到的 init;每个块读文件算哈希。分段的 `encoder` 取它所用 init 的 `encoder`(第 11 节第 6 条)。
 * 回 `{ result, readBlob }`。`opts` 目前不用,留着和快照对称。
 */
export async function collectStreamResult(pipeline, task, opts = {}) {
  void opts;
  if (task?.kind !== undefined && task.kind !== 'stream') throw fail(`不是轨道流任务:${task.kind}`, { retryable: false });
  const key = task?.resultKey;
  if (!KEY_RE.test(String(key))) throw fail(`轨道流任务的 resultKey 不对:${key}`, { retryable: false });
  const { from, to } = rangeOf(task);
  const manifest = await readStreamManifest(pipeline, key);
  if (!manifest) throw fail(`本机没有这条流的清单:${key}`, { code: 'no-stream-manifest' });
  const dir = streamDir(pipeline, key);
  const files = new Map();
  const inits = {};
  const segments = {};
  /*
   * 块的字节留在内存里(只是这一任务范围里的几个分段与开头,读来算哈希本来就要读一遍),推的时候不再按路径重读:
   * 同一条流的稀疏版任务与满密度任务会同时在本机跑(结果键相同、目录相同),满密度那一趟换掉某一段时,旧的稀疏分段文件
   * 过 `REPLACED_DELETE_MS`(5 秒)就删(`frame-stream.mjs` 的 `storeSegment`)。稀疏任务列完清单、推得慢于 5 秒,
   * 按路径重读就 ENOENT(线上 2026-10-21:`push-failed:ENOENT …/4-<hash>.m4s`,推了 6/7)。推列清单时那份字节,
   * 素材服务按哈希收,清单与块一致,不受之后的替换影响。
   */
  const readHashed = async file => {
    const buf = await fs.readFile(file);
    const hash = sha256(buf);
    files.set(hash, buf);
    return { hash, bytes: buf.length };
  };
  for (let n = from; n <= to; n++) {
    const seg = manifest.segments?.[n];
    if (!seg?.file || !seg.init) continue;
    const initMeta = manifest.inits?.[seg.init];
    if (!initMeta) continue;
    let segBlob;
    try { segBlob = await readHashed(path.join(dir, seg.file)); } catch { continue; }
    if (!inits[seg.init]) {
      let initBlob;
      try { initBlob = await readHashed(path.join(dir, `init-${seg.init}.mp4`)); } catch { continue; }
      inits[seg.init] = { hash: initBlob.hash, bytes: initBlob.bytes, codec: initMeta.codec ?? null, width: initMeta.width ?? null, height: initMeta.height ?? null,
        timescale: initMeta.timescale ?? null, rect: initMeta.rect ?? null, encoder: initMeta.encoder ?? null };
    }
    // `box`:这个分段的位置矩形(平面坐标;产稀疏版时量的),清单里有才带
    segments[n] = { hash: segBlob.hash, bytes: segBlob.bytes, init: seg.init, stride: seg.stride, samples: seg.samples,
      sig: seg.sig ?? null, encoder: initMeta.encoder ?? null, ...(seg.box !== undefined ? { box: seg.box } : {}) };
  }
  // `lastFrame`:这条流自己的最后一帧(项目帧号),写清单时据它算整条流的最后一段、按桶写(`src/render/streamBuckets.mjs`)。
  // 取任务的 `input.stream.lastFrame`(切分方给浏览器那一份、导出位图带着),没有就取流库 `stream.json` 记的(生产者按流的计划写);
  // 都没有(旧节点落盘的流)不写,写清单时只好按任务的范围截桶
  const origin = isStreamOrigin(manifest.originFrame) ? manifest.originFrame : null;
  const span = task?.input?.stream;
  const taskLast = span && (span.originFrame === undefined || span.originFrame === origin) ? span.lastFrame : undefined;
  const lastFrame = [taskLast, manifest.lastFrame].find(v => Number.isInteger(v) && origin !== null && v >= origin) ?? null;
  const result = {
    v: RESULT_VERSION, kind: 'stream', resultKey: key, range: { from, to },
    // `originFrame`:这条流自己的第一帧(分段从它起数)。清单里没有这一项的(改分段规则之前落盘的)不写,那样的结果别处不收
    header: { kind: manifest.kind, plane: manifest.plane, clipIds: manifest.clipIds, fps: manifest.fps,
      ...(origin !== null ? { originFrame: origin } : {}), ...(lastFrame !== null ? { lastFrame } : {}), bound: manifest.bound,
      offset: manifest.offset ?? null, tight: manifest.tight ?? null },
    inits, segments,
  };
  assertResultSize(result);
  return { result, readBlob: blobReader(files) };
}

/** 清单里要推的块:`[{ ns, hash, ext }]`,去重 */
function resultBlocks(result) {
  const out = new Map();
  if (result?.kind === 'snapshot') {
    for (const [, hash] of result.frames ?? []) out.set(hash, { ns: SNAP_NS, hash, ext: 'html' });
    // c10a 第 9 节:预渲染小尺寸是像素产物,进 `px`
    for (const [, hash] of smallFramesOf(result)) if (!out.has(hash)) out.set(hash, { ns: PX_NS, hash, ext: 'webp' });
    // X7:附带的 PNG 缓存帧是像素产物,进 `px`
    for (const item of validPngs(result)) for (const [, hash] of item.frames) if (!out.has(hash)) out.set(hash, { ns: PX_NS, hash, ext: 'png' });
  } else if (result?.kind === 'stream') {
    for (const meta of Object.values(result.inits ?? {})) out.set(meta.hash, { ns: PX_NS, hash: meta.hash, ext: 'mp4' });
    for (const seg of Object.values(result.segments ?? {})) out.set(seg.hash, { ns: PX_NS, hash: seg.hash, ext: 'm4s' });
  } else throw fail(`不认识的清单 kind:${result?.kind}`, { retryable: false });
  for (const { hash } of out.values()) if (!KEY_RE.test(String(hash))) throw fail(`清单里的哈希不对:${hash}`, { retryable: false });
  return [...out.values()];
}

/**
 * 把清单里的每个块 `client.put` 一次(快照进 `snap`、流进 `px`;`put` 自己会跳过素材服务上已有的块)。
 * 全部成功才返回 `{ result, uploaded, skipped, bytes }`;任何一块失败就抛(第一处错误,带 `stats`:推到哪儿了)。
 * `onBlock({ blocks, pushed, bytes })`(可选,诊断):开推时报一次总块数,之后每推完一块报一次(`bytes` 是已推块的字节数)。
 */
export async function pushResult(client, result, readBlob, { onBlock } = {}) {
  if (!result || result.v !== RESULT_VERSION) throw fail('不认识的任务清单', { retryable: false });
  if (typeof readBlob !== 'function') throw fail('pushResult 需要 readBlob', { retryable: false });
  assertResultSize(result);
  const blocks = resultBlocks(result);
  let uploaded = 0, skipped = 0, bytesDone = 0;
  const tell = () => { try { onBlock?.({ blocks: blocks.length, pushed: uploaded + skipped, bytes: bytesDone }); } catch { /* 诊断回调出错不影响推送 */ } };
  tell();
  const settled = await settleLimited(blocks, TRANSFER_CONCURRENCY, async ({ ns, hash, ext }) => {
    const bytes = await readBlob(hash);
    if (!bytes || sha256(bytes) !== hash) throw fail(`块 ${hash} 的内容和清单对不上(本机文件在清单之后被改过)`);
    const put = await client.put(ns, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), { ext });
    if (put?.hash && put.hash !== hash) throw fail(`素材服务回的哈希 ${put.hash} 和清单里的 ${hash} 不同`);
    if (put?.uploaded) uploaded++; else skipped++;
    bytesDone += bytes.length;
    tell();
  });
  const failed = settled.find(item => item.status === 'rejected');
  if (failed) {
    const reason = failed.reason;
    const stats = { blocks: blocks.length, pushed: uploaded + skipped, failed: settled.filter(item => item.status === 'rejected').length, bytes: bytesDone };
    if (reason && typeof reason === 'object') { try { reason.stats = stats; } catch { /* 冻结的错误对象 */ } }
    throw reason;
  }
  return { result, uploaded, skipped, bytes: bytesDone };
}

/**
 * 这个流任务要不要满密度的分段:稀疏流任务(`input.density: 'sparse'`)每段有一版就算数(稀疏的、满密度的都行),
 * 别的流任务(满密度任务、没带密度的引用)要每段都是满密度。不是流回 false。
 */
export const wantsDenseStream = ref => ref?.kind === 'stream' && !isSparseStreamTask(ref);
const sparseSegment = seg => Number(seg?.stride) > 1;

/**
 * 写流清单前和内容库里已有的那一份合并(同一个键:结果键、范围相同),**不降级**:
 *   - 新清单里某一段是稀疏的、已有的那一段是满密度的:留已有的(稀疏流任务晚到、别的节点已经补过满密度);
 *   - 新清单里没有、已有的清单里有的分段:留着(边产边写的清单只列了本机已经产出的那几段);
 *   - 其余用新的。留下的分段连它的开头文件一起带过来;
 *   - 新的分段没带位置矩形(`box`,只在稀疏的一趟量)而已有的那一段带着:把它带过来(补成满密度以后位置矩形还在)。
 * 已有的清单对不上(不是流、键或范围不同、形状不对)就原样用新的。没有可留的时回 `next` 本身。
 */
export function mergeStreamResult(existing, next) {
  if (next?.kind !== 'stream' || !existing || typeof existing !== 'object' || existing.kind !== 'stream') return next;
  if (existing.v !== next.v || existing.resultKey !== next.resultKey) return next;
  if (existing.range?.from !== next.range?.from || existing.range?.to !== next.range?.to) return next;
  if (!existing.segments || typeof existing.segments !== 'object' || !existing.inits || typeof existing.inits !== 'object') return next;
  const segments = { ...(next.segments ?? {}) }, inits = { ...(next.inits ?? {}) };
  let kept = 0;
  for (const [n, old] of Object.entries(existing.segments)) {
    const init = old && typeof old === 'object' ? existing.inits[old.init] : null;
    if (!init || !KEY_RE.test(String(old.hash)) || !KEY_RE.test(String(init.hash))) continue;
    const cur = segments[n];
    if (cur && (!sparseSegment(cur) || sparseSegment(old))) {
      if (cur.box === undefined && old.box !== undefined) { segments[n] = { ...cur, box: old.box }; kept++; }
      continue;
    }
    segments[n] = old;
    if (!inits[old.init]) inits[old.init] = init;
    kept++;
  }
  return kept ? { ...next, inits, segments } : next;
}

/** 本机帧库是否覆盖了这一段(快照:`frames ∪ oversize` 盖住每一帧;流:每个分段和它的 init 都在清单里,满密度任务另要每段都是满密度) */
async function coversRange(pipeline, ref) {
  const { from, to } = rangeOf(ref);
  if (ref.kind === 'snapshot') {
    const loc = snapshotLocation(ref);
    if (!loc) return false;
    const index = await pipeline.snapshots().snapshotIndex({ tier: loc.tier, entryKey: loc.entryKey, key: loc.dirKey });
    for (let f = from; f <= to; f++) if (!rangeHas(index.frames, f) && !rangeHas(index.oversize, f)) return false;
    return true;
  }
  if (ref.kind === 'stream') {
    if (!KEY_RE.test(String(ref.resultKey))) return false;
    const manifest = await readStreamManifest(pipeline, ref.resultKey);
    if (!manifest) return false;
    const dense = wantsDenseStream(ref);
    for (let n = from; n <= to; n++) {
      const seg = manifest.segments?.[n];
      if (!seg?.file || !manifest.inits?.[seg.init]) return false;
      if (dense && sparseSegment(seg)) return false;
    }
    return true;
  }
  return false;
}

/**
 * c10a 第 9 节「任务完成的条件:两档都推送成功」:快照清单里列着的每一帧原尺寸都另有一张小尺寸。
 * 只在管线开着小尺寸时(`pipeline.smallTierEnabled()`:配了推送队列、没设 `PROMPTCUT_SMALL_TIER=0`)才要求;
 * 流没有小尺寸(第 1 节),恒为真。
 */
export function smallComplete(result) {
  if (result?.kind !== 'snapshot') return true;
  const have = new Set(smallFramesOf(result).map(([f]) => f));
  return (result.frames ?? []).every(([f]) => have.has(f));
}
const wantsSmall = (pipeline, ref) => ref?.kind === 'snapshot' && typeof pipeline?.smallTierEnabled === 'function' && pipeline.smallTierEnabled() === true;

/** 清单是不是把 `range` 里每一帧 / 每个分段都列上了;`dense`(满密度的流任务,`wantsDenseStream`)时另要每个分段都是满密度 */
function resultComplete(result, { dense = false } = {}) {
  const { from, to } = result.range;
  if (result.kind === 'snapshot') {
    const have = new Set(result.frames.map(([f]) => f));
    for (let f = from; f <= to; f++) if (!have.has(f)) return false;
    return true;
  }
  for (let n = from; n <= to; n++) {
    const seg = result.segments?.[n];
    if (!seg || !result.inits?.[seg.init]) return false;
    if (dense && sparseSegment(seg)) return false;
  }
  return true;
}

/** 清单里每个块在素材服务上是不是都在(逐个 `client.has`;任何一个不在、或者问不到,都算不在) */
export async function blocksPresent(client, result) {
  if (typeof client?.has !== 'function') return false;
  let blocks;
  try { blocks = resultBlocks(result); } catch { return false; }
  let present = 0;
  let missing = false;
  await settleLimited(blocks, TRANSFER_CONCURRENCY, async ({ ns, hash }) => {
    if (missing) return;
    let ok = false;
    try { ok = (await client.has(ns, hash)) === true; } catch { ok = false; }
    if (ok) present++; else missing = true;
  });
  return !missing && present === blocks.length;
}

/**
 * 诊断用:清单里的块在素材服务上的情况 `{ total, present, missing, errors, sample, error }`,逐个问完不提前停
 * (只在 `has` 回 false 的路上用,那条路接下来就是整段重渲,多问几次不算成本)。`sample` 是前两个缺块的哈希前缀,
 * `error` 是第一处问不到的原因。
 */
async function blocksStatus(client, result) {
  if (typeof client?.has !== 'function') return { total: null, present: 0, missing: null, errors: 0, sample: [], error: 'client-has-missing' };
  let blocks;
  try { blocks = resultBlocks(result); } catch (error) { return { total: null, present: 0, missing: null, errors: 0, sample: [], error: String(error?.message ?? error).slice(0, 120) }; }
  let present = 0, errors = 0, firstError = null;
  const sample = [];
  await settleLimited(blocks, TRANSFER_CONCURRENCY, async ({ ns, hash }) => {
    try {
      if ((await client.has(ns, hash)) === true) { present++; return; }
    } catch (error) {
      errors++;
      firstError ??= `${error?.code ?? error?.status ?? ''} ${String(error?.message ?? error)}`.trim().slice(0, 160);
    }
    if (sample.length < 2) sample.push(`${ns}/${hash.slice(0, 12)}`);
  });
  return { total: blocks.length, present, missing: blocks.length - present, errors, sample, error: firstError };
}

/** 诊断用:内容库取回的清单为什么当不了这一段用(`manifestMatches` 回 false 时):第一处对不上的字段 */
function manifestMismatch(body, ref) {
  if (!body || typeof body !== 'object') return 'no-body';
  if (body.v !== RESULT_VERSION) return `v:${body.v}`;
  if (body.kind !== ref?.kind) return `kind:${body.kind}`;
  if (body.resultKey !== ref?.resultKey) return `resultKey:${String(body.resultKey).slice(0, 16)}`;
  if (body.range?.from !== ref?.range?.from || body.range?.to !== ref?.range?.to) return `range:${body.range?.from}-${body.range?.to}`;
  return `shape:${body.kind}`;
}

/**
 * 流清单写进内容库之前先取已有的那一份合并(`mergeStreamResult`,不降级);内容库不能读、取不到、合并后超限都原样用新的。
 * 快照清单原样回。
 */
export async function mergedForWrite(content, result) {
  if (result?.kind !== 'stream' || typeof content?.get !== 'function') return result;
  const kind = manifestKindOf(result.kind), key = manifestKeyOf(result);
  if (!kind || !key) return result;
  let existing = null;
  try { existing = (await content.get(kind, key))?.body ?? null; } catch { return result; }
  const merged = mergeStreamResult(existing, result);
  if (merged === result) return result;
  try { assertResultSize(merged); } catch { return result; }
  return merged;
}

async function writeSingleManifest(content, result, log = () => {}) {
  const kind = manifestKindOf(result?.kind);
  const key = manifestKeyOf(result);
  if (!content || typeof content.put !== 'function' || !kind || !key) return false;
  result = await mergedForWrite(content, result);
  try {
    assertResultSize(result);
  } catch (error) {
    safeLog(log, 'manifest.too-large', { kind, key, bytes: error?.bytes ?? null });
    return false;
  }
  try {
    await content.put(kind, key, result);
    return true;
  } catch (error) {
    safeLog(log, 'manifest.put-failed', { kind, key, code: error?.code ?? null, reason: error?.reason ?? null, message: String(error?.message ?? error) });
    return false;
  }
}

/**
 * 把一段的清单写进内容库。写失败、清单超限只记日志,回 false(C6.4 第 3 节:内容库清单只是给以后复用的)。
 *
 * 轨道流另按「8 段一桶」写(`src/render/streamBuckets.mjs`,读的一侧只按桶找):桶的终点截到**整条流的最后一段**,
 * 由清单 `header` 的 `originFrame` / `lastFrame`(`collectStreamResult` 写的)换算;清单没带时退到 `task`(可选,
 * 这一段的任务)的 `input.stream`;都没有只好按任务的范围截。这样任务 `[0, 59]` 不是流的末尾时最后一个桶是 `56-63`,
 * 与任务 `[60, 124]` 写的同一个键,两边经 `mergedForWrite` 合在一份里。
 */
export async function writeManifest(content, result, log = () => {}, task = null) {
  const kind = manifestKindOf(result?.kind);
  if (!content || typeof content.put !== 'function' || !kind || !result) return false;
  let ok = await writeSingleManifest(content, result, log);
  if (result.kind !== 'stream') return ok;
  const { from, to } = result.range ?? {};
  const lastSegment = streamLastSegmentOf(result.header) ?? streamLastSegmentOf(task?.input?.stream);
  for (const bucket of streamBucketRanges(from, to, lastSegment)) {
    if (bucket.from === from && bucket.to === to) continue;
    if (!(await writeSingleManifest(content, streamBucketManifest(result, bucket), log))) ok = false;
  }
  return ok;
}

function safeLog(log, event, fields) {
  try { log?.(event, fields); } catch { /* 日志出错不影响推送 */ }
}

/**
 * D.1 的产物库(`sink`),素材服务实现(C6.2 契约第 4 节、第 11 节第 3、7 条;C6.4 `manifest-contract.md` 第 3 节)。
 *
 *   - `has(ref, { report }?)`:
 *       1. 本机帧库覆盖了整个 `range`:素材服务上也得齐才算有(语义「节点先把产物推送到素材服务,再向文档服务报完成」,
 *          `docs/archive/agent-reports/AGENT-sink-has.md`)。按本机帧库列清单,`pushResult` 逐块「先问 chunks、有了就跳过」,
 *          缺的块用本机字节补推(不重渲),推齐后把清单写进内容库、回 true;补推出错回 false(记 `sink.has-push-failed`),
 *          交给执行 → `put` 再推。`report` 同 `put` 的,补推时每处理完一块报一次(节点据此算进度);
 *          本机覆盖了原尺寸、开着小尺寸却缺小尺寸(按别的节点的清单拉来的帧 —— `applyResult` 不拉小尺寸):只认内容库里
 *          **两档都齐**、块都在素材服务上的清单(回 true、记下它);否则回 false,交给执行器从本机原尺寸补画小尺寸
 *          (`docs/archive/agent-reports/AGENT-xnode-dedup.md`);
 *       2. 给了 `content`:按 `<resultKey>:<from>-<to>` 查内容库里的清单。清单在、清单覆盖整段、清单里每个块
 *          在素材服务上都有(逐个 `client.has`),三条都满足 → true,并把清单记在 sink 里(`resultFor` 回它);
 *       3. 其它 → false。回 false 前记一行 `sink.has-miss { reason, covered, … }`(诊断,不改行为):`reason` 是
 *          `no-content` / `no-key` / `manifest-get-failed` / `manifest-missing` / `manifest-mismatch`(带 `field`)/
 *          `manifest-incomplete`(带 `listed`)/ `blocks-missing`(带 `total`、`present`、`missing`、`errors`、`sample`)/
 *          `local-small-missing`;本机覆盖而补推出错的仍记 `sink.has-push-failed`。
 *   - `resultFor(ref)`:`has` 回 true 之后拿清单(M5b 的 local-node 以去重方式完成时放进 `result`)。本机覆盖的由
 *     `collect*` 现算;查内容库得到的回记下的那份;都不是回 null。
 *   - `put({ ...ref, artifacts, meta })`:`artifacts` 本阶段忽略,字节以本机帧库为准。`collect*` 再
 *     `pushResult`,全部推完回 `{ complete: true, result }`;清单缺帧、有块推失败、清单超过 256 KiB,
 *     都回 `{ complete: false }`。推成功、给了 `content` 就再把清单写进内容库;写失败只记日志,不影响回包。
 *
 * `ref` 带着任务的 `input` 与 `requires`(M5b 的 local-node 原样传入)。本地档靠它们按 E.9 算落盘键;
 * 缺了就 `has` 回 false、`put` 回 `{ complete: false }`,不猜。`canvasHeavy` 取 `ref.input.canvasHeavy`。
 */
/** 素材服务回的「托管方渲染服务的产物到了容量上限」 */
export const SERVICE_QUOTA = 'service-quota';
/** 素材客户端对 5xx 重试用尽后抛的错:`status === 507` 且 `body.error === 'service-quota'` */
export const isServiceQuotaError = (error) => error?.status === 507 && error?.body?.error === SERVICE_QUOTA;

export function createAssetSink({ pipeline, client, content = null, log = () => {} }) {
  if (!pipeline) throw new Error('createAssetSink needs a pipeline');
  if (!client) throw new Error('createAssetSink needs an asset client');
  /** 查内容库得到的清单:清单键 → 清单 */
  const remembered = new Map();
  const collect = ref => (ref?.kind === 'snapshot' ? collectSnapshotResult(pipeline, ref) : collectStreamResult(pipeline, ref));
  // 导出专用的逐帧位图任务(`export-frames.mjs`;流任务的种类,`input.exportFrames` 为真)另走一套:它的帧不在流库里、清单是另一种形状
  const exportFrames = createExportFramesSink({ root: pipeline.root, client, content, log });
  /**
   * 查内容库里这一段的清单能不能直接当结果用:清单在、对得上、覆盖整段、(`requireSmall` 时)小尺寸也列全、块都在素材服务上。
   * 能用回 `{ ok: true, body }` 并记下(`resultFor` 回它);不能用回 `{ ok: false, reason, fields }`(`sink.has-miss` 的原因)。
   */
  async function lookup(ref, { requireSmall }) {
    if (!content || typeof content.get !== 'function') return { ok: false, reason: 'no-content', fields: {} };
    const kind = manifestKindOf(ref?.kind);
    const key = manifestKeyOf(ref);
    if (!kind || !key) return { ok: false, reason: 'no-key', fields: {} };
    const direct = await lookupKey(ref, kind, key, { requireSmall });
    if (direct.ok || ref?.kind !== 'stream') return direct;
    // 任务自己的键没有能用的:轨道流再按桶找(别的形状的任务 —— 整条流的稀疏流任务、另一种切法 —— 写过的桶),找不全照旧回上面的原因
    return (await lookupBuckets(ref, kind, key, { requireSmall })) ?? direct;
  }

  /** 内容库里键 `key` 这一份清单能不能当 `ref` 这一段的结果用(见 `lookup`) */
  async function lookupKey(ref, kind, key, { requireSmall }) {
    let item;
    try {
      item = await content.get(kind, key);
    } catch (error) {
      safeLog(log, 'manifest.get-failed', { kind, key, code: error?.code ?? null, message: String(error?.message ?? error) });
      return { ok: false, reason: 'manifest-get-failed', fields: { code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 160) } };
    }
    const body = item?.body;
    if (!item || body === undefined) return { ok: false, reason: 'manifest-missing', fields: {} };
    if (!manifestMatches(body, ref)) return { ok: false, reason: 'manifest-mismatch', fields: { field: manifestMismatch(body, ref) } };
    if (!resultComplete(body, { dense: wantsDenseStream(ref) })) {
      const listed = body.kind === 'snapshot' ? body.frames.length : Object.keys(body.segments ?? {}).length;
      return { ok: false, reason: 'manifest-incomplete', fields: { listed } };
    }
    if (requireSmall && !smallComplete(body)) return { ok: false, reason: 'no-small', fields: { small: smallFramesOf(body).length } };
    if (!(await blocksPresent(client, body))) {
      let status;
      try { status = await blocksStatus(client, body); } catch (error) { status = { error: String(error?.message ?? error).slice(0, 160) }; }
      return { ok: false, reason: 'blocks-missing', fields: status };
    }
    remembered.set(key, body);
    return { ok: true, body };
  }

  /**
   * 轨道流按「8 段一桶」找(`src/render/streamBuckets.mjs`,与 `writeManifest` 同一个规矩):每个桶取一份,只看落在任务范围里的分段,
   * 拼成这一段的清单;全齐(满密度任务另要都是满密度)、块都在素材服务上才算数。桶的终点截到整条流的最后一段 —— 取任务的
   * `input.stream`,没带就取已经取到的桶的 `header.lastFrame`;都不知道时只有越过任务末尾的那一个桶的终点拿不准,按可能的终点挨个试
   * (先试满 8 段的,再从任务末尾往后)。拼不出回 null。
   */
  async function lookupBuckets(ref, kind, key, { requireSmall }) {
    const { from, to } = ref.range ?? {};
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
    const step = STREAM_BUCKET_SEGMENTS;
    const dense = wantsDenseStream(ref);
    let lastSegment = streamLastSegmentOf(ref.input?.stream);
    const segments = {}, inits = {};
    let header = null;
    for (let b = Math.floor(from / step) * step; b <= to; b += step) {
      const full = b + step - 1;
      const ends = lastSegment !== null ? [Math.min(Math.max(lastSegment, to), full)]
        : full <= to ? [full]
        : [full, ...Array.from({ length: full - to }, (_, i) => to + i)];
      let body = null;
      for (const end of ends) {
        if (b === from && end === to) continue; // 就是任务自己的键,上面查过了
        let item;
        try { item = await content.get(kind, `${ref.resultKey}:${b}-${end}`); } catch { item = null; }
        if (item?.body !== undefined && manifestMatches(item.body, { kind: 'stream', resultKey: ref.resultKey, range: { from: b, to: end } })) { body = item.body; break; }
      }
      if (!body) return null;
      header ??= body.header;
      if (lastSegment === null) lastSegment = streamLastSegmentOf(body.header);
      for (let n = Math.max(from, b); n <= Math.min(to, full); n++) {
        const seg = body.segments[n];
        const init = seg ? body.inits[seg.init] : null;
        if (!seg || !init || (dense && sparseSegment(seg))) return null;
        segments[n] = seg;
        inits[seg.init] = init;
      }
    }
    const combined = { v: RESULT_VERSION, kind: 'stream', resultKey: ref.resultKey, range: { from, to }, header, inits, segments };
    if (!resultComplete(combined, { dense }) || (requireSmall && !smallComplete(combined))) return null;
    if (!(await blocksPresent(client, combined))) return null;
    remembered.set(key, combined);
    return { ok: true, body: combined };
  }
  return {
    async has(ref, { report } = {}) {
      if (isExportFramesTask(ref)) return exportFrames.has(ref);
      /** 回 false 前记一行 `sink.has-miss`(为什么没走去重;诊断,不改行为) */
      const miss = (reason, fields = {}) => {
        safeLog(log, 'sink.has-miss', { resultKey: String(ref?.resultKey ?? '').slice(0, 16), kind: ref?.kind ?? null, range: ref?.range ?? null, reason, ...fields });
        return false;
      };
      /*
       * c10a 第 9 节:开着小尺寸时,本机帧库覆盖了整段、而这一段还缺小尺寸,本机这份就不算已有。这时只认内容库里**两档都齐**、
       * 块都在素材服务上的清单(AGENT-xnode-dedup:别的节点产的一段,本机按清单只拉了原尺寸 —— `applyResult` 不拉小尺寸 ——
       * 重启后本机领到它时应走去重);清单缺小尺寸就交给执行器从本机原尺寸补画小尺寸再推(不重渲原尺寸)。不认缺小尺寸的清单:
       * 那多半是本机推送队列边渲边写的,原尺寸齐、小尺寸缺,认了它这一段就永远缺小尺寸。
       */
      let covered = false;
      try { covered = await coversRange(pipeline, ref); } catch { covered = false; /* 当本机没有 */ }
      if (covered) {
        let collected;
        try { collected = await collect(ref); } catch { collected = null; }
        if (collected && resultComplete(collected.result, { dense: wantsDenseStream(ref) }) && (!wantsSmall(pipeline, ref) || smallComplete(collected.result))) {
          // 本机有,素材服务上也得齐:推到一半丢了认领、又被自己重新认领时,这里补齐缺的块,不然别的成员按清单取不到
          const tell = (fields) => { try { report?.(fields); } catch { /* 诊断回调出错不影响推送 */ } };
          tell({ stage: 'has-push' });
          try {
            const pushed = await pushResult(client, collected.result, collected.readBlob, { onBlock: (p) => tell(p) });
            if (content) await writeManifest(content, collected.result, log, ref);
            if (pushed.uploaded > 0) {
              safeLog(log, 'sink.has-pushed', { resultKey: String(ref.resultKey ?? '').slice(0, 16), range: ref.range ?? null, uploaded: pushed.uploaded, skipped: pushed.skipped });
            }
            return true;
          } catch (error) {
            safeLog(log, 'sink.has-push-failed', { resultKey: String(ref.resultKey ?? '').slice(0, 16), range: ref.range ?? null,
              code: error?.code ?? error?.status ?? null, message: String(error?.message ?? error).slice(0, 200), ...(error?.stats ?? {}) });
            return false;
          }
        }
        // 本机覆盖了、清单却不全(缺小尺寸,c10a 第 9 节):内容库里两档齐的清单才认(见上),否则交给执行器补上再推
        if (collected && wantsSmall(pipeline, ref)) {
          const found = await lookup(ref, { requireSmall: true });
          if (found.ok) return true;
          if (found.reason === 'blocks-missing') return miss('blocks-missing', { covered: true, ...found.fields });
          return miss('local-small-missing', { covered: true, manifest: found.reason, ...found.fields });
        }
      }
      const found = await lookup(ref, { requireSmall: false });
      return found.ok ? true : miss(found.reason, { covered, ...found.fields });
    },
    async resultFor(ref) {
      if (isExportFramesTask(ref)) return exportFrames.resultFor(ref);
      try {
        if (await coversRange(pipeline, ref)) {
          const { result } = await collect(ref);
          if (resultComplete(result, { dense: wantsDenseStream(ref) }) && (!wantsSmall(pipeline, ref) || smallComplete(result))) return result;
          // 本机这份缺小尺寸:`has` 认的是内容库里两档齐的那份(记下了),回它
        }
      } catch { /* 退到记下的清单 */ }
      const key = manifestKeyOf(ref);
      return key && remembered.has(key) ? remembered.get(key) : null;
    },
    /**
     * 第二个参数(可选,诊断):`report({ stage, blocks, pushed, bytes })` —— `stage` 是 `collect`(列清单)/ `push`(推块);
     * 推块时每推完一块报一次。没收全时回包另带 `reason`(为什么)与 `stats`(`{ blocks, pushed, bytes, ms }`),
     * 并记一行 `sink.incomplete`;收全时回包带 `stats`。
     */
    async put(ref, { report } = {}) {
      if (isExportFramesTask(ref)) return exportFrames.put(ref, { report });
      const started = Date.now();
      const tell = (fields) => { try { report?.(fields); } catch { /* 诊断回调出错不影响推送 */ } };
      let progress = { blocks: null, pushed: 0, bytes: 0 };
      let stage = 'collect';
      const stats = () => ({ ...progress, ms: Date.now() - started });
      const incomplete = (reason, extra = {}) => {
        const out = { complete: false, reason, stats: stats() };
        safeLog(log, 'sink.incomplete', { resultKey: String(ref?.resultKey ?? '').slice(0, 16), range: ref?.range ?? null, reason, ...out.stats, ...extra });
        return out;
      };
      try {
        if (ref?.kind !== 'snapshot' && ref?.kind !== 'stream') return incomplete('bad-kind');
        tell({ stage: 'collect' });
        const collected = await collect(ref);
        if (!resultComplete(collected.result, { dense: wantsDenseStream(ref) })) {
          const listed = ref.kind === 'snapshot' ? collected.result.frames.length : Object.keys(collected.result.segments ?? {}).length;
          return incomplete('range-missing', { listed });
        }
        // c10a 第 9 节:两档都推送成功才算完成;缺小尺寸回 incomplete,节点按可重试失败交回,重做时补上
        if (wantsSmall(pipeline, ref) && !smallComplete(collected.result)) {
          safeLog(log, 'sink.small-incomplete', { resultKey: String(ref.resultKey ?? '').slice(0, 16), range: ref.range ?? null,
            frames: collected.result.frames.length, small: smallFramesOf(collected.result).length });
          return incomplete('small-missing', { frames: collected.result.frames.length, small: smallFramesOf(collected.result).length });
        }
        stage = 'push';
        tell({ stage });
        await pushResult(client, collected.result, collected.readBlob, {
          onBlock: (p) => { progress = p; tell(p); },
        });
        if (content) await writeManifest(content, collected.result, log, ref);
        return { complete: true, result: collected.result, stats: stats() };
      } catch (error) {
        // 素材服务说托管方渲染服务的产物到了容量上限(507 `service-quota`,`docs/plan/hosted-render-contract.md` 第 6 节):
        // 重试也没用,按不可重试的失败抛出去;节点据此暂停认领(`render-node/host.mjs`)
        if (isServiceQuotaError(error)) {
          safeLog(log, 'sink.service-quota', { resultKey: String(ref?.resultKey ?? '').slice(0, 16), range: ref?.range ?? null, ...stats() });
          throw Object.assign(new Error(SERVICE_QUOTA), { code: SERVICE_QUOTA, status: 507, retryable: false });
        }
        const code = error?.code ?? error?.status ?? null;
        return incomplete(`${stage}-failed${code !== null ? `:${String(code).slice(0, 40)}` : ''}`, { message: String(error?.message ?? error).slice(0, 200) });
      }
    },
  };
}

/* ======================================================================== *
 * 拉取端
 * ======================================================================== */

function checkSnapshotResult(result) {
  const bad = why => { throw fail(`快照清单不对:${why}`, { retryable: false }); };
  if (result.tier !== 'shared' && result.tier !== 'local') bad(`tier = ${result.tier}`);
  if (!safeKey(result.dirKey)) bad('dirKey');
  if (result.tier === 'local' && !safeKey(result.entryKey)) bad('本地档缺 entryKey');
  const { from, to } = result.range ?? {};
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) bad('range');
  if (!Array.isArray(result.frames)) bad('frames');
  for (const item of result.frames) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || item[0] < from || item[0] > to || !KEY_RE.test(String(item[1]))) bad(`帧 ${JSON.stringify(item)}`);
  }
}

/**
 * 按任务清单把一段产物拉进本机帧库并发布(契约第 5 节)。回 `{ written, skipped, fetched }`(第 11 节第 8 条):
 * 实际落盘的帧数 / 分段数、本机已有而跳过的、从素材服务下载的块数(init 也算)。
 *
 *   快照:本机 `index.json` 里已有的帧(`frames` 或 `oversize`)不下载;其余按哈希从 `snap` 拉,
 *         经 `commitSnapshots` 分批落盘(超体积由它自己判),最后 `pipeline.adoptResult` 发布。
 *         某块拉不到(404)或拉坏了:已经拉到的照常落盘、发布,然后整体抛错(不留半截文件)。
 *   流:   先问生产者缺哪些(`adoptionNeeds`),只从 `px` 拉这些块,交给 `adoptSegments` 落盘并发布;
 *         拉不到的块对应的分段不收,其余照收,然后整体抛错。管线上没有生产者(`streamProducer()` 回 null,
 *         即 `interactive: false` 或已关闭)就抛 `code: 'no-stream-producer'`。
 */
export async function applyResult(pipeline, client, result) {
  if (!result || typeof result !== 'object' || result.v !== RESULT_VERSION) throw fail('不认识的任务清单', { retryable: false });
  if (result.kind === 'snapshot') return applySnapshotResult(pipeline, client, result);
  if (result.kind === 'stream') return applyStreamResult(pipeline, client, result);
  throw fail(`不认识的清单 kind:${result.kind}`, { retryable: false });
}

async function fetchBlock(client, ns, hash) {
  const buf = await client.get(ns, hash);
  if (buf === null || buf === undefined) throw fail(`块 ${ns}/${hash} 不在素材服务上`, { code: 'blob-missing', status: 404 });
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (sha256(bytes) !== hash) throw fail(`块 ${ns}/${hash} 的内容和哈希对不上`, { code: 'blob-corrupt' });
  return bytes;
}

async function applySnapshotResult(pipeline, client, result) {
  checkSnapshotResult(result);
  const store = pipeline.snapshots();
  const entryKey = result.tier === 'local' ? result.entryKey : null;
  const target = { tier: result.tier, entryKey, key: result.dirKey };
  const index = await store.snapshotIndex(target);
  const seen = new Set();
  const want = [];
  for (const item of result.frames) {
    if (seen.has(item[0])) continue;
    seen.add(item[0]);
    if (rangeHas(index.frames, item[0]) || rangeHas(index.oversize, item[0])) continue;
    want.push(item);
  }
  const skipped = seen.size - want.length;
  const capabilities = { canvasHeavy: result.canvasHeavy === true };
  let written = 0, fetched = 0, failure = null;
  for (let i = 0; i < want.length && !failure; i += APPLY_BATCH) {
    const batch = want.slice(i, i + APPLY_BATCH);
    const settled = await settleLimited(batch, TRANSFER_CONCURRENCY, ([, hash]) => fetchBlock(client, SNAP_NS, hash));
    const items = [];
    settled.forEach((item, k) => {
      if (item.status === 'rejected') { failure ||= item.reason; return; }
      fetched++;
      const html = item.value.toString('utf8');
      // 快照按 UTF-8 文本落盘(`commitSnapshots` 的口径):解码再编码回不到原字节的块不收
      if (!Buffer.from(html, 'utf8').equals(item.value)) { failure ||= fail(`快照块 ${batch[k][1]} 不是合法的 UTF-8`, { code: 'blob-corrupt' }); return; }
      items.push({ localFrame: batch[k][0], html });
    });
    if (items.length) {
      // `adopted: true`:这批帧是从素材服务拉来的,C6.4 的推送钩子据此不再把它们进推送队列(快照库本身不看这个字段)
      await store.commitSnapshots({ ...target, clipId: null, capabilities, items, adopted: true });
      written += items.length;
    }
  }
  await pipeline.adoptResult(result);
  // X7:清单带着 PNG 缓存帧就一并取回。拉不到、对不上只记数,不让这一段快照的落地失败(PNG 只是 legacy 通道的料)
  const png = await applyPngFrames(pipeline, client, result);
  fetched += png.fetched;
  if (failure) throw failure;
  return png.listed ? { written, skipped, fetched, png } : { written, skipped, fetched };
}

/**
 * 清单 `pngs` 里形状对的那些(不对的项、不对的帧跳过,不让整段失败 —— 不认识 / 不合法的附带件照「忽略」处理):
 * 键是 64 位十六进制;帧号在 `range` 里、哈希是 64 位十六进制;同一个键的同一帧只留第一条。
 */
function validPngs(result) {
  if (!Array.isArray(result?.pngs)) return [];
  const { from, to } = result.range ?? {};
  const out = [];
  const keys = new Set();
  for (const item of result.pngs) {
    if (!item || typeof item !== 'object' || !PNG_KEY_RE.test(String(item.key)) || keys.has(item.key) || !Array.isArray(item.frames)) continue;
    keys.add(item.key);
    const seen = new Set();
    const frames = [];
    for (const frame of item.frames) {
      if (!Array.isArray(frame) || !Number.isInteger(frame[0]) || frame[0] < from || frame[0] > to || !KEY_RE.test(String(frame[1])) || seen.has(frame[0])) continue;
      seen.add(frame[0]);
      frames.push(frame);
    }
    const fps = Number(item.fps);
    if (frames.length) out.push({ key: item.key, fps: Number.isFinite(fps) && fps > 0 ? fps : 30, frames });
  }
  return out;
}

/**
 * 本机写这个键的 PNG 缓存用哪个 `MovFrameStore`:有 entry 的 card plan 用到这个键,就用那个 entry 的
 * `CardFrameCache.store(key)`(和 legacy 通道、`renderState` 同一个实例);没有就在同一个目录上另开一个
 * (`controls/<key>/`,同 `CardFrameCache.store`)—— 这个目录本来就由几个进程共用,`MovFrameStore` 每次查都读盘。
 * `expected` 是本机查这个键时认的产出记录:本机的 capture 加卡键。
 */
async function pngTargetFor(pipeline, key, fps) {
  const entries = pipeline?.entries instanceof Map ? pipeline.entries.values() : [];
  for (const entry of entries) {
    if (!entry?.cardCache || !Array.isArray(entry.cardPlan)) continue;
    if (!entry.cardPlan.some(control => control?.key === key)) continue;
    return { store: await entry.cardCache.store(key), expected: entry.cardCache.expected(key) };
  }
  const store = new MovFrameStore({ dir: path.join(pipeline.root, 'controls', key), fps });
  await store.ready;
  const capture = typeof pipeline?.captureCode === 'function' ? pipeline.captureCode() || undefined : undefined;
  return { store, expected: { capture, cards: key } };
}

/**
 * X7 的拉取:清单里每个 PNG 键、每一帧 ——
 *   1. 本机这一帧已经有效(`valid`,按本机的 capture 与卡键)就跳过,不下载;
 *   2. 否则从 `px` 拉,校验 sha256;
 *   3. 字节里的产出记录要是 PNG 自带的、而且对得上本机认的记录(同一份抓帧代码、同一个卡键),对不上的不收
 *      (本机查的时候也会当它不存在,收了只会被逐出);
 *   4. 经 `MovFrameStore.put` 原样落盘,带上对方记下的渲染遍数(全透明帧已由对方二次确认的,本机不再算待确认)。
 * 回 `{ listed, written, skipped, fetched, mismatched, failed }`(帧数;`fetched` 是下载的块数)。
 */
async function applyPngFrames(pipeline, client, result) {
  const stats = { listed: 0, written: 0, skipped: 0, fetched: 0, mismatched: 0, failed: 0 };
  for (const { key, fps, frames } of validPngs(result)) {
    stats.listed += frames.length;
    let target;
    try { target = await pngTargetFor(pipeline, key, fps); } catch { stats.failed += frames.length; continue; }
    const { store, expected } = target;
    try { await store.hydrate(frames.map(([f]) => f)); } catch { /* 当本机没有 */ }
    const want = frames.filter(([f]) => {
      if (store.valid(f, expected)) { stats.skipped++; return false; }
      return true;
    });
    const settled = await settleLimited(want, TRANSFER_CONCURRENCY, ([, hash]) => fetchBlock(client, PX_NS, hash));
    for (let i = 0; i < want.length; i++) {
      const item = settled[i];
      if (item.status === 'rejected') { stats.failed++; continue; }
      stats.fetched++;
      const bytes = item.value;
      const record = readRenderRecord(bytes);
      if (!record?.signature || record.signature.cards !== key || !signatureMatches(record.signature, expected)) { stats.mismatched++; continue; }
      try {
        await store.put(want[i][0], bytes, record.signature, { renders: Number(record.renders) || 1 });
        stats.written++;
      } catch { stats.failed++; }
    }
  }
  return stats;
}

async function applyStreamResult(pipeline, client, result) {
  const producer = typeof pipeline?.streamProducer === 'function' ? pipeline.streamProducer() : null;
  if (!producer) throw fail('这个预渲染实例没有轨道流生产者(interactive: false 或已关闭),收不了流清单', { code: 'no-stream-producer', retryable: false });
  const needs = await producer.adoptionNeeds(result);
  const wanted = new Set(needs.segments);
  const settled = await settleLimited(needs.hashes, TRANSFER_CONCURRENCY, hash => fetchBlock(client, PX_NS, hash));
  const blobs = new Map();
  let fetched = 0, failure = null;
  settled.forEach((item, i) => {
    if (item.status === 'rejected') { failure ||= item.reason; return; }
    fetched++;
    blobs.set(needs.hashes[i], item.value);
  });
  // 只把本机缺、而且字节齐了的分段交给 adoptSegments(它见到缺块会整个不写)
  const segments = {};
  let total = 0;
  for (const [n, seg] of Object.entries(result.segments ?? {})) {
    total++;
    if (!wanted.has(Number(n)) || !blobs.has(seg.hash)) continue;
    const initHash = result.inits?.[seg.init]?.hash;
    if (initHash && needs.hashes.includes(initHash) && !blobs.has(initHash)) continue;
    segments[n] = seg;
  }
  const adopted = Object.keys(segments).length
    ? await producer.adoptSegments({ ...result, segments }, blobs)
    : { written: 0, skipped: 0 };
  if (failure) throw failure;
  return { written: adopted.written, skipped: adopted.skipped + (total - wanted.size), fetched };
}
