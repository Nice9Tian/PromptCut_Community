/**
 * Writes "which user cards and media effect cards this page can run" into the registry
 * (`src/online/nodeCardInfo.ts`, block N, `docs/plan/online-card-exec-contract.md` section 7, item 1):
 * the capability flags of the pure browser node, `cardSourceVersions`, and the `input.browser` of the
 * manifest plan all read from there.
 *
 * Inputs (recomputed when any changes): whether this page can execute **visuals** (`cardVisualExecAvailable`
 * in `cardRuntime/gate.ts`: what the node makes are snapshots of the visuals; on a browser that blocks
 * WebRTC only through script hardening, visuals do not execute and no capability is reported), the synced
 * cards (registry), the run state of each card (registry, only `ready` counts as "loaded successfully"),
 * and this device's graphics capability (the registry's `nodeGraphCapable`).
 * The code identity is computed on the spot with block T's `codeIdentities()` (the same algorithm as the
 * desktop `cardCodeIdentity`, producing the same value), and the source is read from the copy held by
 * `OnlineCardSources`.
 * The transpiler part is loaded on demand: `import()` only when this page can execute and there are
 * synced cards that are `ready`; the whole section is pruned in the desktop build.
 *
 * Started from `browserNodeHost.ts` and stopped together with the host; on an online page, the host acts
 * as a node when it has dual stages and its identity is computer (on mobile or with a single stage it
 * only produces a sparse version for this page, and does not even do the lowest tier).
 */
import { onCardRunStatesChanged, onSyncedUserCardsChanged, cardRunState, syncedUserCards } from "../kernel/registry";
import { cardVisualExecAvailable, subscribeCardExecGate } from "../online/cardRuntime/gate";
import { CARD_RUNTIME_VERSION } from "../online/cardRuntime/version";
import { computeNodeCardInfo, nodeGraphCapable, setNodeCardInfo, subscribeNodeCardInfo } from "../online/nodeCardInfo";
import { activeCardSourceReader } from "./sync/onlineCardSources";

const EMPTY = { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} } as const;

export function startNodeCardInfoLive(): () => void {
  let seq = 0;
  let stopped = false;
  const refresh = async () => {
    const mine = ++seq;
    if (stopped) return;
    if (import.meta.env.VITE_PC_ONLINE !== "1" || !cardVisualExecAvailable()) { setNodeCardInfo(EMPTY); return; }
    const cards = [...syncedUserCards().values()];
    const ready = cards.filter((c) => !!c.source && cardRunState(c.id)?.state === "ready");
    let identities: Record<string, string> = {};
    const reader = activeCardSourceReader();
    if (reader && ready.length) {
      try {
        const m = await import("../online/cardRuntime/transpile.browser");
        identities = await m.codeIdentities({ entries: [...new Set(ready.map((c) => c.source as string))], read: reader.read });
      } catch { identities = {}; }
      if (stopped || mine !== seq) return;
    }
    setNodeCardInfo(computeNodeCardInfo({
      runtime: CARD_RUNTIME_VERSION, available: true, graphCapable: nodeGraphCapable(),
      cards, stateOf: (id) => cardRunState(id)?.state, identities,
    }));
  };
  const kick = () => { void refresh(); };
  const offs = [onCardRunStatesChanged(kick), onSyncedUserCardsChanged(kick), subscribeCardExecGate(kick)];
  // A change in graphics capability also requires recomputing; the registry's own notification comes back
  // here, and if the result is unchanged it does not notify again, so there is no loop
  offs.push(subscribeNodeCardInfo(kick));
  kick();
  return () => {
    stopped = true;
    for (const off of offs) { try { off(); } catch { /* Already unsubscribed */ } }
    setNodeCardInfo(EMPTY);
  };
}
