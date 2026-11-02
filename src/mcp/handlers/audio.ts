import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { timelineDigest } from "../tools/toolEcho";
import { generateVoice, getVoiceConfig } from "../../ai/voice";
import { importAudioFromServer } from "../../editor/io";
import { soundPresets, startSoundGeneration, getSoundGenerationJob, soundGenerationJobs, cancelSoundGeneration, waitSoundGeneration } from "../../editor/io/soundGeneration";

import { clipGuard, audioFxTools, measureAudio, measureAudioJs } from "../common";
import { inClipCut } from "../clipCut";

type Args<K extends keyof EditorApi> = Parameters<EditorApi[K]>[0];

export const audioHandlers = {
  soundPresets: () => soundPresets(),
  soundGenerate: async (args) => {
    const job = startSoundGeneration(args);
    // Keep the Agent operation context open through the atomic project commit. UI callers remain asynchronous.
    const result = await waitSoundGeneration(job.id);
    if (result.state === "succeeded") clipGuard.noteMutation();
    return { ...result, jobId: result.id };
  },
  soundStatus: (args) => {
    if (!args?.jobId) return { jobs: soundGenerationJobs().filter(job => job.targetKey.startsWith(`${getState().project.id}:`)).map(job => ({ ...job, jobId: job.id })) };
    const job = getSoundGenerationJob(String(args.jobId));
    if (!job) throw new Error("Sound effect job not found (after reopening the page, regenerate it from the clip's recipe)");
    return job;
  },
  soundCancel: (args) => cancelSoundGeneration(String(args.jobId)),
  listAudioFx: () => audioFxTools.listAudioFx(),
  createAudioFx: (args) => { const r = audioFxTools.createAudioFx(args); clipGuard.noteMutation(); return r; },
  updateAudioFx: (args) => { const r = audioFxTools.updateAudioFx(args); clipGuard.noteMutation(); return r; },
  removeAudioFx: (args) => { const r = audioFxTools.removeAudioFx(args); clipGuard.noteMutation(); return r; },
  applyAudioFx: (args) => { const r = audioFxTools.applyAudioFx(args); clipGuard.noteMutation(); return r; },
  measureAudio: (args) => measureAudio(args),
  measureAudioJs: (args) => measureAudioJs(args),
  setClipVolume: /* @__PURE__ */ inClipCut((args: Args<"setClipVolume">) => {
    const result = actions.setClipVolume(String(args.clipId), args.volume);
    if (!result.ok) throw new Error(result.error);
    clipGuard.noteMutation();
    return { ...result, timeline: timelineDigest(getState().project) };
  }),
  setClipMuted: /* @__PURE__ */ inClipCut((args: Args<"setClipMuted">) => {
    const result = actions.setClipMuted(String(args.clipId), args.muted);
    if (!result.ok) return result;
    clipGuard.noteMutation();
    return { ...result, timeline: timelineDigest(getState().project) };
  }),
  separateAudio: (args) => {
    if (!!args.clipId === !!args.clipIds) return { ok: false, code: "INVALID_CLIP_IDS", error: "Exactly one of clipId and clipIds must be given" };
    const result = args.clipIds ? actions.separateAudios(args.clipIds) : actions.separateAudio(String(args.clipId));
    // Explicit structured failures are handed over to the Agent; no project write before failure,
    // creating no empty tracks or silent downgrades.
    if (!result.ok) return result;
    clipGuard.noteMutation();
    return { ...result, timeline: timelineDigest(getState().project) };
  },
  createAudio: (args) => {
    const mediaId = args.mediaId ? String(args.mediaId) : "";
    const clipId = args.clipId ? String(args.clipId) : "";
    if (!mediaId && !clipId) throw new Error("Give mediaId (derive audio into the media library) or clipId (convert this segment on the timeline to audio in place)");
    if (mediaId && clipId) throw new Error("Give only one of mediaId and clipId: giving clipId converts that segment to audio and also leaves a copy in the media library");
    if (clipId) {
      const r = actions.convertClipToAudio(clipId);
      if (!r.ok) throw new Error(r.error);
      clipGuard.noteMutation();
      const p = getState().project;
      const m = p.media.find((x) => x.id === r.mediaId);
      return {
        ok: true, clipId, mediaId: r.mediaId, name: m?.name,
        note: r.already ? "This segment was already audio, nothing changed" : "This segment is now audio only (the picture is gone); position, length and fades are kept; the media library also gained this audio",
        timeline: timelineDigest(p),
      };
    }
    const r = actions.audioFromVideo(mediaId);
    if (!r.ok) throw new Error(r.error);
    return {
      ok: true, mediaId: r.media.id, name: r.media.name, created: r.created,
      note: r.created
        ? "The media library gained an audio-only media item (the same file as the source video, not transcoded). Pass this mediaId to add_clip to get an audio-only clip"
        : "The audio media for this video was already derived earlier, use this mediaId directly",
    };
  },

  voiceList: async () => {
    const { config, presets } = await getVoiceConfig();
    return {
      provider: config.provider,
      apiKeySet: config.apiKey.set,
      defaults: { minimax: config.minimax, kling: config.kling, vidu: config.vidu },
      systemVoices: presets.systemVoices,
      customVoices: config.customVoices.map((v) => ({ provider: v.provider, voiceId: v.voiceId, name: v.name, kind: v.kind, note: v.note })),
      textLimits: presets.textLimits,
      hint: config.apiKey.set
        ? "Pick voice_generate's voiceId from systemVoices / customVoices (customVoices must be paired with a provider)."
        : "No API Key is configured, so voice_generate will fail. Tell the user to enter the API Key in \"Voiceover settings\" (can be opened from the voiceover card on the start page or the editor top bar).",
    };
  },

  voiceGenerate: async (args) => {
    if (!args.text || !String(args.text).trim()) throw new Error("text must not be empty");
    const r = await generateVoice({
      text: args.text, provider: args.provider, voiceId: args.voiceId,
      speed: args.speed, emotion: args.emotion, name: args.name,
    });
    // The server has already sent this voiceover into the content store via the asset service store
    // API (server/vite-plugin-voice.ts); register it here using the returned identifier
    const mediaId = await importAudioFromServer({ url: r.url, name: r.name, uploaded: r.media ?? null });
    const media = getState().project.media.find((m) => m.id === mediaId);
    let clipId: string | undefined;
    if (typeof args.start === "number") {
      const clip = actions.addMediaClip(mediaId, Math.max(0, args.start), { trackId: args.trackId });
      if (!clip) throw new Error(`The speech is in the media library (mediaId ${mediaId}), but placing it on the timeline failed. Wrong trackId?`);
      clipId = clip.id;
    }
    return {
      mediaId, name: r.name, duration: media?.duration, clipId,
      provider: r.provider, model: r.model, voiceId: r.voiceId, chars: r.chars,
      hint: clipId
        ? "Added to the media library and placed on the timeline. The next clip's start follows this clip's start + duration."
        : "Added to the media library (not placed on the timeline). To put it on the timeline, pass start and generate again, or the user can drag it from the media library.",
    };
  },
} satisfies Partial<EditorApi>;
