import type { Clip, Timeline } from "./types";
import type { SoundEffectRecipe } from "./soundEffects";
import { cutOf, cutSegmentRender, CUT_SEGMENT_CARD, type CutRenderProject, type TimelineCutClip } from "./cutSegments.ts";
import { envelopeAt, type CutEnvelope } from "./cutAudio.mjs";
import { cardClockOffset, clipSpeed } from "./clipTime.mjs";
import type { FrameExprMap } from "./frameExpr.mjs";
import {
  activeCutEntry,
  activeCutKind,
  cutKindOf,
  cutSpaceSize,
  defaultCutFovDeg,
  effectiveCamera3dFov,
  type CameraClip,
  type CutKind,
  type ResolvedCamera2D,
  type ResolvedCamera3D,
} from "./camera.mjs";

export {
  activeCutEntry,
  activeCutKind,
  cutKindOf,
  cutSpaceSize,
  defaultCutFovDeg,
  effectiveCamera3dFov,
  type CameraClip,
  type CutKind,
  type FrameExprMap,
  type ResolvedCamera2D,
  type ResolvedCamera3D,
};

export interface PreOverlayAttachment {
  id: string;
  cardId: string;
  params: Record<string, unknown>;
  off?: boolean;
}

declare module "./types" {
  interface Clip {
    frameExpr?: FrameExprMap;
    preOverlays?: PreOverlayAttachment[];
  }
  interface Timeline {
    cutKind?: CutKind;
    cameras?: CameraClip[];
    spaceWidth?: number;
    spaceHeight?: number;
    renderView?: "camera" | "space";
  }
}

/** Regenerable sound effect recipe. reuseKey is synthesis input identity, not WAV content hash. */
export interface SoundEffectLink {
  recipe: SoundEffectRecipe;
  reuseKey: string;
}

export interface SoundEffectClipLink extends SoundEffectLink {
  requestId: string;
  /** Audio-visual shares time anchor; audio still only consumes regular WAV assets. */
  sourceClipId?: string;
}


/**
 * Project document model (multi-track). This is the single source of truth shared by editor,
 * timeline, left and right rails, MCP tools, and import/export.
 * The .promptcut.json saved to disk is the JSON of Project.
 */

/** A segment of speech-to-text */
export interface TranscriptSegment {
  start: number; // Seconds (time within asset)
  end: number;
  text: string;
}

export interface Transcript {
  engine: string; // "faster-whisper" | "whisper"
  model: string;
  language?: string;
  createdAt: string; // ISO
  segments: TranscriptSegment[];
}

export type TransitionKind = "cut" | "dissolve";

/** A transition. Hard cut start/end are nearly equal; dissolve is start/end of the gradient */
export interface ShotTransition {
  kind: TransitionKind;
  start: number;
  end: number;
  /** Time of the frame with the highest confidence, aligned to when drawing markers */
  time: number;
  confidence: number;
  /** Thumbnail filename. Dissolves have two (one before and after gradient), drawn stacked on timeline */
  thumbs?: string[];
}

/** Shot division result, written by the shot detection tool */
export interface Shots {
  /** transnetv2 recognizes dissolves; scdet is fallback when extension is not installed, only hard cuts */
  engine: "transnetv2" | "scdet";
  createdAt: string;
  transitions: ShotTransition[];
  shots: { start: number; end: number; inTransition: TransitionKind | null; outTransition: TransitionKind | null }[];
}

/** A target box on screen. Coordinates are **raw asset pixels**, same system as width/height */
export interface SubjectBox {
  /** light tier has only person / face; full tier uses nouns from the prompt */
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  conf: number;
}

/**
 * Target box coverage across four directions (0~1). left/right are left/right half-screens,
 * top/bottom are upper/lower 1/3 bands.
 */
