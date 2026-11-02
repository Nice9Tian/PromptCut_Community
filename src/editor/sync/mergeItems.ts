/**
 * The per-item merge engine of the "conflict merge" window (pure functions, loadable in Node unit tests,
 * touches neither the store nor the network).
 *
 * Semantics: `docs/semantics/workflow/editing.md`, "Undo, redo", the "two-level checkable list";
 * `docs/semantics/product/document-service.md`, "Conflicts" (user decision, 2026-10-22).
 *
 * - **Level 1 ("things")**: each clip on the timeline (card clip, media clip, cut segment), each caption
 *   line, and the project settings count as one entry each; entries in tracks, cuts, transitions, media and
 *   the effects libraries likewise count as one "thing" each (otherwise their changes would have nowhere to
 *   be listed).
 * - **Level 2 (properties)**: the properties of that thing that were changed. The comparison is between two
 *   copies, "baseline → my side", so a property changed several times yields only one entry; changing the
 *   length and then the opacity gives two. A clip's start and end are merged into one "time"; a change of
 *   track is counted separately as "track".
 * - **Additions and deletions count too**: "I deleted" / "I added" are each one whole-thing item (the
 *   property is recorded as `""`); if I changed it and the cloud has deleted it, the properties are still
 *   listed and all count as conflicts, and on "merge" it is restored together with my changes.
 * - **Conflicts and "what the cloud has now" are not stored in the list**: each display and each click on
 *   "merge" computes them from the project at that moment ("recheck on every merge click").
 *
 * An entry in the pending merge list is one thing (`MergeThing`), carrying its properties (`MergeProp`).
 * The list is stored per "project × user" in the document service
 * (`server/docservice/modules/pending-merge.mjs`); this file handles only the content.
 *
 * **Hook left for 0.7.20 "undo conflicts"**: each record carries `source` (currently only `offline`; 0.7.20
 * adds `undo`). Undo conflicts are written in the same shape: `base` is the value after that step landed
 * (the cloud is expected to still have it), and `mine` is the value it should become after the revert;
 * conflict detection, display, merging and deleting the selection do not distinguish the source, so one
 * window uses one set of code.
 */
import { deepEqual } from "../../kernel/diffProject";
import { parseCaptions, formatCaptions, isCaptionClip, type CaptionLine } from "../../kernel/captions";
import type { Project, Track } from "../../kernel/project";
import { contentEndOf, effectiveDuration } from "../../kernel/duration";
import { getCard } from "../../kernel/registry";
import { tr as trText } from "../../i18n/index.ts";
import { shownName, shownNameOf } from "../../i18n/names.ts";

/* ---------------- Shapes ---------------- */

/** Where a pending merge item comes from: offline reconnect (this version), undo conflict (hooked up in 0.7.20) */
export type MergeSource = "offline" | "undo";

/**
 * `card`: one card (one card source file). Card source is not in the project JSON; it is synced through the
 * content store by the editor process's card source sync (`server/card-sync.mjs`). A card that was changed
 * while offline and also changed by someone else in the cloud is handed over by it (`cardConflictThing`),
 * and its merge goes through its `takeMine`, not through `applyMerge` writing to the project.
 */
export type ThingKind = "clip" | "caption" | "settings" | "track" | "cut" | "transition" | "library" | "card";

/** "Whether it exists, and what it is": null means it is absent from this copy (JSON cannot hold undefined) */
export type Box = { v: unknown } | null;

export interface ThingRef {
  kind: ThingKind;
  /** The id of a clip, track, cut, transition or library entry; for a caption it is the row identity; for project settings it is `settings` */
  id: string;
  /** The collection a library entry belongs to: media / filters / pixelMaps / audioFx / cardNodes */
  coll?: string;
  /** Caption: the caption clip it belongs to */
  clipId?: string;
  /** Clip: which track it is on, on my side (filled in on add, restore and track change) */
  trackId?: string;
  /** Clip, track, transition: which cut it is in, on my side (null is the currently active one) */
  cutId?: string | null;
}

export interface MergeProp {
  /** Property key; `""` is the whole thing (add / delete) */
  prop: string;
  base: Box;
  mine: Box;
}

export interface MergeThing {
  /** `<source>:<thing key>`; the same thing from the same source has only one entry, and later batches are merged into it */
  key: string;
  source: MergeSource;
  /** The batch number of the most recent batch merged in */
  batch: string;
  /** History sequence number of the baseline */
  baseRev: number;
  at: number;
  ref: ThingRef;
  change: "modify" | "add" | "delete";
  /** The name used when recording to the list (so it can still be named when neither the cloud nor my side has it) */
  label: string;
  /** Whole item: baseline and my side (used for add, delete, and restore when deleted in the cloud) */
  base: Box;
  mine: Box;
  props: MergeProp[];
}

/* ---------------- Helpers ---------------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const box = (v: unknown): Box => (v === undefined ? null : { v });
const val = (b: Box): unknown => (b ? b.v : undefined);
const sameBox = (a: Box, b: Box): boolean => (a === null || b === null ? a === b : deepEqual(a.v, b.v));
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

/** Short hash (identity of caption lines; not collision-resistant, enough within one clip) */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* ---------------- Where items live in the project ---------------- */

/** Top-level project keys that are not "project settings" (collections and runtime fields) */
const NOT_SETTINGS = new Set(["version", "id", "media", "tracks", "cuts", "transitions", "activeCutId", "filters", "pixelMaps", "audioFx", "cardNodes"]);

/**
 * [ruling: 2026-10-22 lead session, level 3] This table lists only what users edit directly, not
 * values computed from something else. The following are computed and do not go into level 2:
 * - Project setting `duration`: the total duration defaults to the end of the content and follows
 *   the clips (`kernel/duration.ts`; a manually truncated value is not persisted, it lives only in
 *   the editor state). Moving one clip changes it, and the user did not edit it directly. After a
 *   merge, `applyMerge` recomputes it from the end of the content.
 * - Asset `pending` `tiers` `hash` `ext` `size` `duration` `width` `height` `url` `path`: written
 *   by the system on import, storage, upload, and metadata backfill (commits such as "asset
 *   metadata backfill" that skip the undo stack), not produced by user edits. Adding or deleting a
 *   whole asset is still listed; renaming (`name`) is still listed.
 * - Clip `cardAudio` `embeddedAudio`: the generated audio output of a motion graphics card with
 *   sound, plus its capability flag, maintained by the generation flow (`kernel/project.ts`).
 */
