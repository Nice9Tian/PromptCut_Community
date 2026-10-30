import { probeCard } from "./probe";
import { r6ProbeCards } from "./r6";
import { probeTimerCards } from "./timers";
import { probeCssCard, probeMotionJsCard } from "./boolean-probe";
import { probeSlowCard, probeSlowSteppedCard } from "./slow";

/**
 * 探针专用卡。**不是给用户用的** —— 只由 `scripts/probes/*` 挂进临时项目里验行为。
 * 放在 `_probe/` 下和 `native/` 分开,免得有人把它们当成品卡去改。
 */
export const probeCards = [probeCard, ...r6ProbeCards, ...probeTimerCards, probeCssCard, probeMotionJsCard, probeSlowCard, probeSlowSteppedCard];
