import type { TrackKind } from "../skins/palettes";
import { getCard } from "./registry";
import type { MediaAsset } from "./project";

/**
 * Which track color a clip should use.
 *
 * The color scheme specification (color scheme diagnosis and correction v2, item 03) requires the
 * timeline to be "colored by media type": at a glance, which one is text, which is video, which is a
 * transition. Previously all card clips shared one color, which filled the space with color yet
 * conveyed no information.
 *
 * A media clip looks directly at MediaAsset.kind; a card clip has no visual classification field, so
 * it is classified by the card's own tags. The tags are content labels meant for the AI to choose
 * cards, and they happen to also say what the card is on screen. Cards that cannot be classified fall
 * to text: the vast majority of cards are text cards, and this fallback is safer than random coloring.
 */

/**
 * If these words appear in the tags, the card is sorted into the corresponding track color. The first
 * match wins, so the order is the priority.
 * The fallback is text, so cards that "make text move" (number roll / typewriter / text rotation /
 * punchline) fall into the text color without needing a rule, consistent with the colors picked across
 * the full-screen design mockup.
 */
const TAG_RULES: Array<[TrackKind, readonly string[]]> = [
  ["transition", ["Transition", "fade", "switch", "wipe", "push"]],
  // Entrance / exit "effects" are themselves the main body of the card, so they are classified as effects
  ["fx", ["Effects", "particles", "glow", "glitch", "scan", "terminal", "3d", "fade-in", "blur"]],
  // Data visualization: chart cards get a category of their own, not mixed with plain text cards
  ["image", ["chart", "line chart", "trend", "ranking", "bar chart", "leaderboard", "circular", "percentage", "metric"]],
  ["sticker", ["sticker", "corner badge", "badge", "name tag", "entity", "person", "organization", "chapters", "navigation"]],
  ["audio", ["audio", "waveform", "Background music", "Sound"]],
  ["video", ["Video", "Visual", "half-screen", "on camera"]],
];

/**
 * Card id → track color. When the tags cannot classify a card, fall back on the id (the few cards
 * that are more explicit than tags).
 */
const ID_OVERRIDES: Record<string, TrackKind> = {
  "caption-track": "text",
  "chapter-bar": "sticker",
};

export function mediaTrackKind(media: MediaAsset | undefined): TrackKind {
  return media?.kind ?? "video";
}

export function cardTrackKind(cardId: string): TrackKind {
  const override = ID_OVERRIDES[cardId];
  if (override) return override;

  const card = getCard(cardId);
  if (!card) return "text";
  const tags = (card.tags ?? []).map((t) => t.toLowerCase());
  for (const [kind, words] of TAG_RULES) {
    if (tags.some((tag) => words.some((w) => tag.includes(w)))) return kind;
  }
  return "text";
}

/** Which track color a clip finally uses: media looks at kind, cards look at tags */
export function clipTrackKind(
  clip: { cardId?: string; mediaId?: string },
  findMedia: (id: string) => MediaAsset | undefined,
): TrackKind {
  if (clip.mediaId) return mediaTrackKind(findMedia(clip.mediaId));
  if (clip.cardId) return cardTrackKind(clip.cardId);
  return "text";
}