export interface SubjectOccupancy {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type SafeSide = "left" | "right" | "top" | "bottom";

/** Detection result from sampling a frame at a specific point in time */
export interface SubjectSample {
  /** Seconds within the asset */
  t: number;
  boxes: SubjectBox[];
  /** Side with the minimum occupancy: placing cards on this side is least likely to cover people */
  safeSide: SafeSide;
  occupancy: SubjectOccupancy;
  /**
   * true indicates this frame **failed to extract** (seek exceeded duration, file segment was
   * corrupted); boxes above is empty, all four occupancy values are 0, and safeSide is a placeholder.
   *
   * This flag is indispensable: samples that failed extraction are field-by-field identical in JSON to
   * "this frame truly has nobody"; without marking it, subjectForRange would average in a string of
   * zeros, yielding the false conclusion "nobody in this range, right side is safe": precisely the
   * kind of mistake this feature must avoid. The read side always filters out failed first.
   */
  failed?: boolean;
  /** Reason when failed is true (the string from Python side), used to show which frame and why */
  reason?: string;
}

/** Subject detection result, written by detect_subjects */
export interface Subjects {
  /** light = YuNet + RT-DETR (person/face only); full = plus Grounding DINO (recognizes prompts) */
  engine: "light" | "full";
  createdAt: string;
  /** Prompt used during detection. light tier ignores it but stores as-is to trace result origins */
  prompt: string;
  /** Raw asset width and height, coordinate system for boxes */
  width: number;
  height: number;
  samples: SubjectSample[];
  /** Number of failed items in samples. 0 or omitted indicates every frame was extracted */
  failedCount?: number;
  /**
   * Populated with "full" when full tier was intended but fell back to light mid-way (e.g. DINO
   * directory lacks tokenizer files).
   * The engine field records the tier **actually** run, so looking only at engine would suggest
   * the user only installed light in the first place.
   */
  fellBackFrom?: "full";
  /** Reason for fellBackFrom, passed to caller as-is: without the reason, the user cannot fix it */
  fallbackReason?: string;
}

/**
 * Two tiers for the same asset (A1 step 5: smaller first, larger later); values are their content hashes.
 * `original` is MediaAsset.hash; `small` is an H.264 tier within 800×600.
 * Tier switch criteria is in playbackUrl of src/render/mediaTier.ts (inspects only hashes reported
 * complete by the asset service). Small-size asset is generated locally by the importer (C6.6,
 * server/media-tiers.mjs).
 * "Whether this device can play original-size assets" is not a project-level fact and is not recorded
 * here, see src/render/playability.ts.
 */
export interface MediaTiers {
  small?: string;
  original: string;
}

export interface MediaAsset {
  soundEffect?: SoundEffectLink;
  /** Shot cut detection result (optional, written by detect_shots) */
  shots?: Shots;
  /** Subject detection result (optional, written by detect_subjects) */
  subjects?: Subjects;
  /** Speech-to-text result (optional, written by STT tool) */
  transcript?: Transcript;
  id: string;
  kind: "video" | "audio" | "image";
  name: string;
  /** Playable URL in browser (blob: or /media/xxx); relative path stored when saving project */
  url: string;
  /** Server-readable absolute disk path, obtained from upload during import; may not exist */
  path?: string;
  /**
   * Asset key = sha256 of file content (64-character lowercase hex), computed on the server while
   * writing to disk during import (storeMediaStream in server/vite-plugin-media.ts). With it, everything
   * routes through /@media/<hash>: renaming, changing mtime, or copying to another machine still yields
   * the same key. Files without a hash are legacy .proc from the transition period: those continue to
   * find files by path / filename.
   */
  hash?: string;
  /**
   * Original file extension (no dot, lowercase). Stored as <hash>.<ext> in content store; playback
   * relies on it to determine Content-Type.
   */
  ext?: string;
  /** Original file size in bytes */
  size?: number;
  /**
   * Still being stored (uploading / computing hash): this layer renders an "Uploading" placeholder first,
   * without attaching an empty src.
   * Only meaningful within an editor session; cleared by restoreMediaUrls when saved to disk and reopened.
   */
  pending?: boolean;
  /**
   * A1: two tiers for the same asset (smaller first, larger later). Video only; small-size asset is
   * generated locally by importer (C6.6), for tier switch see src/render/mediaTier.ts.
   */
  tiers?: MediaTiers;
  duration?: number; // Seconds
  width?: number;
  height?: number;
  /**
   * Which video the "audio only" copy was derived from (soundAssetFrom).
   * Both point to the same file, differing only in kind: no transcoding is done, so "create as sound"
   * is instantaneous.
   * Used to find the source file when exporting and uploading local files (see editor/io/index.ts).
   */
  soundOf?: string;
  /** Only an explicit, serialized recovery result may activate a missing-material proxy. */
  missingMaterial?: {
    v: 1;
    mediaId: string;
    original: { kind: "video" | "audio" | "image"; name: string; url: string; hash?: string; path?: string };
    reason: "confirmed-missing";
    visual: boolean;
    audio: boolean;
  };
}

/**
 * Old projects used to register every image as kind:"video". At render time you cannot trust kind
 * alone, otherwise a JPG/PNG gets attached to a <video> and Chrome reports a decode error after the
 * first frame. File name, path and URL all take part in the check, covering the three address forms
 * before and after saving.
 */
const IMAGE_MEDIA_EXT = /\.(?:png|jpe?g|gif|webp|bmp|avif|tiff?|svg|heic|heif)(?:[?#]|$)/i;
export function isImageMedia(media: Pick<MediaAsset, "kind" | "name" | "path" | "url">): boolean {
  if (media.kind === "image") return true;
  return [media.name, media.path, media.url].some((value) =>
    typeof value === "string" && IMAGE_MEDIA_EXT.test(value.split(/[?#]/, 1)[0]),
  );
}

/**
 * Derives an "audio only" asset from a video: same file, same duration, kind changed to audio.
 * No transcoding: playing an mp4 through <audio> in a browser outputs only the sound, and the ffmpeg
 * mix takes only the audio track too, so there is no need to cut out a separate file first.
 */
export function soundAssetFrom(src: MediaAsset, id: string): MediaAsset {
  return {
    id,
    kind: "audio",
    name: `${src.name.replace(/\.[^.]+$/, "")} · Audio`,
    url: src.url,
    ...(src.path ? { path: src.path } : {}),
    ...(src.duration != null ? { duration: src.duration } : {}),
    // Transcription is done on the same audio track, so the derived one just inherits it and we
    // avoid transcribing again
    ...(src.transcript ? { transcript: src.transcript } : {}),
    soundOf: src.id,
  };
}

/** Has this asset's audio already been derived? (Idempotent: only one copy is kept per asset) */
export function findSoundAsset(p: Project, mediaId: string): MediaAsset | undefined {
  return p.media.find((m) => m.kind === "audio" && m.soundOf === mediaId);
}

/**
 * Track (formerly split into two kinds, "motion graphics track / video track"; no longer):
 * a track can hold both card clips (cardId) and media clips (mediaId), non-overlapping and
 * sorted by start.
 * Stacking order follows what you see on the timeline: **higher tracks are drawn on top**
 * (tracks[0] is the top row, i.e. the topmost layer). Rendering walks the array in reverse, so
 * later DOM nodes still cover earlier ones, and everything downstream (Stage, MediaLayers,
 * videoClipAt, hit testing) uniformly reads it as "last in the list = topmost".
 * The kind field in old project files is ignored when read in.
 */
export interface Track {
  id: string;
  name: string;
  hidden?: boolean;
  muted?: boolean;
  locked?: boolean;
  /** Clips within the same track do not overlap and are sorted by start */
  clips: TrackClip[];
}

/**
 * A clip on a track. An overlay track uses cardId+params; a video track uses mediaId
 * (+ the offset within the asset).
 */
export interface TrackClip extends Clip {
  /**
   * Persistent marker that a visual card carries sound, so that an export without the card runtime
   * can also reject missing sound.
   */
  embeddedAudio?: boolean;
  /**
   * Persistent WAV sound output of the visual card on the same clip, maintained by the AV card
   * generation flow.
   */
  cardAudio?: import("./cardAudioRendition.mjs").CardAudioRendition;
  soundEffect?: SoundEffectClipLink;
  mediaId?: string;
  /** Second of the asset at which the video clip starts playing (default 0) */
  mediaOffset?: number;
  /**
   * Playback speed of a video clip (default 1; 0.5 plays slower, 2 plays faster, range in
   * kernel/clipTime.mjs). Asset time = mediaOffset + (t − start) × speed,
   * and every place converts it through `clipTime.mjs`. When it equals 1, **do not write this field**
   * (delete it when set back to 1), so that the identity key stays byte-for-byte unchanged.
   * [ruling] In the first version a speed-changed video clip produces no original audio
   * (`speedMutesSource`), and the UI says so; audio clips (including those split off by audio-visual
   * separation) still sound as usual when their speed changes, with pitch following the rate.
   */
  speed?: number;
  audioMuted?: boolean;
  /** Independent sound volume, 0~1; the default is 1 (original audio). */
  audioVolume?: number;
  label?: string;
  /**
   * Attached filter: references one entry in project.filters + the parameter values for this clip.
   * Only media clips have it. See kernel/filters.mjs
   */
  filter?: import("./filters.mjs").ClipFilter;
  /** Generic pixel map: references one entry in project.pixelMaps. Only video / image clips have it. */
  pixelMap?: import("./pixelMap.mjs").ClipPixelMap;
  /**
   * Attached audio effect: references one entry in project.audioFx + the parameter values for this
   * clip. Only video / audio clips have it. See kernel/audioFx.mjs
   */
  audioFx?: import("./audioFx.mjs").ClipAudioFx;
  // fadeIn / fadeOut / opacity moved to Clip in kernel/types.ts: card clips honor them now too,
  // they are no longer exclusive to media clips.
  /**
   * Cut segment: the id of the referenced cut (see kernel/cutSegments.ts). A segment that has it has
   * an empty-string cardId and no mediaId.
   * Pages from 0.7.18 and earlier do not recognize it: they simply neither draw nor play it, and the
   * field is kept as is.
   */
  cutId?: string;
  /**
   * Second of the referenced cut at which the cut segment starts (default 0). On a split, the
   * second half accumulates the length of the first half
   */
  cutOffset?: number;
  /**
   * **Only present on clips derived during rendering, never persisted**: the layer-by-layer envelopes
   * of the outer cut segments (parent cut time).
   * `opacityAt` multiplies them in; the mixer (`audioPlan.mjs`) computes gain from the same set of
   * envelopes. See audioProjectOf in kernel/cutSegments.ts.
   */
  cutEnv?: import("./cutAudio.mjs").CutEnvelope[];
  /**
   * **Only present on clips derived during rendering, never persisted**: the clip id before
   * expansion and the cut segments it passed through
   */
  cutOrigin?: import("./cutAudio.mjs").CutAudioOrigin;
}

/**
 * A cut (one whole timeline). A project can have several, switched from the option bar at the top
 * of the timeline.
 *
 * Content is stored only once: the tracks / duration of **the currently active one** live in
 * Project.tracks / Project.duration (exactly as when there was only one cut, so the seventy-odd
 * places in the whole project that read project.tracks need no change at all), and its entry in
 * cuts has only id and name; **the parked ones** each carry their own tracks / duration / t.
 * Switching = save the current content back to its entry and swap the target entry's content in
 * (kernel/cuts.ts).
 *
 * Naming: in the code, Track is already what the UI calls a "track", so this layer is called Cut in
 * the code and "cut" in the UI. Keep the two names from clashing.
 */
import type { Transition } from "./transitions.ts";

export interface Cut {
  id: string;
  name: string;
  /** Declared spatial compositor kind ("2d" default; never guessed from content) */
  kind?: CutKind;
  /** Cut-level 3D vertical field of view in degrees (falls back to legacy project.camera3dFov, then 40) */
  camera3dFov?: number;
  /** Optional 2D cut canvas space dimensions when larger than the output frame */
  spaceWidth?: number;
  spaceHeight?: number;
  /** Dedicated camera lane clips (ignored by contentEndOf; higher row overrides lower row) */
  cameras?: CameraClip[];
  /** Only when parked; undefined for the active one, whose content is in Project.tracks */
  tracks?: Track[];
  duration?: number;
  /** Only when parked: this cut's transition records */
  transitions?: Transition[];
  /** Playhead position when last left, so switching back resumes from there */
  t?: number;
}

export interface Project {
  version: 1;
  /**
   * Instance node of a media effect card. The definition is not in the project: it is the file
   * `src/cards/user/<id>.tsx`, fetched from the registry.
   */
  cardNodes?: import('./cardGraph.mjs').CardNode[];
  style?: Record<string, unknown>;
  /**
   * The project's own identity, which travels with the .proc. The ownership table of custom cards
   * (src/cards/user/_scopes.json) recognizes exactly this.
   *
   * Ownership used to be keyed on the **draft id**, which is a storage location, not an identity:
   * opening by double-click from the desktop, save as, or moving to another machine all change the
   * draft id (it can even be null), so cards the Agent wrote for this project could no longer be seen
   * even in its own card library.
   * Old files have no such field: when opened from a draft, the draft id fills in (it matches the old
   * entries in the ownership table), otherwise one is generated on the spot.
   */
  id?: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number; // Seconds
  themeId: string;
  /**
   * 3D perspective strength (vertical field of view, in degrees). **A frame has only one camera**, so
   * it lives on the project, not on the cards.
   *
   * Unset = 3D off: the stage adds no perspective, and every card renders exactly as before.
   * It is only needed when a card actually uses rotateX/rotateY/translateZ: without perspective those
   * transforms degrade into affine stretches (parallel lines stay parallel), which look "skewed"
   * rather than "standing up".
   *
   * Why store fov and not the camera distance: distance is tied to the aspect ratio (for portrait, H
   * goes from 1080 to 1920 and the same distance gives a different perspective strength), while fov
   * is stable across aspect ratios. See src/kernel/space3d.ts for the conversion.
   */
  camera3dFov?: number;
  /**
   * Which route the shared WebGL renderer of canvas cards takes (R9 M2, project option).
   *   - `perDocument`: one Worker and context per stage (desktop default);
   *   - `shared`: the editor opens just one Worker and context, shared by both stages.
   * Unset = `perDocument` (the effective value is `resolveGlRoute` in `render/costDevice.mjs`). It only
   * governs the desktop app; the online page's route is decided by the stage gate and ignores this
   * option (`tierGlRoute` in `online/onlineTier.ts`: one set each once the third tier is reached,
   * shared otherwise).
   * The export page has no parent page in the prerender process, so it always takes `perDocument` and
   * ignores this option.
   */
  glRoute?: "perDocument" | "shared";
  /**
   * Project default for the creativity level (`user-workflow.md`, section "Creativity level"; defined
   * in `kernel/creativity.mjs`).
   * Chosen in the project settings; each chat in the AI panel takes it as its default and can override
   * it individually, and the desktop app's sessions follow it.
   * Unset = the factory default "High" (old projects have no such field). The Agent cannot write it:
   * `set_project_meta` only accepts declared fields.
   */
  creativity?: import("./creativity.mjs").CreativityLevel;
  media: MediaAsset[];
  tracks: Track[];
  /** All cuts, in option bar order. Old files have no such field; on load normalizeCuts fills in three */
  cuts?: Cut[];
  /**
   * Transition records (of the currently active cut). A transition binds the segments it references:
   * their relative timing is locked, so to change one on its own, delete the transition first.
   * See kernel/transitions.ts.
   */
  transitions?: Transition[];
  /** The active cut. tracks / duration are its content */
  activeCutId?: string;
  /**
   * Filter library (the ones listed on the "Transitions/filters" tab of the media library).
   * Project-level, shared by all cuts; a clip references one of them with clip.filter.
   * See kernel/filters.mjs.
   */
  filters?: import("./filters.mjs").FilterDef[];
  /** Generic pixel map library. A clip references one of them through pixelMap. */
  pixelMaps?: import("./pixelMap.mjs").PixelMapDef[];
  /**
   * Audio effects library (the ones listed on the "Audio effects" tab of the media library).
   * Project-level, shared by all cuts; a clip references one of them with clip.audioFx.
   * See kernel/audioFx.mjs.
   */
  audioFx?: import("./audioFx.mjs").AudioFxDef[];
  /** Ephemeral render viewpoint override ("camera" default | "space" whole-cut inspection for see_frames). */
  _renderView?: "camera" | "space";
}

/**
 * Default duration (seconds) of a card newly dragged onto the timeline; the drop target preview and
 * the actual card drop use the same value
 */
export const DEFAULT_CARD_DUR = 3;

/** Fallback duration (seconds) of a video clip when the asset has no duration info */
export const DEFAULT_MEDIA_DUR = 5;

/** Identity of a new project. Only needs to avoid collisions, not to look nice */
export function newProjectId(): string {
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
  return `p-${Date.now().toString(36)}-${rand}`;
}

export function createEmptyProject(name = "Untitled"): Project {
  return {
    version: 1,
    id: newProjectId(),
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 30,
    themeId: "midnight",
    media: [],
    tracks: [
      { id: "t-1", name: "Track 1", clips: [] },
      { id: "t-2", name: "Track 2", clips: [] },
    ],
  };
}

/**
 * Flatten the project into the Timeline the Stage needs (the card clips of all tracks, skipping
 * hidden tracks).
 * Track order = stacking order: **higher tracks on the timeline are on top**, so tracks is walked in
 * reverse here: the resulting array is still "later is drawn on top", and the Stage can simply
 * render it in order.
 * Media clips (with a mediaId) do not enter the stage; they go to the video layer.
 */
/**
 * `graph` is put into the returned Timeline as is; **this function does not compute the graph
 * itself**. Computing it means walking the whole project, while FrameScene calls this function once
 * per clip (and with a trimmed version that has only one track left, at that).
 * The graph is only computed in two hosts: ExportView and StageView.
 */
export function flattenOverlay(p: Project, graph?: Timeline["graph"]): Timeline {
  const clips: Clip[] = [];
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (c.cutId) {
        // Cut segment: handed over as a "card" (it is not in the registry; the stage recognizes it by
        // clip.cut). The wrapper layer positions the box, computes opacity and fades, and fixes the layer
        // order by the card rules, and inside it hangs the nested scene of the referenced cut (see the
        // header of kernel/cutSegments.ts).
        // Dangling reference, circular reference: this segment is not drawn, and nothing is thrown.
        const cut = cutSegmentRender(p as CutRenderProject, c);
        if (!cut) continue;
        // Pre-roll: the timeline clip starts earlier than the segment's start
        // (cut.from − (cutOffset − cut.offset)), and the part revealed still starts from cut.from
        const seg: TimelineCutClip & { cutEnv?: CutEnvelope[] } = {
          id: c.id, cardId: CUT_SEGMENT_CARD, start: c.start - (Math.max(0, c.cutOffset ?? 0) - cut.offset), end: c.end, params: {}, cut,
          ...(c.frame ? { frame: c.frame } : null),
          ...(c.frameExpr ? { frameExpr: c.frameExpr } : null),
          ...(c.opacity !== undefined ? { opacity: c.opacity } : null),
          ...(c.emphasis ? { emphasis: c.emphasis } : null),
          ...(c.fadeIn ? { fadeIn: c.fadeIn } : null),
          ...(c.fadeOut ? { fadeOut: c.fadeOut } : null),
          ...(c.cutEnv?.length ? { cutEnv: c.cutEnv } : null),
        };
        clips.push(seg);
        continue;
      }
      if (!c.cardId) continue; // Media clips go to the video layer
      // motion must be carried over: it is only used **during playback**, and if it is dropped here
      // the binding looks saved and the timeline shows it as bound, yet neither the preview nor the
      // export moves at all.
      const cardClip: Clip & { cutEnv?: CutEnvelope[] } = {
        id: c.id, cardId: c.cardId, start: c.start, end: c.end, params: c.params,
        // The typing visuals and the WAV share the source event time; after a split it must not restart
        // from the first character.
        // On a speed-changed media clip, use the card clock (mediaOffset ÷ speed, cardClockOffset in
        // kernel/clipTime.mjs): the same clock as the card's sound, so the pieces connect after a split
        ...((c.cardId === "mu-typing" || c.embeddedAudio || c.cardAudio || p.cardNodes?.some(n => n.id === c.nodeId && n.embeddedAudio))
          ? c.mediaOffset !== undefined ? { sourceOffset: clipSpeed(c) === 1 ? c.mediaOffset : cardClockOffset(c) } : c.nodeId ? { sourceOffset: Number(p.cardNodes?.find(n => n.id === c.nodeId)?.timeOffset) || 0 } : null
          : null),
        ...(c.nodeId ? { nodeId: c.nodeId } : null),
        ...(c.motion ? { motion: c.motion } : null),
        // Same for frame: it is only used when the Stage lays out cards, and if it is dropped here
        // set_position becomes "written but takes no effect".
        ...(c.frame ? { frame: c.frame } : null),
        ...(c.frameExpr ? { frameExpr: c.frameExpr } : null),
        // Opacity / fades must be carried over too: previously only the video layer honored these three
        // fields, so setting them on a card clip was the same as not setting them, and the model's "lower
        // the opacity to avoid the person" trick was a no-op on cards. Stage now applies them via
        // cardOpacityAt.
        ...(c.opacity !== undefined ? { opacity: c.opacity } : null),
        // Emphasis (shadow / stroke) likewise: only used when the Stage renders, and if it is dropped
        // here it ends up set but with no effect
        ...(c.emphasis ? { emphasis: c.emphasis } : null),
        ...(c.fadeIn ? { fadeIn: c.fadeIn } : null),
        ...(c.fadeOut ? { fadeOut: c.fadeOut } : null),
        // Part tree of a composite card: Stage renders from it; if it is dropped, the composite card is an
        // empty card
        ...(c.parts?.length ? { parts: c.parts } : null),
        // Outer cut-segment envelopes on derived clips (never persisted; kept out of types.ts so audio
        // card source closure hashes do not move)
        ...(c.cutEnv?.length ? { cutEnv: c.cutEnv } : null),
      };
      clips.push(cardClip);
    }
  }
  const activeEntry = activeCutEntry(p);
  const cutKind = cutKindOf(activeEntry);
  const effFov = effectiveCamera3dFov(p, activeEntry);
  // Only carry extra keys when actually active/non-default: legacy 2D project timeline objects stay byte-identical
  return {
    width: p.width,
    height: p.height,
    fps: p.fps,
    duration: p.duration,
    clips,
    ...(effFov ? { camera3dFov: effFov } : null),
    ...(cutKind === "3d" ? { cutKind: "3d" as const } : null),
    ...(activeEntry?.cameras?.length ? { cameras: activeEntry.cameras } : null),
    ...(activeEntry?.spaceWidth ? { spaceWidth: activeEntry.spaceWidth } : null),
    ...(activeEntry?.spaceHeight ? { spaceHeight: activeEntry.spaceHeight } : null),
    ...(p._renderView && p._renderView !== "camera" ? { renderView: p._renderView } : null),
    ...(p.themeId ? { themeId: p.themeId } : null),
    ...(graph ? { graph } : null),
  };
}

/** Synthetic cardId marker for image / video media clips placed as 3D boards in 3D cuts. */
export const MEDIA_BOARD_CARD = "@media";

export interface Board3DClip extends Clip {
  cut?: import("./cutSegments.ts").CutSegmentRender;
  cutEnv?: CutEnvelope[];
  mediaId?: string;
  media?: MediaAsset;
  mediaOffset?: number;
  speed?: number;
  filter?: import("./filters.mjs").ClipFilter;
  pixelMap?: import("./pixelMap.mjs").ClipPixelMap;
  emphasis?: import("./emphasis").ClipEmphasis;
  trackId?: string;
  label?: string;
}

/**
 * Flatten all visual items (cards, nested cut segments, AND image/video media clips) in painter/track
 * order (`0` = bottom track, `N - 1` = top track) for 3D scene rendering (`Scene3DView` & `Cut3DScene`).
 */
export function flattenBoards3D(p: Project): Board3DClip[] {
  const overlayById = new Map<string, Clip>();
  for (const c of flattenOverlay(p).clips) overlayById.set(c.id, c);

  const boards: Board3DClip[] = [];
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (c.cardId === "caption-track") continue;
      if (c.cutId || c.cardId) {
        const mapped = overlayById.get(c.id);
        if (mapped) boards.push({ ...mapped, trackId: tr.id, ...(c.label ? { label: c.label } : null) });
        continue;
      }
      if (!c.mediaId) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      boards.push({
        id: c.id,
        cardId: MEDIA_BOARD_CARD,
        start: c.start,
        end: c.end,
        params: {},
        mediaId: c.mediaId,
        media,
        ...(c.mediaOffset !== undefined ? { mediaOffset: c.mediaOffset } : null),
        ...(c.speed !== undefined ? { speed: c.speed } : null),
        ...(c.filter ? { filter: c.filter } : null),
        ...(c.pixelMap ? { pixelMap: c.pixelMap } : null),
        ...(c.emphasis ? { emphasis: c.emphasis } : null),
        ...(c.frame ? { frame: c.frame } : null),
        ...(c.frameExpr ? { frameExpr: c.frameExpr } : null),
        ...(c.opacity !== undefined ? { opacity: c.opacity } : null),
        ...(c.fadeIn ? { fadeIn: c.fadeIn } : null),
        ...(c.fadeOut ? { fadeOut: c.fadeOut } : null),
        ...(c.cutEnv?.length ? { cutEnv: c.cutEnv } : null),
        trackId: tr.id,
        label: c.label || media.name,
      });
    }
  }
  return boards;
}

/** Which media clip should play at a given time (first matching media clip in track order) */
/** Opacity of a clip at time t, fades included. Returns 0 outside the range. */
export function opacityAt(clip: Clip, t: number): number {
  const seg = cutOf(clip);
  if (seg) {
    // Cut segment on a timeline: clip.start may be shifted earlier by pre-roll, while seg.from is the
    // visible start and seg.duration caps the referenced cut's visible span.
    if (t < seg.from || t >= clip.end) return 0;
    const localT = seg.offset + (t - clip.start);
    if (localT < 0 || localT >= seg.duration) return 0;
    let a = envelopeAt({ start: seg.from, end: clip.end, opacity: clip.opacity, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut }, t);
    const env = (clip as TrackClip).cutEnv;
    if (env) for (const e of env) a *= envelopeAt(e, t);
    return Math.max(0, Math.min(1, a));
  }
  if (t < clip.start || t >= clip.end) return 0;
  let a = clip.opacity ?? 1;
  const fin = clip.fadeIn ?? 0;
  const fout = clip.fadeOut ?? 0;
  if (fin > 0 && t < clip.start + fin) a *= (t - clip.start) / fin;
  if (fout > 0 && t > clip.end - fout) a *= (clip.end - t) / fout;
  // Clip expanded from a cut segment: multiply in the envelopes of the outer segments
  const env = (clip as TrackClip).cutEnv;
  if (env) for (const e of env) a *= envelopeAt(e, t);
  return Math.max(0, Math.min(1, a));
}

/**
 * Whether this clip has ever had opacity or fades set. For cards where they were never set, the
 * Stage touches nothing at all, so the export of an old project stays byte-for-byte unchanged
 */
export function hasOpacityControls(clip: Clip): boolean {
  return (
    clip.opacity !== undefined ||
    (clip.fadeIn ?? 0) > 0 ||
    (clip.fadeOut ?? 0) > 0 ||
    (((clip as TrackClip).cutEnv?.length ?? 0) > 0)
  );
}

/**
 * Opacity of a card clip at time t. It differs from opacityAt in just one place: the Stage mounts a
 * card LEAD seconds early (so that the first frame of the entrance animation lands exactly on start),
 * and during those frames t is still before start, where opacityAt gives 0 and would swallow the first
 * frame of the entrance animation. So t is clamped into [start, end) before computing: during the
 * early mount period it takes the value at the moment of start, which is 0 if there is a fade-in
 * (a fade-in starts from 0 anyway) and opacity itself if there is none.
 *
 * Cut segments (`cutOf(clip)`) keep pre-roll before `seg.from` and overrun past `seg.duration` at 0.
 */
export function cardOpacityAt(clip: Clip, t: number): number {
  if (cutOf(clip)) return opacityAt(clip, t);
  const tt = Math.max(clip.start, Math.min(t, clip.end - 1e-6));
  return opacityAt(clip, tt);
}

/**
 * All media layers on screen at a given time, in track order (later in the array = drawn on top),
 * with computed opacity. When two clips overlap and each has a fade, both are returned together:
 * that is where a crossfade comes from.
 * Audio clips are not included (they go through audioClipsAt).
 */
export function videoLayersAt(
  p: Project,
  t: number,
): Array<{ trackId: string; clip: TrackClip; media: MediaAsset; opacity: number }> {
  const layers: Array<{ trackId: string; clip: TrackClip; media: MediaAsset; opacity: number }> = [];
  // Same convention as flattenOverlay: walk in reverse, so the last one produced is the topmost
  // layer (= the topmost track on the timeline)
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (!c.mediaId || t < c.start || t >= c.end) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      const opacity = opacityAt(c, t);
      if (opacity <= 0) continue;
      // trackId: the preview attaches players per track (two <video> per track, alternating), and it is
      // what maps this clip onto its pair
      layers.push({ trackId: tr.id, clip: c, media, opacity });
    }
  }
  return layers;
}

