/**
 * M8 探针的公共件：纯逻辑部分（不起进程、不连网络，只用 Node 内置模块）。计划 `docs/plan/m8-plan.md` 第 2 节开头、第 4 节第 1 项。
 * 起停进程在 `procs.mjs`，连文档服务的角色（旁观节点、假节点、假发布方）在 `conn.mjs`，协调口 KV 在 `kv.mjs`，
 * 阿里云资源采样在 `resources.mjs`；本文件被它们共用，单测在 `server/test/m8-kit.test.mjs`。
 *
 * 这里有：
 *   - 角色与本轮 id 的约定（`newRunId`、`ROLES`）；
 *   - 两种部署（放云端 / 放本机）与本机替身的连接参数（`placeParams`、`docTargetOf`、`healthzUrlOf`）；
 *   - 端口护栏（`checkPorts`：不碰用户常驻与 dev-test 的端口）；
 *   - 通用判据：J-全完 `judgeAllDone`、J-恰一 `judgeExactlyOnce`（按 epoch 计，计划第 7 节 D3）、
 *     J-纯层 `judgePureLayers`、产物逐字节相同 `judgeIdenticalBytes`、各节点都干了活 `judgeEachWorked`、
 *     接手用时 `takeoverMs`（旁观节点时间线）；
 *   - 结果 JSON 的统一形状（`createResult`、`mergeRoleResults`、`lastJsonLine`）。
 *
 * 结果行的形状（每个探针 stdout 的最后一行，一行 JSON）：
 *   { probe, role, run, place, case?, ok, checks: [{ name, ok, detail? }], fails: [string], counts: {…}, ms, …各探针自己的字段 }
 *   `ok` = 没有 fails 且至少一条 check。`--role all` 汇总时各角色的结果放在 `roles.<角色>`，checks 名前加 `<角色>:`。
 *   口令、令牌一律不进结果行。
 */
import '../../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { createHash, randomBytes } from 'node:crypto';

/* ================================================================== 角色与本轮 id */

/** M8 探针里用到的角色名（各探针可以只用一部分） */
export const ROLES = Object.freeze({
  CREATOR: 'creator',   // 建项目、发布、汇总；通常是 PC
  HOST: 'host',         // 独立渲染主机（`cloud/scripts/render-host.mjs`）
  NODE: 'node',         // 假节点（按 `render-queue-e2e.mjs` 的写法），或桌面编辑器队列节点
  WATCHER: 'watcher',   // 旁观节点：只收不认领，记每个任务的认领、放回、关闭
  MEMBER: 'member',     // 第二成员（页面或只读连接）
  ALL: 'all',           // 本机替身：同一台机器上各起一个子进程跑全部角色
});

/** 本轮 id：时间（36 进制）+ 4 位随机十六进制，形如 `mfx3k2a1b2c`；够短，拼进 KV 键不超长 */
export const newRunId = (now = Date.now()) => `${now.toString(36)}${randomBytes(2).toString('hex')}`;

/** 随机口令（探针自建项目用；只进 KV 与配置文件，不打印） */
export const newSecret = (bytes = 12) => randomBytes(bytes).toString('base64url');

/** 设备 id：16～64 个 [A-Za-z0-9_-]（`shared-config.mjs` 的要求） */
export const deviceIdOf = (tag, run) => `m8-${tag}-${run}`.replace(/[^A-Za-z0-9_-]/g, '-').padEnd(16, '0').slice(0, 64);

/** 16 位小写十六进制的测试指纹（`PROMPTCUT_TEST_ENV_FINGERPRINT` 的格式，C10 集成分支 `server/frame-pipeline.mjs`） */
export const FINGERPRINT_RE = /^[0-9a-f]{16}$/;
export const fingerprintOf = (seed) => createHash('sha256').update(String(seed)).digest('hex').slice(0, 16);

/* ================================================================== 部署参数 */

