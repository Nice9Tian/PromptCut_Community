/**
 * Add audio tracks to the exported final video.
 *
 * The frame-by-frame screenshot pipeline only produces visuals; audio must be spliced back with
 * ffmpeg at the end: each piece of media with audio in the project (background music and video
 * audio) is delayed by its position on the timeline, sliced by mediaOffset, faded by
 * fadeIn/fadeOut, and mixed into a single track. Speed-changed media clips do not emit original
 * audio (kernel/clipTime.mjs).
 *
 * Separated into its own file for testability: buildAudioPlan / buildFfmpegArgs are pure functions
 * that do not touch the disk.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { audioPlanOf } from "../../src/kernel/audioPlan.mjs";
import { ffmpegVarispeed } from "../../src/kernel/clipTime.mjs";
import { audioProjectOf } from "../../src/kernel/cutAudio.mjs";
import { audioFxOfClip } from "../../src/kernel/audioFx.mjs";

export const MISSING_MATERIAL_WAV = fileURLToPath(new URL("../../src/audio/assets/missing-material.wav", import.meta.url));

function isConfirmedMissingAudio(media, project) {
  const state = media?.missingMaterial;
  if (media && media.kind !== "image" && state?.v === 1 && state.reason === "confirmed-missing"
    && state.mediaId === media.id && state.audio === true && typeof state.visual === "boolean"
    && state.original?.kind === media.kind && state.original?.name === media.name && state.original?.url === media.url
    && state.original?.hash === media.hash) return true;
  const source = media?.soundOf ? project?.media?.find((item) => item.id === media.soundOf) : undefined;
  const sourceState = source?.missingMaterial;
  return source?.kind === "video" && sourceState?.v === 1 && sourceState.reason === "confirmed-missing"
    && sourceState.mediaId === source.id && sourceState.audio === true && typeof sourceState.visual === "boolean"
    && sourceState.original?.kind === "video" && sourceState.original?.name === source.name && sourceState.original?.url === source.url
    && sourceState.original?.hash === source.hash;
}

/**
 * During export, asset URLs look like /@export/<id>/media/<file>, and the actual file is at
 * outDir/media/<file>.
 */
export function localPathOf(url, outDir) {
  if (!url) return null;
  const marker = "/media/";
  const i = url.lastIndexOf(marker);
  if (i === -1) return null;
  return path.join(outDir, "media", decodeURIComponent(url.slice(i + marker.length)));
}

/**
 * Pick all clips that should produce sound from Project. Images have no audio; hidden tracks do not
 * produce sound; volume uses clip.opacity (shares the same field with visuals: audio fades as
 * visuals fade).
 *
 * sourceOf: media → file readable by ffmpeg or same-origin http address. Pass mediaSourceOf from
 * export-frames during export, following the same rules as the visual layer. Previously, only
 * localPathOf(/@export/<id>/media/) was recognized, and /@media/<file> in the media library was
 * skipped, so background music, voiceovers, and original video audio upon opening .proc never made
 * it into the final video.
 */
