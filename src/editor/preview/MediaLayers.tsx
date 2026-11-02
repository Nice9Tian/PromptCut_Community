import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { clipHasEmbeddedAudio } from "../../kernel/cardAudioRendition.mjs";
import { getCard, syncedUserCards } from "../../kernel/registry";
import type { AudioFxDef } from "../../kernel/audioFx.mjs";
import { releasePreviewAudio, routePreviewAudio } from "../../audio/previewAudio";
import { MISSING_MATERIAL_WAV_URL, missingMaterialSourceTime } from "../../audio/missingMaterial";
import { CARD_AUDIO_SAMPLE_RATE, acquireCardAudioClipUrl, cardAudioNodeOf, generatedCardAudioClipsAt, getCardAudioEpoch, subscribeCardAudioEpoch, persistentCardAudio } from "../../audio/cardAudio";
import { audioClipsAt, isImageMedia, nextVideoLayerAfter, videoLayersAt, type MediaAsset, type Project, type TrackClip } from "../../kernel/project";
import { audioProjectOf } from "../../kernel/cutAudio.mjs";
import { clipSpeed, speedMutesSource } from "../../kernel/clipTime.mjs";
import { isScrubbing, subscribeScrub } from "../timeline/useScrub";
import { driveMedia, releaseMedia, targetTimeOf } from "../../render/mediaDrive";
import { VideoTrack } from "../../render/VideoTrack";
import { playbackUrl } from "../../render/mediaTier";
import { onlinePage } from "../../online/pageFlag";
import { ONLINE_CARD_AUDIO_BLOCKED } from "../../online/soundPolicy";
import { onlineLiveCardAudio, onlineLiveEffectAudio } from "../io/onlineSoundSource";
import { confirmedMissingAudio } from "../io/missingMaterials";
import "../io/onlineSoundBoot";
import { tr as trText } from "../../i18n/index.ts";

/**
 * Media layers in the preview: picture (video/images) and sound (music, narration).
 *
 * There can be several picture layers at once. Two media clips that overlap in time, each with its
 * own fade in and fade out, make a crossfade.
 * Tracks higher up on the timeline are drawn on top (videoLayersAt already returns them in the
 * order "last one = topmost").
 * Each sound segment gets one <audio>, and its volume follows opacityAt, so fades on audio
 * segments work the same way.
 *
 * **After E7 step 1 the picture layers are no longer in this file**: `VideoTrack` moved to
 * `src/render/VideoTrack.tsx` (the stage and the main document share the same copy), element
 * driving moved to `src/render/mediaDrive.ts`, and the pure functions moved to
 * `src/render/mediaSync.ts`. What is left here is "lay them out by track" and the sound layer
 * (`AudioLayer`). Audio routing (`audio/previewAudio.ts`) is wired up on this side only; the
 * stage is always `muted`.
 */