/**
 * For each track, the first picture clip (video/image) that starts **strictly after t**, with the same
 * convention as videoLayersAt: skip hidden tracks, audio clips, card clips and clips whose asset
 * cannot be found; the order is also "last = topmost".
 * A track with no more pictures after that produces no entry.
 *
 * # Why we need to know "the next clip"
 *
 * Every time the preview switched to another video clip, it used to create a new <video> and seek into
 * the middle of the file. The asset has a keyframe every 5 seconds, so seeking into the middle has to
 * decode up to 150 frames before a picture appears, and each cut blacks out or stalls for one or
 * two hundred milliseconds; in a real project of 88.7 seconds there were 25 cuts, and of the
 * switches inside the same file **not one was continuous** in the source file, so merely reusing
 * the player cannot save that seek either.
 * So the preview keeps two players per track: when there is still a little time before the next
 * clip's start point, it loads that clip into the idle one, seeks it to the start point and parks it
 * there (see render/VideoTrack.tsx). This function answers "who is the next clip".
 *
 * Opacity is ignored: if the next clip starts with a fade-in, its opacity at the start moment is 0,
 * but it is precisely the one that needs to be loaded in advance.
 *
 * `skip`: **the filtering must be pushed down into it** (E7 item 1). This function returns only one
 * clip per track, so filtering afterwards on the outside (for example the media clips taken over by
 * a media effect card) would leave that track with no `next`, and the dual-`<video>` preloading
 * fails for the whole track. When a predicate is given, it keeps searching for the next clip on that
 * track.
 */
