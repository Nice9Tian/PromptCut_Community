/**
 * Motion graphics asset catalog: the ready-made Lottie animations and tsParticles configs under
 * server/catalog.
 *
 * The files themselves have long shipped with the package (runtime/app/server/catalog), but
 * previously nowhere in the software listed them: the left rail's media panel did not show them,
 * list_cards did not mention them, and the parameter form was a plain text box, so both the user and
 * the AI had to know a path like `/catalog/<kind>/<name>.json` to make use of them.
 *
 * Here the two index.json files are read in at build time (vite imports the JSON directly), for
 * three uses:
 *   - The Lottie card's src and the particle card's config, two controls, become the `asset` type,
 *     with options being this catalog, and list_cards returns controls as is, so the AI can see which
 *     assets exist without paging through the card-creation guide again;
 *   - The left rail's media panel gets an extra group "Motion graphics media", and a click / drag
 *     onto the timeline gives a card with the URL already filled in;
 *   - The parameter form gives these two controls a dropdown, while manual entry is still kept.
 *
 * Only entries registered in index.json are read; the server's /catalog route also lets only these
 * names through.
 */
import lottieIndex from "../../server/catalog/lottie/index.json";
import particlesIndex from "../../server/catalog/particles/index.json";

export type AssetKind = "lottie" | "particles";

export interface CatalogAsset {
  kind: AssetKind;
  name: string;
  /** Same-origin URL, filled directly into the card parameter */
  url: string;
  description: string;
  /** The observation written by the model after looking at the picture; more specific than description */
  note?: string;
  /** Suggested use cases */
  use?: string;
  tags: string[];
  /** Lottie only: the animation's own duration / canvas size */
  seconds?: number;
  w?: number;
  h?: number;
  featured?: boolean;
}

interface RawItem {
  name: string;
  url: string;
  description?: string;
  note?: string;
  use?: string;
  tags?: string[];
  seconds?: number;
  w?: number;
  h?: number;
  featured?: boolean;
}

function normalize(kind: AssetKind, items: RawItem[]): CatalogAsset[] {
  return items
    .filter((it) => it && typeof it.name === "string" && typeof it.url === "string")
    .map((it) => ({
      kind,
      name: it.name,
      url: it.url,
      description: it.description ?? "",
      note: it.note,
      use: it.use,
      tags: it.tags ?? [],
      seconds: it.seconds,
      w: it.w,
      h: it.h,
      featured: it.featured,
    }));
}

export const lottieAssets: CatalogAsset[] = normalize("lottie", (lottieIndex as { items: RawItem[] }).items);
export const particleAssets: CatalogAsset[] = normalize("particles", (particlesIndex as { items: RawItem[] }).items);

export function assetsOf(kind: AssetKind): CatalogAsset[] {
  return kind === "lottie" ? lottieAssets : particleAssets;
}

/**
 * The card and parameter name an asset belongs to: which parameter of which card gets the URL when
 * an asset is selected.
 * extra is what must be cleared at the same time: the Lottie card's json (inline text) has higher
 * priority than src, and its default value is a demo animation, so filling only src without clearing
 * json would still play the demo: this was hit in real testing.
 */
export const ASSET_TARGET: Record<AssetKind, { cardId: string; paramKey: string; extra: Record<string, unknown> }> = {
  lottie: { cardId: "lottie", paramKey: "src", extra: { json: "" } },
  particles: { cardId: "particles", paramKey: "config", extra: {} },
};

/** The parameters to write into the clip after an asset is selected */
export function assetParams(a: CatalogAsset): Record<string, unknown> {
  const t = ASSET_TARGET[a.kind];
  return { ...t.extra, [t.paramKey]: a.url };
}

/** A one-line readable label: name + description (used by both the dropdown and list_cards) */
export function assetLabel(a: CatalogAsset): string {
  const extra = a.kind === "lottie" && a.seconds ? `,${a.seconds}s` : "";
  return `${a.name} — ${a.description || a.note || ""}${extra}`;
}

/** The options for the `asset` control. value is the URL, usable once filled into the parameter */
export function assetOptions(kind: AssetKind): { value: string; label: string }[] {
  return assetsOf(kind).map((a) => ({ value: a.url, label: assetLabel(a) }));
}

/** Reverse lookup by URL (the parameter form shows which one is currently selected) */
export function findAssetByUrl(kind: AssetKind, url: string): CatalogAsset | undefined {
  return assetsOf(kind).find((a) => a.url === url);
}
