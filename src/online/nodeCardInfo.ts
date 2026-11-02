/**
 * Registry of "what can run" on this page when a pure browser node executes user cards and
 * media effect cards (Block N, `docs/plan/online-card-exec-contract.md` Section 7 items 1 and 3).
 *
 * Three parties use it:
 *   - Write: `src/editor/nodeCardInfoLive.ts` calculates and writes values based on the run state
 *     and code identity of each synced card in the registry (`setNodeCardInfo`);
 *     `cardEnvFingerprint` returned by the document service after node check-in is also recorded
 *     here (`setNodeCardEnvFingerprint`);
 *   - Read: `browserNode.ts` (`node.hello` reports runtime version; capability bits and
 *     `cardSourceVersions` are used for node-side filtering), `planPublisher.ts` (`input.browser`
 *     in manifest plan, based on which the splitter decides whether to emit user cards and
 *     media effect cards for the browser).
 *
 * In-memory only, does not inspect environment or touch stage: pure data plus subscriptions,
 * loaded directly by Node unit tests. Belongs to the render layer (`src/online/`).
 *
 * # "Do not report for a short period after generation change"
 *
 * When a synced card updates a version (a file changed), its code identity does not count within
 * `NODE_CARD_SETTLE_MS` (following the rationale of desktop `CARD_CODE_SETTLE_MS`: when an author
 * saves repeatedly, avoid claiming on intermediate states); it is reported only after that delay.
 * Reads filter by current time; if any card has not settled, a timer is started to notify
 * subscribers when it matures.
 */

/** New or identity-changed cards report after this delay (same value as `CARD_CODE_SETTLE_MS` in `server/card-code.mjs`; tier-3 number) */
export const NODE_CARD_SETTLE_MS = 1500;

export interface NodeCardInfo {
  /** Online card runtime version (`cardRuntime/version.ts`); null if this page cannot execute user cards and media effect cards */
  cardRuntime: string | null;
  userCards: boolean;
  graphCards: boolean;
  /** Card id → code identity (cards loaded successfully on this page with settled identities) */
  cardSources: Record<string, string>;
  /** Environment fingerprint calculated for this node by document service based on runtime version (`node.welcome.cardEnvFingerprint`); null if not checked in or absent */
  cardEnvFingerprint: string | null;
}

export interface NodeCardInfoInput {
  cardRuntime: string | null;
  userCards: boolean;
  graphCards: boolean;
  cardSources: Readonly<Record<string, string>>;
}

/** Cards runnable on this page → registered content (pure function, used by `nodeCardInfoLive.ts` and unit tests) */
export function computeNodeCardInfo(input: {
  /** Online card runtime version */
  runtime: string;
  /** Whether this page can execute synced cards right now (`cardExecAvailable()` in `cardRuntime/gate.ts`) */
  available: boolean;
  /** Whether this device has sufficient graphics capability to run media effect cards (judged by Block G; treated as insufficient if not judged) */
  graphCapable: boolean;
  /** Synced cards (`syncedUserCards()`): id and entry file key */
  cards: Iterable<{ id: string; source?: string }>;
  /** Card id → run state name (`registry.cardRunState(id)?.state`) */
  stateOf: (id: string) => string | undefined;
  /** Entry file key → code identity (`transpile.browser.codeIdentities`) */
  identities: Readonly<Record<string, string>>;
}): NodeCardInfoInput {
  if (!input.available || !input.runtime) return { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} };
  const cardSources: Record<string, string> = {};
  for (const c of input.cards) {
    if (!c || typeof c.id !== "string" || !c.id || !c.source) continue;
    if (input.stateOf(c.id) !== "ready") continue;
    const identity = input.identities[c.source];
    if (typeof identity === "string" && identity) cardSources[c.id] = identity;
  }
  return { cardRuntime: input.runtime, userCards: true, graphCards: input.graphCapable === true, cardSources };
}