export const DERIVED_PROPS = {
  settings: ["duration"],
  media: ["pending", "tiers", "hash", "ext", "size", "duration", "width", "height", "url", "path"],
  clip: ["cardAudio", "embeddedAudio"],
} as const;
/** Library collections, one entry each */
export const LIBRARY_COLLS = ["media", "filters", "pixelMaps", "audioFx", "cardNodes"] as const;

interface TrackHome { list: Obj[]; cutId: string | null }

/** All track lists in the project: `/tracks` of the active cut, and `tracks` of each parked cut */
function trackLists(p: Obj): TrackHome[] {
  const out: TrackHome[] = [];
  if (Array.isArray(p.tracks)) out.push({ list: p.tracks as Obj[], cutId: null });
  for (const c of Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []) {
    if (isObj(c) && typeof c.id === "string" && Array.isArray(c.tracks)) out.push({ list: c.tracks as Obj[], cutId: c.id });
  }
  return out;
}

function transitionLists(p: Obj): { list: Obj[]; cutId: string | null }[] {
  const out: { list: Obj[]; cutId: string | null }[] = [];
  if (Array.isArray(p.transitions)) out.push({ list: p.transitions as Obj[], cutId: null });
  for (const c of Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []) {
    if (isObj(c) && typeof c.id === "string" && Array.isArray(c.transitions)) out.push({ list: c.transitions as Obj[], cutId: c.id });
  }
  return out;
}

function findTrack(p: Obj, trackId: string): { track: Obj; list: Obj[]; cutId: string | null } | null {
  for (const h of trackLists(p)) {
    const track = h.list.find((t) => isObj(t) && t.id === trackId);
    if (track) return { track, list: h.list, cutId: h.cutId };
  }
  return null;
}

function findClip(p: Obj, clipId: string): { clip: Obj; track: Obj; cutId: string | null } | null {
  for (const h of trackLists(p)) {
    for (const t of h.list) {
      if (!isObj(t) || !Array.isArray(t.clips)) continue;
      const clip = (t.clips as Obj[]).find((c) => isObj(c) && c.id === clipId);
      if (clip) return { clip, track: t, cutId: h.cutId };
    }
  }
  return null;
}

/** An item found in the project: its value, plus the clip's position */
interface Found {
  ref: ThingRef;
  value: unknown;
}

/** Key of an item (without the source) */
export function thingKeyOf(ref: ThingRef): string {
  switch (ref.kind) {
    case "clip": return `clip:${ref.id}`;
    case "caption": return `caption:${ref.clipId}:${ref.id}`;
    case "settings": return "settings";
    case "library": return `lib:${ref.coll}:${ref.id}`;
    case "track": return `track:${ref.id}`;
    case "cut": return `cut:${ref.id}`;
    case "transition": return `tr:${ref.id}`;
    case "card": return `card:${ref.id}`;
  }
}

function settingsOf(p: Obj): Obj {
  const out: Obj = {};
  for (const k of Object.keys(p)) if (!NOT_SETTINGS.has(k) && !(DERIVED_PROPS.settings as readonly string[]).includes(k) && p[k] !== undefined) out[k] = p[k];
  return out;
}

/** All "items" in the project (caption lines are handled separately, see `captionThings`) */
function collect(p: Obj): Map<string, Found> {
  const out = new Map<string, Found>();
  const add = (ref: ThingRef, value: unknown) => {
    const k = thingKeyOf(ref);
    if (!out.has(k)) out.set(k, { ref, value });
  };
  add({ kind: "settings", id: "settings" }, settingsOf(p));
  for (const h of trackLists(p)) {
    for (const t of h.list) {
      if (!isObj(t) || typeof t.id !== "string") continue;
      add({ kind: "track", id: t.id, cutId: h.cutId }, t);
      for (const c of Array.isArray(t.clips) ? (t.clips as Obj[]) : []) {
        if (isObj(c) && typeof c.id === "string") add({ kind: "clip", id: c.id, trackId: t.id, cutId: h.cutId }, c);
      }
    }
  }
  for (const h of transitionLists(p)) {
    for (const tr of h.list) if (isObj(tr) && typeof tr.id === "string") add({ kind: "transition", id: tr.id, cutId: h.cutId }, tr);
  }
  for (const c of Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []) {
    if (isObj(c) && typeof c.id === "string") add({ kind: "cut", id: c.id }, cutValue(p, c));
  }
  for (const coll of LIBRARY_COLLS) {
    for (const e of Array.isArray(p[coll]) ? (p[coll] as Obj[]) : []) {
      if (isObj(e) && typeof e.id === "string") add({ kind: "library", id: e.id, coll }, e);
    }
  }
  return out;
}

/** Whole cut: for the active one the content is at the project top level, for parked ones on itself */
function cutValue(p: Obj, c: Obj): Obj {
  if (p.activeCutId === c.id && c.tracks === undefined) {
    return { id: c.id, name: c.name, tracks: p.tracks, duration: p.duration, transitions: p.transitions ?? [] };
  }
  return c;
}

/* ---------------- Properties ---------------- */

/** Clip properties: start and end combine into "time", `params` / `frame` are expanded one level, a track change is "owning track" */
function clipProps(c: Obj, ref: ThingRef): Map<string, unknown> {
  const out = new Map<string, unknown>();
  out.set("@time", [c.start, c.end]);
  out.set("@track", ref.trackId);
  for (const [k, v] of Object.entries(c)) {
    if (k === "id" || k === "start" || k === "end" || v === undefined) continue;
    if ((DERIVED_PROPS.clip as readonly string[]).includes(k)) continue; // Computed (generated output), not listed
    if ((k === "params" || k === "frame") && isObj(v)) {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined) continue;
        if (k === "params" && sk === "lines" && isCaptionClip(c as { cardId?: string })) continue; // Caption lines are computed one by one separately
        out.set(`${k}.${sk}`, sv);
      }
      continue;
    }
    out.set(k, v);
  }
  return out;
}

function plainProps(v: Obj, skip: string[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, x] of Object.entries(v)) if (!skip.includes(k) && x !== undefined) out.set(k, x);
  return out;
}

