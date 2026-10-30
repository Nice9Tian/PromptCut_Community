/**
 * 在线双舞台两个跨源舞台的**首次握手**计时(C10 契约第 2 节;语义 `mechanism/rendering.md`「舞台」)。
 *
 * 以前的做法:编辑台一挂上舞台就开一个 `STAGE_HANDSHAKE_TIMEOUT_MS`(20 秒)的定时器,到点两台没都握上就退回同源单舞台,
 * 本页会话内不再回到双舞台。慢网络下(2026-09-30 阿里云,舞台页主脚本 4.26 MB、约 90～280 KB/s)单个舞台光下载就要
 * 15～46 秒,舞台根本没坏也被判握手失败,页面从此只能是单舞台,不能当纯浏览器节点(`browserNode.ts` 的 `single-stage`)。
 *
 * 现在的做法〔裁:2026-09-30 `claude/stage-handshake`〕:
 *
 * - **每一台各自计时,从那一台 iframe 的 `load` 起算**:`load` 跨源也会触发,舞台页的主脚本执行完才触发(模块脚本是延后
 *   执行的),而舞台在挂载的 effect 里就发 `pc-stage-ready`,所以「加载完」到「握手」本来只差一点点。加载完
 *   `STAGE_HANDSHAKE_TIMEOUT_MS` 还没握上 = 舞台真坏了,照旧退回。舞台源回错误页(5xx)、连不上时 iframe 同样触发 `load`,
 *   于是这两种坏法仍在约 20 秒后退回,和原来差不多。同一台又 `load` 一次(重载)就重新起算。
 * - **总上限**:自打开(本计时器建起)起 `STAGE_HANDSHAKE_TOTAL_MS` 仍没两台都握上,照样退回(「不许开不出画面」的兜底:
 *   舞台页一直不 `load` 的情况也有尽头)。
 * - **过渡的同源单舞台**(「不许开不出画面」):自打开起 `STAGE_INTERIM_AFTER_MS`(20 秒,与原来退回的时刻相同)可见舞台
 *   (`ids[0]`,即 A)还没握上,就报 `interim`:调用方先按同源单舞台出画面,原来那两个跨源 iframe 不拆、改作隐藏的预热
 *   iframe 继续加载(主脚本下完进了 HTTP 缓存,`/editor/assets/` 是长缓存)。计时照旧:预热的那两台照样报 `loaded` /
 *   `ready`,两台都握上就 `ok`(调用方换回双舞台,只换一次);某一台加载完 20 秒没握上,或到总上限,就 `fail`(留在单舞台)。
 * - 两台都握上之后本计时器收摊,之后断开由 `stageWatch.ts` 看守(那边的数字不变)。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor,定时器可注入(单测用假时钟)。
 */
import { STAGE_HANDSHAKE_TIMEOUT_MS, type StageLetter } from "./stageOrigins.ts";

/**
 * 自打开起等两台都握上手的总上限〔裁〕。取 2 分钟:阿里云最慢那一档(约 90 KB/s)下,舞台页主脚本不压缩时两台依次各约 47 秒,
 * 压缩后(1.33 MB)各约 15 秒,都落在 2 分钟里;再慢的网络先保证出画面,退回同源单舞台。
 */
export const STAGE_HANDSHAKE_TOTAL_MS = 120_000;
/** 自打开起这么久可见舞台还没握上,先用同源单舞台出画面(与原来退回单舞台的时刻相同,等待期间的空白不比原来长) */
export const STAGE_INTERIM_AFTER_MS = 20_000;

type Timer = unknown;

export interface StageHandshakeDeps {
  ids: readonly StageLetter[];
  /** 握不上手:退回同源单舞台(`markStageHandshake("failed", reason)`) */
  fail(reason: string): void;
  /** 两台都握上手了(`markStageHandshake("ok")`) */
  ok?(): void;
  /** 可见舞台(`ids[0]`)到 `interimMs` 还没握上:先用同源单舞台出画面、跨源的两台改作预热(`markStageHandshake("interim")`)。不给就没有这一步 */
  interim?(reason: string): void;
  /** 缺省 `STAGE_INTERIM_AFTER_MS` */
  interimMs?: number;
  /** 每台从 `load` 起等握手的时限,缺省 `STAGE_HANDSHAKE_TIMEOUT_MS` */
  perStageMs?: number;
  /** 自打开起的总上限,缺省 `STAGE_HANDSHAKE_TOTAL_MS` */
  totalMs?: number;
  now?(): number;
  setTimer?(fn: () => void, ms: number): Timer;
  clearTimer?(t: Timer): void;
}

