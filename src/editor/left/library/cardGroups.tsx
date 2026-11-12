import { useCallback, useEffect, useMemo, useState } from "react";
import type { CardDef } from "../../../kernel/types";
import type { PartDef } from "../../../kernel/partTypes";
import { allCards } from "../../../kernel/registry";
import { allParts } from "../../../kernel/partRegistry";
import { assetCardKind, featuredParticleIds } from "../../../cards/assets";
import { isCardVisible, loadScopes, readVisibility, usedCardIds, type CardVisibility, type ScopeEntry } from "../../cardScope";
import { useStore } from "../../../store/project";
import { CardCell } from "../CardCell";
import { PartCell } from "../PartCell";
import { AnimationThumb } from "../AnimationThumb";
import { ThumbTile } from "./ThumbTile";
import type { GroupData, GroupItem } from "./groups";
import { tr } from "../../../i18n/index.ts";

type AnyCard = CardDef<any>;

/**
 * The single data source of the card library: three visibility tiers (CardScopeBar), the ownership
 * table, filtering by search text, grouping by origin.
 * The "Animations" section (AnimationsSection) calls it only once and several card groups share it:
 * the ownership table loads only once, and when the filter changes all groups change together.
 */
export interface CardLibrary {
  vis: CardVisibility;
  setVis: (v: CardVisibility) => void;
  scopes: Record<string, ScopeEntry>;
  /** Reload the ownership table after a tier change from the right-click menu */
  reloadScopes: () => void;
  user: AnyCard[];
  magic: AnyCard[];
  native: AnyCard[];
  lottie: AnyCard[];
  particles: AnyCard[];
}

/** Search by name, description, id; media wrapper cards are also searched by tag: words like "snowflake" and "starry sky" are in tags, not in name / description */
function cardMatches(c: AnyCard, q: string): boolean {
  if (!q) return true;
  return (
    c.name.toLowerCase().includes(q) ||
    c.description.toLowerCase().includes(q) ||
    c.id.toLowerCase().includes(q) ||
    (c.source === "asset" && (c.tags ?? []).some((t) => t.toLowerCase().includes(q)))
  );
}

/** q is a search term that has already been trimmed and lowercased */
export function useCardLibrary(q: string): CardLibrary {
  // Three-tier filter. scopes is the server-side ownership table (which custom card belongs to which project)
  const [vis, setVis] = useState<CardVisibility>(() => readVisibility());
  const [scopes, setScopes] = useState<Record<string, ScopeEntry>>({});
  useEffect(() => {
    loadScopes().then(setScopes).catch(() => {});
  }, []);
  const reloadScopes = useCallback(() => {
    loadScopes(true).then(setScopes).catch(() => {});
  }, []);

  // Ownership goes by the project's own id (it follows the .proc), plus the extra condition "currently used on the timeline" ...
  // previously it went by the draft id, and a .proc opened from the desktop app has no draft id, so custom cards in use in the video were not visible here at all.
  // The cards in use are joined into a string used as a dependency: the project object changes on every edit, and the card list should not be recomputed each time
  const projectId = useStore((s) => s.project.id ?? null);
  const usedKey = useStore((s) => [...usedCardIds(s.project)].sort().join("\n"));

  const lists = useMemo(() => {
    const used = new Set(usedKey ? usedKey.split("\n") : []);
    const all = allCards()
      // Audio media effect cards do not go into the card panel: an audio media effect card dragged in has no nodeId, so it produces neither sound nor picture and is an empty clip.
      // It can only be attached to a clip via apply_card.
      .filter((c) => c.kind !== "audio")
      .filter((c) => isCardVisible(c, vis, scopes, projectId, used))
      .filter((c) => cardMatches(c, q));
    return {
      // Cards built on the spot by the AI or the user: something just created must be visible immediately, otherwise only the AI knows the card exists after it is built
      user: all.filter((c) => c.source === "user"),
      magic: all.filter((c) => c.source === "magicui"),
      native: all.filter((c) => c.source === "native"),
      // Media wrapper cards: Lottie / particle cards translated from the asset catalog (src/cards/assets), split into two groups by kind
      lottie: all.filter((c) => assetCardKind(c) === "lottie"),
      particles: all.filter((c) => assetCardKind(c) === "particles"),
    };
  }, [q, vis, scopes, projectId, usedKey]);

  return { vis, setVis, scopes, reloadScopes, ...lists };
}

/** Parts library: the pieces of composite cards. Searched by name, description, id, tag */
export function usePartsList(q: string): PartDef<any>[] {
  return useMemo(
    () =>
      allParts().filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          (p.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      ),
    [q],
  );
}

const THUMBS = 8;

/** Representative-frame thumbnails for overview group boxes */
const cardThumbs = (list: AnyCard[]): GroupItem[] =>
  list.slice(0, THUMBS).map((def) => ({
    id: def.id,
    node: <ThumbTile title={tr(def.name)} preview={<AnimationThumb kind="card" def={def} />} />,
  }));

const partThumbs = (list: PartDef<any>[]): GroupItem[] =>
  list.slice(0, THUMBS).map((def) => ({
    id: def.id,
    node: <ThumbTile title={tr(def.name)} preview={<AnimationThumb kind="part" def={def} />} />,
  }));

/** Contents of the six card groups (custom cards / Magic UI / built-in cards / parts library / Lottie / particle backgrounds) */
export function useCardGroups(
  lib: CardLibrary,
  parts: PartDef<any>[],
  searching: boolean,
  onUserMenu: (e: React.MouseEvent, cardId: string) => void,
): Record<string, GroupData> {
  const { user, magic, native, lottie, particles } = lib;
  return useMemo(() => {
    const cards = (list: AnyCard[]): GroupItem[] => list.map((def) => ({ id: def.id, node: <CardCell def={def} fill /> }));
    const none = (
      <div className="pc-left-note">
        {searching ? tr("No matching cards") : tr("Cards in this group are hidden by the card filter; use the filter button next to the search box to adjust")}
      </div>
    );
    const featured = particles.filter((c) => featuredParticleIds.has(c.id));
    return {
      "user-cards": {
        items: user.map((def) => ({
          id: def.id,
          // Right-click to change tier: project media ⇄ custom media (see UserCardMenu; the menu itself is rendered persistently by the section)
          node: (
            <div className="pc-lib-fill" onContextMenu={(e) => onUserMenu(e, def.id)}>
              <CardCell def={def} fill />
            </div>
          ),
        })),
        thumbs: cardThumbs(user),
        emptyDetail: none,
      },
      magicui: { items: cards(magic), thumbs: cardThumbs(magic), emptyDetail: none },
      native: { items: cards(native), thumbs: cardThumbs(native), emptyDetail: none },
      parts: {
        items: parts.map((def) => ({ id: def.id, node: <PartCell def={def} fill /> })),
        thumbs: partThumbs(parts),
        emptyDetail: <div className="pc-left-note">{searching ? tr("No matching parts") : tr("The parts library is empty")}</div>,
      },
      lottie: { items: cards(lottie), thumbs: cardThumbs(lottie), emptyDetail: none },
      // There are many particle cards (fifty-plus): the overview shows only the featured ones, while the details and counts cover all; when searching, if no featured card matches, show the first few matches
      particles: { items: cards(particles), thumbs: cardThumbs(featured.length ? featured : particles), emptyDetail: none },
    };
  }, [user, magic, native, lottie, particles, parts, searching, onUserMenu]);
}
