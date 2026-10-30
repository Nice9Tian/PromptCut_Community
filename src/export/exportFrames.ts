/**
 * 导出开始时请渲染节点把本页不执行的卡按原尺寸逐帧渲好(语义 `docs/semantics/product/platforms.md`「在线浏览器」的「导出」:
 * 「本页不执行的同步用户卡、素材效果卡,导出开始时请渲染节点按原尺寸逐帧渲好再用,没到齐时提示等待」)—— 页面这一侧。
 * 节点那一侧见 `server/export-frames.mjs`。
 *
 * # 怎么请
 *
 * 页面在自己的文档服务连接上发布一个**只为导出**的清单计划(任务形状同 `online/planPublisher.ts` 的清单计划,另带 `input.exportOnly: true`,
 * 签名里多一段,所以它和平时那份清单计划不是一个任务):
 *
 *   `plan:<projectId>@<projectRev>#clips:<sig>`   `input.clips` = 要渲染节点出的片段   `input.exportOnly: true`   (`input.exportSalt`)
 *
 * 认领它的节点不切快照、不切轨道流,只给这些片段切**导出位图任务**;计划完成时的回包带一份索引(每个片段的结果键、矩形、帧范围、
 * 它的每一份任务原样一份,出不了的片段和原因)。页面是这个计划的发布方,计划完成时收到它的 `task.done`。
 *
 * # 怎么等(每一步都有尽头:要么到齐,要么说清楚为什么没到)
 *
 * 一、等索引。每 `EXPORT_PLAN_POLL_MS` 把计划再发布一次,看回包里它的状态:`open` = 还没有节点认领(提示「没有渲染节点在线」,
 *    接着等,不设超时);`claimed` = 节点接了;`failed` = 计划失败了,报失败;`done` = 做完了 —— 已经做完的计划再发布时队列会把它的
 *    `task.done`(带索引)再发给这条连接一遍,所以这一轮之后还拿不到索引就是这份结果不带索引,报失败。
 * 二、等清单。每 `EXPORT_MANIFEST_POLL_MS` 取一次还没到的清单(内容库 `render-manifest`,键 `<结果键>:<起>-<止>`),每一帧都列了才算这一段到齐。
 *    另外每 `EXPORT_TASK_CHECK_MS` 把还没到的那几份任务原样再发布一次(索引里带着):队列不会为失败的任务补发通知,回包里的状态是
 *    `failed` 就报失败;任务已经不在了(页面的连接断开超过宽限,订阅被清、还没人认领的任务被删)这一下就重建了,不用用户重来。
 *    清单的帧数没有再涨、也没有哪份任务正被节点认领着,这样持续 `EXPORT_STALL_MS` 就报失败(节点切完计划之后退出了:任务绑着它的环境,
 *    别的节点接不了)。
 * 三、失败之后再点导出。队列里失败的任务在保留期(10 分钟)内不会重开,同一个计划也不会重切。所以这一页只要失败过一次,下一次的计划
 *    带一个新的标识(`input.exportSalt`,进计划的签名,也进导出位图的键):计划是新的、任务是新的,节点重新渲。没失败过不带,
 *    同一份内容再导出时直接用上一次的结果。
 * 全部到齐才开始导,不出半截的成片。节点说某个片段出不了、或节点渲的那一版和本页手里这一版对不上(导出期间项目被改了),同样抛带说明的错误。
 *
 * # 怎么取
 *
 * 一帧一张 PNG(`px/<哈希>`,只读票据),取回来直接当 `data:` 地址用(无损,不解码)。只留当前这一帧,用完不留。
 */
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { STREAM_SEGMENT_FRAMES } from "../render/streamSegments.mjs";
import { CLIPS_KEY_MARK, clipsSig } from "../online/planPublisher";
import type { FrameCoverage, LayerRect } from "./cardLayers";
import { ONLINE_EXPORT_TEXT } from "./text";

/** 只为导出的清单计划在签名里多的那一段 */
export const EXPORT_ONLY_SIG = "export=1";
/** 多久把计划再发布一次(问状态、要回完成通知) */
export const EXPORT_PLAN_POLL_MS = 3000;
/** 多久再取一次没到齐的清单 */
export const EXPORT_MANIFEST_POLL_MS = 2000;
/** 等清单时多久把还没到的任务原样再发布一次(核对它们还在不在、失败没有;不在了就此重建) */
export const EXPORT_TASK_CHECK_MS = 6000;
/**
 * 等清单时多久没有进展就报失败:清单的帧数没涨、也没有哪份任务正被节点认领着。只在这一处定(三级数字)。
 * 节点正在渲的任务一直是「认领着」,不会被它误伤;够不着的是「节点退出了、任务没人接」。
 */