/** 阿里云的缺省地址（`m8-plan.md` 第 1.2 节）。放云端时不给 --hosted / --coord 就用它们 */
export const CLOUD = Object.freeze({
  hosted: 'https://203-0-113-16.sslip.io/hosted',
  coord: 'https://203-0-113-16.sslip.io/coord',
  media: 'https://203-0-113-16.sslip.io/media',
  /** 明文的文档服务端口：代理不解 TLS，经代理连云端时转到这里 */
  docPlain: '203.0.113.16:8787',
  assetPlain: '203.0.113.16:8788',
});

/** 局域网主机的文档服务路径（`server/auth/route.mjs` 的 LAN_DOC_PATH） */
export const LAN_DOC_PATH = '/docservice';

const trimSlash = (s) => String(s).replace(/\/+$/, '');

/**
 * 某种放法的连接参数。
 * @param {'cloud' | 'lan' | 'local'} place
 *   - cloud：项目在阿里云主实例；`hosted`、`coord` 缺省取 CLOUD；
 *   - lan：项目在 PC 的局域网主机编辑器上（`PROMPTCUT_LAN_HOST=1`）；必给 `lanHost`（`<ip>:<端口>`）与 `coord`；
 *     `cloudHealthz` 是托管端 `/healthz`（前后总连接数只记录；「全程不连阿里云」按本轮查，见 `judgeCloudUntouched`）；
 *   - local：本机替身（本机临时托管组合）；必给 `hosted`（http://127.0.0.1:<端口>）与 `coord`。
 * @param {{ hosted?: string, coord?: string, lanHost?: string, docPlain?: string, media?: string }} [o]
 * @returns {{ place, hosted: string, ws: string, healthz: string, coord: string, docPlain: string | null, media: string | null, cloudHealthz: string | null }}
 *   `hosted` 是文档服务的 http(s) 基址，`ws` 是 ws(s) 基址（共享项目配置的 `url`），`docPlain` 是代理能转的明文 host:port
 */
export function placeParams(place, o = {}) {
  if (place === 'cloud') {
    const hosted = trimSlash(o.hosted ?? CLOUD.hosted);
    return {
      place, hosted, ws: wsOf(hosted), healthz: `${hosted}/healthz`, coord: trimSlash(o.coord ?? CLOUD.coord),
      docPlain: o.docPlain ?? (isTls(hosted) ? CLOUD.docPlain : hostPortOf(hosted)), media: o.media ?? CLOUD.media, cloudHealthz: null,
    };
  }
  if (place === 'lan') {
    if (!o.lanHost) throw new TypeError('放本机要给 lanHost（PC 局域网主机编辑器的 <ip>:<端口>）');
    if (!o.coord) throw new TypeError('放本机要给 coord（协调口基址；全程不连阿里云时用 PC 局域网上的协调口）');
    const base = `http://${String(o.lanHost).replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '')}`;
    return {
      place, hosted: `${base}${LAN_DOC_PATH}`, ws: `${wsOf(base)}${LAN_DOC_PATH}`, healthz: `${base}/api/docservice/healthz`,
      coord: trimSlash(o.coord), docPlain: hostPortOf(base), media: o.media ?? null, cloudHealthz: `${trimSlash(o.hosted ?? CLOUD.hosted)}/healthz`,
    };
  }
  if (place === 'local') {
    if (!o.hosted || !o.coord) throw new TypeError('本机替身要给 hosted 与 coord');
    const hosted = trimSlash(o.hosted);
    return { place, hosted, ws: wsOf(hosted), healthz: `${hosted}/healthz`, coord: trimSlash(o.coord), docPlain: o.docPlain ?? hostPortOf(hosted), media: o.media ?? null, cloudHealthz: null };
  }
  throw new TypeError(`place 只能是 cloud / lan / local，收到 ${place}`);
}

