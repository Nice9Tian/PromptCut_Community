/**
 * Which cards' sound code can be executed on this page in online browser mode
 * (`docs/semantics/product/platforms.md` "Platform boundaries of card audio").
 *
 * Stage one only opens **built-in** cards (shipped with page build, defined in registry): built-in
 * notification sounds, keyboard sounds, built-in sound cards.
 * Audio for user cards and media effect cards is opened in stage two along with "online execution
 * of user cards and media effect cards": hooked in by calling `setOnlineUserCardAudioGate` from the
 * isolated environment side, without needing criteria changes here. Media effect cards with asset
 * input have an additional gate: online pages cannot retrieve sample chunks of assets (`mediaBlock`
 * in `audioSources.ts`).
 *
 * Light vs. heavy (synthesized in browser only when classified as light) is not judged here: this
 * only answers "can this device run this code"; light vs. heavy is judged by
 * `src/editor/io/onlineSoundJudge.ts`.
 *
 * This module belongs to the render layer (`src/online/`): only imports kernel.
 */
import type { CardDef } from "../kernel/types";

type AudioCard = Pick<CardDef<any>, "source" | "audio">;

let userCardGate: ((def: AudioCard) => boolean) | null = null;

/** Stage two interface: whether audio for user cards and media effect cards can be executed on this page is decided by isolated environment side; disallowed across the board when not connected */
export function setOnlineUserCardAudioGate(gate: ((def: AudioCard) => boolean) | null): void {
  userCardGate = gate;
}

/** Whether this card's `audio()` can be executed by the online page */
export function onlineCardAudioRunnable(def: AudioCard | undefined | null): boolean {
  if (!def || typeof def.audio !== "function") return false;
  if (def.source === "user") return userCardGate ? userCardGate(def) : false;
  return true;
}

export const ONLINE_CARD_AUDIO_BLOCKED = "Online browser mode cannot yet run this card's sound code (sound from user cards and media effect cards must be generated on the local PC and then synced)";