export function buildAudioPlan(source, outDir, exists = fs.existsSync, sourceOf = (m) => localPathOf(m.url, outDir)) {
  // Cut segments: expanded via kernel/cutAudio.mjs into translated, trimmed clips (same copy as
  // audioPlanOf); searching for clips by clipId below also looks in this copy
  const project = audioProjectOf(source);
  const out = [];
  // Rules for who produces sound and how loud are in kernel/audioPlan.mjs (same copy as loudness
  // measurement and Chrome offline audio mixing); this only fills in file locations
  for (const e of audioPlanOf(project)) {
    const sourceClip = (project.tracks ?? []).flatMap(track => track.clips ?? []).find(clip => clip.id === e.clipId);
    // A generated node replaces its corresponding source-media input; applying both would double it.
    if (!sourceClip?.cardAudio && isCardAudioNode(project, sourceClip?.nodeId)) continue;
    const m = (project.media || []).find((x) => x.id === e.mediaId);
    const missingMaterial = isConfirmedMissingAudio(m, project);
    const file = missingMaterial ? MISSING_MATERIAL_WAV : sourceOf(m);
    const soundEffect = !!(sourceClip?.cardAudio || m?.soundEffect || sourceClip?.soundEffect);
    if (!file || (!/^https?:/i.test(file) && !exists(file))) {
      if (soundEffect) throw new Error(`The generated sound effect file for ${e.clipId} is missing, restore the media or regenerate it`);
      continue;
    }
    out.push({ file, clipId: e.clipId, start: e.start, dur: e.dur, offset: missingMaterial ? 0 : e.offset, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx,
      // Speed-changed audio clips (kernel/clipTime.mjs): read dur × speed seconds of asset, and use
      // ffmpegVarispeed to change speed and pitch into dur seconds
      ...(e.speed && !missingMaterial ? { speed: e.speed, renderDir: outDir } : null),
      ...(e.env ? { env: e.env } : null),
      ...(missingMaterial ? { missingMaterial: true } : null), ...(soundEffect ? { soundEffect: true } : {}) });
  }
  // Audio media effect card nodes have no ffmpeg-readable source file.  Keep them in the one common
  // plan so Chrome's OfflineAudioContext can request their true WAV blocks.  A caller that
  // explicitly selects the old --audio ffmpeg path must reject them, never silently omit them.
  for (const track of project.tracks ?? []) {
    if (track.hidden || track.muted) continue;
    for (const clip of track.clips ?? []) {
      // Speed-changed video clips do not emit original audio, but audio media effect cards attached to
      // them emit audio as normal: cards read this asset as input, changing speed and pitch with the
      // speed multiplier (varispeedBlock in src/render/cards/audioSources.ts; user decision, 2026-10-23:
      // "Allow."). Only audio media effect card nodes are collected here; unified audio-visual cards take
      // the audioPlanOf route above (generated WAVs; also emit audio as normal on speed-changed clips,
      // user decision, 2026-10-23: "Produce sound.").
      if (clip.audioMuted || clip.cardAudio || !isCardAudioNode(project, clip.nodeId)) continue;
      // Generated blocks are sample-addressed; do not quantize their timeline placement to
      // the legacy 3 ms audio-plan precision before converting duration to frames.
      const dur = clip.end - clip.start;
      if (!(dur > 0)) continue;
      const definition = audioFxOfClip(project, clip);
      out.push({ cardAudio: true, nodeId: clip.nodeId, clipId: clip.id, start: clip.start, dur,
        offset: 0, volume: (clip.opacity ?? 1) * (clip.audioVolume ?? 1), fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0,
        fx: definition ? { def: definition, params: clip.audioFx?.params } : null, ...(clip.cutEnv?.length ? { env: clip.cutEnv } : null) });
    }
  }
  return out;
}

/** Kept local to this script so the project model need not invent a fake media asset for a generated node.
 *  Inspects nodes only: Node-side scripts cannot read TSX definitions, kind is the copy H2 copied
 *  into the node from definitions. */
export function isCardAudioNode(project, nodeId) {
  if (!nodeId) return false;
  const node = (project.cardNodes ?? []).find(value => value.id === nodeId);
  return node?.adapter === "card" && node.kind === "audio";
}

/**
 * Whether this file contains an audio stream (videos do not necessarily have audio tracks;
 * referencing directly would crash the entire filter).
 */
