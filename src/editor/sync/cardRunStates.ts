/**
 * The editor page side computes the run state of each sync card (`docs/plan/online-card-exec-contract.md`
 * section 8; the original tenth run state was dropped along with the old tier, and on 2026-10-07 the user
 * decided that the online browser runs user cards and media effect cards without distinguishing identity).
 * Pure function.
 *
 * Order (once an earlier condition holds, later ones are not checked):
 *   1. This page cannot execute (the site master switch is off, or there is no isolated environment)
 *      → `not-isolated`;
 *   2. The entry of this card cannot be transpiled → the state the transpiler gave
 *      (`unsupported-syntax` / `missing-module` / `load-error`);
 *   3. A stage reported a state for this card → use the stage's (`ready`, `load-error`, `gpu`, `media`,
 *      `runtime-error`, ...); when both stages reported and they differ, take the one that is not `ready`
 *      (if one cannot run it, treat it as unable to run; only when both render the same picture is it fine);
 *   4. Transpiled, but no stage has reported yet → `loading`;
 *   5. Not yet the turn of transpiling (the source was just fetched) → `loading`.
 * The result is written to `registry.setCardRunStates`; the parameters panel, the timeline badges and the
 * light/heavy decision read from there.
 */
import type { CardRunState, SyncedUserCard } from "../../kernel/registry.ts";
import type { BundleResult } from "../../online/cardRuntime/protocol.ts";
import { cyrb53 } from "../../render/cyrb53.mjs";
import { tr } from "../../i18n/index.ts";

export interface EditorRunStateInput {
  /** Sync table (cards parsed statically; `source` is the key of the entry file) */
  cards: Iterable<SyncedUserCard>;
  /** Whether this page can execute (`cardExecAvailable()` in `gate.ts`) */
  available: boolean;
  /** Explanation for when execution is unavailable (the sentence for a site that is off); omit if there is none */
  blockedDetail?: string | null;
  /** Transpile results (one per entry) */
  bundles: readonly BundleResult[];
  /** States reported by each stage (card id → state); stages that have not reported are not in it */
  stages?: Iterable<ReadonlyMap<string, CardRunState> | null | undefined>;
  /** How many stages must report this card before a conclusion is drawn (two stages give 2: both pictures must agree, and while only one has loaded it still counts as `loading`; one stage gives 1); defaults to 1 */
  stageCount?: number;
}

export function editorRunStates(input: EditorRunStateInput): Map<string, CardRunState> {
  const out = new Map<string, CardRunState>();
  const byEntry = new Map(input.bundles.map((b) => [b.entry, b]));
  const stages = [...(input.stages ?? [])].filter((m): m is ReadonlyMap<string, CardRunState> => !!m);
  for (const card of input.cards) {
    if (!card || typeof card.id !== "string" || out.has(card.id)) continue;
    if (!input.available) { out.set(card.id, { state: "not-isolated", ...(input.blockedDetail ? { detail: input.blockedDetail } : {}) }); continue; }
    const bundle = card.source ? byEntry.get(card.source) : undefined;
    if (bundle && !bundle.ok) { out.set(card.id, bundle.state); continue; }
    if (!bundle) { out.set(card.id, { state: "loading" }); continue; }
    const reported = stages.map((m) => m.get(card.id)).filter((s): s is CardRunState => !!s);
    const bad = reported.find((s) => s.state !== "ready");
    // If one says it cannot run, treat it as unable to run (no need to wait for the other); those that say OK must wait until enough stages have reported
    if (!bad && reported.length < Math.max(1, input.stageCount ?? 1)) { out.set(card.id, { state: "loading" }); continue; }
    // Runnable ones carry this generation's short signature: the source version in the cost identity uses it (when the source or the transpiler changes, the identity changes with it)
    out.set(card.id, bad ?? { state: "ready", version: String(cyrb53(String(bundle.bundle?.generation ?? ""))) });
  }
  return out;
}

/** Explanations for the parameters panel (the table in section 8 of the contract); `ready` and `loading` give no explanation */
export function runStateMessage(s: CardRunState | undefined): string | null {
  if (!s) return null;
  const d = s.detail ? s.detail : "";
  const where = s.file ? `, ${s.file.replace(/^src\/cards\/user\//, "")}` : "";
  switch (s.state) {
    case "ready": case "loading": return null;
    case "unsupported-syntax": return tr("The online browser cannot run this card: it uses syntax the online page does not support{0}. The picture is provided by a render node.", d ? ` (${d}${where})` : "");
    case "missing-module": return tr("The online browser cannot run this card: it references a module that is not available on the online page{0}. The picture is provided by a render node.", d ? `: ${d}` : "");
    case "load-error": return tr("The online browser cannot run this card: error while loading{0}.", d ? ` (${d})` : "");
    case "gpu": return tr("This device's graphics capability is not enough, so the picture of media effect cards is provided by a render node.");
    case "media": return tr("This device cannot decode this media clip, so the picture of media effect cards is provided by a render node.");
    case "runtime-error": return tr("This card failed to run in the online browser, so a render node provides the picture this time.");
    case "not-isolated": return d ? tr("{0}, so the picture of user cards and media effect cards is provided by a render node.", d) : tr("This page has no isolated runtime environment, so the picture of user cards and media effect cards is provided by a render node.");
    default: return null;
  }
}