function propsOf(f: Found): Map<string, unknown> {
  const v = isObj(f.value) ? f.value : {};
  switch (f.ref.kind) {
    case "clip": return clipProps(v, f.ref);
    case "settings": return plainProps(v, []);
    case "track": return plainProps(v, ["id", "clips"]);
    case "cut": return plainProps(v, ["id", "tracks", "duration", "transitions", "t"]);
    case "transition": return plainProps(v, ["id"]);
    case "library": return plainProps(v, f.ref.coll === "media" ? ["id", ...DERIVED_PROPS.media] : ["id"]);
    case "caption": {
      const l = f.value as CaptionLine;
      return new Map<string, unknown>([["time", [l.start, l.end]], ["zh", l.zh], ["en", l.en]]);
    }
    case "card": return new Map<string, unknown>([["source", f.value]]);
  }
}

function propDiff(a: Found, b: Found): MergeProp[] {
  const pa = propsOf(a), pb = propsOf(b);
  const keys = [...new Set([...pa.keys(), ...pb.keys()])];
  const out: MergeProp[] = [];
  for (const k of keys) {
    const x = box(pa.get(k)), y = box(pb.get(k));
    if (!sameBox(x, y)) out.push({ prop: k, base: x, mine: y });
  }
  return out;
}

/* ---------------- Caption lines ---------------- */

const overlap = (a: CaptionLine, b: CaptionLine) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Align two sets of caption lines: first match identical ones, pair the rest by largest time overlap, the others are adds or deletes */
export function alignLines(a: CaptionLine[], b: CaptionLine[]): { pairs: [number, number][]; onlyA: number[]; onlyB: number[] } {
  const usedB = new Set<number>();
  const pairOf = new Map<number, number>();
  a.forEach((la, i) => {
    const j = b.findIndex((lb, jj) => !usedB.has(jj) && deepEqual(la, lb));
    if (j >= 0) { usedB.add(j); pairOf.set(i, j); }
  });
  a.forEach((la, i) => {
    if (pairOf.has(i)) return;
    let best = -1, bestO = 0;
    b.forEach((lb, j) => {
      if (usedB.has(j)) return;
      const o = overlap(la, lb);
      if (o > bestO) { bestO = o; best = j; }
    });
    if (best >= 0) { usedB.add(best); pairOf.set(i, best); }
  });
  const pairs = [...pairOf.entries()].sort((x, y) => x[0] - y[0]);
  return { pairs, onlyA: a.map((_, i) => i).filter((i) => !pairOf.has(i)), onlyB: b.map((_, j) => j).filter((j) => !usedB.has(j)) };
}

const lineId = (l: CaptionLine) => `${l.start.toFixed(2)}-${l.end.toFixed(2)}-${shortHash(`${l.zh}|${l.en}`)}`;

function linesOf(clip: unknown): CaptionLine[] {
  return isObj(clip) && isObj(clip.params) ? parseCaptions(clip.params.lines) : [];
}

/** Caption clip exists in both baseline and my side: align line by line to produce the "captions" kind of item */
function captionThings(clipId: string, baseClip: Obj, mineClip: Obj): { base: Found | null; mine: Found | null }[] {
  const a = linesOf(baseClip), b = linesOf(mineClip);
  const { pairs, onlyA, onlyB } = alignLines(a, b);
  const out: { base: Found | null; mine: Found | null }[] = [];
  for (const [i, j] of pairs) {
    if (deepEqual(a[i], b[j])) continue;
    const ref: ThingRef = { kind: "caption", id: lineId(a[i]), clipId };
    out.push({ base: { ref, value: a[i] }, mine: { ref, value: b[j] } });
  }
  for (const i of onlyA) out.push({ base: { ref: { kind: "caption", id: lineId(a[i]), clipId }, value: a[i] }, mine: null });
  for (const j of onlyB) out.push({ base: null, mine: { ref: { kind: "caption", id: `+${lineId(b[j])}`, clipId }, value: b[j] } });
  return out;
}

/** Find a caption line in a project: added ones match the identical line, the rest match as-is first, then by largest time overlap */
function locateLine(p: Obj, ref: ThingRef, base: CaptionLine | undefined, mine: CaptionLine | undefined): { lines: CaptionLine[]; index: number; clip: Obj } | null {
  const at = findClip(p, ref.clipId ?? "");
  if (!at) return null;
  const lines = linesOf(at.clip);
  let index = -1;
  if (base) {
    index = lines.findIndex((l) => deepEqual(l, base));
    if (index < 0) {
      let bestO = 0;
      lines.forEach((l, i) => { const o = overlap(l, base); if (o > bestO) { bestO = o; index = i; } });
    }
  } else if (mine) {
    index = lines.findIndex((l) => deepEqual(l, mine));
  }
  return { lines, index, clip: at.clip };
}

/* ---------------- Display names ---------------- */

const quoted = (s: string) => trText("\"{0}\"", s);
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function clipName(c: Obj | undefined, id: string): string {
  if (!c) return id;
  let name = "";
  if (typeof c.cardId === "string" && c.cardId) name = shownNameOf(getCard(c.cardId)?.name) ?? c.cardId;
  else if (typeof c.label === "string" && c.label.trim()) name = c.label.trim();
  if (!name) return id;
  return typeof c.start === "number" ? `${name} @${c.start.toFixed(1)}s` : name;
}

const LIB_KIND: Record<string, string> = { media: trText("media"), filters: trText("Filters"), pixelMaps: trText("Pixel map"), audioFx: trText("Audio effects"), cardNodes: trText("Media effect card nodes") };

