/**
 * 保存时暂停前台编辑(`docs/semantics/mechanism/document-service.md`「保存基准与修改状态检查」:
 * 「保存暂时禁用前台编辑，等待本机写完；失败不覆盖上次有效保存，并恢复编辑」)。
 *
 * 「前台编辑」是用户在这台设备上直接动手的那些:键盘(含快捷键、Agent 面板里打字回车)、鼠标与触摸(点、拖、滚轮、右键)、
 * 拖放文件、剪贴板。上锁期间这些输入事件在 window 的捕获阶段就被拦下(取消缺省动作、不再往下传),编辑器自己的处理函数
 * 一个都收不到 —— 不是把按钮置灰,而是从输入源头掐断,快捷键、拖放、面板里的回车都走不到改项目那一步。
 *
 * 不在这里拦的:本机 Agent 正在跑的工具、素材入库、后台任务这类「已经开始的本机写入」—— 保存要**等它们写完**
 * (`io/localWrites.ts`),不是拦住它们;别的设备、云端来的修改也不拦(语义:「不要求整个云端长期停写」)。
 * 抬手类事件(pointerup / mouseup / keyup / dragend 等)放行:锁上之前按下的键、开始的拖动要能正常收尾,不然界面会卡在拖动中。
 *
 * 锁从挑好落点之后开始(「另存为」要用户手势,挑落点必须是点击后的第一个 await,用户在那个对话框里点取消就不算保存、
 * 不上锁),到保存结束为止 —— 成功、等本机写入超时、写盘失败都解锁。
 */

/** 上锁期间拦下的输入事件 */
export const BLOCKED_INPUT_EVENTS = [
  "keydown", "keypress", "beforeinput", "input", "compositionstart",
  "pointerdown", "mousedown", "touchstart", "click", "dblclick", "auxclick", "contextmenu", "wheel",
  "dragstart", "dragenter", "dragover", "drop",
  "paste", "cut",
  // 桌面版标题栏菜单(撤销、重做、新建、打开……)经这个自定义事件把命令交给顶栏(`TopBar.tsx`)
  "pc-titlebar-command",
] as const;

export type SaveKind = "proc" | "procp";

export interface SaveLockState {
  saving: boolean;
  kind: SaveKind | null;
  /** 正在等哪几样本机写入(给「正在保存」那一层看);写盘时为空 */
  waiting: readonly string[];
  /** 现在在哪一步:等本机写入 / 写文件 */
  step: "waiting" | "writing" | null;
}

const IDLE: SaveLockState = { saving: false, kind: null, waiting: [], step: null };
let state: SaveLockState = IDLE;
const listeners = new Set<() => void>();

function setState(next: SaveLockState) {
  state = next;
  for (const l of listeners) {
    try { l(); } catch { /* 订阅方出错不影响保存 */ }
  }
}

export function getSaveLockState(): SaveLockState {
  return state;
}

export function subscribeSaveLock(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** 现在是不是在保存(前台编辑暂停中) */
export function isSaveLocked(): boolean {
  return state.saving;
}

export interface SaveLock {
  /** 更新「正在等什么」 */
  waiting(labels: readonly string[]): void;
  /** 进入写文件这一步 */
  writing(): void;
  /** 解锁(可重复调用) */
  end(): void;
}

/**
 * 上锁。已经在保存时回 null(保存进行中再点一次保存:不另起一次)。
 * 调用方必须在 finally 里 `end()`。
 */
export function beginSaveLock(kind: SaveKind): SaveLock | null {
  if (state.saving) return null;
  installSaveInputGuard();
  // 焦点留在输入框里的话,上锁前先让它失焦:输入框在失焦时提交的那一笔(已经打完的字)赶在保存之前落地
  try {
    const active = (globalThis as { document?: { activeElement?: { blur?: () => void } | null } }).document?.activeElement;
    active?.blur?.();
  } catch { /* 没有 DOM(测试)或焦点元素不让失焦:不影响上锁 */ }
  // 上一次保存留下的提示卡收起来:这一次的结果另说
  showSaveNotice(null);
  setState({ saving: true, kind, waiting: [], step: "waiting" });
  let ended = false;
  return {
    waiting(labels) {
      if (ended) return;
      setState({ ...state, waiting: [...labels], step: "waiting" });
    },
    writing() {
      if (ended) return;
      setState({ ...state, waiting: [], step: "writing" });
    },
    end() {
      if (ended) return;
      ended = true;
      setState(IDLE);
    },
  };
}

/* ── 输入拦截 ──────────────────────────────────────────────── */

const guarded = new WeakSet<object>();

function swallow(e: Event) {
  if (!state.saving) return;
  if (e.cancelable) e.preventDefault();
  e.stopImmediatePropagation();
}

/**
 * 在 window 的捕获阶段挂上拦截(幂等)。模块载入时就挂:捕获阶段的 window 是事件路径上的第一站,
 * 挂得越早越排在同一站的其它监听前面。没上锁时它什么都不做。
 */
export function installSaveInputGuard(target: EventTarget | undefined = (globalThis as { window?: EventTarget }).window): void {
  if (!target || guarded.has(target)) return;
  guarded.add(target);
  for (const type of BLOCKED_INPUT_EVENTS) target.addEventListener(type, swallow, { capture: true });
}

installSaveInputGuard();

/* ── 保存的结果提示 ────────────────────────────────────────── */

export interface SaveNotice {
  tone: "error" | "info";
  title: string;
  message: string;
}

let notice: SaveNotice | null = null;
const noticeListeners = new Set<() => void>();

export function getSaveNotice(): SaveNotice | null {
  return notice;
}

export function subscribeSaveNotice(l: () => void): () => void {
  noticeListeners.add(l);
  return () => { noticeListeners.delete(l); };
}

export function showSaveNotice(next: SaveNotice | null): void {
  notice = next;
  for (const l of noticeListeners) {
    try { l(); } catch { /* 同上 */ }
  }
}

export function dismissSaveNotice(): void {
  showSaveNotice(null);
}
