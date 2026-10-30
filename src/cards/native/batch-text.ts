import type { CardDef, Clip } from "../../kernel/types";
import { quoteLockup } from "./quote-lockup";
import { punchPill } from "./punch-pill";
import { termCard } from "./term-card";
import { typeShift } from "./type-shift";
import { entityChips } from "./entity-chips";
import { pinBoard } from "./pin-board";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const textCards: CardDef<any>[] = [
  quoteLockup,
  punchPill,
  termCard,
  typeShift,
  entityChips,
  pinBoard,
];

export const textDemoClips: Clip[] = [
  { id: "text-demo-1", cardId: "quote-lockup", start: 20, end: 22, params: {} },
  { id: "text-demo-2", cardId: "punch-pill", start: 22, end: 24, params: {} },
  { id: "text-demo-3", cardId: "term-card", start: 24, end: 26, params: {} },
  { id: "text-demo-4", cardId: "type-shift", start: 26, end: 28, params: {} },
  { id: "text-demo-5", cardId: "entity-chips", start: 28, end: 30, params: {} },
  { id: "text-demo-6", cardId: "pin-board", start: 30, end: 32, params: {} },
];
