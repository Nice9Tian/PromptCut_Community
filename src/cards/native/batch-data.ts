import { rankBars } from "./rank-bars";
import { statProof } from "./stat-proof";
import { growthCurve } from "./growth-curve";
import { versusCard } from "./versus-card";
import { uiCallout } from "./ui-callout";
import type { CardDef, Clip } from "../../kernel/types";

export const dataCards: CardDef<any>[] = [
  rankBars,
  statProof,
  growthCurve,
  versusCard,
  uiCallout,
];

export const dataDemoClips: Clip[] = [
  { id: "data-1", cardId: "rank-bars", start: 32, end: 34, params: {} },
  { id: "data-2", cardId: "stat-proof", start: 34, end: 36, params: {} },
  { id: "data-3", cardId: "growth-curve", start: 36, end: 38, params: {} },
  { id: "data-4", cardId: "versus-card", start: 38, end: 40, params: {} },
  { id: "data-5", cardId: "ui-callout", start: 40, end: 42, params: {} },
];
