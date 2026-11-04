import { Component, type ReactNode } from "react";
import { noteCardRenderError } from "./cardTrouble";

/**
 * Error boundary for runtime-loaded cards (synced user cards and media effect cards executed in
 * the online browser): errors thrown during component rendering do not bring down the entire stage;
 * this card records `runtime-error` (`cardTrouble.ts`), and the stage subsequently removes it and
 * falls back to the original approach (`docs/plan/online-card-exec-contract.md` section 8).
 * Wraps only runtime-loaded cards: cards present at build time (all cards on desktop, cards included
 * in the online bundle) are not wrapped, keeping the React tree verbatim identical to before.
 */
export class RuntimeCardBoundary extends Component<{ cardId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { noteCardRenderError(this.props.cardId, error); }
  render() { return this.state.failed ? null : this.props.children; }
}
