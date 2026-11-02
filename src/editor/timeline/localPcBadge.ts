import { tr } from "../../i18n/index.ts";
/**
 * The card name of a timeline clip (C10 contract, section 9). Pure function, loaded directly by unit tests.
 * It used to also decide whether the "local PC assisted render" badge shows; removed by user decision,
 * 2026-10-21 (that case does not exist), and the file name is kept.
 */

/** Label of a card clip: name defined at build time → name in the sync table (`knownCardName` has already taken them in this order) → "Unknown card" */
export const UNKNOWN_CARD_LABEL = tr("Unknown card");
export function clipCardLabel(knownName: string | null | undefined): string {
  return typeof knownName === "string" ? knownName : UNKNOWN_CARD_LABEL;
}
