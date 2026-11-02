import { probeCard } from "./probe";
import { r6ProbeCards } from "./r6";
import { probeTimerCards } from "./timers";
import { probeCssCard, probeMotionJsCard } from "./boolean-probe";
import { probeSlowCard, probeSlowSteppedCard } from "./slow";

/**
 * Cards dedicated to probes. **Not meant for users**: they are mounted into temporary projects only
 * by `scripts/probes/*` to verify behavior.
 * They are placed under `_probe/`, separate from `native/`, so that nobody mistakes them for finished
 * cards and edits them.
 */
export const probeCards = [probeCard, ...r6ProbeCards, ...probeTimerCards, probeCssCard, probeMotionJsCard, probeSlowCard, probeSlowSteppedCard];
