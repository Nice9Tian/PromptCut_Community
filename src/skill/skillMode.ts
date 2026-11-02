/**
 * SKILL mode on the frontend side: subscribe to state, toggle, and notify the desktop shell to morph.
 *
 * SKILL is one of two working modes (`user-workflow.md` "Working mode"): the Agent in the desktop app
 * directly connects to this project via MCP (plan `docs/plan/agent-workflow-plan.md` A4). The toggle
 * only decides whether desktop app sessions can make changes (server-side SKILL gate,
 * `server/skill-gate.mjs`); the AI panel Agent is usable in both modes.
 *
 * The source of truth is that state file on the server, not variables here: the Rust shell is
 * a separate process, and only that file serves as an agreed-upon place for both sides. It only does
 * three things: query once per second, deliver results to subscribers, and notify the shell whenever
 * state changes.
 *
 * Why polling instead of SSE: the shell is already polling the same file (Rust lacks the web's event
 * stream machinery), and adding a separate push mechanism in the frontend would only cause desynced
 * timestamps between both sides. A JSON request once per second is dirt cheap.
 */
import { onlinePage } from "../online/pageFlag";
import { tr } from "../i18n/index.ts";

export interface SkillState {
  active: boolean;
  since: string | null;
  closedAt: string | null;
  closedBy: string | null;
}

export interface SkillSnapshot {
  state: SkillState;
}

const CLOSED: SkillState = { active: false, since: null, closedAt: null, closedBy: null };

let snapshot: SkillSnapshot = { state: CLOSED };
const listeners = new Set<(s: SkillSnapshot) => void>();
let timer: number | null = null;
/** Last state notified to the shell; only emits events when it actually flips */
let lastNotified: boolean | null = null;

function emit() {
  for (const fn of listeners) fn(snapshot);
}

/**
 * Tells the desktop shell "entered/exited SKILL mode".
 *
 * Upon receiving it, the shell collapses the main window and turns into a floating icon in the
 * top-right corner (and restores conversely). Uses window.__TAURI__ events, following the same
 * path as "Appearance → Skin…"; does nothing if not running in the desktop app, working as usual
 * in the browser.
 */
function notifyShell(active: boolean) {
  if (lastNotified === active) return;
  lastNotified = active;
  const tauri = (window as unknown as {
    __TAURI__?: { event?: { emit?: (e: string, payload?: unknown) => Promise<unknown> } };
  }).__TAURI__;
  void tauri?.event?.emit?.("pc-skill-mode", { active, at: new Date().toISOString() })?.catch?.(() => {});
}

async function poll() {
  // Online browser mode has no SKILL mode (requires local editor process): do not query
  if (onlinePage()) return;
  try {
    const res = await fetch("/api/skill-mode");
    const data = await res.json();
    if (data?.ok) {
      const s = data.state ?? {};
      snapshot = { state: { ...CLOSED, active: s.active === true, since: s.since ?? null, closedAt: s.closedAt ?? null, closedBy: s.closedBy ?? null } };
      notifyShell(snapshot.state.active);
      emit();
    }
  } catch {
    /* dev server is down / restarting; ask again next second without turning UI into an error */
  }
}

export function subscribeSkill(fn: (s: SkillSnapshot) => void): () => void {
  listeners.add(fn);
  fn(snapshot);
  if (timer === null) {
    void poll();
    timer = window.setInterval(() => void poll(), 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function getSkillSnapshot(): SkillSnapshot {
  return snapshot;
}

async function post(path: string, body: unknown, what: string): Promise<void> {
  // Timeouts, non-2xx, and server failures are thrown to reset the button and display the reason
  // (previously without checking responses, the button would stay stuck at "… in progress")
  let res: Response;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw new Error(tr("{0} request was not sent: {1}", what, e instanceof Error ? e.message : String(e)));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new Error(tr("{0} request was rejected (HTTP {1}): {2}", what, res.status, data?.error ?? tr("the server gave no reason")));
  }
}

/** Enable: user switches to SKILL in top bar. Afterward, desktop app sessions can make changes */
export async function openSkillMode(): Promise<void> {
  await post("/api/skill-mode/open", {}, tr("Open SKILL mode"));
  await poll();
}

/**
 * Disable: user switches back to Classic mode. Afterward, any tool call from desktop app
 * sessions is rejected (AI panel Agent is not affected)
 */
export async function closeSkillMode(by = "user"): Promise<void> {
  await post("/api/skill-mode/close", { by }, tr("Close SKILL mode"));
  await poll();
  if (snapshot.state.active) {
    throw new Error(tr("The close request succeeded, but the server still reports SKILL mode as on. Another instance may be changing the state at the same time, try again"));
  }
}
