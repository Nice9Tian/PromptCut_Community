import type { ReactNode } from "react";
import type { GroupLayout } from "./layout";
import type { MediaAsset } from "../../../kernel/project";
import { tr } from "../../../i18n/index.ts";

/**
 * The "group definition" table for the three sections: media library / animations / effects. To move a
 * group, change its layout, rename it or change its category, edit only this file.
 * The content of each group is computed from the search term by the matching *Group hook (GroupData);
 * GroupBrowser handles the overview and the detail.
 */

export type GroupCategory = "visual" | "audio";
export const CATEGORIES: readonly GroupCategory[] = ["visual", "audio"];

export interface GroupDef {
  id: string;
  title: string;
  layout: GroupLayout;
  category: GroupCategory;
  /**
   * What to do when a group has 0 items (and no search is active):
   *   import  media group: draw a dashed "Import…" placeholder; clicking it imports directly
   *   hint    show the group box as usual, with a hint supplied by the group itself (GroupData.emptyHint)
   *   hide    hide the whole group (card groups)
   * Groups with no hits are always hidden while searching.
   */
  empty: "import" | "hint" | "hide";
  /** data-pc on the group detail root node, reusing the automation hook names of the containers from before the redesign */
  hook?: string;
  /** Description shown when hovering over a group box / the detail count */
  hint?: string;
}

/** Media library: imported media */
export const LIBRARY_GROUPS: readonly GroupDef[] = [
  { id: "videos", title: tr("Video"), layout: "big_16_9", category: "visual", empty: "import" },
  { id: "images", title: tr("Images"), layout: "big_16_9", category: "visual", empty: "import" },
  { id: "music", title: tr("Audio"), layout: "big_strip", category: "audio", empty: "import" },
  // Every cut in the project (2026-10-20 user decision: "cuts should also appear in the media library"); click to open on the timeline, drag onto a track to place a cut segment
  { id: "cuts", title: tr("Cut"), layout: "big_16_9", category: "visual", empty: "hint", hook: "lib-cuts", hint: tr("Click to open on the timeline, drag onto a track to place a cut segment that references it") },
];

/** Animations: all kinds of cards and parts, all visual (GroupBrowser uses this to skip the category pill row) */
export const ANIMATION_GROUPS: readonly GroupDef[] = [
  {
    id: "user-cards",
    title: tr("Custom cards"),
    layout: "middle_cube",
    category: "visual",
    empty: "hide",
    hint: tr("Cards built on the spot by the AI or the user. Right-click = switch tier between \"Project media\" and \"Custom media\""),
  },
  { id: "magicui", title: tr("Magic UI"), layout: "middle_cube", category: "visual", empty: "hide" },
  { id: "native", title: tr("Built-in cards"), layout: "middle_cube", category: "visual", empty: "hide" },
  {
    id: "parts",
    title: tr("Parts library"),
    layout: "middle_cube",
    category: "visual",
    empty: "hide",
    hint: tr("Parts for composite cards: click once to add to the selected composite card, or with none selected, create a new composite card at the playhead"),
  },
  { id: "lottie", title: tr("Lottie animations"), layout: "middle_cube", category: "visual", empty: "hide" },
  {
    id: "particles",
    title: tr("Particle background"),
    layout: "big_16_9",
    category: "visual",
    empty: "hide",
    hint: tr("The overview shows only a few featured items; open this group to see all"),
  },
];

export const EFFECTS_GROUPS: readonly GroupDef[] = [
  { id: "transitions", title: tr("Transition"), layout: "middle_cube", category: "visual", empty: "hint" },
  { id: "filters", title: tr("Filters"), layout: "middle_cube", category: "visual", empty: "hint", hook: "filters" },
  { id: "emphasis", title: tr("Emphasis"), layout: "middle_cube", category: "visual", empty: "hint" },
  { id: "themes", title: tr("Global style"), layout: "middle_cube", category: "visual", empty: "hint", hook: "theme-list" },
  { id: "audiofx", title: tr("Audio effects"), layout: "big_strip", category: "audio", empty: "hint", hook: "audiofx" },
  { id: "audio-presets", title: tr("Audio presets"), layout: "big_strip", category: "audio", empty: "hint", hint: tr("Click one = create from preset") },
];

export const LIBRARY_GROUP_IDS = LIBRARY_GROUPS.map((g) => g.id);
export const ANIMATION_GROUP_IDS = ANIMATION_GROUPS.map((g) => g.id);
export const EFFECTS_GROUP_IDS = EFFECTS_GROUPS.map((g) => g.id);

/** Whichever kind of media an import lands in, open the group that manages that kind */
export const KIND_GROUP: Record<MediaAsset["kind"], string> = { video: "videos", image: "images", audio: "music" };

/** One item in a group: laid out in the detail as a masonry layout by the group's layout; aspect = height / width, undefined if unknown */
export interface GroupItem {
  id: string;
  node: ReactNode;
  aspect?: number;
}

export interface GroupData {
  /** All items under the current search term. The detail lays these out, and the "N items" on the group box counts them too */
  items: GroupItem[];
  /** Thumbnail preview in an overview group box: display only, no automation hooks. Takes the first few by the group's layout */
  thumbs?: GroupItem[];
  /** Extra content placed above / below the items in the detail (duration picker, list of existing transitions, reference notes…) */
  detailTop?: ReactNode;
  detailBottom?: ReactNode;
  /** One-line hint when an overview group box has 0 items (groups with empty = "hint") */
  emptyHint?: ReactNode;
  /** Message when the detail has 0 items (empty state or "No matching…") */
  emptyDetail?: ReactNode;
}