/** Human-readable name of an item */
export function thingLabel(ref: ThingRef, value: unknown): string {
  const v = isObj(value) ? value : undefined;
  const named = (kind: string) => `${kind}${quoted(v && typeof v.name === "string" && v.name.trim() ? v.name.trim() : ref.id)}`;
  switch (ref.kind) {
    case "clip": return trText("Clip {0}", quoted(clipName(v, ref.id)));
    case "caption": {
      const l = value as CaptionLine | undefined;
      return trText("Captions {0}", quoted(short(l ? l.zh || l.en || lineId(l) : ref.id, 20)));
    }
    case "settings": return trText("Project settings");
    case "track": return named(trText("track"));
    case "cut": return named(trText("Cut"));
    case "transition": return trText("Transition {0}", quoted(v && typeof v.kind === "string" ? v.kind : ref.id));
    case "library": return named(LIB_KIND[ref.coll ?? ""] ?? trText("Items"));
    case "card": return trText("Card source {0}", quoted(ref.id.replace(/^src\//, "")));
  }
}

const PROP_LABEL: Record<string, string> = {
  "@time": trText("Time"), "@track": trText("Track"),
  opacity: trText("Opacity"), fadeIn: trText("Fade in"), fadeOut: trText("Fade out"), label: trText("Name"), mediaOffset: trText("Media start"), speed: trText("Speed"), audioMuted: trText("Muted"), audioVolume: trText("Volume"),
  filter: trText("Filters"), pixelMap: trText("Pixel map"), audioFx: trText("Audio effects"), emphasis: trText("Emphasis"), motion: trText("Motion path"), parts: trText("Part"), cardId: trText("Cards"),
  mediaId: trText("media"), cutId: trText("Referenced cut"), cutOffset: trText("Cut start"), soundEffect: trText("Sound effect"), embeddedAudio: trText("Embedded audio"), cardAudio: trText("Card audio"), nodeId: trText("Nodes"),
  "frame.x": trText("Position X"), "frame.y": trText("Position Y"), "frame.w": trText("Width"), "frame.h": trText("High"), "frame.scale": trText("Scale"), "frame.rotate": trText("Rotate"),
  "frame.anchor": trText("Anchor"), "frame.rotateX": trText("X-axis flip"), "frame.rotateY": trText("Y-axis flip"), "frame.translateZ": trText("Depth"),
};
const CAPTION_PROP: Record<string, string> = { time: trText("Time"), zh: trText("Chinese"), en: trText("English") };
const SETTINGS_PROP: Record<string, string> = {
  name: trText("Name"), fps: trText("Frame rate"), width: trText("Width"), height: trText("Height"), duration: trText("Duration"), themeId: trText("Theme"), camera3dFov: trText("3D perspective"),
  glRoute: trText("Render route"), creativity: trText("Creativity level"), style: trText("Style"),
};
const TRACK_PROP: Record<string, string> = { name: trText("Name"), hidden: trText("Hidden"), muted: trText("Muted"), locked: trText("Locked") };
const TRANSITION_PROP: Record<string, string> = { kind: trText("Type"), dur: trText("Duration"), aId: trText("Previous segment"), bId: trText("Next segment"), prevB: trText("Original position") };

export function propLabel(kind: ThingKind, prop: string): string {
  if (prop === "") return trText("Whole item");
  switch (kind) {
    case "clip":
      if (PROP_LABEL[prop]) return PROP_LABEL[prop];
      if (prop.startsWith("params.")) return trText("Parameter {0}", quoted(prop.slice(7)));
      if (prop.startsWith("frame.")) return trText("Frame {0}", quoted(prop.slice(6)));
      return prop;
    case "caption": return CAPTION_PROP[prop] ?? prop;
    case "settings": return SETTINGS_PROP[prop] ?? prop;
    case "track": return TRACK_PROP[prop] ?? prop;
    case "cut": return prop === "name" ? trText("Name") : prop;
    case "transition": return TRANSITION_PROP[prop] ?? prop;
    case "library": return prop === "name" ? trText("Name") : prop;
    case "card": return trText("Source code");
  }
}

/** Human-readable form of a value */
export function formatValue(v: unknown, prop = "", names?: (trackId: string) => string | undefined): string {
  if (v === undefined || v === null) return trText("none");
  if ((prop === "@time" || prop === "time") && Array.isArray(v) && v.length === 2) {
    const [a, b] = v as number[];
    return trText("{0}–{1} s", num(a), num(b));
  }
  if (prop === "@track" && typeof v === "string") return trText("Track {0}", quoted(names?.(v) ?? v));
  if (typeof v === "boolean") return v ? trText("on") : trText("off");
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return quoted(short(v));
  let s = "";
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return short(s, 32);
}

function num(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/* ---------------- Compute the diff: baseline → my side ---------------- */

export interface DiffMeta {
  source: MergeSource;
  batch: string;
  baseRev: number;
  at: number;
}

/**
 * Compare baseline and my side to get the pending merge items. Lists only what "my side changed"; whether
 * the cloud changed is not decided here (computed on demand when displaying and merging).
 */
export function diffThings(base: Project, mine: Project, meta: DiffMeta): MergeThing[] {
  const B = collect(base as unknown as Obj), M = collect(mine as unknown as Obj);
  const out: MergeThing[] = [];
  const make = (ref: ThingRef, change: MergeThing["change"], b: Found | null, m: Found | null, props: MergeProp[]): MergeThing => ({
    key: `${meta.source}:${thingKeyOf(ref)}`,
    source: meta.source,
    batch: meta.batch,
    baseRev: meta.baseRev,
    at: meta.at,
    ref,
    change,
    label: thingLabel(ref, (m ?? b)?.value),
    base: b ? box(clone(b.value)) : null,
    mine: m ? box(clone(m.value)) : null,
    props,
  });
  for (const key of new Set([...B.keys(), ...M.keys()])) {
    const b = B.get(key) ?? null, m = M.get(key) ?? null;
    if (b && m) {
      // Clip moved: my side's position wins (adds, restores, and track changes all go here)
      const ref = m.ref;
      const props = propDiff(b, m);
      if (props.length) out.push(make(ref, "modify", b, m, props.map((p) => ({ ...p, base: clone(p.base), mine: clone(p.mine) }))));
      if (ref.kind === "clip" && isCaptionClip(m.value as { cardId?: string }) && isCaptionClip(b.value as { cardId?: string })) {
        for (const line of captionThings(ref.id, b.value as Obj, m.value as Obj)) {
          const lref = (line.mine ?? line.base)!.ref;
          if (line.base && line.mine) out.push(make(lref, "modify", line.base, line.mine, propDiff(line.base, line.mine)));
          else if (line.base) out.push(make(lref, "delete", line.base, null, [{ prop: "", base: box(clone(line.base.value)), mine: null }]));
          else if (line.mine) out.push(make(lref, "add", null, line.mine, [{ prop: "", base: null, mine: box(clone(line.mine.value)) }]));
        }
      }
    } else if (b) {
      out.push(make(b.ref, "delete", b, null, [{ prop: "", base: box(clone(b.value)), mine: null }]));
    } else if (m) {
      out.push(make(m.ref, "add", null, m, [{ prop: "", base: null, mine: box(clone(m.value)) }]));
    }
  }
  return out;
}

/**
 * Merge a new batch into the existing table: for the same source and the same item keep only one entry
 * ("one entry per property"); for the same property the newer one wins.
 * When the change kinds differ (earlier recorded a delete, now a modification) keep both, and the new
 * key carries the batch number.
 */
export function mergeIntoTable(table: MergeThing[], incoming: MergeThing[]): MergeThing[] {
  const out = [...table];
  for (const t of incoming) {
    const i = out.findIndex((x) => x.key === t.key);
    if (i < 0) { out.push(t); continue; }
    const old = out[i];
    if (old.change !== t.change) { out.push({ ...t, key: `${t.key}#${t.batch}` }); continue; }
    if (t.change !== "modify") { out[i] = { ...t, base: old.base }; continue; }
    const props = [...old.props];
    for (const p of t.props) {
      const j = props.findIndex((x) => x.prop === p.prop);
      if (j < 0) props.push(p);
      else props[j] = p;
    }
    out[i] = { ...t, base: old.base, props };
  }
  return out;
}

/* ---------------- Check against the current project: conflicts, what the cloud has now ---------------- */

/** Find an item in a project (clips by id, regardless of which track or cut they live in) */
function locate(p: Obj, t: MergeThing): Found | null {
  const ref = t.ref;
  switch (ref.kind) {
    case "clip": {
      const at = findClip(p, ref.id);
      return at ? { ref: { ...ref, trackId: at.track.id as string, cutId: at.cutId }, value: at.clip } : null;
    }
    case "caption": {
      const at = locateLine(p, ref, val(t.base) as CaptionLine | undefined, val(t.mine) as CaptionLine | undefined);
      return at && at.index >= 0 ? { ref, value: at.lines[at.index] } : null;
    }
    case "settings": return { ref, value: settingsOf(p) };
    case "track": {
      const at = findTrack(p, ref.id);
      return at ? { ref: { ...ref, cutId: at.cutId }, value: at.track } : null;
    }
    case "cut": {
      const c = (Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []).find((x) => isObj(x) && x.id === ref.id);
      return c ? { ref, value: cutValue(p, c) } : null;
    }
    case "transition": {
      for (const h of transitionLists(p)) {
        const tr = h.list.find((x) => isObj(x) && x.id === ref.id);
        if (tr) return { ref: { ...ref, cutId: h.cutId }, value: tr };
      }
      return null;
    }
    case "library": {
      const e = (Array.isArray(p[ref.coll ?? ""]) ? (p[ref.coll ?? ""] as Obj[]) : []).find((x) => isObj(x) && x.id === ref.id);
      return e ? { ref, value: e } : null;
    }
    case "card": return t.base ? { ref, value: val(t.base) } : null;
  }
}

function propValue(f: Found, prop: string): unknown {
  return propsOf(f).get(prop);
}

export type PropState = "clean" | "conflict" | "same" | "cloud-gone";

export interface PropRow {
  /** Key of a level-2 entry `<item key>|<property>` */
  id: string;
  prop: string;
  label: string;
  text: string;
  state: PropState;
  conflict: boolean;
  /** Current value in the cloud (compared against for "re-verify on every Merge click") */
  cloud: Box;
}

export interface ThingRow {
  key: string;
  source: MergeSource;
  label: string;
  change: MergeThing["change"];
  /** Level-1 wording: added / deleted / modified / deleted in the cloud */
  changeText: string;
  conflict: boolean;
  props: PropRow[];
}

export const propRowId = (thingKey: string, prop: string) => `${thingKey}|${prop}`;

/** Current state of a level-2 entry and the cloud's value */
function propState(t: MergeThing, p: MergeProp, cloud: Found | null): { state: PropState; cloud: Box } {
  if (t.change === "add") {
    if (!cloud) return { state: "clean", cloud: null };
    return { state: sameBox(box(cloud.value), t.mine) ? "same" : "conflict", cloud: box(cloud.value) };
  }
  if (t.change === "delete") {
    if (!cloud) return { state: "same", cloud: null };
    return { state: sameBox(box(cloud.value), t.base) ? "clean" : "conflict", cloud: box(cloud.value) };
  }
  if (!cloud) return { state: "cloud-gone", cloud: null };
  const c = box(propValue(cloud, p.prop));
  if (sameBox(c, p.mine)) return { state: "same", cloud: c };
  return { state: sameBox(c, p.base) ? "clean" : "conflict", cloud: c };
}

/** Two-level list shown in the window; conflicts and cloud values are computed against the current project */
export function mergeRows(project: Project, table: MergeThing[]): ThingRow[] {
  const p = project as unknown as Obj;
  const trackName = (id: string) => {
    const at = findTrack(p, id);
    return at && typeof at.track.name === "string" ? at.track.name : undefined;
  };
  return table.map((t) => {
    const cloud = locate(p, t);
    const props: PropRow[] = t.props.map((mp) => {
      const { state, cloud: c } = propState(t, mp, cloud);
      const label = propLabel(t.ref.kind, mp.prop);
      let text: string;
      if (t.ref.kind === "card") {
        const d = lineDelta(String(val(c) ?? ""), String(val(mp.mine) ?? ""));
        text = trText("Source: my version has {0} more lines and {1} fewer lines than the cloud's current version (the cloud version was edited by someone else)", d.added, d.removed);
      } else if (t.change === "add") {
        text = state === "clean" ? trText("Added on my side (not in the cloud yet)") : state === "same" ? trText("Added on my side (the cloud already has the same)") : trText("Added on my side (the cloud already has a different one)");
      } else if (t.change === "delete") {
        text = state === "clean" ? trText("Deleted on my side (unchanged in the cloud)") : state === "same" ? trText("Deleted on my side (also gone in the cloud)") : trText("Deleted on my side (the cloud version has since been changed by someone else)");
      } else {
        const from = formatValue(val(mp.base), mp.prop, trackName), to = formatValue(val(mp.mine), mp.prop, trackName);
        const now = state === "cloud-gone" ? trText("Deleted in the cloud") : trText("The cloud is now {0}", formatValue(val(c), mp.prop, trackName));
        text = trText("{0} {1} → {2} ({3})", label, from, to, now);
      }
      return { id: propRowId(t.key, mp.prop), prop: mp.prop, label, text, state, conflict: state === "conflict" || state === "cloud-gone", cloud: c };
    });
    const cloudGone = t.change === "modify" && !cloud;
    return {
      key: t.key,
      source: t.source,
      label: t.label,
      change: t.change,
      changeText: t.change === "add" ? trText("Add") : t.change === "delete" ? trText("Delete") : cloudGone ? trText("Deleted in the cloud") : trText("Change"),
      conflict: props.some((r) => r.conflict),
      props,
    };
  });
}

/**
 * "N changes pending merge, M of them in conflict" on the conflict banner and buttons: counted by level 1
 * (the item that was changed), consistent with the mobile app demo; `items` is the total number of
 * level-2 entries (the "N selected" side counts level-2 entries).
 */
export function mergeCounts(rows: ThingRow[]): { total: number; conflicts: number; items: number } {
  let items = 0;
  for (const r of rows) items += r.props.length;
  return { total: rows.length, conflicts: rows.filter((r) => r.conflict).length, items };
}

/* ---------------- Merge: write the selected level-2 entries into the project as on my side ---------------- */

export interface ApplyResult {
  project: Project;
  /** Not in the project JSON, must be written elsewhere (card source: the editor process's card source sync `takeMine`); removed from the table once written */
  external: { key: string; props: string[]; thing: MergeThing }[];
  /** Written (including tracks, cuts, and assets merged in along with them); removed from the table */
  done: { key: string; props: string[] }[];
  /** Not written, with reasons; kept in the table */
  failed: { key: string; prop: string; reason: string }[];
}

class Skip extends Error {}

function sortByStart(clips: Obj[]) {
  clips.sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0));
}

function setProp(kind: ThingKind, obj: Obj, prop: string, b: Box) {
  const v = val(b);
  if (kind === "clip" && prop === "@time") {
    const [s, e] = Array.isArray(v) ? (v as number[]) : [];
    obj.start = s; obj.end = e;
    return;
  }
  if (kind === "clip" && prop === "@track") return; // Position is handled separately
  if (kind === "clip" && (prop.startsWith("params.") || prop.startsWith("frame."))) {
    const [k, ...rest] = prop.split(".");
    const sk = rest.join(".");
    const inner: Obj = isObj(obj[k]) ? { ...(obj[k] as Obj) } : {};
    if (v === undefined) delete inner[sk];
    else inner[sk] = clone(v);
    obj[k] = inner;
    return;
  }
  if (kind === "caption") {
    const l = obj as unknown as CaptionLine;
    if (prop === "time" && Array.isArray(v)) { l.start = Number(v[0]); l.end = Number(v[1]); }
    else if (prop === "zh" || prop === "en") l[prop] = typeof v === "string" ? v : "";
    return;
  }
  if (v === undefined) delete obj[prop];
  else obj[prop] = clone(v);
}

/** A clip to be placed into a track must not overlap other clips in the same track */
function overlapsIn(track: Obj, clip: Obj): boolean {
  const s = Number(clip.start), e = Number(clip.end);
  return (Array.isArray(track.clips) ? (track.clips as Obj[]) : []).some((c) => c.id !== clip.id && Number(c.start) < e && s < Number(c.end));
}

/**
 * On the current project (the cloud's current state plus this page's unconfirmed edits), write the
 * selected entries as on my side. Does not mutate the input; returns a new project.
 * `selection`: item key → selected properties. When a track, cut, or asset to be added is not in the
 * cloud, and the table has its add, it is merged in along with it.
 */
export function applyMerge(project: Project, table: MergeThing[], selection: Map<string, Set<string>>, opts: { manualDuration?: number | null } = {}): ApplyResult {
  const p = structuredClone(project) as unknown as Obj;
  const done = new Map<string, Set<string>>();
  const failed: ApplyResult["failed"] = [];
  const external: ApplyResult["external"] = [];
  const mark = (key: string, props: string[]) => {
    let s = done.get(key);
    if (!s) done.set(key, (s = new Set()));
    for (const x of props) s.add(x);
  };
  const byKey = new Map(table.map((t) => [t.key, t]));

  /** The add of an item pending in the table (dependency of a track, cut, or asset) */
  const pendingAdd = (kind: ThingKind, id: string, coll?: string) =>
    table.find((t) => t.change === "add" && t.ref.kind === kind && t.ref.id === id && (coll === undefined || t.ref.coll === coll) && !done.has(t.key));

  const ensureCut = (cutId: string | null | undefined) => {
    if (!cutId) return;
    if ((Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []).some((c) => c.id === cutId)) return;
    const dep = pendingAdd("cut", cutId);
    if (!dep) throw new Skip(trText("The containing cut no longer exists in the cloud"));
    writeThing(dep, val(dep.mine) as Obj);
    mark(dep.key, [""]);
  };
  const ensureTrack = (trackId: string | undefined, cutId: string | null | undefined): Obj => {
    const at = trackId ? findTrack(p, trackId) : null;
    if (at) return at.track;
    const dep = trackId ? pendingAdd("track", trackId) : undefined;
    if (!dep) throw new Skip(trText("Its track no longer exists in the cloud"));
    ensureCut(dep.ref.cutId ?? cutId);
    writeThing(dep, val(dep.mine) as Obj);
    mark(dep.key, [""]);
    return findTrack(p, trackId!)!.track;
  };
  const ensureMedia = (clip: Obj) => {
    const mediaId = typeof clip.mediaId === "string" ? clip.mediaId : null;
    if (!mediaId) return;
    if ((Array.isArray(p.media) ? (p.media as Obj[]) : []).some((m) => m.id === mediaId)) return;
    const dep = pendingAdd("library", mediaId, "media");
    if (!dep) throw new Skip(trText("The media used no longer exists in the cloud"));
    writeThing(dep, val(dep.mine) as Obj);
    mark(dep.key, [""]);
  };

  /** Write a whole item as value (undefined = delete it) */
  function writeThing(t: MergeThing, value: Obj | CaptionLine | undefined, opts: { move?: boolean } = {}) {
    const ref = t.ref;
    switch (ref.kind) {
      case "clip": {
        const at = findClip(p, ref.id);
        if (value === undefined) {
          if (at) at.track.clips = (at.track.clips as Obj[]).filter((c) => c.id !== ref.id);
          return;
        }
        const clip = clone(value) as Obj;
        ensureMedia(clip);
        if (at && !opts.move) {
          const others = { ...at.track, clips: (at.track.clips as Obj[]).filter((c) => c.id !== ref.id) };
          if (overlapsIn(others, clip)) throw new Skip(trText("Overlaps a clip in the same track"));
          const list = (at.track.clips as Obj[]).map((c) => (c.id === ref.id ? clip : c));
          sortByStart(list);
          at.track.clips = list;
          return;
        }
        const track = ensureTrack(ref.trackId, ref.cutId);
        if (overlapsIn(track, clip)) throw new Skip(trText("Overlaps a clip in the same track"));
        if (at) at.track.clips = (at.track.clips as Obj[]).filter((c) => c.id !== ref.id);
        const list = [...((track.clips as Obj[] | undefined) ?? []), clip];
        sortByStart(list);
        track.clips = list;
        return;
      }
      case "caption": {
        const line = value as CaptionLine | undefined;
        const at = locateLine(p, ref, val(t.base) as CaptionLine | undefined, val(t.mine) as CaptionLine | undefined);
        if (!at) throw new Skip(trText("The clip the captions belong to no longer exists in the cloud"));
        const lines = [...at.lines];
        if (line === undefined) { if (at.index >= 0) lines.splice(at.index, 1); }
        else if (at.index >= 0) lines[at.index] = { ...line };
        else lines.push({ ...line });
        const params = isObj(at.clip.params) ? { ...(at.clip.params as Obj) } : {};
        params.lines = formatCaptions(lines);
        at.clip.params = params;
        return;
      }
      case "settings": {
        const v = (value ?? {}) as Obj;
        for (const k of Object.keys(settingsOf(p))) if (!(k in v)) delete p[k];
        for (const [k, x] of Object.entries(v)) p[k] = clone(x);
        return;
      }
      case "track": {
        const at = findTrack(p, ref.id);
        if (value === undefined) {
          if (at) at.list.splice(at.list.indexOf(at.track), 1);
          return;
        }
        if (at) {
          const next = { ...clone(value as Obj), clips: at.track.clips };
          at.list[at.list.indexOf(at.track)] = next;
          return;
        }
        ensureCut(ref.cutId);
        const home = ref.cutId ? ((p.cuts as Obj[]).find((c) => c.id === ref.cutId) as Obj) : p;
        if (!Array.isArray(home.tracks)) {
          // The cut is the one currently active in the cloud: content is at the project top level
          if (ref.cutId && p.activeCutId === ref.cutId) (p.tracks as Obj[]).push({ ...clone(value as Obj), clips: [] });
          else throw new Skip(trText("The containing cut no longer exists in the cloud"));
          return;
        }
        (home.tracks as Obj[]).push({ ...clone(value as Obj), clips: [] });
        return;
      }
      case "cut": {
        const cuts = Array.isArray(p.cuts) ? (p.cuts as Obj[]) : (p.cuts = []) as Obj[];
        const i = cuts.findIndex((c) => c.id === ref.id);
        if (value === undefined) {
          if (i < 0) return;
          if (p.activeCutId === ref.id) throw new Skip(trText("This cut is currently open in the cloud, so it can't be deleted"));
          cuts.splice(i, 1);
          return;
        }
        if (i >= 0) { cuts[i] = { ...cuts[i], name: (value as Obj).name }; return; }
        // A newly added cut is inserted in its parked form; tracks and clips are merged one by one
        const v = value as Obj;
        cuts.push({ id: v.id, name: v.name, tracks: [], duration: typeof v.duration === "number" ? v.duration : 0, transitions: [] });
        return;
      }
      case "transition": {
        let home: Obj[] | null = null;
        for (const h of transitionLists(p)) if (h.list.some((x) => x.id === ref.id)) home = h.list;
        if (value === undefined) {
          if (home) home.splice(home.findIndex((x) => x.id === ref.id), 1);
          return;
        }
        if (home) { home[home.findIndex((x) => x.id === ref.id)] = clone(value as Obj); return; }
        if (ref.cutId) {
          const c = (Array.isArray(p.cuts) ? (p.cuts as Obj[]) : []).find((x) => x.id === ref.cutId);
          if (!c) throw new Skip(trText("The containing cut no longer exists in the cloud"));
          if (p.activeCutId !== ref.cutId) { c.transitions = [...((c.transitions as Obj[]) ?? []), clone(value as Obj)]; return; }
        }
        p.transitions = [...((p.transitions as Obj[]) ?? []), clone(value as Obj)];
        return;
      }
      case "library": {
        const coll = ref.coll ?? "";
        const list = Array.isArray(p[coll]) ? [...(p[coll] as Obj[])] : [];
        const i = list.findIndex((x) => x.id === ref.id);
        if (value === undefined) { if (i >= 0) list.splice(i, 1); }
        else if (i >= 0) list[i] = clone(value as Obj);
        else list.push(clone(value as Obj));
        p[coll] = list;
        return;
      }
    }
  }

  for (const [key, props] of selection) {
    const t = byKey.get(key);
    if (!t || !props.size) continue;
    if (done.has(key) && t.change !== "modify") continue; // Already merged in as a dependency
    if (t.ref.kind === "card") { external.push({ key, props: [...props], thing: t }); continue; }
    try {
      if (t.change === "add") {
        writeThing(t, val(t.mine) as Obj);
        mark(key, [""]);
        continue;
      }
      if (t.change === "delete") {
        writeThing(t, undefined);
        mark(key, [""]);
        continue;
      }
      const chosen = t.props.filter((x) => props.has(x.prop));
      if (!chosen.length) continue;
      const cloud = locate(p, t);
      if (!cloud) {
        // I changed it, the cloud deleted it: "Merge" = restore it together with my changes; unchecked properties follow the baseline
        const restored = clone(val(t.mine)) as Obj;
        for (const x of t.props) if (!props.has(x.prop)) setProp(t.ref.kind, restored, x.prop, x.base);
        writeThing(t, restored, { move: true });
        mark(key, chosen.map((x) => x.prop));
        continue;
      }
      const next = clone(cloud.value) as Obj;
      for (const x of chosen) setProp(t.ref.kind, next, x.prop, x.mine);
      const move = t.ref.kind === "clip" && chosen.some((x) => x.prop === "@track");
      writeThing(t, next, { move });
      mark(key, chosen.map((x) => x.prop));
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      for (const x of t.change === "modify" ? t.props.filter((y) => props.has(y.prop)) : t.props) failed.push({ key, prop: x.prop, reason: e.message });
    }
  }
  // The total duration is computed (not in the table): after merging clips, recompute it by the rules from the end of the content (a manually truncated value is supplied by the caller from the editor state)
  if (done.size && Array.isArray(p.tracks) && typeof p.duration === "number") {
    p.duration = effectiveDuration(contentEndOf(p.tracks as Track[]), p.duration, opts.manualDuration ?? null);
  }
  return { project: p as unknown as Project, done: [...done].map(([key, s]) => ({ key, props: [...s] })), failed, external };
}

/** Compare two texts by line: how many lines my side has more or fewer than the other (used for the card source sentence in the conflict window; when too long, estimated from the line multiset) */
const NL = "\n";
export function lineDelta(from: string, to: string): { added: number; removed: number } {
  const a = from.split(NL), b = to.split(NL);
  if (a.length * b.length > 4_000_000) {
    const count = new Map<string, number>();
    for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
    let common = 0;
    for (const l of b) { const n = count.get(l) ?? 0; if (n > 0) { common++; count.set(l, n - 1); } }
    return { added: b.length - common, removed: a.length - common };
  }
  let prev = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint32Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  const lcs = prev[b.length];
  return { added: b.length - lcs, removed: a.length - lcs };
}

/**
 * A card's conflict (handed over by card source sync on reconnect after being offline: changed locally,
 * and changed in the cloud by someone else too) → one entry in the pending merge table.
 * Level 1 is this card (the source file), level 2 is "source"; `base` records the cloud's version at the
 * moment of conflict (already installed locally), `mine` is my side's.
 */
export function cardConflictThing(o: { key: string; mine: string; cloud: string; rev: number; at: number; batch: string; source?: MergeSource }): MergeThing {
  const ref: ThingRef = { kind: "card", id: o.key };
  const source = o.source ?? "offline";
  return {
    key: `${source}:${thingKeyOf(ref)}`, source, batch: o.batch, baseRev: o.rev, at: o.at, ref, change: "modify",
    label: thingLabel(ref, null), base: { v: o.cloud }, mine: { v: o.mine },
    props: [{ prop: "source", base: null, mine: { v: o.mine } }],
  };
}

/** Remove these level-2 entries from the table; when an item's level-2 entries are all removed, remove that item too */
export function removeFromTable(table: MergeThing[], remove: { key: string; props: string[] }[]): MergeThing[] {
  const drop = new Map(remove.map((r) => [r.key, new Set(r.props)]));
  const out: MergeThing[] = [];
  for (const t of table) {
    const d = drop.get(t.key);
    if (!d) { out.push(t); continue; }
    const props = t.props.filter((x) => !d.has(x.prop));
    if (props.length) out.push({ ...t, props });
  }
  return out;
}

/**
 * "Re-verify on every Merge click": compare the cloud values recorded when displayed in the window with
 * the current ones; level-2 entries that changed are not merged this time and are refreshed for the user to review.
 * `seen`: level-2 entry key → the cloud value at display time.
 */
export function staleSelections(project: Project, table: MergeThing[], seen: Map<string, Box>, selection: Map<string, Set<string>>): string[] {
  const rows = mergeRows(project, table.filter((t) => selection.has(t.key)));
  const out: string[] = [];
  for (const r of rows) for (const p of r.props) {
    if (!selection.get(r.key)?.has(p.prop)) continue;
    const before = seen.get(p.id);
    if (before === undefined) continue;
    if (!sameBox(before, p.cloud)) out.push(p.id);
  }
  return out;
}

/* ---------------- Selection (shared by the desktop window and the mobile panel) ---------------- */

/** Selection state: item key → checked properties */
export type Selection = Map<string, Set<string>>;

/** "Select non-conflicting": check all non-conflicting level-2 entries (existing selections are left alone) */
export function selectNonConflict(rows: ThingRow[], prev: Selection = new Map()): Selection {
  const next: Selection = new Map([...prev].map(([k, s]) => [k, new Set(s)]));
  for (const r of rows) for (const p of r.props) {
    if (p.conflict) continue;
    let s = next.get(r.key);
    if (!s) next.set(r.key, (s = new Set()));
    s.add(p.prop);
  }
  return next;
}

/** Level-1 checkbox: all checked / partial / none checked */
export function thingCheck(row: ThingRow, sel: Selection): "all" | "some" | "none" {
  const s = sel.get(row.key);
  const n = s ? row.props.filter((p) => s.has(p.prop)).length : 0;
  return n === 0 ? "none" : n === row.props.length ? "all" : "some";
}

/** Click a level-1 checkbox: check all if not all checked, uncheck all if all checked */
export function toggleThing(row: ThingRow, sel: Selection): Selection {
  const next: Selection = new Map(sel);
  if (thingCheck(row, sel) === "all") next.delete(row.key);
  else next.set(row.key, new Set(row.props.map((p) => p.prop)));
  return next;
}

/** Click a level-2 checkbox */
export function toggleProp(row: ThingRow, prop: string, sel: Selection): Selection {
  const next: Selection = new Map(sel);
  const s = new Set(next.get(row.key) ?? []);
  if (s.has(prop)) s.delete(prop);
  else s.add(prop);
  if (s.size) next.set(row.key, s);
  else next.delete(row.key);
  return next;
}

/** How many are checked (counting level-2 entries), only those still in the list */
export function selectedCount(rows: ThingRow[], sel: Selection): number {
  let n = 0;
  for (const r of rows) { const s = sel.get(r.key); if (s) n += r.props.filter((p) => s.has(p.prop)).length; }
  return n;
}

/** Drop entries from the selection that are no longer in the list (after merge or delete) */
export function pruneSelection(rows: ThingRow[], sel: Selection): Selection {
  const next: Selection = new Map();
  for (const r of rows) {
    const s = sel.get(r.key);
    if (!s) continue;
    const kept = new Set(r.props.filter((p) => s.has(p.prop)).map((p) => p.prop));
    if (kept.size) next.set(r.key, kept);
  }
  return next;
}

/** Turn the selection into a manifest of "item key + property" (used for delete selected and removal from the table) */
export function selectionList(sel: Selection): { key: string; props: string[] }[] {
  return [...sel].map(([key, s]) => ({ key, props: [...s] }));
}
