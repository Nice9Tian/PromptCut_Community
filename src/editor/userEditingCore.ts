/**
 * 「用户正在编辑」的汇总与节流(计划 docs/plan/agent-workflow-plan.md A2;语义 user-workflow.md「保护」)。
 * 纯逻辑,不碰 store、不发请求:接线在 ./userEditing.ts,测试在 ./userEditingCore.test.mjs。
 *
 * 口径(计划第 4 节第 1 条〔裁〕):一个片段(卡片也是片段)算「正在编辑」,当且仅当
 *   - 拖动中(时间轴拖动 / 改时长、舞台上移动、字幕条拖动),或
 *   - 文字编辑中(舞台上改字、字幕双击改字),或
 *   - 选中着,且选中期间用户动过它、离最后一次动不到 30 秒。
 * 只选中不动不算;取消选中后「动过」的记录作废。
 *
 * 推送:状态一变就推(前沿立即发,之后至多每 250 ms 一次,窗口到点发最新一份 —— 拖动时不会每帧发);
 * 非空时每 5 秒心跳一次,服务端 15 秒收不到续期就当页面走了;「刚动过」的条目带剩余毫秒数,到点自动掉出。
 */

export type EditingKind = "drag" | "text" | "recent";

export interface EditingEntity {
  clipId: string;
  kind: EditingKind;
  /** 只有 recent 带:离 30 秒到期还剩多少毫秒 */
  remainingMs?: number;
}

export const USER_EDITING_TIMING = Object.freeze({
  /** 选中后动过,多久之内算「正在编辑」 */
  recentMs: 30_000,
  /** 两次推送之间至少隔多久 */
  throttleMs: 250,
  /** 非空时多久心跳一次(服务端的过期时间是它的 3 倍,见 server/agent/user-editing.mjs 的 ttlMs) */
  heartbeatMs: 5_000,
});

const RANK: Record<EditingKind, number> = { drag: 0, text: 1, recent: 2 };

export interface EditingTrackerOptions {
  send: (entities: EditingEntity[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  recentMs?: number;
  throttleMs?: number;
  heartbeatMs?: number;
}

export interface EditingTracker {
  /** 某个界面位置(slot)开始 / 结束拖动或文字编辑某个片段;clipId 为 null 表示结束 */
  setActive(slot: string, clipId: string | null, kind: "drag" | "text"): void;
  /** 当前选区(第一个是主选) */
  setSelection(ids: readonly string[]): void;
  /** 用户这次修改动到的片段(调用方已排除 Agent 让页面执行的修改) */
  touch(ids: readonly string[]): void;
  /** 此刻的完整状态 */
  snapshot(): EditingEntity[];
  /** 发送开关:关着时只记状态不发;打开时立刻补发一次 */
  setEnabled(on: boolean): void;
  dispose(): void;
}

export function createEditingTracker(o: EditingTrackerOptions): EditingTracker {
  const now = o.now ?? (() => Date.now());
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const recentMs = o.recentMs ?? USER_EDITING_TIMING.recentMs;
  const throttleMs = o.throttleMs ?? USER_EDITING_TIMING.throttleMs;
  const heartbeatMs = o.heartbeatMs ?? USER_EDITING_TIMING.heartbeatMs;

  /** slot → { clipId, kind } */
  const active = new Map<string, { clipId: string; kind: "drag" | "text" }>();
  let selection: string[] = [];
  /** clipId → 最后一次动过的时刻(只记选中着的) */
  const touched = new Map<string, number>();

  let enabled = false;
  let disposed = false;
  let lastKey = "[]";
  let lastSentAt = -Infinity;
  let timer: unknown = null;
  let timerAt = Infinity;

  function snapshot(): EditingEntity[] {
    const t = now();
    const byClip = new Map<string, EditingEntity>();
    for (const { clipId, kind } of active.values()) {
      const old = byClip.get(clipId);
      if (!old || RANK[kind] < RANK[old.kind]) byClip.set(clipId, { clipId, kind });
    }
    for (const id of selection) {
      const at = touched.get(id);
      if (at === undefined || byClip.has(id)) continue;
      const left = at + recentMs - t;
      if (left > 0) byClip.set(id, { clipId: id, kind: "recent", remainingMs: left });
    }
    return [...byClip.values()].sort((a, b) => (a.clipId < b.clipId ? -1 : a.clipId > b.clipId ? 1 : 0));
  }

  /** 比较用的键:不含剩余毫秒(它每一刻都在变) */
  const keyOf = (list: EditingEntity[]) => JSON.stringify(list.map((e) => [e.clipId, e.kind]));

  function arm(at: number) {
    if (disposed) return;
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) clearTimer(timer);
    timerAt = at;
    timer = setTimer(() => { timer = null; timerAt = Infinity; flush(); }, Math.max(0, at - now()));
  }

  /** 下一次该醒来的时刻:心跳、最早到期的「刚动过」 */
  function nextWake(list: EditingEntity[]): number {
    let at = Infinity;
    if (list.length) at = lastSentAt + heartbeatMs;
    for (const e of list) if (e.kind === "recent" && e.remainingMs !== undefined) at = Math.min(at, now() + e.remainingMs + 1);
    return at;
  }

  function flush() {
    if (disposed || !enabled) return;
    const t = now();
    const list = snapshot();
    const key = keyOf(list);
    const changed = key !== lastKey;
    const heartbeatDue = list.length > 0 && t - lastSentAt >= heartbeatMs;
    if (changed || heartbeatDue) {
      if (t - lastSentAt < throttleMs) { arm(lastSentAt + throttleMs); return; }
      lastKey = key;
      lastSentAt = t;
      try { o.send(list); } catch { /* 发不出去就等下一次 */ }
    }
    const wake = nextWake(list);
    if (wake < Infinity) arm(wake);
  }

  return {
    setActive(slot, clipId, kind) {
      if (clipId) {
        const cur = active.get(slot);
        if (cur && cur.clipId === clipId && cur.kind === kind) return;
        active.set(slot, { clipId, kind });
      } else if (!active.delete(slot)) return;
      flush();
    },
    setSelection(ids) {
      const next = ids.filter((x) => typeof x === "string");
      if (next.length === selection.length && next.every((x, i) => x === selection[i])) return;
      selection = next;
      // 取消选中的片段,「动过」的记录作废
      for (const id of [...touched.keys()]) if (!next.includes(id)) touched.delete(id);
      flush();
    },
    touch(ids) {
      const t = now();
      let any = false;
      for (const id of ids) {
        if (!selection.includes(id)) continue;
        touched.set(id, t);
        any = true;
      }
      if (any) flush();
    },
    snapshot,
    setEnabled(on) {
      enabled = on;
      if (on) { lastKey = "\u0000"; flush(); }
      else if (timer !== null) { clearTimer(timer); timer = null; timerAt = Infinity; }
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
