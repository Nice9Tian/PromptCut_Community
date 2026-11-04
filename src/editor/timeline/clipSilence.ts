/**
 * The check for "this segment on the timeline produces no sound at all", shared by the desktop app and
 * the mobile app.
 *
 * The check itself is in the kernel (`clipGoesSilentBySpeed` in `cardAudioRendition.mjs`): a
 * speed-changed clip plays no original sound, but an audio-visual card attached to it still plays, and so
 * does an audio media effect card, so it counts as mute only if it has neither.
 * This adds one thing the kernel cannot reach: **synced custom cards**. On an online page the user
 * card definitions are not in this machine's card registry, so the embedded sound a card declares can
 * only be asked from `syncedUserCards()` (elsewhere it is supplemented the same way, see
 * `src/editor/preview/MediaLayers.tsx`, `src/editor/io/exportSounds.ts`).
 *
 * It lives in this layer rather than the kernel: `syncedUserCards` is runtime state of the card registry
 * (`src/kernel/registry.ts`), not project data; the kernel check looks only at the project and the card
 * definitions passed in, so unit tests of it do not have to start the card registry.
 */
import { clipGoesSilentBySpeed } from "../../kernel/cardAudioRendition.mjs";
import { getCard, syncedUserCards } from "../../kernel/registry";
import type { Project, TrackClip } from "../../kernel/project";

export function clipMakesNoSound(
  project: Pick<Project, "cardNodes" | "media">,
  clip: Partial<TrackClip>,
): boolean {
  if (!clipGoesSilentBySpeed(project, clip, getCard)) return false;
  return !syncedUserCards().get(clip.cardId ?? "")?.embeddedAudio;
}