type Listener = () => void;
const listeners = new Set<Listener>();
let current: NodeCardInfoInput = { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} };
let cardEnvFingerprint: string | null = null;
/** Card id → timestamp when current identity first appeared */
const since = new Map<string, { identity: string; at: number }>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerImpl: { set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>; clear: (t: ReturnType<typeof setTimeout>) => void } = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
  clear: (t) => clearTimeout(t),
};

const sameSources = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

function notify() {
  for (const l of [...listeners]) { try { l(); } catch { /* The subscriber is broken */ } }
}

function armTimer(now: number) {
  if (timer !== null) { timerImpl.clear(timer); timer = null; }
  let wait = Infinity;
  for (const [, s] of since) {
    const left = s.at + NODE_CARD_SETTLE_MS - now;
    if (left > 0 && left < wait) wait = left;
  }
  if (wait === Infinity) return;
  timer = timerImpl.set(() => { timer = null; notify(); }, wait + 5);
}

/** Replaces entire registered content (called by `nodeCardInfoLive.ts` when registry, gate, or code identity changes); no notification if unchanged */
export function setNodeCardInfo(next: NodeCardInfoInput, now: number = Date.now()): boolean {
  const same = next.cardRuntime === current.cardRuntime && next.userCards === current.userCards && next.graphCards === current.graphCards
    && sameSources(next.cardSources, current.cardSources);
  if (same) return false;
  current = { cardRuntime: next.cardRuntime, userCards: next.userCards === true, graphCards: next.graphCards === true, cardSources: { ...next.cardSources } };
  for (const id of [...since.keys()]) if (!(id in current.cardSources)) since.delete(id);
  for (const [id, identity] of Object.entries(current.cardSources)) {
    const old = since.get(id);
    if (!old || old.identity !== identity) since.set(id, { identity, at: now });
  }
  armTimer(now);
  notify();
  return true;
}

/** `cardEnvFingerprint` returned by document service after node check-in (pass null if absent: cleared on offline or session end); no notification if unchanged */
export function setNodeCardEnvFingerprint(fp: string | null): boolean {
  const next = typeof fp === "string" && fp ? fp : null;
  if (next === cardEnvFingerprint) return false;
  cardEnvFingerprint = next;
  notify();
  return true;
}

/** Currently registered content; cards without settled identities (new generation for less than `NODE_CARD_SETTLE_MS`) are not in `cardSources` */
export function getNodeCardInfo(now: number = Date.now()): NodeCardInfo {
  const cardSources: Record<string, string> = {};
  for (const [id, identity] of Object.entries(current.cardSources)) {
    const s = since.get(id);
    if (!s || s.identity !== identity || now - s.at >= NODE_CARD_SETTLE_MS) cardSources[id] = identity;
  }
  return { cardRuntime: current.cardRuntime, userCards: current.userCards, graphCards: current.graphCards, cardSources, cardEnvFingerprint };
}

export function subscribeNodeCardInfo(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Clear (offline, project switch, unit test) */
export function resetNodeCardInfo(): void {
  current = { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} };
  cardEnvFingerprint = null;
  since.clear();
  if (timer !== null) { timerImpl.clear(timer); timer = null; }
}

/** Test only: replace timer */
export function __setNodeCardInfoTimers(impl: typeof timerImpl | null): void {
  timerImpl = impl ?? {
    set: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t; },
    clear: (t) => clearTimeout(t),
  };
}

/* ------------------------------------------------------------------ Graphics capability of this device */

let graphCapable = false;
/**
 * Whether this device has sufficient graphics capability to run media effect cards (contract 4.3,
 * judged by Block G: WebGL2 available, not software rendering, max texture large enough, context
 * never lost).
 * Defaults to "insufficient": does not report `graphCards` before judgment, so media effect card
 * tasks will not be claimed by this device. Notifies subscribers on change.
 */
export function setNodeGraphCapable(ok: boolean): boolean {
  const next = ok === true;
  if (next === graphCapable) return false;
  graphCapable = next;
  notify();
  return true;
}
export function nodeGraphCapable(): boolean {
  return graphCapable;
}