export const EXPORT_STALL_MS = 3 * 60_000;

/** 同一项目/同一会话只为导出的计划最小发起间隔(毫秒):节流防短时间内高频重复提交 */
export const EXPORT_PLAN_THROTTLE_MS = 2000;
/** 同一项目/同一会话同时只允许 1 份导出的计划在执行 */
export const MAX_CONCURRENT_EXPORT_PLANS = 1;

interface PlanThrottleEntry {
  inFlight: boolean;
  lastTime: number;
}
const planThrottles = new Map<string, PlanThrottleEntry>();

export function resetExportPlanThrottle(): void {
  planThrottles.clear();
}

export function exportPlanThrottleState(key: string): { inFlight: boolean; lastTime: number } | null {
  const e = planThrottles.get(key);
  return e ? { inFlight: e.inFlight, lastTime: e.lastTime } : null;
}

/**
 * 这一页上一次请渲染节点失败之后,下一次带的新标识(见文件头「失败之后再点导出」);没失败过是 null。
 * 只认小写字母与数字、最多 32 位(节点一侧 `server/export-frames.mjs` 的 `exportSaltOf` 同一个口径)。
 */
let retrySalt: string | null = null;
const freshSalt = () => (Math.random().toString(36).slice(2, 12) + Date.now().toString(36)).replace(/[^0-9a-z]/g, "").slice(0, 32);
export const exportRetrySalt = () => retrySalt;
export function resetExportRetry(): void { retrySalt = null; resetExportPlanThrottle(); }
const HASH_RE = /^[0-9a-f]{64}$/;

export interface ExportFrameDeps {
  /** 文档服务上的一次请求(回同一 reqId 的回包) */
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** 队列推来的 `task.done` / `task.failed`(页面是发布方,自动订阅);回退订 */
  subscribeQueue(cb: (msg: Record<string, unknown>) => void): () => void;
  assetBase(): string | null;
  authHeaders(): Promise<Record<string, string>>;
  publisherId: string;
  codeVersion?: string | null;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** 多久没有进展就报失败;不给 = `EXPORT_STALL_MS`(探针注成几秒) */
  stallMs?: number;
  /** 多久核对一次任务;不给 = `EXPORT_TASK_CHECK_MS` */
  taskCheckMs?: number;
}

export interface ExportPlanTask {
  id: string;
  kind: "plan";
  resultKey: string;
  range: null;
  source: { projectId: string; projectRev: number };
  input: { clips: string[]; exportOnly: true; exportSalt?: string };
  weight: { class: "medium"; estMs: null; frames: null };
  requires: { codeVersion?: string };
  priority: number;
}

/**
 * 只为导出的计划在队列里的名次:排在所有细任务前面(锚帧 50、导出位图任务 60)。用户正等着导出;名次低的话,节点手里别的快照、
 * 轨道流任务没做完就轮不到它(实测同一个项目里等了五分钟)。整数名次仍属 normal 档(`server/render-queue/messages.mjs` 的 `priorityBand`)。
 */
export const EXPORT_PLAN_PRIORITY = 70;

/** 只为导出的清单计划(队列按清单计划收:结果键的形状、`input.clips` 的形状都照它的规矩) */
export function exportPlanTask({ projectId, projectRev, clips, codeVersion, salt }: { projectId: string; projectRev: number; clips: readonly string[]; codeVersion?: string | null; salt?: string | null }): ExportPlanTask {
  const list = [...new Set(clips)].map(String).filter(Boolean).sort();
  const tail = typeof salt === "string" && /^[0-9a-z]{1,32}$/.test(salt) ? salt : "";
  const resultKey = `${projectId}@${projectRev}${CLIPS_KEY_MARK}${clipsSig(list, tail ? `${EXPORT_ONLY_SIG}:${tail}` : EXPORT_ONLY_SIG)}`;
  return {
    id: `plan:${resultKey}`, kind: "plan", resultKey, range: null,
    source: { projectId, projectRev }, input: { clips: list, exportOnly: true, ...(tail ? { exportSalt: tail } : {}) }, weight: { class: "medium", estMs: null, frames: null },
    requires: typeof codeVersion === "string" && codeVersion ? { codeVersion } : {}, priority: EXPORT_PLAN_PRIORITY,
  };
}