export function hasAudioStream(file, ffprobeCmd) {
  try {
    const out = execFileSync(
      ffprobeCmd,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Convert ffprobe path back to ffmpeg in the same directory (reverse of ffprobeOf in `ffmpeg.mjs`).
 */
const ffmpegOf = (ffprobeCmd) => String(ffprobeCmd).replace(/ffprobe(\.exe)?$/i, (m) => (m.toLowerCase() === 'ffprobe.exe' ? 'ffmpeg.exe' : 'ffmpeg'));

/**
 * Speed-changed audio clips (the kind separated from audio-visual, kernel/clipTime.mjs) are first
 * converted with ffmpeg into a timeline-length wav: reads dur × speed seconds of asset, with
 * `ffmpegVarispeed` changing speed and pitch. Both export mixing paths (slice segments in Chrome
 * offline audio mixing, ffmpeg mixing) start from this wav, so both paths get identical resampling
 * results. Kept here (rather than in `audio-mix.mjs`) because those seven modules in `server/bakery/`
 * enter the code fingerprint of the shared snapshot key (SNAPSHOT_FILES in
 * `server/frame-code.mjs`); modifying them would change keys for all existing snapshots.
 * @returns {string} Path to the prepared wav
 */
export function renderVarispeedWav(entry, ffmpegCmd, index) {
  const dir = path.join(entry.renderDir || ".", "audio-speed");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `speed-${index}-${String(entry.clipId).replace(/[^\w.-]+/g, "_").slice(0, 60)}.wav`);
  execFileSync(ffmpegCmd, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(entry.offset), "-t", String(entry.dur * entry.speed), "-i", entry.file,
    "-vn", "-sn", "-dn", "-af", ffmpegVarispeed(entry.speed).join(","), "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", out], { timeout: 600000, windowsHide: true });
  return out;
}

/**
 * Ordinary silent videos can be skipped; when synthesized sound effects exist but audio tracks
 * cannot be read, it must fail rather than reporting success for a silent final video. Speed-changed
 * audio clips are replaced with prepared wavs (see above).
 */
export function playableAudioPlan(plan, ffprobeCmd, probe = hasAudioStream, render = renderVarispeedWav) {
  return plan.filter((entry) => {
    if (entry.cardAudio) return true;
    const playable = probe(entry.file, ffprobeCmd);
    if (!playable && entry.soundEffect) throw new Error(`The generated sound effect for ${entry.clipId} has no readable audio track, restore the media or regenerate it`);
    return playable;
  }).map((entry, i) => {
    if (!entry.speed || entry.cardAudio) return entry;
    const { speed: _speed, renderDir: _dir, ...rest } = entry;
    return { ...rest, file: render(entry, ffmpegOf(ffprobeCmd), i), offset: 0 };
  });
}

/** Assemble ffmpeg arguments: copy video stream as is, mix audio according to plan */
export function buildFfmpegArgs(videoIn, plan, videoOut, durationSec) {
  if (plan.some(p => p.cardAudio)) throw new Error("ffmpeg audio mux cannot render card audio; use the Chrome audio mixer");
  const args = ["-y", "-i", videoIn];
  const filters = [];
  plan.forEach((p, i) => {
    // Speed-changed audio clip: reads dur × speed seconds of asset, first changes speed and pitch to
    // dur seconds before positioning (shares the same ffmpegVarispeed as clip trimming on Chrome path)
    args.push("-ss", String(p.offset), "-t", String(p.speed ? p.dur * p.speed : p.dur), "-i", p.file);
    const k = i + 1; // 0 is video
    const chain = p.soundEffect
      ? ['aresample=48000', `adelay=${Math.round(p.start * 48000)}S:all=1`]
      : [...ffmpegVarispeed(p.speed ?? 1), `adelay=${Math.round(p.start * 1000)}:all=1`];
    if (p.fadeIn > 0) chain.push(`afade=t=in:st=${p.soundEffect ? p.start : p.start.toFixed(3)}:d=${p.fadeIn}`);
    if (p.fadeOut > 0) {
      const fadeStart = p.start + p.dur - p.fadeOut;
      chain.push(`afade=t=out:st=${p.soundEffect ? fadeStart : fadeStart.toFixed(3)}:d=${p.fadeOut}`);
    }
    // Cut segment envelope (absolute timeline time): one afade for fade-in and fade-out per layer,
    // multiplied (same semantics as gainCurve in kernel/audioPlan.mjs)
    for (const e of p.env ?? []) {
      if ((e.fadeIn ?? 0) > 0) chain.push(`afade=t=in:st=${e.start.toFixed(3)}:d=${e.fadeIn}`);
      if ((e.fadeOut ?? 0) > 0) chain.push(`afade=t=out:st=${(e.end - e.fadeOut).toFixed(3)}:d=${e.fadeOut}`);
    }
    if (p.volume !== 1) chain.push(`volume=${p.volume}`);
    filters.push(`[${k}:a]${chain.join(",")}[a${k}]`);
  });
  const labels = plan.map((_, i) => `[a${i + 1}]`).join("");
  // normalize=0: do not automatically lower volume when multiple audio tracks are overlaid,
  // otherwise adding background music will lower the original audio
  filters.push(`${labels}amix=inputs=${plan.length}:normalize=0:dropout_transition=0[aout]`);
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[aout]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    String(durationSec),
    videoOut,
  );
  return args;
}