const isTls = (url) => /^(https|wss):/i.test(String(url));
/** http(s) / ws(s) 基址 → ws(s) 基址 */
export const wsOf = (url) => trimSlash(url).replace(/^http/i, 'ws');
/** ws(s) / http(s) 基址 → http(s) 基址 */
export const httpOf = (url) => trimSlash(url).replace(/^ws/i, 'http');
/** 文档服务基址 → `/healthz`（局域网主机编辑器是 `/api/docservice/healthz`，见 placeParams） */
export const healthzUrlOf = (base) => `${httpOf(base)}/healthz`;

/** 明文 URL → `host:port`（缺省端口按协议补）；TLS 地址回 null（代理不解 TLS，要显式给明文端口） */
export function hostPortOf(url) {
  const u = new URL(String(url));
  if (u.protocol === 'https:' || u.protocol === 'wss:') return null;
  return `${u.hostname}:${u.port || 80}`;
}

/**
 * 代理要转到哪里：显式给的 `target` 优先；否则从明文基址推；TLS 基址又没给就抛错。
 * @returns {{ host: string, port: number, text: string }}
 */
export function docTargetOf(base, target = null) {
  const text = target ?? hostPortOf(base);
  if (!text) throw new TypeError(`${base} 是 TLS 地址：要给明文文档服务的 host:port（如 ${CLOUD.docPlain}），代理不解 TLS`);
  const i = text.lastIndexOf(':');
  const port = Number(text.slice(i + 1));
  if (i <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) throw new TypeError(`代理目标不是 host:port：${text}`);
  return { host: text.slice(0, i).replace(/^\[|\]$/g, ''), port, text };
}

/* ================================================================== 端口护栏 */

/** 不许探针占的端口：5190～5192（用户常驻编辑器及舞台）、5203～5205（dev-test） */
export const FORBIDDEN_PORTS = Object.freeze([5190, 5191, 5192, 5203, 5204, 5205]);

/**
 * 编辑器 / 渲染主机占「端口、+1、+2」三个号；核对都不在禁区、（给了 band 时）都在分配的段里。不过就抛错。
 * @param {number[]} ports 各实例的起点端口（代理、协调口这种单端口的用 `{ single: true }` 另核）
 * @param {{ band?: [number, number], triple?: boolean }} [o]
 */
export function checkPorts(ports, { band = null, triple = true } = {}) {
  const all = [];
  for (const p of ports) {
    if (p === 0) continue; // 端口 0：系统给号，不会落进禁区
    if (!Number.isInteger(p) || p < 1 || p > 65533) throw new RangeError(`端口不对：${p}`);
    for (const q of triple ? [p, p + 1, p + 2] : [p]) all.push(q);
  }
  const bad = all.filter((q) => FORBIDDEN_PORTS.includes(q));
  if (bad.length) throw new RangeError(`端口 ${bad.join('、')} 是用户常驻编辑器或 dev-test 的，探针不许用`);
  if (band) {
    const out = all.filter((q) => q < band[0] || q > band[1]);
    if (out.length) throw new RangeError(`端口 ${out.join('、')} 不在分配的段 ${band[0]}～${band[1]} 里`);
  }
  const dup = all.filter((q, i) => all.indexOf(q) !== i);
  if (dup.length) throw new RangeError(`端口重叠：${[...new Set(dup)].join('、')}`);
  return all;
}

/* ================================================================== 判据 */

/**
 * J-全完：发布的任务全部落定为完成。
 * @param {string[]} ids 发布的任务 id
 * @param {Record<string, string> | Map<string, string>} states id → 最终状态（'done' / 'failed' / 'open' / 'claimed' / 缺）
 * @returns {{ ok: boolean, total: number, done: number, notDone: Array<{ id: string, state: string | null }> }}
 */
export function judgeAllDone(ids, states) {
  const get = (id) => (states instanceof Map ? states.get(id) : states?.[id]) ?? null;
  const notDone = ids.filter((id) => get(id) !== 'done').map((id) => ({ id, state: get(id) }));
  return { ok: ids.length > 0 && notDone.length === 0, total: ids.length, done: ids.length - notDone.length, notDone };
}