type CardState = "pending" | "ready" | "error";
const NO_HASHES: readonly string[] = [];
function AudioLayer({ project, clip, media, volume, t, playing, scrubbing, audioFx, onCardState, localHashes }: { project: Project; clip: TrackClip; media?: MediaAsset; volume: number; t: number; playing: boolean; scrubbing: boolean; audioFx?: AudioFxDef[]; onCardState?: (clipId: string, state: CardState, message?: string) => void; localHashes: readonly string[] }) {
  const ref = useRef<HTMLAudioElement>(null);
  const nodeId = cardAudioNodeOf(project, clip);
  const missingAudio = confirmedMissingAudio(media, project);
  const embedded = clipHasEmbeddedAudio(project, clip, getCard) || !!syncedUserCards().get(clip.cardId)?.embeddedAudio;
  const [cardOffset, setCardOffset] = useState(0);
  // Card runtime blocks use clip-local samples; mediaOffset applies only to the old source media path.
  const target = nodeId ? Math.max(0, t - clip.start + cardOffset) : missingAudio ? missingMaterialSourceTime(clip, t) : targetTimeOf(clip, t);
  const [cardUrl, setCardUrl] = useState<string | null>(null);
  const [cardState, setCardState] = useState<"idle" | CardState>("idle");
  // Whether the playback source of this card sound is synthesized on the spot (media effect card, built-in sound judged light in the online browser) or an already stored product; only for the acceptance probe (`data-pc-audio-source`)
  const [cardLive, setCardLive] = useState(false);
  // Online browser (`product/platforms.md`, "Platform boundary for card sounds"): when the product bytes can't be fetched, the browser synthesizes it instead (built-in sound judged light).
  // `productFailed` = the product URL of this segment has already been reported unreadable; `effectUrl` = temporary URL a standalone sound effect was synthesized to from its recipe
  const [productFailed, setProductFailed] = useState(false);
  const [effectUrl, setEffectUrl] = useState<string | null>(null);
  const effectKey = !nodeId && !missingAudio ? clip.soundEffect?.reuseKey : undefined;
  useEffect(() => { setProductFailed(false); }, [clip.id, clip.cardAudio?.mediaId, clip.mediaId, effectKey]);
  useEffect(() => {
    if (!productFailed || !effectKey) return;
    let current = true, release: (() => void) | undefined;
    void onlineLiveEffectAudio(project, clip).then((lease) => {
      if (!lease) return;
      if (!current) { lease.release(); return; }
      release = lease.release; setEffectUrl(lease.url);
    }, () => { /* Synthesis failed: this segment stays silent */ });
    return () => { current = false; release?.(); setEffectUrl(null); };
    // Only the recipe identity matters: changes elsewhere in the project don't need a re-synthesis
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productFailed, effectKey, clip.id]);
  // After a media effect card is swapped (HMR reruns src/cards/index.ts) the project reference stays
  // the same, so the effect doesn't rerun on its own;
  // this version number, bumped by 1 on every configureCardAudio call, is the trigger to refetch.
  const cardAudioEpoch = useSyncExternalStore(subscribeCardAudioEpoch, getCardAudioEpoch, getCardAudioEpoch);
  useEffect(() => {
    let current = true;
    if (!nodeId) { setCardUrl(null); setCardState("idle"); return; }
    setCardUrl(null); setCardState("pending");
    onCardState?.(clip.id, "pending"); ref.current?.dispatchEvent(new CustomEvent("promptcut:card-audio-pending", { bubbles: true, detail: { nodeId, clipId: clip.id } }));
    const frames = Math.max(1, Math.ceil((clip.end - clip.start) * CARD_AUDIO_SAMPLE_RATE));
    let release: (() => void) | undefined;
    const acquire = async () => {
      if (embedded && !productFailed) {
        try {
          const result = persistentCardAudio(project, clip);
          setCardOffset(result.offset);
          return { url: playbackUrl(result.media, localHashes), release() {}, live: false };
        } catch (error) {
          // Online browser: with no valid product, the built-in sound judged light is synthesized by the browser (same source clock, offset already in the node); desktop app prompts as before
          const live = await onlineLiveCardAudio(project, clip, nodeId, frames);
          if (!live) throw error;
          setCardOffset(0);
          return live;
        }
      }
      setCardOffset(0);
      if (onlinePage()) {
        const live = await onlineLiveCardAudio(project, clip, nodeId, frames);
        if (!live) throw new Error(embedded ? trText("The card audio asset of {0} cannot be read, please restore the asset or regenerate it", clip.label ?? clip.id) : ONLINE_CARD_AUDIO_BLOCKED);
        return live;
      }
      return acquireCardAudioClipUrl({ project, nodeId, frames });
    };
    void acquire().then((lease) => {
      release = lease.release; const url = lease.url;
      if (!current) { release(); return; }
      setCardLive(!("live" in lease && lease.live === false));
      setCardUrl(url); // Confirmed by canplay once decoding is really ready; a URL existing doesn't mean the bytes are readable.
    }, (error: unknown) => {
      if (!current) return;
      const message = error instanceof Error ? error.message : String(error); setCardState("error"); onCardState?.(clip.id, "error", message);
      ref.current?.dispatchEvent(new CustomEvent("promptcut:card-audio-error", { bubbles: true, detail: { nodeId, clipId: clip.id, error: message } }));
    });
    return () => { current = false; release?.(); };
  }, [project, nodeId, clip.id, clip.start, clip.end, onCardState, cardAudioEpoch, embedded, localHashes, productFailed]);
  useLayoutEffect(() => {
    // While a media effect card node is loading or has failed there is deliberately no source URL.
    // driveMedia may attempt play(), but it cannot emit source-media audio as a fallback.
    if (nodeId && !cardUrl) return;
    // Variable-speed sound segment (the kind split out by audio-visual separation): plays at the clip speed without pitch preservation (pitch follows the rate), the same semantics as ffmpegVarispeed in both export mixing paths
    const rate = nodeId ? 1 : clipSpeed(clip);
    if (ref.current && rate !== 1 && ref.current.preservesPitch !== false) ref.current.preservesPitch = false;
    driveMedia(ref.current, { target, playing, volume, scrubbing, ...(rate !== 1 ? { rate } : null) });
    routePreviewAudio(ref.current, audioFx, clip, t, playing);
  }, [nodeId, cardUrl, target, playing, volume, scrubbing, audioFx, clip, t]);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      releaseMedia(el);
      releasePreviewAudio(el);
    };
  }, []);
  // The main document's sound also goes through the tier-switch criterion (T1a review #5). C6.6 "audio stays at the small media size first": if the tier changes during playback, the sound keeps using the previous tier
  // and switches only once stopped (paused, or the paused state before a drag is released), so the two sounds don't overlap or pop. If the previous tier was already silent (it failed), switch immediately.
  const wanted = missingAudio ? MISSING_MATERIAL_WAV_URL : media ? playbackUrl(media, localHashes) : undefined;
  const held = useRef<string | undefined>(undefined);
  if (held.current === undefined || !playing || held.current === wanted || !media || ref.current?.error) held.current = wanted;
  return <audio ref={ref}
    onCanPlay={() => { if (nodeId && cardUrl) { setCardState("ready"); onCardState?.(clip.id, "ready"); } }}
    onError={() => {
      // Online browser: the product bytes can't be fetched (never synced, or cleared from the asset service) → switch to the browser-synthesized playback source
      if (!missingAudio && onlinePage() && !productFailed && (effectKey || (nodeId && embedded))) { setProductFailed(true); return; }
      if (nodeId && cardUrl) { const message = trText("The card audio asset of {0} cannot be read, please restore the asset or regenerate it", clip.label ?? clip.id); setCardState("error"); onCardState?.(clip.id, "error", message); }
    }}
    src={nodeId ? (cardUrl ?? undefined) : missingAudio ? MISSING_MATERIAL_WAV_URL : (effectUrl ?? held.current)} preload="auto" hidden
    data-pc-audio-clip={clip.id} data-pc-audio-source={nodeId ? (cardUrl ? (cardLive ? "live" : "product") : undefined) : (effectUrl ? "live" : "product")}
    data-card-audio-state={nodeId ? cardState : undefined} data-card-audio-node={nodeId ?? undefined} />;
}