export type StageHandshakePhase = "waiting" | "interim" | "ok" | "failed" | "disposed";

export interface StageHandshakeSlot {
  /** 最近一次 `load` 的时刻(相对打开);没 `load` 过为 null */
  loadedAt: number | null;
  /** 握手的时刻(相对打开);没握上为 null */
  readyAt: number | null;
  /** `load` 了几次 */
  loads: number;
}

export interface StageHandshake {
  /** 这一台 iframe 触发了 `load`(新文档加载完):开始 / 重新起算它的握手时限 */
  loaded(id: StageLetter): void;
  /** 这一台握上手了(`pc-stage-ready`) */
  ready(id: StageLetter): void;
  readonly phase: StageHandshakePhase;
  /** 诊断 */
  status(): { phase: StageHandshakePhase; elapsedMs: number; interimAt: number | null; slots: Record<string, StageHandshakeSlot>; reason: string | null };
  dispose(): void;
}

export function createStageHandshake(deps: StageHandshakeDeps): StageHandshake {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const perStageMs = deps.perStageMs ?? STAGE_HANDSHAKE_TIMEOUT_MS;
  const totalMs = deps.totalMs ?? STAGE_HANDSHAKE_TOTAL_MS;
  const t0 = now();
  let phase: StageHandshakePhase = "waiting";
  let reason: string | null = null;
  let interimAt: number | null = null;
  const interimMs = deps.interimMs ?? STAGE_INTERIM_AFTER_MS;
  const front = deps.ids[0];
  const live = () => phase === "waiting" || phase === "interim";
  const slots = new Map<StageLetter, StageHandshakeSlot & { deadline: Timer | null }>();
  for (const id of deps.ids) slots.set(id, { loadedAt: null, readyAt: null, loads: 0, deadline: null });

  const clearAll = () => {
    clearTimer(total);
    if (interimTimer !== null) clearTimer(interimTimer);
    for (const s of slots.values()) if (s.deadline !== null) { clearTimer(s.deadline); s.deadline = null; }
  };
  const summary = () => {
    const got = deps.ids.filter((id) => slots.get(id)!.readyAt !== null);
    const loaded = deps.ids.filter((id) => slots.get(id)!.loadedAt !== null);
    return `握上手的舞台:${got.join("、") || "无"};加载完的舞台:${loaded.join("、") || "无"}`;
  };
  const failWith = (why: string) => {
    if (!live()) return;
    phase = "failed";
    reason = `${why}(${summary()})`;
    clearAll();
    deps.fail(reason);
  };

  const total: Timer = setTimer(() => failWith(`打开 ${Math.round(totalMs / 1000)} 秒内两个舞台没都握上手`), totalMs);
  const interimTimer: Timer | null = deps.interim ? setTimer(() => {
    if (phase !== "waiting" || slots.get(front)!.readyAt !== null) return;
    phase = "interim";
    interimAt = now() - t0;
    deps.interim!(`可见舞台 ${front} 挂上 ${Math.round(interimMs / 1000)} 秒没握上手,先用同源单舞台出画面、预热两个舞台源(${summary()})`);
  }, interimMs) : null;

  return {
    loaded(id) {
      const s = slots.get(id);
      if (!s || !live() || s.readyAt !== null) return;
      s.loads++;
      s.loadedAt = now() - t0;
      if (s.deadline !== null) clearTimer(s.deadline);
      s.deadline = setTimer(() => {
        s.deadline = null;
        if (s.readyAt === null) failWith(`舞台 ${id} 加载完 ${Math.round(perStageMs / 1000)} 秒没握上手`);
      }, perStageMs);
    },
    ready(id) {
      const s = slots.get(id);
      if (!s || !live()) return;
      if (s.readyAt === null) s.readyAt = now() - t0;
      if (s.deadline !== null) { clearTimer(s.deadline); s.deadline = null; }
      if (deps.ids.every((x) => slots.get(x)!.readyAt !== null)) {
        phase = "ok";
        clearAll();
        deps.ok?.();
      }
    },
    get phase() { return phase; },
    status() {
      const out: Record<string, StageHandshakeSlot> = {};
      for (const [id, s] of slots) out[id] = { loadedAt: s.loadedAt, readyAt: s.readyAt, loads: s.loads };
      return { phase, elapsedMs: now() - t0, interimAt, slots: out, reason };
    },
    dispose() {
      if (live()) phase = "disposed";
      clearAll();
    },
  };
}