/**
 * J-恰一：每个任务恰好一次 `task.done`，按 epoch 计（`m8-plan.md` 第 7 节 D3〔裁〕：文档服务重启后队列清空、
 * 发布方重发，同一个 id 在新 epoch 里再完成一次是对的；每个 epoch 内至多一次，至少在一个 epoch 里完成过）。
 * @param {string[]} ids 发布的任务 id
 * @param {Array<{ id: string, epoch?: string | null }>} doneEvents 发布方收到的每一条 `task.done`（按到达顺序，重复的也记）
 * @param {{ perEpoch?: boolean }} [o] perEpoch 为 false 时跨 epoch 也只许一次（口径 (b)，只作对照）
 * @returns {{ ok, total, epochs: string[], dup: Array<{ id, epoch, n }>, missing: string[], stray: number }}
 *   `stray`：不在 ids 里的 done（别的轮次的），只计数不判
 */
export function judgeExactlyOnce(ids, doneEvents, { perEpoch = true } = {}) {
  const want = new Set(ids);
  const counts = new Map();
  const epochs = [];
  let stray = 0;
  for (const e of doneEvents) {
    if (!want.has(e?.id)) { stray += 1; continue; }
    const epoch = e.epoch ?? null;
    if (epoch !== null && !epochs.includes(epoch)) epochs.push(epoch);
    const k = perEpoch ? `${epoch}\u0000${e.id}` : e.id;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const dup = [];
  for (const [k, n] of counts) {
    if (n <= 1) continue;
    const [epoch, id] = perEpoch ? k.split('\u0000') : [null, k];
    dup.push({ id, epoch: epoch === 'null' ? null : epoch, n });
  }
  const seen = new Set(doneEvents.filter((e) => want.has(e?.id)).map((e) => e.id));
  const missing = ids.filter((id) => !seen.has(id));
  return { ok: ids.length > 0 && dup.length === 0 && missing.length === 0, total: ids.length, epochs, dup, missing, stray };
}

/**
 * J-纯层：没有一层混了两种指纹。输入是逐帧 / 逐段的观察：这一层（层键，例如快照的 resultKey 或内容键）的这一段由什么指纹产出。
 * 来源可以是清单（按层表逐层取清单）、任务的 `requires.envFingerprint`、完成它的节点的指纹 —— 见 `layerObservations`。
 * @param {Array<{ layer: string, fingerprint: string | null, ref?: string }>} observations
 * @returns {{ ok, layers: number, observed: number, unknown: number, mixed: Array<{ layer, fingerprints: Record<string, number>, refs: string[] }> }}
 *   `unknown`：指纹缺失的观察条数；有缺失也算不过（判不了就不能说纯）
 */
export function judgePureLayers(observations) {
  const byLayer = new Map();
  let unknown = 0;
  for (const o of observations) {
    if (typeof o?.layer !== 'string') continue;
    if (typeof o.fingerprint !== 'string' || o.fingerprint === '') unknown += 1;
    const l = byLayer.get(o.layer) ?? { fps: new Map(), refs: [] };
    const fp = o.fingerprint ?? '(unknown)';
    l.fps.set(fp, (l.fps.get(fp) ?? 0) + 1);
    if (o.ref) l.refs.push(o.ref);
    byLayer.set(o.layer, l);
  }
  const mixed = [...byLayer].filter(([, l]) => l.fps.size > 1)
    .map(([layer, l]) => ({ layer, fingerprints: Object.fromEntries(l.fps), refs: l.refs.slice(0, 8) }));
  return { ok: byLayer.size > 0 && mixed.length === 0 && unknown === 0, layers: byLayer.size, observed: observations.length, unknown, mixed };
}

/** 快照 / 流细任务的 id（`<kind>:<resultKey>:<from>-<to>`）→ { kind, resultKey, from, to }；认不出回 null */
export function parseTaskId(id) {
  const m = /^([a-z-]+):(.+):(\d+)-(\d+)$/.exec(String(id));
  return m ? { kind: m[1], resultKey: m[2], from: Number(m[3]), to: Number(m[4]) } : null;
}

/**
 * 从任务与「谁完成了它」拼出 J-纯层的观察：每个完成了的细任务出两条 —— 任务要求的指纹、完成它的节点的指纹。
 * 层键缺省取 resultKey（一层 = 一个结果键的全部段）。
 * @param {Array<{ id: string, requires?: { envFingerprint?: string } }>} tasks
 * @param {Record<string, string>} completedBy 任务 id → 完成它的节点 id
 * @param {Record<string, string>} nodeFingerprints 节点 id → 指纹
 * @param {(task) => string} [layerOf]
 */
export function layerObservations(tasks, completedBy, nodeFingerprints, layerOf = (t) => parseTaskId(t.id)?.resultKey ?? t.id) {
  const obs = [];
  for (const t of tasks) {
    const layer = layerOf(t);
    const req = t.requires?.envFingerprint;
    if (typeof req === 'string') obs.push({ layer, fingerprint: req, ref: `${t.id}#requires` });
    const node = completedBy[t.id];
    if (node !== undefined) obs.push({ layer, fingerprint: nodeFingerprints[node] ?? null, ref: `${t.id}#${node}` });
  }
  return obs;
}

/**
 * 假细任务（不渲染，按 `render-queue-e2e.mjs` 的写法由假节点睡一会儿就完成）：每层一个结果键、切成若干段，
 * 每段要求这一层的指纹（`requires.envFingerprint`），用来在不起 Chrome 的情况下证 J-全完、J-恰一、J-纯层。
 * 形状同 `server/test/fake-ws-kit.mjs` 的 snapshotTaskInput（契约 A.4：id = `snapshot:<resultKey>:<from>-<to>`）。
 * @param {{ run: string, projectId: string, layers: Array<{ fingerprint: string | null, segments: number, extra?: object }>, framesPerSegment?: number, projectRev?: number }} o
 *   `layer.extra` 浅合并进这一层的每个任务（例如 m8-scale 的卡片级指纹锁要 `tier: 'local'` 与 `input.entryKey / contentKey`，契约 F.1）
 */
export function fakeLayerTasks({ run, projectId, layers, framesPerSegment = 60, projectRev = 1 }) {
  const tasks = [];
  layers.forEach((layer, i) => {
    const resultKey = `m8-${run}-L${i}`;
    for (let s = 0; s < layer.segments; s++) {
      const from = s * framesPerSegment;
      const to = from + framesPerSegment - 1;
      tasks.push({
        id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey,
        range: { unit: 'localFrame', from, to }, source: { projectId, projectRev }, input: {},
        weight: { class: 'light', estMs: null, frames: framesPerSegment },
        requires: layer.fingerprint ? { envFingerprint: layer.fingerprint } : {}, priority: 0,
        ...(layer.extra ?? {}),
      });
    }
  });
  return tasks;
}

/** sha256（十六进制）；收 Buffer / Uint8Array / 字符串 */
export const sha256Of = (data) => createHash('sha256').update(data).digest('hex');

/**
 * 产物逐字节相同：两份「键 → 字节或 sha256」逐键比。键是段 id、帧号或文件相对路径，由探针定。
 * 两边的键集合不同也算不过（`onlyA`、`onlyB`）。
 * @param {Record<string, Buffer | string> | Map<string, Buffer | string>} a
 * @param {Record<string, Buffer | string> | Map<string, Buffer | string>} b
 * @returns {{ ok, compared: number, identical: number, mismatched: string[], onlyA: string[], onlyB: string[] }}
 */
export function judgeIdenticalBytes(a, b) {
  const entries = (x) => (x instanceof Map ? [...x] : Object.entries(x ?? {}));
  const digest = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : sha256Of(v));
  const A = new Map(entries(a).map(([k, v]) => [k, digest(v)]));
  const B = new Map(entries(b).map(([k, v]) => [k, digest(v)]));
  const onlyA = [...A.keys()].filter((k) => !B.has(k));
  const onlyB = [...B.keys()].filter((k) => !A.has(k));
  const both = [...A.keys()].filter((k) => B.has(k));
  const mismatched = both.filter((k) => A.get(k) !== B.get(k));
  return { ok: both.length > 0 && mismatched.length === 0 && onlyA.length === 0 && onlyB.length === 0, compared: both.length, identical: both.length - mismatched.length, mismatched, onlyA, onlyB };
}

