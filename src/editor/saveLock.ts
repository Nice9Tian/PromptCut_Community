/**
 * Pause foreground editing while saving (`docs/semantics/mechanism/document-service.md` "Save
 * baseline and modified-state check":
 * "Saving temporarily disables foreground editing and waits for the local write to finish; on
 * failure it does not overwrite the last valid save, and editing is restored").
 *
 * "Foreground editing" is what the user does directly on this device: keyboard (including
 * shortcuts, typing and pressing Enter in the Agent panel), mouse and touch (click, drag, wheel,
 * right-click), file drag-and-drop, clipboard. While locked, these input events are intercepted in
 * the window capture phase (default action canceled, no further propagation), so none of the
 * editor's own handlers receive them: rather than greying out buttons, input is cut off at the
 * source, so shortcuts, drag-and-drop and Enter in the panel never reach the step that modifies the
 * project.
 *
 * Not intercepted here: "local writes that have already started", such as tools the local Agent is
 * running, asset ingestion and background tasks: saving has to **wait for them to finish**
 * (`io/localWrites.ts`), not block them; changes coming from other devices or the cloud are not
 * blocked either (semantics: "the whole cloud is not required to stop writing for a long time").
 * Release-type events (pointerup / mouseup / keyup / dragend, etc.) pass through: keys pressed and
 * drags started before the lock must be able to finish normally, otherwise the UI would get stuck
 * mid-drag.
 *
 * The lock starts after the destination is chosen ("Save as" needs a user gesture, so choosing the
 * destination must be the first await after the click; if the user clicks cancel in that dialog it
 * does not count as saving and does not lock), and lasts until saving ends: success, timeout
 * waiting for local writes, and disk write failure all unlock.
 */

/** Input events intercepted while locked */
export const BLOCKED_INPUT_EVENTS = [
  "keydown", "keypress", "beforeinput", "input", "compositionstart",
  "pointerdown", "mousedown", "touchstart", "click", "dblclick", "auxclick", "contextmenu", "wheel",
  "dragstart", "dragenter", "dragover", "drop",
  "paste", "cut",
  // The desktop app's title bar menu (undo, redo, new, open...) hands commands to the top bar
  // (`TopBar.tsx`) through this custom event
  "pc-titlebar-command",
] as const;

export type SaveKind = "proc" | "procp";

export interface SaveLockState {
  saving: boolean;
  kind: SaveKind | null;
  /** Which local writes are being waited on (for the "Saving" layer to show); empty while writing to disk */
  waiting: readonly string[];
  /** Which step it is at now: waiting for local writes / writing the file */
  step: "waiting" | "writing" | null;
}

const IDLE: SaveLockState = { saving: false, kind: null, waiting: [], step: null };
let state: SaveLockState = IDLE;
const listeners = new Set<() => void>();

function setState(next: SaveLockState) {
  state = next;
  for (const l of listeners) {
    try { l(); } catch { /* A subscriber's error does not affect saving */ }
  }
}

export function getSaveLockState(): SaveLockState {
  return state;
}

export function subscribeSaveLock(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** Whether a save is in progress (foreground editing paused) */
export function isSaveLocked(): boolean {
  return state.saving;
}

export interface SaveLock {
  /** Update "what is being waited on" */
  waiting(labels: readonly string[]): void;
  /** Enter the file-writing step */
  writing(): void;
  /** Unlock (can be called repeatedly) */
  end(): void;
}

/**
 * Lock. Returns null if a save is already in progress (clicking save again during a save: don't
 * start another one).
 * The caller must `end()` in a finally.
 */
export function beginSaveLock(kind: SaveKind): SaveLock | null {
  if (state.saving) return null;
  installSaveInputGuard();
  // If focus is in an input, blur it before locking: what the input commits on blur (text already
  // typed) lands before the save
  try {
    const active = (globalThis as { document?: { activeElement?: { blur?: () => void } | null } }).document?.activeElement;
    active?.blur?.();
  } catch { /* No DOM (tests) or the focused element refuses to blur: locking is not affected */ }
  // Dismiss the prompt card left by the previous save: this save's result is a separate matter
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

/* ── Input interception ─────────────────────────────────────── */

const guarded = new WeakSet<object>();

function swallow(e: Event) {
  if (!state.saving) return;
  if (e.cancelable) e.preventDefault();
  e.stopImmediatePropagation();
}

/**
 * Attach the interception in the window capture phase (idempotent). It is attached at module load:
 * the capture-phase window is the first stop on the event path, and the earlier it is attached, the
 * earlier it sits ahead of the other listeners at the same stop. When not locked it does nothing.
 */
export function installSaveInputGuard(target: EventTarget | undefined = (globalThis as { window?: EventTarget }).window): void {
  if (!target || guarded.has(target)) return;
  guarded.add(target);
  for (const type of BLOCKED_INPUT_EVENTS) target.addEventListener(type, swallow, { capture: true });
}

installSaveInputGuard();

/* ── Save result prompts ────────────────────────────────────── */

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
    try { l(); } catch { /* Same as above */ }
  }
}

export function dismissSaveNotice(): void {
  showSaveNotice(null);
}