/** 索引里的一条(节点那一侧 `server/render-node/export-plan.mjs` 的 `exportIndexOf`) */
export interface ExportIndexStream {
  clipId: string;
  kind: "card" | "below";
  plane: "local" | "stage";
  resultKey: string;
  originFrame: number;
  lastFrame: number;
  lastSegment: number;
  segmentsPerTask: number;
  fps: number;
  rect: LayerRect;
  inputSig?: string;
  /** 这条的每一份导出位图任务(节点发布时的那一份,原样;页面核对任务状态时原样再发布) */
  tasks: Record<string, unknown>[];
}
export interface ExportIndex { streams: ExportIndexStream[]; unsupported: { clipId: string; reason: string }[] }

const rectOf = (r: unknown): LayerRect | null => {
  const o = r as Partial<LayerRect> | null;
  if (!o || typeof o !== "object") return null;
  const { x, y, w, h } = o;
  return [x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) && (w as number) > 0 && (h as number) > 0 ? { x: x as number, y: y as number, w: w as number, h: h as number } : null;
};

/** 计划完成回包里的索引;形状不对回 null,单条不对的跳过 */
export function parseExportIndex(raw: unknown): ExportIndex | null {
  const b = raw as { streams?: unknown; unsupported?: unknown } | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.streams)) return null;
  const streams: ExportIndexStream[] = [];
  for (const s of b.streams as Record<string, unknown>[]) {
    const rect = rectOf(s?.rect);
    const kind = s?.kind === "below" ? "below" : s?.kind === "card" ? "card" : null;
    const plane = s?.plane === "stage" ? "stage" : s?.plane === "local" ? "local" : null;
    const ints = [s?.originFrame, s?.lastFrame, s?.lastSegment, s?.segmentsPerTask].map(Number);
    if (!s || typeof s.clipId !== "string" || !s.clipId || !HASH_RE.test(String(s.resultKey)) || !rect || !kind || !plane) continue;
    if (!ints.every(Number.isInteger) || ints[0] < 0 || ints[1] < ints[0] || ints[2] < 0 || ints[3] < 1 || !(Number(s.fps) > 0)) continue;
    // 任务只收这条流自己的导出位图任务(id 是 `stream:<这条的结果键>:<起>-<止>`、带 `exportFrames`),别的不认
    const tasks = (Array.isArray(s.tasks) ? (s.tasks as Record<string, unknown>[]) : []).filter((t) => !!t && typeof t === "object" && t.kind === "stream"
      && typeof t.id === "string" && t.id.startsWith(`stream:${String(s.resultKey)}:`) && t.resultKey === s.resultKey
      && (t.input as { exportFrames?: unknown } | null)?.exportFrames === true);
    streams.push({ clipId: s.clipId, kind, plane, resultKey: String(s.resultKey), originFrame: ints[0], lastFrame: ints[1], lastSegment: ints[2], segmentsPerTask: ints[3],
      fps: Number(s.fps), rect, ...(typeof s.inputSig === "string" && s.inputSig ? { inputSig: s.inputSig } : {}), tasks });
  }
  const unsupported: ExportIndex["unsupported"] = [];
  for (const u of Array.isArray(b.unsupported) ? (b.unsupported as Record<string, unknown>[]) : []) {
    if (u && typeof u.clipId === "string" && u.clipId) unsupported.push({ clipId: u.clipId, reason: typeof u.reason === "string" && u.reason ? u.reason : "unknown" });
  }
  return { streams, unsupported };
}

/** 这条的清单按任务怎么分段:`[from, to]`(分段号),与切分同一种切法 */
export function exportSpans(stream: Pick<ExportIndexStream, "lastSegment" | "segmentsPerTask">): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let from = 0; from <= stream.lastSegment; from += stream.segmentsPerTask) out.push([from, Math.min(stream.lastSegment, from + stream.segmentsPerTask - 1)]);
  return out;
}

