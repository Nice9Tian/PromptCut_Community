/**
 * What "this card's parameters look like", as seen by the parameters panel and the timeline subtitle
 * (pure function, loaded directly by unit tests).
 *
 * First look up the runnable definition in the registry (`getCard`); if it is not found, a user card synced
 * from the content store on the online page also has a read-only view (`syncedCardView`: name,
 * description, defaults and controls statically parsed from the source, no component; C10 contract
 * section 9, "clips can still have parameters edited as usual"). If neither exists, return undefined.
 */
import type { CardDef, Control } from "../../kernel/types";
import type { SkippedControl, SyncedCardView } from "../../kernel/registry";
import { onlineUnsupported } from "../../online/onlineUnsupported";
import { tr } from "../../i18n/index.ts";

/** What the panel needs: both a runnable definition and a synced view satisfy it */
export interface ParamsCardView {
  name: string;
  description?: string;
  defaults: Record<string, unknown>;
  controls: Control[];
  /** Only on the synced view: the source has controls that were not recognized */
  controlsIncomplete?: boolean;
  /** Only on the synced view: the unrecognized controls, one entry each */
  skippedControls?: SkippedControl[];
}

export function paramsCardView(
  cardId: string | undefined | null,
  lookup: { getCard: (id: string) => CardDef<any> | undefined; syncedCardView: (id: string) => SyncedCardView | undefined },
): ParamsCardView | undefined {
  if (typeof cardId !== "string" || !cardId) return undefined;
  return lookup.getCard(cardId) ?? lookup.syncedCardView(cardId);
}

/** The sentence shown when there are no controls to draw */
export const NO_PARAMS_TEXT = tr("This card has no adjustable parameters");
/** Entry name used when the source has controls but none are recognized online (the middle of the `onlineUnsupported` sentence) */
export const ONLINE_PARAMS_ENTRY = tr("changing this card's parameters");

/**
 * What to show when the parameters panel cannot draw controls; returns null if there are controls to draw.
 * When a synced card's source declares controls but none were parsed, say "Online browser mode does not
 * yet support editing this card's parameters…" rather than "no adjustable parameters" (it does have some).
 */
export function paramsEmptyText(view: ParamsCardView | undefined): string | null {
  if (view && Array.isArray(view.controls) && view.controls.length > 0) return null;
  if (view?.controlsIncomplete) return onlineUnsupported(ONLINE_PARAMS_ENTRY);
  return NO_PARAMS_TEXT;
}

/** Entry name used in the line the panel adds below the recognized controls when only some of the source's controls were recognized */
export const ONLINE_PARAMS_REST_ENTRY = tr("changing this card's remaining parameters");

/**
 * A synced card's controls were only partly recognized (e.g. after expanding controls imported from another
 * file): draw the recognized ones as usual and add a hint line below;
 * in all other cases (all recognized, none recognized, runnable definition) return null.
 */
export function paramsPartialText(view: ParamsCardView | undefined): string | null {
  if (!view?.controlsIncomplete || !Array.isArray(view.controls) || view.controls.length === 0) return null;
  return onlineUnsupported(ONLINE_PARAMS_REST_ENTRY);
}

/** Maximum number of unrecognized controls the panel lists one by one (the rest are summarized as "and N more") */
export const SKIPPED_LIST_MAX = 5;

/** How an unrecognized control is named on the panel: its "label" (key), else the key, else "a control" */
function skippedName(s: SkippedControl): string {
  if (s.label && s.key) return tr("\"{0}\" ({1})", s.label, s.key);
  if (s.label) return tr("\"{0}\"", s.label);
  if (s.key) return s.key;
  return tr("a control");
}

/**
 * When a synced card has unrecognized controls, explain under the "Online browser mode does not yet support
 * editing…" sentence which ones and why (C10 contract section 9 [ruling 2026-09-30]);
 * return null when there is no per-item record (old pages, runnable definitions).
 */
export function paramsSkippedText(view: ParamsCardView | undefined): string | null {
  const list = view?.controlsIncomplete && Array.isArray(view.skippedControls) ? view.skippedControls : [];
  if (!list.length) return null;
  const shown = list.slice(0, SKIPPED_LIST_MAX).map((s) => `${skippedName(s)}:${s.reason}`);
  const more = list.length > SKIPPED_LIST_MAX ? tr("; {0} in total", list.length) : "";
  return tr("Unrecognized parameters: {0}{1}", shown.join(";"), more);
}

/** Timeline subtitle: current value of the first text control → card description → empty */
export function clipSubtitleOf(view: ParamsCardView | undefined, params: Record<string, unknown> | undefined): string {
  if (!view) return "";
  const textControl = (view.controls ?? []).find((c) => c.type === "text");
  let subtitle = "";
  if (textControl) {
    const val = params?.[textControl.key] ?? view.defaults?.[textControl.key];
    subtitle = val != null ? String(val).trim() : "";
  }
  return subtitle || view.description || "";
}
