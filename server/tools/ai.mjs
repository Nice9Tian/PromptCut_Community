export const aiTools = [
  {
    name: "detect_shots",
    description: "Detect shot changes (transitions) in media. Detection is slow (about 36 seconds for 5 minutes of media), so it returns a jobId immediately; poll the result with list_shots. With the shot detection extension installed, it uses TransNetV2, which recognizes both hard cuts and dissolves, and for dissolves also gives the start and end times of the fade; without the extension it automatically falls back to ffmpeg scdet, which only recognizes hard cuts and cannot recognize dissolves (the returned engine field says which one was used). Parameters: mediaId is required, force is optional (default false; if detection has already been done, the result is reused directly).",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        force: { type: "boolean", description: "true means ignore existing results and detect again" }
      },
      required: ["mediaId"]
    },
    side: "page"
  },
  {
    name: "list_shots",
    description: "Read the shot division result of media; after detect_shots, use it to poll and fetch data (when unfinished it returns running:true and a progress percentage). Returns shots (each shot's start/end in seconds, and which transition it enters and exits with) and transitions (each transition's kind: cut (hard cut) / dissolve, start/end span, confidence). **Look at this first when adding motion graphics cards to media**: align a card's start and end to shot boundaries, and do not let one card span two shots; do not place emphasis-type motion graphics inside a dissolve interval, since the picture itself is blending there. Each shot also carries a subject field: if detect_subjects has been run, it describes the people in that interval (safeSide: which side is empty, suggestedPosition: can be filled directly into the card's params.position, suggestedOccupancy: how much of the chosen side is people, occupancy: occupancy of the four sides, boxes: person boxes), **and if you want \"don't cover the face\", fill in suggestedPosition**; if it has not been run, it is null, and the returned subjectHint prompts you to call detect_subjects. suggestedPosition takes only the values left / right / bottom and **never returns center**; it is \"the least bad of the remaining three tiers\", which does not guarantee no covering, so look at suggestedOccupancy: above 0.5, suggestedPosition is given as null with a warning, meaning all four tiers are taken up by people and this shot has no position that avoids them, so shrink the card or place it in another shot, and do not force a value. Whether this value can be filled is determined by the controls of list_cards({cardId}); if the card has no position, or the options do not include this value, switch to a card that supports it, **and do not fall back to the default centered position: the center is exactly where faces are**. subject.approximate being true means this shot has no sample point and the numbers come from the nearest sample, so they are only approximate. The top-level subjectFailedCount in the result is the number of samples whose frame extraction failed, and subjectFellBackFrom being full means it was meant to run the full tier but fell back to light midway (the prompt did not take effect).",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" }
      },
      required: ["mediaId"]
    },
    side: "page"
  },
  {
    name: "track_points",
    description: "Track the motion path of one or more points in media, so that cards/captions follow a target in the picture. Returns a jobId immediately; poll with get_track. Both tiers work, and tracking works even without the extension: with the motion tracking extension installed it uses BootsTAPIR (about 26 seconds for 250 frames, understands the picture content, and can re-recognize a target after it turns, deforms, or is occluded for a long time); without it, it falls back to template matching (about 1 second for 250 frames; a rigid, clearly textured target can be tracked to sub-pixel accuracy, but once the target turns, scales, or is occluded for a long time it is lost). Which tier is running is shown by the engine returned by get_track. Parameters: mediaId is required; points is required, written as [[frame number, x, y], ...], with coordinates in the original pixels of that media. Note: **the point to track must land on a textured spot**: the inside of a solid-color region (such as the center of a white block) has no local features to match and cannot be tracked.",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        points: {
          type: "array",
          description: "[[frame, x, y], ...], raw pixel coordinates",
          items: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
          minItems: 1
        }
      },
      required: ["mediaId", "points"]
    },
    side: "page"
  },
  {
    name: "get_track",
    description: "Reads the motion tracking result. Poll it after track_points (returns running:true and a progress percentage while unfinished). **Returns only a summary by default**: for each point, the number of visible frames, the displacement range, and the start and end coordinates, which is enough to judge whether the tracking worked and whether it is worth binding. **Do not read the coordinates out just to make a card follow along**; that is the job of attach_clip_motion, and the data flows directly inside the app. For a 30-second video each point is 900 coordinate pairs, so reading them in is pure waste. Pass full:true only if you really need to compute something yourself. A point with a note means tracking failed outright for it (not enough texture, too close to the edge); do not use that one. An engine of template means the user has not installed the extension and the template matching fallback is in use, which silently loses the target when it turns or deforms. Do not read a long invisible stretch as \"there is no motion in the picture\"; you can suggest that the user install the extension with track_install and track again.",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        full: { type: "boolean", description: "Return per-frame coordinates (very long). Default false, returns only a summary" }
      },
      required: ["mediaId"]
    },
    side: "page"
  },
  {
    name: "track_status",
    description: "Checks which tier motion tracking can run at; look before tracking. An engine of bootstapir means the extension is installed (accurate, slow, handles occlusion and deformation); template means the extension is not installed and the numpy template matching fallback is used (fast, tracks rigid objects with clear texture very accurately, but loses the target if it turns, scales or is blocked for a long time); null means neither tier is usable (usually Python cannot be found). When the user wants a more stable result, use track_install to install the extension.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "track_install",
    description: "Installs the motion tracking extension (BootsTAPIR, torch + weights about 400 MB, takes a few minutes). Once installed, tracking automatically switches from the template matching fallback to the neural network tier. Because this takes far longer than the call timeout, it returns a jobId immediately; check that jobId with background_job_status, or use track_status to see whether engine has become bootstapir. **Do not start it repeatedly**. Install only when the user explicitly wants better tracking: the fallback tier is good enough for rigid targets, so do not make the user download 400 MB just to track a still object with clear texture.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "detect_subjects",
    description: "Detects where people are in the media picture, to decide which side to put a card on without covering them. Returns a jobId immediately; poll with list_subjects. When it finishes, each shot in list_shots carries subject and suggestedPosition. **When the user says \"don't cover the face\", \"avoid the people\" or \"put it on the empty side\", take this route; do not guess position.** The result carries engine (current tier) and etaSeconds (estimated time): measured, light takes about 0.5 s/frame and full about 3 s/frame, so for 20 shots with 60 samples light takes half a minute and full a little over three minutes. **Asking list_subjects every 3 seconds for light and every 10 seconds for full is enough**, do not ask every second. Wait between polls with the wait tool, do not sleep with shell commands yourself. An engine of null means neither tier is usable and this job will most likely fail; call subject_status first to confirm. Sample times are computed automatically by default: if detect_shots has been run, take three points per shot at 20%/50%/80% (for shots shorter than 1 second take only the midpoint); otherwise take one point every 2 seconds. If the total exceeds 200, precision is reduced automatically (first only one midpoint per shot, and if still over, thin out at equal intervals). When this happens, a sampledNote sentence is given in the result, and shot-level conclusions are coarser and more shots are approximate. You can also pass times yourself (an array of seconds within the media, at most 200 at a time). prompt is honored only by the full tier (it can find any noun) and **must be English noun phrases separated by \" . \" and ending with a period**, for example \"person . face . dog .\"; translate the user's Chinese request into English yourself before passing it. The full tier's text tower is bert-base-uncased, whose vocabulary has no Chinese; Chinese input is split into [UNK] and returns boxes that **look valid but are actually noise** (measured: Chinese for \"monitor . chair .\" boxed the main subject of the picture with conf 0.44, pure guesswork). The light tier ignores prompt and only recognizes person and face, but echoes the prompt back unchanged. Parameters: mediaId required; times / prompt / force optional. The same media that was already measured is reused automatically (it reruns only if the prompt changed, force:true is passed, or the previous result came from the light tier and this call carries a prompt, since light cannot answer a prompt, so it is automatically re-measured and returns staleEngine:true). Use subject_status first to see which tier can run.",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        times: {
          type: "array",
          description: "Specify the sample times yourself (seconds within the media). If omitted, they are computed automatically per shot",
          items: { type: "number" }
        },
        prompt: { type: "string", description: "What to look for, **English noun phrases only**, separated by \" . \" and ending with a period, such as \"person . face . dog .\". Only takes effect in the full tier; Chinese is split into [UNK] and returns noise boxes" },
        force: { type: "boolean", description: "true means ignore existing results and detect again" }
      },
      required: ["mediaId"]
    },
    side: "page"
  },
  {
    name: "list_subjects",
    description: "Reads the subject detection result of a media item. Poll it after detect_subjects (returns running:true and a progress percentage while unfinished, and null if never detected). Returns engine (light / full), prompt, width/height (the coordinate system) and samples: each sample gives t (seconds within the media), boxes (label / x / y / w / h / conf, in **raw video pixels**, listing only the 4 largest by area, with boxCount the true count), occupancy (how much of the left half / right half / top 1/3 band / bottom 1/3 band is covered by people, 0~1), safeSide (the side with the least occupancy), suggestedPosition (safeSide converted to a value a card can use directly, **only left / right / bottom, never center**), **suggestedRect (the empty side given directly as a stage rectangle {x1,y1,x2,y2}; feed it to set_rect to place any card there, not limited by the card's position tiers, and usable even when safeSide is top; null when all four sides are occupied)** and suggestedOccupancy (how much of the chosen side is people). When suggestedPosition is null, look at warning: all four tiers are occupied by people, so at that moment there is no position that avoids people; shrink the card or change shot, and do not fall back to center, since center is exactly where the face is. Whether this value can be filled in is determined by the controls of list_cards({cardId}); if the card does not support it, switch to another card. At the top level there are also failedCount (the number of samples whose frame extraction failed; those samples carry failed:true and reason, and **it does not mean \"there is nobody in this frame\", so do not draw conclusions from it**) and fellBackFrom (full means the full tier was meant to run but fell back to light midway, so prompt did not take effect). **When arranging cards by shot you do not need to call this tool**, because list_shots has already folded these samples per shot; this one is for \"I want to see how many people are in the picture at a specific moment and where they are\". When engine is light, label can only be person or face; do not read \"no cat\" as there really being no cat in the picture.",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" }
      },
      required: ["mediaId"]
    },
    side: "page"
  },
  {
    name: "subject_status",
    description: "Checks which tier subject detection can run at; look before detecting. An engine of full means the full extension is installed (YuNet face + RT-DETR body + Grounding DINO open vocabulary, prompt takes effect, can find any noun); light means only the light tier is installed (YuNet + RT-DETR, recognizes only person and face, prompt has no effect); null means **neither tier is usable and there is no fallback tier**: do not pretend detection was done, and fall back to see_frames to look at the real picture for position and occlusion judgments. If the user wants it, install the light tier with subject_install (about 30 MB).",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "subject_install",
    description: "Installs the light tier of subject detection (onnxruntime, about 30 MB, around a minute). Once installed, the engine in subject_status becomes light and person and face can be recognized. It may exceed the call timeout, so it returns a jobId immediately; check that jobId with background_job_status, or use subject_status to see whether engine has changed. **Do not start it repeatedly**. Note two things: after the dependencies are installed, weight files (yunet.onnx / rtdetr_r18vd.onnx) may still be missing, and those come only if the user runs the .exe of the extension library pack, as the result will say; the full tier (Grounding DINO, 690 MB) is not installed online, ships only with the extension library pack, and this tool cannot install it.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "attach_clip_motion",
    description: "Binds a card to a motion trajectory so that it follows a target in the picture: this is the real use of motion tracking. First get a trajectory with track_points, then bind it with this tool; **no need to read the coordinates out**, the per-frame data flows directly inside the app. The card keeps the position you put it at and just moves along with the target. Parameters: clipId required (the card clip to follow, cannot be a media clip); mediaId required (which media the trajectory comes from); pointIndex defaults to 0 (as many trajectories as the points passed to track_points, numbered in the order passed); whenHidden defaults to hold (stay at the last seen position while the target is blocked) or hide (hide the whole card while the target is blocked). The card clip and that media clip must really overlap on the timeline, otherwise it errors: a card following a picture that is not playing at that moment is meaningless. The result carries movedX/movedY (displacement range) and visibleFrames, and gives a warning when the displacement is close to 0 or a large stretch is invisible.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        mediaId: { type: "string" },
        pointIndex: { type: "number", description: "Which trajectory, default 0" },
        whenHidden: { type: "string", enum: ["hold", "hide"], description: "Behavior while the target is blocked, default hold" }
      },
      required: ["clipId", "mediaId"]
    },
    side: "agent"
  },
  {
    name: "detach_clip_motion",
    description: "Removes the motion following of a card and returns it to a fixed position. Parameters: clipId required.",
    inputSchema: {
      type: "object",
      properties: { clipId: { type: "string" } },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "stt_status",
    description: "Queries the state of the speech recognition environment: Python version, whether each engine (faster-whisper / whisper) is installed, whether CUDA is available, and the list of downloaded models. Call this tool before transcribing or installing an engine to learn the current environment.",
    inputSchema: { type: "object", properties: {} },
    side: "page"
  },
  {
    name: "stt_install",
    description: "Installs the specified speech recognition engine (pip install into the user data directory). Because installation may exceed 60 seconds, this tool returns a jobId immediately; after calling, poll with stt_status until the target engine has installed=true. Parameters: engine (required, \"faster-whisper\" or \"whisper\").",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["faster-whisper", "whisper"] }
      },
      required: ["engine"]
    },
    side: "page"
  },
  {
    name: "transcribe_media",
    description: "Runs speech-to-text on the specified media file and writes the result to the project store. Because transcription may exceed 60 seconds, this tool returns a jobId immediately; poll the result with get_transcript (it is done once segments appear). When there are more than 200 segments, only the first 200 and total are returned. Parameters: mediaId (required); engine, model, language optional (defaults: faster-whisper / small / auto).",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" },
        engine: { type: "string", enum: ["faster-whisper", "whisper"] },
        model: { type: "string", enum: ["tiny", "base", "small", "medium", "large-v3"] },
        language: { type: "string", description: "Language code, such as zh/en; auto-detected if omitted" }
      },
      required: ["mediaId"]
    },
    side: "page"
  },
  {
    name: "get_transcript",
    description: "Reads the speech-to-text result of the specified media from the project store (engine, model, language, createdAt, segments). Can be used to poll the result after transcribe_media starts; returns null if unfinished.",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string" }
      },
      required: ["mediaId"]
    },
    side: "agent"
  },
  {
    name: "fill_captions",
    description: "Fill the lines of a caption-track captions card directly from a media transcript, trimmed and aligned by time locally; do not assemble `start|end|text` strings yourself. If clipId is omitted, the only captions card on the timeline is found automatically; if mediaId is omitted, the first media with a transcript is used. Returns how many lines were filled.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "Caption card to fill; must be specified when the timeline has several" },
        mediaId: { type: "string", description: "Source media of the transcript" },
        showEn: { type: "boolean", description: "Whether to show the English line, default false" }
      }
    },
    side: "agent"
  },
  {
    name: "list_captions",
    description: "List every caption in a caption card: index, start/end seconds (relative to the card start), absolute timeline seconds, text. Call it before editing captions to get the exact index. If clipId is omitted, the only caption card on the timeline is found automatically.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "clipId of the caption card; must be specified when the timeline has several" }
      }
    },
    side: "agent"
  },
  {
    name: "edit_caption",
    description: "Edit **a single** caption in a caption card: change the text, shift the time, change the duration, delete it, or insert one at a given place. Use fill_captions to refill everything; this tool is for single-caption tweaks such as \"caption 3 is wrong\" or \"this line should appear half a second later\". index is the index returned by list_captions (starting at 0, sorted by time). op: edit changes this caption (give at least one of text / start / end), remove deletes it, insert adds one at start (text required; errors if it does not fit in a free gap). start / end are seconds **relative to the caption card start**, consistent with what list_captions returns; times are clamped between the neighboring captions and never overlap others.",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "clipId of the caption card; must be specified when the timeline has several" },
        op: { type: "string", enum: ["edit", "remove", "insert"], description: "Default edit" },
        index: { type: "number", description: "Which caption (index from list_captions, starting at 0). Required for edit / remove" },
        text: { type: "string", description: "Text of this caption. Required for insert; words wrapped in *asterisks* are highlighted in the primary color" },
        en: { type: "string", description: "English line, may be left empty" },
        start: { type: "number", description: "Start second (relative to the caption card start). With edit, giving only start = shift the whole caption, length unchanged" },
        end: { type: "number", description: "End second (relative to the caption card start)" }
      }
    },
    side: "agent"
  }
];
