/**
 * Generates a piece of card sound for the Cloud Agent **inside the render page** (the cloud route of
 * `render_card_audio`; contract `docs/plan/cloud-agent-contract.md` section 9.4c).
 *
 * The process of the Cloud Agent service does not execute card code. It hands "project × clip" to
 * the render service on the same machine (`POST /look` → the worker process's `/api/cards/audio`,
 * `server/vite-plugin-cards.ts`), and the worker process has the render page dynamically load this
 * module and call `renderClipCardAudio`: the card's `audio()` is evaluated in this page. A project
 * carrying card source is touched only by the worker process isolated per project, and the page
 * request gate and egress limits keep governing this page as before.
 *
 * Evaluation, the way the WAV is written, and the identity record are the same functions as in the
 * desktop app (`src/editor/io/cardAudioGeneration.ts`), so when another member's page checks the
 * record by the same algorithm it will not judge it stale. This module statically imports `../cards`:
 * the registry and the sound hook are in the same module tree as this module.
 */
import "../cards";
import type { Project } from "../kernel/project";
import { findClip } from "../kernel/project";
import { cardJson } from "../kernel/cardGraph.mjs";
import { cardAudioIdentity, cardAudioSourceOffset, clipHasEmbeddedAudio, resolveCardAudioRendition } from "../kernel/cardAudioRendition.mjs";
import { requireCardAudioHooks, renderEmbeddedCardWav } from "./cardAudio";

export interface HostedCardAudioResult {
  ok: true;
  clipId: string;
  /**
   * The existing record still matches (force not passed): do not recompute, and return the asset it
   * points to
   */
  reusable?: { mediaId: string; hash: string };
  name?: string;
  bytes?: number;
  expectedClip: string;
  rendition?: Record<string, unknown>;
}

const sha256Hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The generated WAV stays here and is taken away in chunks by the worker process
 * (`takeCardAudioChunk`), then cleared once it has all been taken
 */
let held: Uint8Array | null = null;

export async function renderClipCardAudio(project: Project, clipId: string, options: { force?: boolean; maxBytes?: number } = {}): Promise<HostedCardAudioResult> {
  held = null;
  const hooks = requireCardAudioHooks();
  const hit = findClip(project, clipId);
  if (!hit || !clipHasEmbeddedAudio(project, hit.clip, hooks.getCard)) throw new Error("Cannot find a motion graphics card with embedded audio");
  if (hit.track.locked) throw new Error("Unlock the track containing the card first");
  const clip = hit.clip;
  const expectedClip = JSON.stringify(clip);
  const identity = cardAudioIdentity(project, clip, hooks), sourceOffset = cardAudioSourceOffset(project, clip);
  if (new TextEncoder().encode(cardJson(identity)).byteLength > 96 * 1024) throw new Error("Card audio parameter record is too large. Shorten the clip or simplify the input");
  if (!options.force) {
    try {
      const reusable = resolveCardAudioRendition(project, clip, hooks);
      return { ok: true, clipId, expectedClip, reusable: { mediaId: reusable.media.id, hash: reusable.media.hash! } };
    } catch { /* Regenerate when missing or stale */ }
  }
  const rendered = await renderEmbeddedCardWav(project, clip, new AbortController().signal);
  if (options.maxBytes && rendered.wav.byteLength > options.maxBytes) throw new Error("This card audio is too large for the cloud to generate in one pass. Shorten the clip");
  const sourceKey = await sha256Hex(new TextEncoder().encode(cardJson({ version: 1, identity, sourceOffset, frames: rendered.frames, sampleRate: 48000 })));
  held = rendered.wav;
  return {
    ok: true, clipId, expectedClip, bytes: rendered.wav.byteLength,
    name: `${clip.label || hooks.getCard(clip.cardId)?.name || clip.cardId} · card audio.wav`,
    rendition: { version: 1, cardId: clip.cardId, sourceKey, sourceOffset, duration: rendered.frames / 48000,
      sampleRate: 48000, frames: rendered.frames, channels: rendered.channels, identity },
  };
}

/** Take one chunk (base64); when `from` reaches the end, the retained WAV is cleared */
export function takeCardAudioChunk(from: number, size: number): string {
  if (!held) throw new Error("No retained card audio");
  const part = held.subarray(from, Math.min(held.byteLength, from + size));
  if (from + size >= held.byteLength) held = null;
  let text = "";
  for (let i = 0; i < part.length; i += 0x8000) text += String.fromCharCode(...part.subarray(i, i + 0x8000));
  return btoa(text);
}
