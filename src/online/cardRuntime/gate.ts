import { tr } from "../../i18n/index.ts";
/**
 * Whether this page can execute synced user cards and media effect cards (prerequisite of
 * `docs/plan/online-card-exec-contract.md` 3.1).
 *
 * If any condition is missing, do not execute and fall back entirely to the original approach:
 *   - `site`: The site master switch is not off (`onlineCardExec` in runtime configuration
 *     `runtime-config.json`, defaults to on);
 *   - `isolated`: This page has dual stages with successful handshake, stage origin and editor page
 *     have different origins, stage self-check confirms Content Security Policy is effective, and
 *     asset ticket handover succeeded.
 * These two items are written by security isolation (stage handshake and self-check); before it
 * writes them, this page **does not execute** (default `isolated: false`): setups without nginx
 * (local dev server, pages served by the desktop app itself) fail self-check and stay on this
 * default indefinitely. Single stage and dual stage are evaluated the same way: stages are always
 * cross-origin isolated (user decision, 2026-10-14), and the isolated session is established based
 * on the currently mounted stage (`online/stageIsolation.ts`).
 *
 * Transpilation (`onlineCardSources.ts`) is only performed when this check says "yes", so pages
 * that cannot execute will not load the transpiler.
 */
export interface CardExecGate {
  /** Site runtime switch; treated as on before reading, but still does not execute if isolation is not ready. */
  site: boolean | null;
  isolated: boolean;
  reason: string | null;
  /** Compatible with caller's visual status field; egress capability is not an execution condition. */
  visual: boolean;
}

let gate: CardExecGate = { site: null, isolated: false, reason: "No verdict on the isolated environment yet", visual: true };
const listeners = new Set<() => void>();

export function cardExecGate(): Readonly<CardExecGate> {
  return gate;
}

/** Whether this page can execute synced cards at this moment */
export function cardExecAvailable(): boolean {
  return gate.site !== false && gate.isolated;
}

/** Whether this page can execute synced cards' **visuals** right now (sound thread only checks `cardExecAvailable`) */
export function cardVisualExecAvailable(): boolean {
  return cardExecAvailable();
}




/** Message reported when execution is unavailable (parameters panel): site disabled vs. unisolated are distinct messages, both with status `not-isolated` */
export function cardExecBlockedDetail(): string | null {
  if (gate.site === false) return tr("This site does not have online running of user cards and media effect cards enabled");
  if (!gate.isolated) return null;
  return null;
}

export function setCardExecGate(patch: Partial<CardExecGate>): void {
  const next = { ...gate, ...patch };
  if (next.isolated) next.reason = null;
  if (next.site === gate.site && next.isolated === gate.isolated && next.reason === gate.reason && next.visual === gate.visual) return;
  gate = next;
  for (const l of [...listeners]) { try { l(); } catch { /* The subscriber is broken */ } }
}

export function subscribeCardExecGate(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Master switch in runtime config (`runtime-config.json` object or text): only explicit `false` is off */
export function siteCardExecOf(config: unknown): boolean {
  let c: unknown = config;
  if (typeof c === "string") { try { c = JSON.parse(c); } catch { return true; } }
  return !(c && typeof c === "object" && (c as { onlineCardExec?: unknown }).onlineCardExec === false);
}

/** For unit tests */
export function resetCardExecGateForTest(): void {
  gate = { site: null, isolated: false, reason: "No verdict on the isolated environment yet", visual: true };
  listeners.clear();
}