/**
 * 每个节点都干了活（E1「三方各认领 ≥ 1」）。
 * @param {Record<string, number>} workByNode 节点 → 完成（或认领）数
 * @param {{ min?: number, expectNodes?: string[], total?: number }} [o] `total` 给了就另核各节点之和等于它
 */
export function judgeEachWorked(workByNode, { min = 1, expectNodes = null, total = null } = {}) {
  const nodes = expectNodes ?? Object.keys(workByNode);
  const idle = nodes.filter((n) => (workByNode[n] ?? 0) < min);
  const sum = nodes.reduce((s, n) => s + (workByNode[n] ?? 0), 0);
  const sumOk = total === null || sum === total;
  return { ok: nodes.length > 0 && idle.length === 0 && sumOk, nodes: nodes.length, idle, sum, ...(total === null ? {} : { total }) };
}

/**
 * E3（C2 / C4）「在线页面恢复同步、重启前最后一次提交可读」。
 * @param {{ rev: number, digest: string, path?: string, value?: any } | null} lastCommit 页面角色在重启前最后一次提交
 *   （提交后以 `project.open` 读回的版本与摘要；`path` / `value` 是这次提交写下的字段）
 * @param {{ sessionsAfter: number, rev: number, seenAfter: { rev: number, digest: string | null }[], valueAt?: any } | null} page
 *   主机侧副本在重启之后的观察：`sessionsAfter` = 重启之后建成并重读过的新会话数；`rev` = 最后的版本；
 *   `seenAfter` = 这些新会话里重读、逐版应用见到的各版摘要（不含重启前内存里的）；`valueAt` = 最后内容里 `path` 处的值
 * @returns {{ resync: { ok, … }, readable: { ok, … } }}
 *   resync：重启之后以新会话重读过、并追到 rev ≥ lastCommit.rev。
 *   readable：重启之后见到的 lastCommit.rev 那一版摘要与 lastCommit.digest 相同；重启后又有写入、没见到那一版时，
 *   退回核对那次提交写下的值还在（`via: 'value'`）。
 */
