/**
 * Start gate for measurement (online browser mode; companion to section 9, "Recognition", of the C10
 * contract).
 *
 * After an online page opens, the user cards synced into the content store are only recognized once the
 * card sources have finished their first sync (`sync/onlineCardSources.ts`). Before that they are
 * treated as unknown ids, so measurement (the resident probe in `probeRunner.ts`, the single-stage bounds
 * search) may measure one on a background stage and record a cost entry for it. So measurement on the online
 * page waits on this gate: it opens once the first card source sync completes (success, or an error reply);
 * if there is no reply at all, it waits at most `MEASURE_GATE_MAX_MS` and then starts as usual.
 *
 * **Per connection**: the gate is opened for one specific shared project connection. When the connection
 * changes (switching projects, reconnecting to another project, leaving and re-entering: the sync table is
 * cleared and refetched), the gate closes again the next time it is queried, until the new connection's first
 * card source sync has a result, again waiting at most `MEASURE_GATE_MAX_MS`. The connection is supplied by
 * `setMeasureGateLink` (the online page's `Preview` wires it to `currentSharedLink()`); with no connection
 * (null) the gate does not re-close.
 *
 * **Then wait for the first load of synced cards to have a result** (section 6 of
 * `docs/plan/online-card-exec-contract.md`): when this page can execute synced user cards, after the card
 * sources finish syncing they still have to be transpiled and handed to the stage to load; until then their
 * runtime state is `loading` and they have no cost identity yet. The gate waits until no card is `loading`
 * (success or failure both count as a result) before opening, so the first round of measurement does not miss
 * them when queued and the UI does not first lay out as "not measured". It is still capped by the same
 * `MEASURE_GATE_MAX_MS`; cards that load successfully only after the gate has opened get a separate follow-up
 * measurement round queued by the runtime state notification (`ProbeGate.tsx`). When this page cannot execute
 * and no card is `loading`, this step has no effect.
 *
 * The desktop runtime (not the online page) is open from the start and is not closed per connection. In Node
 * unit tests `onlinePage()` is always false, so the gate is likewise open.
 */
import { onlinePage } from "../online/pageFlag";
import { anyCardLoading, onCardRunStatesChanged } from "../kernel/registry";

/** Maximum time (ms) to wait for the first card source sync; after that, measurement starts as usual */
export const MEASURE_GATE_MAX_MS = 10_000;

export type MeasureGateReason = "desktop" | "synced" | "failed" | "timeout";

type Timer = ReturnType<typeof setTimeout>;
let state: "unset" | "held" | "open" = "unset";
let timer: Timer | null = null;
let waiters: Array<() => void> = [];
/** The current shared project connection (`setMeasureGateLink`); not given = do not close per connection */
let linkOf: (() => unknown) | null = null;
/** Which connection the gate was opened for / is currently waiting for */
let openFor: unknown = null;
let heldFor: unknown = null;
let maxMs = MEASURE_GATE_MAX_MS;
/**
 * Card sources have finished syncing and only the first load of synced cards is pending: record that
 * sync's outcome, and open once the runtime state has no `loading`
 */
let pendingRelease: { ok: boolean; link: unknown } | null = null;
let offRunStates: (() => void) | null = null;
let cardLoading: () => boolean = anyCardLoading;
const diag = { heldAt: null as number | null, openedAt: null as number | null, reason: null as MeasureGateReason | null, holds: 0, links: 0, confirmedAt: null as number | null };
/** Unit tests can replace the timer and the clock */
let clock: { now: () => number; setTimer: (fn: () => void, ms: number) => Timer; clearTimer: (t: Timer) => void } = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
};

function currentLink(): unknown {
  if (!linkOf) return null;
  try { return linkOf() ?? null; } catch { return null; }
}

function open(reason: MeasureGateReason, link: unknown = currentLink() ?? heldFor): void {
  if (state === "open") return;
  state = "open";
  pendingRelease = null;
  if (timer !== null) clock.clearTimer(timer);
  timer = null;
  if (link !== null && link !== openFor) diag.links++;
  openFor = link;
  if (reason === "synced" || reason === "failed") diag.confirmedAt = clock.now();
  diag.openedAt = clock.now();
  diag.reason = reason;
  const list = waiters;
  waiters = [];
  for (const w of list) { try { w(); } catch { /* A broken waiter does not affect the others */ } }
}

function hold(link: unknown, ms: number): void {
  state = "held";
  pendingRelease = null;
  heldFor = link;
  diag.holds++;
  diag.heldAt = clock.now();
  diag.openedAt = null;
  diag.reason = null;
  if (timer !== null) clock.clearTimer(timer);
  timer = clock.setTimer(() => { timer = null; open("timeout"); }, Math.max(0, ms));
}