export function nextVideoLayerAfter(
  p: Project,
  t: number,
  skip?: (clip: TrackClip) => boolean,
): Array<{ trackId: string; clip: TrackClip; media: MediaAsset }> {
  const out: Array<{ trackId: string; clip: TrackClip; media: MediaAsset }> = [];
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    let best: { clip: TrackClip; media: MediaAsset } | null = null;
    // Do not assume clips are already sorted by start: an old file read in may never have been sorted,
    // so just find the earliest one
    for (const c of tr.clips) {
      if (!c.mediaId || c.start <= t || skip?.(c)) continue;
      if (best && c.start >= best.clip.start) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      if (!media || media.kind === "audio") continue;
      best = { clip: c, media };
    }
    if (best) out.push({ trackId: tr.id, ...best });
  }
  return out;
}

/** All audio clips that should sound at a given time (opacity is used as volume) */
export function audioClipsAt(
  p: Project,
  t: number,
): Array<{ clip: TrackClip; media: MediaAsset; volume: number }> {
  const out: Array<{ clip: TrackClip; media: MediaAsset; volume: number }> = [];
  for (const tr of p.tracks) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (!c.mediaId || t < c.start || t >= c.end) continue;
      const media = p.media.find((m) => m.id === c.mediaId);
      // Audio clips still sound as usual when speed-changed (pitch follows the rate; in the preview
      // playbackRate = speed, pitch is not preserved; kernel/clipTime.mjs)
      if (!media || media.kind !== "audio" || tr.muted || c.audioMuted) continue;
      out.push({ clip: c, media, volume: opacityAt(c, t) * (c.audioVolume ?? 1) });
    }
  }
  return out;
}

