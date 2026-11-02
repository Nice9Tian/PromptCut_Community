/**
 * Audio effects in the editor preview: connects <video> / <audio> elements into Web Audio and
 * attaches fxChain.
 *
 * An element is connected into the AudioContext (createMediaElementSource) only **the first time an
 * effect is needed**: once connected, the sound goes only through the node graph and can never
 * return to the element's direct output; so clips with no effect are left untouched, and the old
 * behavior is completely unchanged. For an element that has been connected, if the clip is
 * switched to one without effects, it passes straight through (source → destination).
 *
 * Volume still goes through el.volume (driveMedia in MediaLayers), with the node graph behind it;
 * the order matches the export: volume → effects.
 *
 * # Two pitfalls
 *   1. Before a user gesture an AudioContext is suspended, and a connected element would be silent.
 *      resume once on playback; Chrome lets it through after any click anywhere in the editor
 *      (sticky activation). The same holds for Agent-driven play, as long as the user has clicked
 *      in this page.
 *   2. createMediaElementSource outputs silence for cross-origin media without CORS enabled. So only
 *      same-origin elements (/@media/, blob:) are connected; for external media with an effect, it
 *      has no effect in the preview (a console hint, once), while the export works as usual: the
 *      export uses the local wav extracted by ffmpeg.
 */

import { audioFxOfClip, isAudioFxAnimated, type AudioFxDef } from "../kernel/audioFx.mjs";
import type { TrackClip } from "../kernel/project";
import { buildFxChain, fxChainKey, type FxChain } from "./fxChain";

interface Routed {
  src: MediaElementAudioSourceNode;
  chain: FxChain | null;
  key: string;
}

let ctx: AudioContext | null = null;
const routed = new WeakMap<HTMLMediaElement, Routed>();
const warned = new Set<string>();

function context(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function sameOrigin(el: HTMLMediaElement): boolean {
  const s = el.currentSrc || el.src;
  if (!s) return false;
  if (s.startsWith("blob:") || s.startsWith("data:")) return true;
  try {
    return new URL(s, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Called once per frame (inside the layout effect of MediaLayers): clip is the clip this element is
 * playing at the moment (null if none), and t is the timeline time.
 * It connects only when needed; an element that has been connected swaps chains / passes through per
 * clip; effects that vary over time write their parameters every frame.
 */
export function routePreviewAudio(el: HTMLMediaElement | null, audioFx: AudioFxDef[] | undefined, clip: TrackClip | null, t: number, playing: boolean): void {
  if (!el) return;
  const def = clip && audioFx?.length ? audioFxOfClip({ audioFx }, clip) : null;
  let r = routed.get(el);
  if (!r) {
    if (!def) return; // No effect attached and never connected: do nothing
    if (!sameOrigin(el)) {
      const s = el.currentSrc || el.src;
      if (!warned.has(s)) {
        warned.add(s);
        console.warn(`[previewAudio] External-link media cannot be connected to Web Audio (cross-origin is muted), so effects do not apply in preview; export is not affected: ${s}`);
      }
      return;
    }
    const c = context();
    const src = c.createMediaElementSource(el);
    src.connect(c.destination);
    r = { src, chain: null, key: "" };
    routed.set(el, r);
  }
  const c = context();
  if (playing && c.state === "suspended") void c.resume();
  // The same element rotates its src (the two slots of MediaLayers): after being connected, if it
  // switches to a cross-origin external link, the MediaElementAudioSourceNode outputs silence and
  // cannot return to the element's direct output. It cannot be fixed; the only option is to check every
  // time and show a hint once per address
  if (!sameOrigin(el)) {
    const s = el.currentSrc || el.src;
    if (s && !warned.has(s)) {
      warned.add(s);
      console.warn(`[previewAudio] This playback slot is already connected to Web Audio, so switching to cross-origin external-link media will be silent (preview limitation; export is not affected): ${s}`);
    }
  }

  const d = clip ? clip.end - clip.start : 0;
  const key = def && clip ? fxChainKey(def, clip.audioFx?.params, d) : "";
  if (key !== r.key) {
    if (r.chain) {
      r.src.disconnect();
      r.chain.dispose();
      r.chain = null;
    } else {
      r.src.disconnect();
    }
    if (def && clip) {
      const chain = buildFxChain(c, def, clip.audioFx?.params, d, isAudioFxAnimated(def));
      r.src.connect(chain.input);
      chain.output.connect(c.destination);
      chain.setTime(t - clip.start, d);
      r.chain = chain;
    } else {
      r.src.connect(c.destination);
    }
    r.key = key;
  } else if (r.chain && r.chain.animated && clip) {
    r.chain.setTime(t - clip.start, d);
  }
}

/** Tear down the element's chain when it unmounts (the source node goes with the element and needs no handling) */
export function releasePreviewAudio(el: HTMLMediaElement | null): void {
  if (!el) return;
  const r = routed.get(el);
  if (!r) return;
  try { r.src.disconnect(); } catch { /* Broken */ }
  r.chain?.dispose();
  routed.delete(el);
}

/**
 * For debugging / end-to-end tests: the number of elements connected into Web Audio and the context
 * state. Attached to window.__pcPreviewAudio
 */
export function previewAudioStats(): { routed: number; withChain: number; state: string | null } {
  let n = 0;
  let withChain = 0;
  for (const el of document.querySelectorAll<HTMLMediaElement>("video, audio")) {
    const r = routed.get(el);
    if (!r) continue;
    n++;
    if (r.chain) withChain++;
  }
  return { routed: n, withChain, state: ctx ? ctx.state : null };
}
if (typeof window !== "undefined") (window as unknown as { __pcPreviewAudio?: unknown }).__pcPreviewAudio = previewAudioStats;
