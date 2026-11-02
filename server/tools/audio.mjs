export const audioTools = [
  {
    name: "render_card_audio",
    description: "Generate the persistent WAV for the motion graphics card's own audio(). The sound still belongs to the same visual clip; no separate audio clip is created. First provide the visual Component/card and a deterministic audio via create_card/edit_card; this tool waits until the result is actually stored and returns mediaId. Call it again after changing parameters or source. Missing or failed audio is never silently exported without sound, and canceled or late results do not overwrite the old reference. The online page can only read the already synced WAV and cannot run user sound code.",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, force: { type: "boolean", description: "Ignore reusable results and recompute" } }, required: ["clipId"] },
    side: "page", timeoutMs: 120000,
  },
  {
    name: "cancel_card_audio", description: "Cancel the sound generation or upload in progress for the specified motion graphics clip, keeping the existing usable audio reference.",
    inputSchema: { type: "object", properties: { clipId: { type: "string" } }, required: ["clipId"] }, side: "page",
  },
  {
    name: "sound_presets",
    description: "Look up reusable native synthesized sound effects (short notification sounds, keyboard sounds), their sources, full default parameters and resource limits. Pick an existing preset first, then sound_generate; no need to create a new audio card or use an external service.",
    inputSchema: { type: "object", properties: {} }, side: "page",
  },
  {
    name: "sound_generate",
    description: "Generate an editable WAV sound effect and store it via the asset service. preset: notification is a notification sound, keyboard is a keyboard sound. Given sourceClipId (mu-typing), it automatically reuses its text, milliseconds per character, delay, pauses and seed, and places a separate audio segment at the same timeline anchor; a media effect card cannot be attached to that segment again. For an ordinary notification sound, use start to place it; if omitted it only goes into the media library. Given clipId, it regenerates the original sound effect segment, replacing it only after a successful upload; on cancel or failure the old sound is kept. recipe may carry a previous full recipe; params only changes sound parameters; refreshSource:true rebuilds the events from the current typing card (use after changing text or speed). The tool waits for synthesis and storage to finish before returning the result; the page shows progress and it can be canceled; other sessions can query with sound_status and cancel with sound_cancel. requestId is an idempotency key: retries must reuse it, and a different sound effect must use a different key. A sound effect never implicitly extends the project out point, and an overlap on the specified track raises an error.",
    inputSchema: { type: "object", properties: {
      preset: { type: "string", enum: ["notification", "keyboard"] },
      sourceClipId: { type: "string" }, clipId: { type: "string" },
      start: { type: "number", minimum: 0 }, trackId: { type: "string" },
      params: { type: "object", description: "Partial override of the tunable full parameters given by sound_presets" },
      typing: { type: "object", description: "Text rhythm when there is no sourceClipId: {text,duration(ms per character),delayMs,punctuationPauseMs,newlinePauseMs,jitterMs,seed,pauses}" },
      recipe: { type: "object", description: "Full persisted sound effect recipe" },
      seed: { type: "integer", minimum: 0, maximum: 4294967295 },
      requestId: { type: "string", maxLength: 200 }, name: { type: "string" },
      refreshSource: { type: "boolean" },
    }, required: ["requestId"] }, side: "page", timeoutMs: 120000,
  },
  {
    name: "sound_status", description: "Query the progress and result of a sound effect generation job. Without jobId, lists the jobs of the current project (so another session can query or cancel a job being generated). Only succeeded means it has been stored and the clip switched; failed/cancelled/stale never overwrite the old sound.",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } } }, side: "page",
  },
  {
    name: "sound_cancel", description: "Cancel sound effect generation or upload. An already usable old sound effect stays unchanged, and late results do not overwrite it.",
    inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] }, side: "page",
  },
  {
    name: "set_clip_volume",
    description: "Set the independent sound volume of an audio or video card. volume ranges 0~1, 0=silent, 0.5=50%, 1=original sound (default). Does not change picture opacity, keeps fade in/out; does not undo track mute, hidden state, or the original video mute after audio-visual separation. Supports undo; a locked track must be unlocked first.",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, volume: { type: "number", minimum: 0, maximum: 1 } }, required: ["clipId", "volume"] },
    side: "agent",
  },
  {
    name: "set_clip_muted",
    description: "Mute or unmute a single media/motion graphics card that has sound. Only changes the sound, not the picture; the timeline clearly marks it as muted, and it supports undo and saving. Cannot bypass track mute or locking.",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, muted: { type: "boolean" } }, required: ["clipId", "muted"] },
    side: "agent",
  },
  {
    name: "separate_audio",
    description: "Separate the audio track of an ordinary video media clip: the original video is muted, the sound goes on a new track below, keeping position, offset, volume and fade in/out. clipId for a single selection or clipIds for multiple, give only one. Sound embedded in the code of a motion graphics card cannot be separated and explicitly returns ok:false/code:EMBEDDED_CARD_AUDIO_UNSEPARABLE; no substitute media is generated automatically and no empty track is created. If any item of a multi-selection fails, the whole batch is left unmodified.",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, clipIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } } }, oneOf: [{ required: ["clipId"] }, { required: ["clipIds"] }] },
    side: "agent",
  },
  {
    name: "measure_audio",
    description: "Measure loudness (EBU R128, with the same ffmpeg used for export). You cannot hear sound, so use this to see the numbers before adjusting volume: give clipId to measure that segment on the timeline (only the stretch of media it uses, the **original media sound**, excluding clip volume / fade in/out / effects), give mediaId to measure the whole media, scope:'timeline' to measure the mixed result of the whole timeline (including each segment's volume and fades; **audio effects are not included**, a note is flagged when effects exist). Returns integrated (overall loudness in LUFS, higher is louder, -14 is a common release target), truePeak (peak in dBTP, above 0 clips and pops, release needs it below -1), lra / lraLow / lraHigh (loudness range, the 10th / 95th percentiles after silence is filtered out). The timeline tier also gives series: per-second loudness and the clipId sounding in that second, to find which second is too loud and who is responsible. Rule of thumb: voice needs to be 12~15 LU louder than music / ambient sound to be heard clearly; subtract the integrated of the two segments to get the difference, and to lower by X dB use set_clip_volume to 10^(-X/20) (lowering 12 dB ≈ 0.25); raising can only be done with the gain of create_audio_fx.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "Measure this segment on the timeline" },
        mediaId: { type: "string", description: "Measure the whole media" },
        scope: { type: "string", enum: ["clip", "media", "timeline"], description: "If omitted, it is decided by whether clipId or mediaId was given" },
        series: { type: "boolean", description: "Pass true when the clip / media tier also needs the per-second curve (the timeline tier always gives it)" }
      }
    },
    side: "agent"
  },
  {
    name: "measure_audio_js",
    description: "Custom measurement: for what the built-in measure_audio cannot measure (RMS, peak, zero-crossing rate, energy in a frequency band, silent segments, beats, correlation between two segments...), write a piece of JS to compute it yourself. **Only available at creativity level \"high\"**; low and medium tiers are rejected, so use only measure_audio then. What to measure works the same as measure_audio: clipId measures the original audio of the media used by that clip on the timeline, mediaId measures the whole media, scope:'timeline' measures the mix of the whole timeline (including clip volume and fades, excluding audio effects; like export it is stereo, and mono media is 3 dB lower per channel); start / duration cut a window (in seconds) within that audio. The server decodes the audio to 32-bit float PCM (default 16000 Hz, sampleRate adjustable from 8000 to 48000; at most 2 channels, mono:true mixes down to mono; at most 12 million samples across all channels in total) and runs code in an isolated sandbox (a Worker in headless Chrome, no network access, no Node capabilities). code is the body of an async function with the parameter input = { channels: Float32Array[] (one per channel, values roughly -1 to 1), sampleRate, duration (seconds), frames, numberOfChannels, scope, start, clipId?, mediaId? }; use return to return a JSON-serializable summary (at most 256 KB, do not return raw samples). The time limit defaults to 10 seconds (timeoutMs up to 30000); on timeout, a thrown error, a syntax error, or a result that cannot be serialized or is too large, it returns ok:false with error (including the error message and line number); fix the code and retry. Example: code:'const x = input.channels[0]; let s = 0, pk = 0; for (const v of x) { s += v * v; pk = Math.max(pk, Math.abs(v)); } return { rmsDb: 10 * Math.log10(s / x.length), peakDb: 20 * Math.log10(pk) };'",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", maxLength: 20000, description: "Body of an async function; it receives input and uses return to return the result" },
        clipId: { type: "string", description: "Measure this segment on the timeline" },
        mediaId: { type: "string", description: "Measure the whole media" },
        scope: { type: "string", enum: ["clip", "media", "timeline"], description: "If omitted, decided by whether clipId or mediaId was given; if neither is given, the timeline is measured" },
        start: { type: "number", minimum: 0, description: "Start at this second within that audio (default 0)" },
        duration: { type: "number", exclusiveMinimum: 0, description: "Measure only this many seconds (default: measure to the end)" },
        sampleRate: { type: "number", minimum: 8000, maximum: 48000, description: "Sample rate for decoding, default 16000" },
        mono: { type: "boolean", description: "true mixes down to mono" },
        timeoutMs: { type: "number", minimum: 1000, maximum: 30000, description: "Time limit for the code, default 10000" }
      },
      required: ["code"]
    },
    side: "agent",
    timeoutMs: 90000
  },
  {
    name: "create_audio",
    description: "Turn video into audio. Two ways to use it: give mediaId: derive an \"audio only\" asset in the media library (the same file as the source video, no transcoding, so it is instant); after that, add_clip with this mediaId gives a pure audio clip. Give clipId: convert **this clip** on the timeline to audio in place; the picture is gone, while position, length, offset within the media and fades are all kept, and an audio asset is also left in the media library. Only one audio asset is derived per video, and repeated calls return the same mediaId. Images have no audio and are rejected; media that is already audio is returned as is. Fades work the same for audio (preview follows the volume, export uses afade); to add fades to audio, use add_transition.",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string", description: "Video in the media library: derive an audio asset" },
        clipId: { type: "string", description: "A video clip on the timeline: convert to audio in place" }
      }
    },
    side: "agent"
  },
  {
    name: "list_audio_fx",
    description: "List the audio effects library (those in the \"Audio effects\" tab of the media library), plus the available effect kinds, each kind's parameters (range / default / unit), a few presets and the expression syntax. Each effect gives fxId, name, description, params (parameters that can be tuned per clip once attached), ops, summary, animated, usedBy (which clips it is attached to). Before attaching an effect, check whether there is an existing one to reuse; when unsure which kind to use, read the hint of each kind in kinds.",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "create_audio_fx",
    description: "Create a new audio effect and put it in the \"Audio effects\" tab of the media library: the user can see and reuse it, and you can attach it to any video / audio clip. ops are several steps applied in order, each step { kind, <param name>: value }, with eleven kinds: gain (db, -60 to 24, **can exceed 0 dB, the only way to amplify audio that is too quiet**), highpass (freq, q), lowpass (freq, q), peaking equalizer peaking (freq, q, db), lowshelf (freq, db), highshelf (freq, db), compressor (threshold, ratio, knee, attack, release), limiter (ceiling), delay echo (time, feedback, mix), reverb (decay, mix), pan stereo position (pan). Parameters left out take their defaults (see kinds in list_audio_fx). A parameter is a number, or an **expression string that varies over time**: t = seconds within the clip, d = clip duration, p = t/d, and it can also reference parameters declared in params. Example: { name:'Duck background', params:{ amount:{ default:-12, min:-40, max:0, label:'dB' } }, ops:[{ kind:'gain', db:'amount' }] }; clear voice: ops:[{ kind:'highpass', freq:100 }, { kind:'peaking', freq:3000, q:1, db:3 }, { kind:'compressor', threshold:-24, ratio:3 }]. Pass clipId to also attach it to that clip. Preview and export use the same node graph (Web Audio), so what you hear matches the export.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name shown in the media library, up to 30 characters" },
        description: { type: "string", description: "One sentence on what effect this is and what kind of audio it suits" },
        params: {
          type: "object",
          description: "Optional: parameters that can be tuned per clip; the key is the parameter name (starts with a lowercase letter, must not duplicate a kind's parameter names such as freq / db / q), the value is { default, min?, max?, label? }. Use the parameter name directly in expressions",
          additionalProperties: {
            type: "object",
            properties: {
              default: { type: "number" },
              min: { type: "number" },
              max: { type: "number" },
              label: { type: "string" }
            },
            required: ["default"]
          }
        },
        ops: {
          type: "array",
          description: "Steps applied in order, 1 to 8 steps, each step { kind, <param name>: number or expression }",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["gain", "highpass", "lowpass", "peaking", "lowshelf", "highshelf", "compressor", "limiter", "delay", "reverb", "pan"] }
            },
            required: ["kind"],
            additionalProperties: true
          }
        },
        clipId: { type: "string", description: "Optional: attach directly to this clip (video / audio) after creating" },
        clipParams: { type: "object", description: "Optional: parameter values for this clip when attached, overriding the defaults in params" }
      },
      required: ["name", "ops"]
    },
    side: "agent"
  },
  {
    name: "update_audio_fx",
    description: "Edit an effect in the audio effects library. **All** clips it is attached to change with it (clips reference it, not a copy). If ops / params are given, they replace the whole item. To change only one clip, use apply_audio_fx and pass params overrides for that clip, or create a separate effect.",
    inputSchema: {
      type: "object",
      properties: {
        fxId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        params: { type: "object", description: "Same as create_audio_fx" },
        ops: { type: "array", items: { type: "object" }, description: "Same as create_audio_fx" }
      },
      required: ["fxId"]
    },
    side: "agent"
  },
  {
    name: "remove_audio_fx",
    description: "Delete an effect from the audio effects library. It is rejected while still attached to clips; if you really need to delete it, pass force:true and state the reason in reason (the user will see it); the clips attached to it in all cuts are detached together.",
    inputSchema: {
      type: "object",
      properties: {
        fxId: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["fxId"]
    },
    side: "agent"
  },
  {
    name: "apply_audio_fx",
    description: "Attach an effect from the audio effects library to a video / audio clip (only one per clip, attaching again replaces it; to stack several effects, write multi-step ops in one effect); params gives parameter values for this clip alone. Pass an empty string for fxId to detach. Images and cards have no audio and are not accepted. After attaching you can run measure_audio to check the numbers.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        fxId: { type: "string", description: "Empty string = detach the audio effect from this clip" },
        params: { type: "object", description: "Optional: parameter values for this clip, only those declared in this effect's params" }
      },
      required: ["clipId", "fxId"]
    },
    side: "agent"
  },
  {
    name: "voice_list",
    description: "Check the voiceover (voice_generate) settings: the default service (minimax / kling / vidu), each service's default voice and parameters, the available voices (systemVoices are system voices; customVoices are the \"My voices\" the user created or registered in \"Voiceover settings\", such as cloned human voices), and whether the API key is set (apiKeySet). Call it once before the first voiceover, and pick voiceId from here; do not make one up.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "voice_generate",
    description: "Turn a piece of text into speech (cloud TTS, via API), returned synchronously, taking a few seconds. Parameters not passed take the values in \"Voiceover settings\" (factory default is MiniMax speech-2.8-hd). The generated mp3 goes into the media library; pass start (seconds) to also place it at that position on the timeline (trackId optional), otherwise it only goes into the media library. One segment at a time: at most 5000 characters per call for MiniMax / Vidu, 1000 for Kling; split long scripts into sentence groups and call multiple times, with the next segment's start = the previous start + the previous duration (you may leave a 0.2 to 0.4 second breath gap). voiceId must be a voice listed by voice_list, others are rejected; there is no tool to create a new voice: the first synthesis with a new voice is charged an extra ¥9.9, and only the user can create one in \"Voiceover settings\". If no API key is configured or the quota is used up, it returns an error; report the error to the user as is and do not retry repeatedly. Returns mediaId, duration (seconds), clipId (only if placed on the timeline), provider, voiceId, chars (billed characters).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to read aloud. Write numbers and English the way you want them read (\"130 milliseconds\", \"PromptCut zero point five\")" },
        start: { type: "number", description: "Start position on the timeline (seconds); if omitted, it only goes into the media library" },
        trackId: { type: "string", description: "Which track to place it on; if omitted, one is picked automatically" },
        provider: { type: "string", enum: ["minimax", "kling", "vidu"], description: "If omitted, the default service from settings is used" },
        voiceId: { type: "string", description: "Voice id, must be one listed in voice_list; if omitted, the service's default voice is used" },
        speed: { type: "number", description: "Speech speed, 0.5~2 for MiniMax / Vidu, 0.8~2 for Kling; if omitted, the setting is used" },
        emotion: { type: "string", enum: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "calm"], description: "Emotion, only effective for MiniMax / Vidu; if omitted, the model decides from the text" },
        name: { type: "string", description: "Short label included in the media name, e.g. \"Opening narration\"" }
      },
      required: ["text"]
    },
    side: "page"
  }
];