/**
 * The topmost picture layer at a given time. Only video/image count: it used to return audio clips
 * as pictures too, so dragging a song into a track would make <video> seek an mp3.
 */
export function videoClipAt(p: Project, t: number): { clip: TrackClip; media: MediaAsset } | null {
  const layers = videoLayersAt(p, t);
  if (layers.length === 0) return null;
  const top = layers[layers.length - 1];
  return { clip: top.clip, media: top.media };
}

export function findClip(p: Project, clipId: string): { track: Track; clip: TrackClip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

let seq = 0;
export function newId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

// ── Reading side of subject detection ────────────────────────────────────────────────
// The detection result is "a series of samples taken at moments in time", while callers always ask
// "where is the person in this shot (an interval)".
// This section folds the former into the latter, as pure functions with no side effects; unit tests
// are in src/kernel/subject.test.mjs.

/** Subject status over an interval, produced by subjectForRange merging the samples inside it */
export interface SubjectRangeInfo {
  /** Sample times that took part in the merge (seconds within the asset), sorted by time */
  times: number[];
  /**
   * true means there is **not a single sample** in this interval, and the numbers below come from the
   * nearest sample in time.
   * The caller must surface this: using the person's position in a neighboring shot as the conclusion
   * for this shot would be wrong.
   */
  approximate: boolean;
  /** Boxes of all samples in the interval pooled (a person in three samples appears three times) */
  boxes: SubjectBox[];
  /** Mode: the side that appears most often in the interval */
  safeSide: SafeSide;
  /** Mean occupancy rate of each side */
  occupancy: SubjectOccupancy;
}

/**
 * Tie-break order when safeSide is tied.
 *
 * Left/right first, then top/bottom: horizontal blank space really can take the card (the left and
 * right half-screens each take half of the picture), while top/bottom is only a narrow 1/3 band, so
 * when both are equally "empty" the side is the safer place.
 * right ranks before left because resident elements such as captions and channel logos usually sit at
 * the bottom left, so the right side is more often empty.
 */
const SAFE_SIDE_PRIORITY: SafeSide[] = ["right", "left", "bottom", "top"];

/**
 * Get the subject status over an interval.
 *
 * Samples falling within [start, end] are preferred; if there are none (the shot is too short or the
 * sampling density is too low) it falls back to the nearest sample in time and sets approximate to
 * true. Returns null when subjects as a whole is empty.
 */
export function subjectForRange(
  subjects: Subjects | null | undefined,
  start: number,
  end: number,
): SubjectRangeInfo | null {
  // Samples whose frame extraction failed are thrown away first. Their boxes are empty and their
  // occupancy is four zeros; mixed into the average they would launder "this frame could not be
  // extracted" into "this side is empty". Return null when all of them failed: better that the caller
  // sees "no detection result" than a right that was made up out of thin air.
  const all = (subjects?.samples ?? []).filter((s) => !s.failed);
  if (all.length === 0) return null;

  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  let picked = all.filter((s) => s.t >= lo && s.t <= hi);
  const approximate = picked.length === 0;
  if (approximate) {
    // The one nearest to the interval. On equal distance take the earlier one, which keeps the result
    // deterministic
    let best = all[0];
    let bestD = Infinity;
    for (const s of all) {
      const d = s.t < lo ? lo - s.t : s.t > hi ? s.t - hi : 0;
      if (d < bestD) { best = s; bestD = d; }
    }
    picked = [best];
  }
  picked = [...picked].sort((a, b) => a.t - b.t);

  const counts = new Map<SafeSide, number>();
  for (const s of picked) counts.set(s.safeSide, (counts.get(s.safeSide) ?? 0) + 1);
  let safeSide: SafeSide = SAFE_SIDE_PRIORITY[0];
  let bestCount = -1;
  for (const side of SAFE_SIDE_PRIORITY) {
    const c = counts.get(side) ?? 0;
    if (c > bestCount) { bestCount = c; safeSide = side; }
  }

  const n = picked.length;
  const occupancy: SubjectOccupancy = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const s of picked) {
    occupancy.left += s.occupancy?.left ?? 0;
    occupancy.right += s.occupancy?.right ?? 0;
    occupancy.top += s.occupancy?.top ?? 0;
    occupancy.bottom += s.occupancy?.bottom ?? 0;
  }
  for (const k of ["left", "right", "top", "bottom"] as const) {
    occupancy[k] = occupancy[k] / n;
  }

  return {
    times: picked.map((s) => s.t),
    approximate,
    boxes: picked.flatMap((s) => s.boxes ?? []),
    safeSide,
    occupancy,
  };
}

