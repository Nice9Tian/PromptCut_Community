/**
 * 仅供测试与进程内集成，生产代码不得引用。
 *
 * 内存产物库（契约 `docs/plan/render-queue-contract.md` D.1 的 `sink`、D.3）。M5 起由素材服务实现，
 * 语义见 `mechanism/asset-service.md`「先推送、确认收全，再报完成」与设计 4.4「开工前先问素材服务这一段是不是已经有了」。
 *
 *   sink.has({ resultKey, kind, tier, range })                         → Promise<boolean>
 *   sink.put({ resultKey, kind, tier, range, artifacts, meta })        → Promise<{ complete: boolean }>
 *
 * 一段 = 一个结果键的一个范围（`resultKey` + `range.from`～`range.to`）。按内容寻址：同一段再推一次不覆盖
 * 第一次收全的那份，只记进推送历史。
 *
 * 测试用的附加接口：
 *   entries()           收全了的段：[{ resultKey, kind, tier, range, artifacts, meta }]，按收全的先后
 *   seed({ resultKey, range, kind?, tier? })   预置一段为已收全（meta 为 null）
 *   failNextPut(n)      接下来 n 次 put 回 { complete: false }，不存
 *   putCount(resultKey) 对这个结果键调过几次 put（含没收全的）
 *   puts()              全部 put 的记录：[{ resultKey, range, meta, complete }]
 *   hasCalls()          全部 has 的记录：[{ resultKey, range, answer }]
 *   misuse()            参数不合 D.1 的调用（缺 resultKey / range、meta 缺字段）：测试断言为空
 *   holds(resultKey, range)   这个范围里每个单位都收到过（同步）
 *   stores(resultKey, range)  这一项（结果键 + 范围）存着没有（同步；轨道流另按「8 段一桶」存，规矩同 `writeManifest`，
 *                             桶的终点截到任务 `input.stream` 换算的整条流的最后一段，`src/render/streamBuckets.mjs`）
 *
 * `has` 按单位答：任务范围里每个分段（快照的每帧）都收到过（满密度任务另要满密度的那一版）才算有，同 `createAssetSink` 的查找。
 *
 * 所有方法都立即落定（回的是已兑现的 Promise），不依赖任何计时器。
 */

import { streamBucketRanges, streamLastSegmentOf } from '../../src/render/streamBuckets.mjs';

const segmentKey = (resultKey, range) => `${resultKey}#${range.from}-${range.to}`;

const clone = value => (value === undefined ? undefined : structuredClone(value));
/** 这次调用是不是稀疏流任务的(task-runner 给的 ref 带任务的 `input`) */
const sparseRef = args => args?.kind === 'stream' && args?.input?.density === 'sparse';

function badArgs(what, args) {
  if (!args || typeof args !== 'object') return `${what}：参数不是对象`;
  if (typeof args.resultKey !== 'string' || args.resultKey === '') return `${what}：resultKey 必须是非空字符串`;
  const r = args.range;
  if (!r || typeof r !== 'object' || !Number.isInteger(r.from) || !Number.isInteger(r.to)) return `${what}：range 必须带整数 from / to`;
  return null;
}

export function createArtifactSink() {
  /** segmentKey → 收全了的一段(轨道流另按「8 段一桶」各存一项,同 `writeManifest`) */
  const stored = new Map();
  /**
   * 每个结果键的每个单位(流的分段、快照的帧)收到的是哪一版:`<resultKey>#<n>` → 'dense' | 'sparse'。
   * `has` 按它答(同 `createAssetSink` 的查找:只看任务范围里的分段,不看桶里别的任务的那几段齐没齐)
   */
  const covered = new Map();
  const putLog = [];
  const hasLog = [];
  const misuse = [];
  let failing = 0;

  const cover = (resultKey, range, sparse) => {
    for (let n = range.from; n <= range.to; n++) {
      const k = `${resultKey}#${n}`;
      if (!sparse || !covered.has(k)) covered.set(k, sparse ? 'sparse' : 'dense');
    }
  };
  const coversAll = (resultKey, range, sparseOk) => {
    for (let n = range.from; n <= range.to; n++) {
      const got = covered.get(`${resultKey}#${n}`);
      if (!got || (!sparseOk && got === 'sparse')) return false;
    }
    return true;
  };

  function has(args) {
    const bad = badArgs('has', args);
    if (bad) {
      misuse.push(bad);
      return Promise.reject(new TypeError(bad));
    }
    const answer = coversAll(args.resultKey, args.range, sparseRef(args));
    hasLog.push({ resultKey: args.resultKey, range: clone(args.range), answer });
    return Promise.resolve(answer);
  }

  function put(args) {
    const bad = badArgs('put', args);
    if (bad) {
      misuse.push(bad);
      return Promise.reject(new TypeError(bad));
    }
    const { resultKey, kind, tier, range, artifacts, meta } = args;
    // D.1：meta = { taskId, nodeId, token }，供记账（设计第 7 节「节点信任」）
    if (!meta || typeof meta.taskId !== 'string' || typeof meta.nodeId !== 'string' || !Number.isInteger(meta.token)) {
      misuse.push(`put：meta 必须是 { taskId: string, nodeId: string, token: int }，实际 ${JSON.stringify(meta)}`);
    }
    let complete = true;
    if (failing > 0) {
      failing -= 1;
      complete = false;
    }
    putLog.push({ resultKey, range: clone(range), meta: clone(meta), complete });
    const sparse = sparseRef(args);
    if (complete) {
      cover(resultKey, range, sparse);
      // 轨道流:任务自己的范围,再加「8 段一桶」里与它不同的每个桶(桶的终点截到任务 `input.stream` 换算的整条流的最后一段)
      const ranges = [{ from: range.from, to: range.to }];
      if (kind === 'stream') {
        const lastSegment = streamLastSegmentOf(args.input?.stream);
        for (const b of streamBucketRanges(range.from, range.to, lastSegment)) if (b.from !== range.from || b.to !== range.to) ranges.push(b);
      }
      for (const r of ranges) {
        const key = segmentKey(resultKey, r);
        if (!stored.has(key) || (stored.get(key).sparse === true && !sparse)) {
          stored.set(key, { resultKey, kind, tier, range: clone(r), artifacts: clone(artifacts), meta: clone(meta), ...(sparse ? { sparse: true } : {}) });
        }
      }
    }
    return Promise.resolve({ complete });
  }

  return {
    has,
    put,
    entries: () => [...stored.values()].map(entry => clone(entry)),
    seed({ resultKey, range, kind = null, tier = null }) {
      const bad = badArgs('seed', { resultKey, range });
      if (bad) throw new TypeError(bad);
      const key = segmentKey(resultKey, range);
      if (!stored.has(key)) stored.set(key, { resultKey, kind, tier, range: clone(range), artifacts: null, meta: null });
      cover(resultKey, range, false);
    },
    failNextPut(n = 1) {
      if (!Number.isInteger(n) || n < 0) throw new TypeError('failNextPut：n 必须是非负整数');
      failing += n;
    },
    putCount: resultKey => putLog.filter(p => p.resultKey === resultKey).length,
    puts: () => putLog.map(p => clone(p)),
    hasCalls: () => hasLog.map(h => clone(h)),
    misuse: () => misuse.slice(),
    /** 这一段收全了没有（同步，给断言用）:这个范围里每个单位都收到过 */
    holds: (resultKey, range) => coversAll(resultKey, range, true),
    /** 内容库里这一项(结果键 + 范围,含按桶写的)有没有(同步,给断言用) */
    stores: (resultKey, range) => stored.has(segmentKey(resultKey, range)),
  };
}