/** Tracks that have picture segments (video/images), in the same order convention as videoLayersAt: walk backwards, last one = topmost */
function visualTrackIds(p: Project): string[] {
  const audio = new Set(p.media.filter((m) => m.kind === "audio").map((m) => m.id));
  const known = new Set(p.media.map((m) => m.id));
  const ids: string[] = [];
  for (const tr of [...p.tracks].reverse()) {
    if (tr.hidden) continue;
    if (tr.clips.some((c) => c.mediaId && known.has(c.mediaId) && !audio.has(c.mediaId))) ids.push(tr.id);
  }
  return ids;
}

export function MediaLayers({
  project,
  t,
  playing,
  muted = false,
  masterVolume = 1,
  audioOnly = false,
  localHashes = NO_HASHES,
}: {
  project: Project;
  t: number;
  playing: boolean;
  /** For export: picture as usual, no sound at all (the audio track is mixed by ffmpeg) */
  muted?: boolean;
  /** Overall preview volume 0-1, applied on top of each segment's own fade volume; pass 0 to mute */
  masterVolume?: number;
  audioOnly?: boolean;
  /**
   * Hashes that the currently connected asset service reports as `complete` (A1's `localHashes`);
   * the sound layer and the picture layer switch tier by it.
   * Defaults to an empty set = always the original media size. The source (polling
   * `GET media/<hash>/chunks` every 2 seconds) comes in step 6.
   */
  localHashes?: readonly string[];
}) {
  // While the playhead is held down, seek is sparser; the moment it is released this goes back to false, and each layer aligns precisely once at 0.03s (see SCRUB_SEEK_MIN_MS in mediaSync)
  const scrubbing = useSyncExternalStore(subscribeScrub, isScrubbing, isScrubbing);
  // When only sound is output (the editor's main document): cut segments are expanded per kernel/cutAudio.mjs into shifted, trimmed clips, and the sound of referenced cuts plays along
  const sound = audioOnly ? audioProjectOf(project) : project;
  const layers = videoLayersAt(sound, t);
  const nexts = nextVideoLayerAfter(project, t);
  const audios = muted ? [] : audioClipsAt(sound, t);
  const generated = muted ? [] : generatedCardAudioClipsAt(sound, t);
  const [cardStatus, setCardStatus] = useState<Record<string, { state: CardState; message?: string }>>({});
  const setGeneratedStatus = useCallback((clipId: string, state: CardState, message?: string) => setCardStatus(status => ({ ...status, [clipId]: { state, message } })), []);
  const master = Math.max(0, Math.min(1, masterVolume));
  const stage = { width: project.width, height: project.height };
  return (
    <>
      {!audioOnly && visualTrackIds(project).map((id) => (
        <VideoTrack
          key={id}
          project={project}
          cur={layers.find((l) => l.trackId === id) ?? null}
          next={nexts.find((n) => n.trackId === id) ?? null}
          t={t}
          playing={playing}
          scrubbing={scrubbing}
          muted={muted}
          gain={project.tracks.find((track) => track.id === id)?.muted ? 0 : master}
          stage={stage}
          filters={project.filters}
          localHashes={localHashes}
        />
      ))}
      {/* Variable-speed video segments don't play their original sound ([ruling] first version, kernel/clipTime.mjs; same rule as audioPlanOf in the export mix) */}
      {audioOnly && !muted && layers.filter(l => !cardAudioNodeOf(sound, l.clip) && !isImageMedia(l.media) && l.media.kind === "video" && !l.clip.audioMuted && !speedMutesSource(l.clip, sound) && !sound.tracks.find(tr => tr.id === l.trackId)?.muted).map(l => (
        <AudioLayer key={l.clip.id} project={sound} clip={l.clip} media={l.media} volume={l.opacity * master * (l.clip.audioVolume ?? 1)} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} localHashes={localHashes} />
      ))}
      {audios.filter(a => !cardAudioNodeOf(sound, a.clip)).map((a) => (
        <AudioLayer key={a.clip.id} project={sound} clip={a.clip} media={a.media} volume={a.volume * master} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} localHashes={localHashes} />
      ))}
      {generated.map((a) => <AudioLayer key={`card-audio:${a.clip.id}`} project={sound} clip={a.clip} media={a.media} volume={a.volume * master} t={t} playing={playing} scrubbing={scrubbing} audioFx={project.audioFx} onCardState={setGeneratedStatus} localHashes={localHashes} />)}
      {generated.map(({ clip }) => {
        const status = cardStatus[clip.id]; if (!status || status.state === "ready") return null;
        return <div key={`card-audio-status:${clip.id}`} role="status" aria-live="polite" style={{ position: "absolute", left: 12, bottom: 12, zIndex: 100, padding: "6px 9px", borderRadius: 4, color: "#fff", background: status.state === "error" ? "#a11" : "#333", fontSize: 12 }}>{status.state === "pending" ? trText("Generating audio: {0}", clip.label ?? clip.id) : trText("Audio generation failed: {0}", status.message ?? clip.label ?? clip.id)}</div>;
      })}
    </>
  );
}