/** Before querying the gate: on the first press, whether this is an online page sets the initial value; if an online page's connection changes, close the gate again */
function check(): void {
  if (state === "unset") {
    if (onlinePage()) holdMeasureForCardSources();
    else open("desktop", null);
    return;
  }
  if (state === "open" && diag.reason !== "desktop") {
    const link = currentLink();
    if (link !== null && link !== openFor) hold(link, maxMs);
  }
}

/** Where to get the current shared project connection (wired up by the online page's `Preview`; when the connection changes, the gate re-closes for the new connection) */
export function setMeasureGateLink(fn: (() => unknown) | null): void {
  linkOf = fn;
}

/**
 * Close the gate and wait for card sources (called by the online page's `Preview` when it starts syncing
 * card sources; does nothing if the gate has already opened. Re-closing after a connection change is decided
 * when the gate is queried).
 * From this moment it waits at most `ms`, then opens by itself.
 */
export function holdMeasureForCardSources(ms: number = MEASURE_GATE_MAX_MS): void {
  if (state !== "unset") return;
  maxMs = ms;
  hold(currentLink(), ms);
}

/**
 * The first card source sync has a result: `ok` true means the sync completed, false means it replied with
 * a failure. Both open the gate.
 * `link` is the connection used for this sync: if it is not the current connection (it changed again by the
 * time the sync returned) it does not count; if the gate is already open, record that it was opened for this
 * connection.
 */
export function releaseMeasureGate(ok: boolean, link?: unknown): void {
  if (link !== undefined && linkOf && link !== currentLink()) return;
  if (state === "open") {
    // The new connection's card sources finished syncing while the gate was open (nobody has queried yet): record that it was opened for this connection, and do not close for it afterwards
    if (link !== undefined && diag.reason !== "desktop") {
      if (link !== null && link !== openFor) diag.links++;
      openFor = link;
      diag.confirmedAt = clock.now();
    }
    return;
  }
  if (state === "unset") state = "held";
  const target = link !== undefined ? link : currentLink() ?? heldFor;
  if (cardLoading()) {
    // Synced cards are still being transpiled or loaded: do not open yet, wait until they have a result
    // (`settleCardLoading`); the timer keeps running and opens the gate when it fires
    pendingRelease = { ok, link: target };
    offRunStates ??= onCardRunStatesChanged(settleCardLoading);
    return;
  }
  open(ok ? "synced" : "failed", target);
}

/** Runtime state changed: if card sources have finished syncing and no card is still loading, open the gate */
function settleCardLoading(): void {
  if (!pendingRelease || state === "open" || cardLoading()) return;
  const { ok, link } = pendingRelease;
  pendingRelease = null;
  open(ok ? "synced" : "failed", link);
}

/** Whether the gate is open (the first query sets the initial value by whether this is the online page; on the online page, re-close if the connection changed) */
export function measureGateOpen(): boolean {
  check();
  return state === "open";
}

/** Wait until the gate opens (returns immediately if it is already open) */
export function whenMeasureGateOpen(): Promise<void> {
  check();
  if (state === "open") return Promise.resolve();
  return new Promise((resolve) => { waiters.push(resolve); });
}

/**
 * For diagnostics and probes. `holds`: how many times the gate has closed (the connection changed and the new
 * connection had not finished syncing when the gate was queried; each re-close adds one); `links`: for how
 * many connections the gate has opened (opening the gate, or the new connection syncing first while the gate
 * is open, both count); `confirmedAt`: the time of the latest card source sync that produced a result.
 */
export function measureGateDiag() {
  return { state, heldAt: diag.heldAt, openedAt: diag.openedAt, reason: diag.reason, holds: diag.holds, links: diag.links, confirmedAt: diag.confirmedAt,
    waitedMs: diag.openedAt !== null && diag.heldAt !== null ? diag.openedAt - diag.heldAt : null };
}

/** For unit tests: return to the freshly loaded state; the timer and the clock can be replaced */
export function resetMeasureGate(next?: Partial<typeof clock> & { cardLoading?: () => boolean }): void {
  if (timer !== null) clock.clearTimer(timer);
  timer = null;
  state = "unset";
  pendingRelease = null;
  offRunStates?.();
  offRunStates = null;
  cardLoading = next?.cardLoading ?? anyCardLoading;
  waiters = [];
  linkOf = null;
  openFor = null;
  heldFor = null;
  maxMs = MEASURE_GATE_MAX_MS;
  diag.heldAt = null;
  diag.openedAt = null;
  diag.reason = null;
  diag.holds = 0;
  diag.links = 0;
  diag.confirmedAt = null;
  clock = {
    now: next?.now ?? (() => Date.now()),
    setTimer: next?.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: next?.clearTimer ?? ((t) => clearTimeout(t)),
  };
}