export function judgeLastCommit(lastCommit, page) {
  if (!lastCommit || !page) {
    const why = !lastCommit ? '没有重启前最后一次提交' : '没有副本的观察';
    return { resync: { ok: false, why }, readable: { ok: false, why } };
  }
  const resyncOk = page.sessionsAfter >= 1 && page.rev >= lastCommit.rev;
  const resync = { ok: resyncOk, sessionsAfter: page.sessionsAfter, rev: page.rev, want: lastCommit.rev };
  const at = (page.seenAfter ?? []).filter((x) => x.rev === lastCommit.rev);
  let readable;
  if (!resyncOk) readable = { ok: false, why: '重启后副本没重读或没追到那一版', rev: page.rev, want: lastCommit.rev };
  else if (at.length) {
    const match = at.every((x) => x.digest === lastCommit.digest);
    readable = { ok: match, via: 'digest', rev: lastCommit.rev, digestMatch: match, seen: at.length };
  } else {
    const hasValue = lastCommit.path !== undefined && 'value' in lastCommit;
    const match = hasValue && JSON.stringify(page.valueAt) === JSON.stringify(lastCommit.value);
    readable = { ok: match, via: 'value', rev: page.rev, want: lastCommit.rev, digestMatch: null, valueMatch: hasValue ? match : null };
  }
  return { resync, readable };
}