/**
 * Translate safeSide into a value that can be filled straight into the card's params.position.
 *
 * The card side has only four presets, center / bottom / left / right (see getPositionClass in
 * src/cards/native/hud.ts), and **no top**. So when safeSide is top it cannot be passed as is: passed
 * over, getPositionClass would fall into the default branch and become center, and center is exactly
 * where faces most often are, which turns the information "the top is empty" into "plastered over the
 * face". Here it instead picks the one with the lowest occupancy among the remaining three valid
 * presets: better on the side than in the middle.
 */
export function positionForSafeSide(
  safeSide: SafeSide,
  occupancy?: SubjectOccupancy | null,
): CardPosition {
  if (safeSide !== "top") return safeSide;
  const occ = occupancy ?? { left: 1, right: 1, top: 1, bottom: 1 };
  const legal: CardPosition[] = ["right", "left", "bottom"];
  let best: CardPosition = "right";
  let bestV = Infinity;
  for (const side of legal) {
    const v = occ[side] ?? 1;
    if (v < bestV) { bestV = v; best = side; }
  }
  return best;
}

/**
 * Value range of positionForSafeSide.
 *
 * **Does not include center**: safeSide can only be right/left/bottom/top (see SIDE_PRIORITY in
 * safezone.py); the first three are returned as is, and top is only picked among those three, so
 * center is unreachable.
 * The docs used to say "center/bottom/left/right", which would make the model think centering is a
 * valid suggestion, while the center is exactly where the face is.
 */