/** 一份清单里列着的帧:项目帧号 → PNG 的哈希 */
export function readExportManifest(body: unknown, resultKey: string, span: [number, number]): Map<number, string> | null {
  const b = body as { kind?: unknown; resultKey?: unknown; range?: { from?: unknown; to?: unknown }; frames?: unknown } | null;
  if (!b || typeof b !== "object" || b.kind !== "export-frames" || b.resultKey !== resultKey || !Array.isArray(b.frames)) return null;
  if (b.range?.from !== span[0] || b.range?.to !== span[1]) return null;
  const out = new Map<number, string>();
  for (const item of b.frames as unknown[]) {
    if (Array.isArray(item) && Number.isInteger(item[0]) && HASH_RE.test(String(item[1]))) out.set(item[0] as number, String(item[1]));
  }
  return out;
}

const cancelled = () => Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true });

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(cancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 等待时报给调用方的状态 */
export type ExportFramesStatus =
  | { phase: "publishing"; clips: number }
  /** 计划发出去了,还没有渲染节点认领 */
  | { phase: "no-node"; clips: number }
  /** 有节点接了,正在算怎么出 */
  | { phase: "planning"; clips: number }
  /** 节点正在逐帧渲:已到 `done` 帧,共 `total` 帧 */
  | { phase: "rendering"; clips: number; done: number; total: number };

type PublishResult = { id?: string; error?: string; state?: string };

/** 请到的位图:每个片段有哪些帧、怎么取 */
export interface ExportFrames {
  coverage: Map<string, FrameCoverage>;
  /** 这个片段这一帧的 PNG(`data:` 地址) */
  dataUrl(clipId: string, frame: number, signal?: AbortSignal): Promise<string>;
  stats: { fetched: number; bytes: number };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * 请渲染节点把 `clips` 逐帧渲好,等到齐。`project` 是导出用的那一版(页面手里的快照),`projectRev` 是文档服务确认的版本号。
 * 到齐的判据:索引里每个片段的每一段清单都在、清单把这一段的每一帧都列了(帧范围以节点给的为准:片段的第一帧到最后一帧)。
 */
export async function requestExportFrames({ projectId, projectRev, project, clips, deps, signal, onStatus }: {
  projectId: string; projectRev: number; project: unknown; clips: readonly string[];
  deps: ExportFrameDeps; signal: AbortSignal; onStatus?: (s: ExportFramesStatus) => void;
}): Promise<ExportFrames> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const throttleKey = `${projectId}:${deps.publisherId}`;
  const tStart = now();
  const existingThrottle = planThrottles.get(throttleKey);
  if (existingThrottle?.inFlight) {
    throw Object.assign(new Error("同一项目正在等待或执行导出计划，请勿重复发起"), { throttled: true, retryable: false });
  }
  if (!retrySalt && existingThrottle && tStart - existingThrottle.lastTime < EXPORT_PLAN_THROTTLE_MS) {
    const waitMs = EXPORT_PLAN_THROTTLE_MS - (tStart - existingThrottle.lastTime);
    await sleep(waitMs, signal);
  }
  const throttleRecord: PlanThrottleEntry = { inFlight: true, lastTime: now() };
  planThrottles.set(throttleKey, throttleRecord);

  const stallMs = deps.stallMs ?? EXPORT_STALL_MS;
  const taskCheckMs = deps.taskCheckMs ?? EXPORT_TASK_CHECK_MS;
  const task = exportPlanTask({ projectId, projectRev, clips, codeVersion: deps.codeVersion ?? null, salt: retrySalt });
  const want = task.input.clips;
  const say = (s: ExportFramesStatus) => { try { onStatus?.(s); } catch { /* 宿主坏了不影响等待 */ } };
  const heard: { index: ExportIndex | null; planFailed: string | null } = { index: null, planFailed: null };
  /** 失败了的导出位图任务:结果键 → 原因(队列只在任务彻底失败时才发 `task.failed`:不可重试,或重试用尽) */
  const taskFailures = new Map<string, string>();
  const off = deps.subscribeQueue((msg) => {
    const id = typeof msg?.id === "string" ? msg.id : "";
    if (id === task.id) {
      if (msg.type === "task.done") heard.index = parseExportIndex((msg.result as { exportIndex?: unknown } | null)?.exportIndex) ?? heard.index;
      else if (msg.type === "task.failed") heard.planFailed = String(msg.error ?? "failed");
      return;
    }
    // 流任务的 id:`stream:<结果键>:<起>-<止>`
    if (msg?.type === "task.failed" && id.startsWith("stream:")) taskFailures.set(id.split(":")[1] ?? "", String(msg.error ?? "failed"));
  });
  const failureText = (error: string) => (error === "superseded" ? ONLINE_EXPORT_TEXT.projectChanged : ONLINE_EXPORT_TEXT.nodeFailed(error));
  /** 请渲染节点这件事失败了:下一次导出带一个新的标识,计划和任务都是新的(队列里失败的那几份不会重开) */
  const failed = (message: string, extra: Record<string, unknown> = {}) => {
    retrySalt = freshSalt();
    return Object.assign(new Error(message), extra);
  };
  let hello = false;
  /** 发布一批任务,回每一项的回包(按 id);连接断着、回包不对回 null(下一轮再发) */
  const publish = async (tasks: readonly unknown[]): Promise<Map<string, PublishResult> | null> => {
    try {
      if (!hello) {
        const r = await deps.request({ type: "publisher.hello", publisherId: deps.publisherId });
        hello = r?.type === "publisher.welcome";
      }
      if (!hello) return null;
      const reply = await deps.request({ type: "task.publish", tasks });
      if (reply?.type !== "task.published") { hello = false; return null; }
      const out = new Map<string, PublishResult>();
      for (const r of Array.isArray(reply.results) ? (reply.results as PublishResult[]) : []) if (r && typeof r.id === "string") out.set(r.id, r);
      return out;
    } catch { hello = false; return null; }
  };
  try {
    say({ phase: "publishing", clips: want.length });
    // 一、发计划,等索引
    let doneRounds = 0;
    while (!heard.index) {
      if (signal.aborted) throw cancelled();
      if (heard.planFailed) throw failed(failureText(heard.planFailed));
      const r = (await publish([task]))?.get(task.id);
      const state = r && !r.error && typeof r.state === "string" ? r.state : null;
      if (heard.index) break;
      // 计划已经失败了(保留期内不会重开):不是「没有节点」,报失败
      if (state === "failed") throw failed(failureText(heard.planFailed ?? "plan-failed"));
      // 计划做完了,队列随回包把它的完成通知(带索引)又发了一遍;等过一轮还没有,这份结果就是不带索引的
      if (state === "done" && ++doneRounds > 1) throw failed(ONLINE_EXPORT_TEXT.nodeFailed("no-index"));
      say(state === "claimed" || state === "done" ? { phase: "planning", clips: want.length } : { phase: "no-node", clips: want.length });
      await sleep(EXPORT_PLAN_POLL_MS, signal);
    }
    const found: ExportIndex = heard.index;
    // 二、节点说出不了的、没列出来的片段:导不了,说清楚是哪几个、为什么
    const listed = new Map(found.streams.map((s) => [s.clipId, s]));
    const bad = want.filter((id) => !listed.has(id)).map((id) => ({ clipId: id, reason: found.unsupported.find((u) => u.clipId === id)?.reason ?? "unknown" }));
    if (bad.length) throw failed(ONLINE_EXPORT_TEXT.nodeCannot(bad.length, bad[0].reason), { unsupported: bad });
    // 节点渲的那一版和本页手里这一版对不上(导出期间项目被改了):不拿别的版本的画面出片。
    // 没带输入签名的没法核对,同样不用(当过期)
    for (const s of found.streams) {
      if (!want.includes(s.clipId)) continue;
      if (!s.inputSig) throw failed(ONLINE_EXPORT_TEXT.nodeFailed("no-input-signature"));
      if (streamSigStale(s.inputSig, streamInputSig(project, { clipIds: [s.clipId], kind: s.kind }))) throw failed(ONLINE_EXPORT_TEXT.projectChanged);
    }
    // 三、等每一段的清单到齐
    const frames = new Map<string, Map<number, string>>();
    const pending = new Map<string, { stream: ExportIndexStream; span: [number, number] }>();
    /** 清单键 → 这一段的任务(索引里带的);旧节点的索引不带,那几段只靠「没有进展」那一条兜着 */
    const taskOf = new Map<string, Record<string, unknown>>();
    let total = 0;
    for (const id of want) {
      const s = listed.get(id)!;
      frames.set(id, new Map());
      total += s.lastFrame - s.originFrame + 1;
      for (const span of exportSpans(s)) {
        const key = `${s.resultKey}:${span[0]}-${span[1]}`;
        pending.set(key, { stream: s, span });
        const t = s.tasks.find((x) => x.id === `stream:${key}`);
        if (t) taskOf.set(key, t);
      }
    }
    const doneFrames = () => { let n = 0; for (const got of frames.values()) n += got.size; return n; };
    /** 这一段清单把它盖住的每一帧都列了才收(节点只在一段全推完之后写清单,不全的不该出现) */
    const covers = (got: Map<number, string>, s: ExportIndexStream, span: [number, number]) => {
      const first = s.originFrame + span[0] * STREAM_SEGMENT_FRAMES;
      const last = Math.min(s.lastFrame, s.originFrame + (span[1] + 1) * STREAM_SEGMENT_FRAMES - 1);
      for (let f = first; f <= last; f++) if (!got.has(f)) return false;
      return true;
    };
    let progressAt = now(), lastDone = 0, checkedAt = -Infinity;
    for (;;) {
      if (signal.aborted) throw cancelled();
      for (const [key, { stream, span }] of [...pending]) {
        let body: unknown = null;
        try {
          const r = await deps.request({ type: "content.get", kind: "render-manifest", key });
          body = r?.type === "content.item" && !r.missing ? r.body : null;
        } catch { body = null; }
        const got = readExportManifest(body, stream.resultKey, span);
        if (!got || !covers(got, stream, span)) continue;
        const into = frames.get(stream.clipId)!;
        for (const [f, hash] of got) if (f >= stream.originFrame && f <= stream.lastFrame) into.set(f, hash);
        pending.delete(key);
      }
      if (!pending.size) break;
      for (const [resultKey, error] of taskFailures) {
        if ([...pending.values()].some((p) => p.stream.resultKey === resultKey)) throw failed(failureText(error));
      }
      // 核对还没到的任务:原样再发布一次,看回包里的状态(失败的不会有通知;不在了的就此重建)
      if (now() - checkedAt >= taskCheckMs) {
        checkedAt = now();
        const tasks = [...pending.keys()].map((key) => taskOf.get(key)).filter((t): t is Record<string, unknown> => !!t);
        const results = tasks.length ? await publish(tasks) : null;
        for (const r of results?.values() ?? []) {
          if (r.error) continue;
          if (r.state === "failed") throw failed(failureText(taskFailures.get(String(r.id).split(":")[1] ?? "") ?? "task-failed"));
          // 有节点正认领着(或刚做完、清单还在路上):算有进展
          if (r.state === "claimed" || r.state === "done") progressAt = now();
        }
      }
      const done = doneFrames();
      if (done > lastDone) { lastDone = done; progressAt = now(); }
      if (now() - progressAt > stallMs) throw failed(ONLINE_EXPORT_TEXT.nodeStalled(stallMs));
      say({ phase: "rendering", clips: want.length, done, total });
      await sleep(EXPORT_MANIFEST_POLL_MS, signal);
    }
    const coverage = new Map<string, FrameCoverage>();
    for (const id of want) {
      const s = listed.get(id)!;
      coverage.set(id, { clipId: id, plane: s.plane, rect: s.rect, frames: new Set(frames.get(id)!.keys()) });
    }
    const stats = { fetched: 0, bytes: 0 };
    return {
      coverage, stats,
      async dataUrl(clipId, frame, sig) {
        const hash = frames.get(clipId)?.get(frame);
        if (!hash) throw new Error(ONLINE_EXPORT_TEXT.nodeFailed("frame-missing"));
        const base = deps.assetBase();
        if (!base) throw new Error("还没有远程素材服务");
        const f = deps.fetch ?? fetch;
        const res = await f(`${base.replace(/\/+$/, "")}/px/${hash}`, { headers: await deps.authHeaders(), signal: sig });
        if (!res.ok) throw new Error(`取不到渲染节点渲好的画面 ${hash.slice(0, 12)}:${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        stats.fetched++;
        stats.bytes += bytes.length;
        return `data:image/png;base64,${bytesToBase64(bytes)}`;
      },
    };
  } finally {
    throttleRecord.inFlight = false;
    throttleRecord.lastTime = now();
    try { off(); } catch { /* 订阅方坏了 */ }
  }
}