/* ================================================================== 旁观节点的时间线 */

/**
 * 旁观节点记的时间线：一个任务一串 `{ t, ev: 'opened' | 'taken' | 'closed', version?, state? }`（本机时钟）。
 * 汇总成每个任务的 { taken, reopenedAfterTaken, closed: [state…] }，与 `ht-w-probe.mjs` 的旁观节点同口径。
 */
export function summarizeTimeline(events) {
  const r = { taken: 0, reopenedAfterTaken: 0, closed: [], versions: [] };
  for (const e of events ?? []) {
    if (e.ev === 'taken') { r.taken += 1; r.versions.push(e.version ?? null); }
    else if (e.ev === 'opened' && r.taken > 0) r.reopenedAfterTaken += 1;
    else if (e.ev === 'closed') r.closed.push(e.state ?? null);
  }
  return r;
}

/**
 * 接手用时（E2、C1 的「≤ 37 s 被另一节点认领」）：从 `since`（断网 / stall 的时刻）起，这个任务「放回后再被认领」的那次
 * `taken` 距 `since` 多少毫秒。时间线里 since 之后先出现 opened（放回）再出现 taken 才算接手；没有回 null。
 */
export function takeoverMs(events, since) {
  let reopened = false;
  for (const e of events ?? []) {
    if (e.t < since) continue;
    if (e.ev === 'opened') reopened = true;
    else if (e.ev === 'taken' && reopened) return e.t - since;
  }
  return null;
}

/* ================================================================== 结果 JSON */

/**
 * 一个探针进程的结果收集器。`check` 进 checks，不过的同时进 fails；`toJSON()` 出结果行。
 * @param {{ probe: string, role: string, run?: string | null, place?: string | null, case?: string | null, startedAt?: number }} head  `startedAt` 缺省为现在（结果行的 ms 从它算）
 */
export function createResult(head) {
  const started = head.startedAt ?? Date.now();
  const checks = [];
  const fails = [];
  const counts = {};
  const extra = {};
  const r = {
    checks, fails, counts, extra,
    /** 一条断言；回 ok 的布尔值，方便 `if (!r.check(...)) return` */
    check(name, ok, detail) {
      checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) });
      if (!ok) fails.push(`${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`}`);
      return !!ok;
    },
    /** 用一个判据函数的返回值（带 ok 字段）记一条断言，detail 去掉 ok */
    judge(name, verdict) {
      const { ok, ...detail } = verdict;
      return r.check(name, ok, detail);
    },
    fail(message) { fails.push(String(message).slice(0, 800)); },
    count(name, n = 1) { counts[name] = (counts[name] ?? 0) + n; },
    set(fields) { Object.assign(extra, fields); return r; },
    get ok() { return fails.length === 0 && checks.length > 0; },
    toJSON() {
      return { probe: head.probe, role: head.role, run: head.run ?? extra.run ?? null, place: head.place ?? null, ...(head.case ? { case: head.case } : {}),
        ...extra, ok: r.ok, checks, fails, counts, ms: Date.now() - started };
    },
  };
  return r;
}

/**
 * `--role all` 的汇总：各角色的结果行 → 一个结果（checks 名前加 `<角色>:`，各角色原样放 `roles`）。
 * @param {Array<{ role: string, code?: number | null, line: object | null }>} results
 */
export function mergeRoleResults(head, results) {
  const r = createResult({ ...head, role: ROLES.ALL });
  const roles = {};
  for (const { role, code, line } of results) {
    roles[role] = line;
    for (const ch of line?.checks ?? []) r.checks.push({ ...ch, name: `${role}:${ch.name}` });
    for (const f of line?.fails ?? []) r.fails.push(`${role}: ${f}`);
    if (!line) r.fail(`${role}: 没有结果行（退出码 ${code ?? null}）`);
    else if (!line.ok && !(line.fails ?? []).length) r.fail(`${role}: 结果 ok 为假（退出码 ${code ?? null}）`);
  }
  r.set({ roles });
  return r;
}

/** 一段 stdout 的最后一行 JSON；没有或不是 JSON 回 null */
export function lastJsonLine(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith('{')) continue;
    try { return JSON.parse(l); } catch { /* 半行，往前找 */ }
  }
  return null;
}

/** 过程日志：一行一条 JSON 写 stderr（stdout 只留给结果行） */
export const sayer = (probe, role) => (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), probe, role, step, ...fields })}\n`);