export type CardPosition = "left" | "right" | "bottom";

/**
 * How much of a side must be covered by people to count as "occupied". When more than half of a
 * half-screen is people, a card placed there is bound to overlap them
 */
export const OCCUPIED_THRESHOLD = 0.5;

export interface PositionSuggestion {
  /**
   * A value that can be filled into the card's params.position; null when all four presets are
   * occupied (do not force a value in that case)
   */
  suggestedPosition: CardPosition | null;
  /**
   * Occupancy rate of the chosen side (0~1). When suggestedPosition is null, it is the occupancy rate
   * of the least-bad preset
   */
  suggestedOccupancy: number;
  /** Only present when suggestedPosition is null */
  warning?: string;
}

/**
 * Fold safeSide + occupancy into a suggestion for "where to put the card", and say clearly whether
 * that suggestion is reliable.
 *
 * Why this layer is needed on its own: positionForSafeSide picks **the least bad of the remaining
 * three valid presets**. In a front-facing half-body talking-head shot (safeSide=top) the most
 * common situation is that all four sides are occupied, and it still returns a side, and that side
 * measured an occupancy of 0.895, so the card lands on the face. Measured on out/media/talker.mp4
 * at t=2.75: occupancy {left:0.895, right:0.895, top:0.692, bottom:0.993}, safeSide="top", and the
 * right it picked is 89.5% person. In such a case it must say "this shot has no position that does
 * not cover a person", rather than hand out a right that sounds so certain.
 */