/** 取命令行参数：`arg('--x', 缺省)`；`flag('--y')` */
export function argsOf(argv = process.argv.slice(2)) {
  return {
    argv,
    arg: (name, fallback = null) => (argv.includes(name) && argv[argv.indexOf(name) + 1] !== undefined ? argv[argv.indexOf(name) + 1] : fallback),
    flag: (name) => argv.includes(name),
  };
}

/**
 * 「放本机全程不连阿里云」（`cloud-untouched`）按本轮查：本轮的项目（名字带本轮编号）在云端托管端查不到，
 * 本轮的用户（项目成员）就不可能进过云端。以前数云端 `/healthz` 的总连接数，别人进出就误判；总数只留作参考、不判。
 *
 * @param {{ status: number, body?: any } | null} lookup  云端 `GET shared/lookup?name=<本轮项目名>` 的结果；连不上给 null
 * @param {{ projectId?: string | null, name?: string | null }} mine  本轮的项目
 * @param {{ before?: number | null, after?: number | null }} [connections]  云端 `/healthz` 前后的总连接数（只记录）
 * @returns {{ ok: boolean, via: 'lookup' | 'unreachable', why?: string, status?: number, connections: object }}
 *   404：本轮项目不在云端，过；200 且 projectId 是本轮的：不过；200 但 projectId 不同（重名，不是本轮的）：过、写明；
 *   连不上或别的状态：记 `unreachable` 并放过（同以前「前后有一次读不到就不判」）。
 */
export function judgeCloudUntouched(lookup, mine, connections = {}) {
  const conns = { before: connections.before ?? null, after: connections.after ?? null };
  if (!mine?.name) return { ok: false, via: 'lookup', why: '没有本轮的项目名', connections: conns };
  if (!lookup || typeof lookup.status !== 'number') return { ok: true, via: 'unreachable', why: '云端查不了（连不上）', connections: conns };
  if (lookup.status === 404) return { ok: true, via: 'lookup', status: 404, connections: conns };
  if (lookup.status === 200) {
    const id = lookup.body?.projectId ?? null;
    if (mine.projectId && id && id !== mine.projectId) return { ok: true, via: 'lookup', status: 200, why: `云端有同名项目 ${id}，不是本轮的`, connections: conns };
    return { ok: false, via: 'lookup', status: 200, why: `本轮的项目出现在云端（${id ?? '没有 projectId'}）`, connections: conns };
  }
  return { ok: true, via: 'unreachable', status: lookup.status, why: `云端回 ${lookup.status}`, connections: conns };
}

/**
 * e1 真实细任务数的门槛与检查名：每条时间轴 `seconds × fps / segFrames` 段，门槛 `min(cap, 条数 × 每条段数)`；
 * 检查名按门槛写（`real:tasks>=<门槛>`），不再固定写 50。
 * @returns {{ need: number, label: string, expected: number }}
 */
export function realTasksThreshold({ clips, seconds, fps = 30, segFrames = 60, cap = 50 }) {
  const expected = clips * seconds * fps / segFrames;
  const need = Math.ceil(Math.min(cap, expected));
  return { need, label: `real:tasks>=${need}`, expected };
}