export function suggestPosition(
  safeSide: SafeSide,
  occupancy?: SubjectOccupancy | null,
): PositionSuggestion {
  const pos = positionForSafeSide(safeSide, occupancy);
  const occ = occupancy?.[pos] ?? 0;
  if (occ > OCCUPIED_THRESHOLD) {
    return {
      suggestedPosition: null,
      suggestedOccupancy: Math.round(occ * 100) / 100,
      warning: `All four tiers are occupied by people (even the emptiest, ${pos}, is ${Math.round(occ * 100)}% people).`
        + " This shot has no position that avoids covering the person. Consider shrinking the card, lowering its opacity, or placing it on a different shot.",
    };
  }
  return { suggestedPosition: pos, suggestedOccupancy: Math.round(occ * 100) / 100 };
}

/**
 * The maximum number of frames to extract in one detection.
 *
 * **Shared by two places**: the server's /api/subject/detect uses it as a hard cap (over it, 400),
 * and the side computing sample times clamps with it too. It used to be 200 on the server alone, with
 * no cap on the kernel side, so the default path "compute automatically when times is not passed"
 * was bound to be rejected with a 400 on somewhat longer or more fragmented assets: with the constant
 * written in one place only, the two can no longer disagree.
 * Each frame costs one ffmpeg seek plus one forward pass; in the full tier it measured 2.7 s/frame,
 * and 200 frames is already 9 minutes.
 */
export const MAX_SUBJECT_TIMES = 200;

/**
 * Compute the sample times for subject detection of an asset (seconds within the asset).
 *
 * If the asset has shot boundaries, take three points per shot at 20% / 50% / 80%: a person usually
 * moves within a shot, and taking only the midpoint would squash "on the left at the start, on the
 * right at the end" into the conclusion of a single instant, while the card has to cover the whole
 * shot. A shot shorter than 1 second gets only the midpoint: within that little time three frame
 * extractions would get almost the same frame, wasting three forward passes.
 * If shot detection was never run, fall back to one point every 2 seconds.
 *
 * The result is deduplicated, sorted, and clamped to within the asset's duration: ffmpeg cannot
 * extract a frame when it seeks past the duration, and that sample would be lost for nothing with no
 * indication of why.
 *
 * The total is hard-clamped to within max (default MAX_SUBJECT_TIMES=200, the same constant as on
 * the server) and reduced in two steps: first drop the three points per shot to only the midpoint (no
 * shot is lost, only the position is estimated more coarsely), and if still over, thin out at equal
 * spacing. A caller that wants to know whether precision was reduced can compare the length of
 * subjectSampleTimes(media, Number.MAX_SAFE_INTEGER) with the length here.
 */
export function subjectSampleTimes(
  media: Pick<MediaAsset, "duration" | "shots">,
  max: number = MAX_SUBJECT_TIMES,
): number[] {
  const dur = media.duration ?? 0;
  const shots = media.shots?.shots ?? [];
  const limit = Math.max(1, Math.floor(max));

  /** Clamp into the duration, keep two decimals, deduplicate, sort */
  const tidy = (raw: number[]): number[] => {
    const seen = new Set<string>();
    return raw
      .map((t) => Math.max(0, dur > 0 ? Math.min(t, Math.max(0, dur - 0.05)) : t))
      .map((t) => Math.round(t * 100) / 100)
      .filter((t) => (seen.has(t.toFixed(2)) ? false : (seen.add(t.toFixed(2)), true)))
      .sort((a, b) => a - b);
  };

  let out: number[];
  if (shots.length > 0) {
    const three: number[] = [];
    const mid: number[] = [];
    for (const s of shots) {
      const len = s.end - s.start;
      if (len <= 0) continue;
      mid.push(s.start + len / 2);
      if (len < 1) three.push(s.start + len / 2);
      else three.push(s.start + len * 0.2, s.start + len * 0.5, s.start + len * 0.8);
    }
    out = tidy(three);
    // The first step when over the limit is to **reduce precision rather than drop shots**, but do not
    // go all the way down in one step either: being over by just a little and collapsing everything to
    // one midpoint per shot would cut 240 points to 80, and the reason the 20%/80% points exist (people
    // moving within a shot) would be gone entirely (measured in the re-check). First thin out shot by
    // shot: every shot keeps its midpoint as the floor, and the remaining quota is spread at equal
    // spacing among the 20%/80% points of the shots; only when the midpoints alone exceed the limit does
    // it fall back to "one midpoint per shot", and then hand over to the equal-spacing thinning below.
    if (out.length > limit) {
      if (mid.length > limit) {
        out = tidy(mid);
      } else {
        const extras: number[] = [];
        for (const s of shots) {
          const len = s.end - s.start;
          if (len >= 1) extras.push(s.start + len * 0.2, s.start + len * 0.8);
        }
        const room = Math.max(0, limit - mid.length);
        const picked: number[] = [];
        if (room > 0 && extras.length > 0) {
          const stride = extras.length / Math.min(room, extras.length);
          for (let i = 0; i < Math.min(room, extras.length); i++) picked.push(extras[Math.floor(i * stride)]);
        }
        out = tidy([...mid, ...picked]);
      }
    }
  } else {
    const grid: number[] = [];
    for (let t = 1; t < dur; t += 2) grid.push(t);
    // When the asset is shorter than 1 second (or has no duration info at all), no point above can be
    // laid out; give at least a midpoint, otherwise the caller gets an empty array and can only report
    // "cannot compute sample times", when this asset can in fact be detected.
    if (grid.length === 0) grid.push(dur > 0 ? dur / 2 : 0);
    out = tidy(grid);
  }

  // If still over, thin out at equal spacing. **It must be clamped here**, and the caller cannot be
  // expected to batch: setMediaSubjects replaces the whole thing, the second batch would wash out the
  // first, so the so-called "please batch" simply cannot be done on the client.
  // Measured on three real scenarios that go over the limit (the verifier's
  // verify-agent-ux-sampletimes.mjs):
  // 7 minutes without shots, 210 points; 5 minutes with 80 shots, 240 points; 3 minutes with 90
  // 2-second shots, 270 points.
  if (out.length > limit) {
    const n = out.length;
    const seen = new Set<number>();
    const thinned: number[] = [];
    for (let i = 0; i < limit; i++) {
      const idx = limit === 1 ? Math.floor((n - 1) / 2) : Math.round((i * (n - 1)) / (limit - 1));
      if (seen.has(idx)) continue;
      seen.add(idx);
      thinned.push(out[idx]);
    }
    out = thinned;
  }
  return out;
}
