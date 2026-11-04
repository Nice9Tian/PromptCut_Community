import { startShotDetection, waitForShots } from "../../ai/shots";
import { installTrack, startTracking, trackStatus, waitForTrack } from "../../ai/track";
import { installSubject, startSubjectDetection, subjectStatus, waitForSubjects } from "../../ai/subject";
import { buildClipMotion } from "../../kernel/motion";
import { EditorApi } from "../../ai/mcpExecutor";
import { getState, actions } from "../../store/project";
import { validateCardParams } from "../../kernel/cardParams";
import { captionsFromTranscript, captionsOf, describeCaption, formatCaptions } from "../../kernel/captions";
import { mediaReadyForServer, perceptionMediaRef } from "../../ai/perceptionMedia";
import { findClip, subjectForRange, subjectSampleTimes, suggestPosition, MAX_SUBJECT_TIMES } from "../../kernel/project";
import { sttStatus, transcribeMedia } from "../../editor/io/stt";
import { runAutoWorkflow, getAutoWorkflowStatus } from "../tools/autoWorkflow";
import { getJob as getInstallJob } from "../../ai/sttInstallStore";
import { runSttInstall } from "../../editor/io/runSttInstall";

import {
  sttJobs, shotJobs,
  trackInstallJobs,
  trackJobs,
  trackResults,
  subjectJobs,
  subjectInstallJobs,
  findCaptionClip,
  topBoxes,
  subjectDigest
} from "../common";

export const aiHandlers = {

  // Shot detection: ~36 seconds for 5 minutes of media, likewise returns jobId immediately; results are polled with list_shots.
  detectShots: async (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    if (media.kind !== "video") throw new Error(`${media.name} is not a video, so there are no shots to split`);
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} is not in the asset service yet (upload incomplete or failed), try again later or re-import`);
    if (media.shots && !args.force) {
      return {
        reused: true, mediaId: args.mediaId, engine: media.shots.engine,
        shots: media.shots.shots.length, transitions: media.shots.transitions.length,
        hint: "This media has already been analyzed; use list_shots to get the result, or pass force:true to re-run",
      };
    }
    const jobId = await startShotDetection(perceptionMediaRef(media));
    shotJobs.set(args.mediaId, { jobId, percent: 0, engine: "scdet" });
    waitForShots(jobId, (percent, engine) => shotJobs.set(args.mediaId, { jobId, percent, engine }))
      .then((result) => {
        actions.setMediaShots(args.mediaId, result);
        shotJobs.delete(args.mediaId);
      })
      .catch((e: unknown) => {
        shotJobs.set(args.mediaId, {
          jobId, percent: 0, engine: "scdet",
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return {
      jobId, started: true, mediaId: args.mediaId,
      hint: "Shot detection has started in the background, poll this mediaId with list_shots",
    };
  },

  listShots: (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    const pending = shotJobs.get(args.mediaId);
    if (pending?.error) throw new Error(pending.error);
    if (!media.shots) {
      if (pending) return { running: true, percent: pending.percent, engine: pending.engine };
      return null;
    }
    // Each shot includes subject status in this interval. **This is the drop target for
    // the "do not occlude faces" path**: once the model gets suggestedPosition, it can
    // directly fill it into the card's position without guessing from images. If not detected
    // yet, it is null, with a hint in the response pointing to detect_subjects: without this
    // hint, the model would only see a bunch of subject: null and assume "there are no
    // people in this media".
    const subjectPending = subjectJobs.get(args.mediaId);
    return {
      running: false,
      engine: media.shots.engine,
      // When extensions are not installed, there are only hard cuts; this note must be visible to the model to keep it from assuming there really are no dissolves in the video
      engineNote: media.shots.engine === "scdet"
        ? "Currently using the ffmpeg scdet fallback, which only detects hard cuts and cannot detect gradual transitions such as dissolves"
        : "TransNetV2, recognizes both hard cuts and dissolves",
      shots: media.shots.shots.map((s) => ({
        ...s,
        subject: subjectDigest(subjectForRange(media.subjects, s.start, s.end)),
      })),
      transitions: media.shots.transitions.map(({ thumbs, ...rest }) => rest),
      // Order matters (measured during review):
      //   1. Last job failed: state this first regardless of whether old results exist.
      //      Failed jobs stay in the table; previously it kept returning "running (0%)", leading
      //      the model to poll a dead job indefinitely; when old results were present, it
      //      previously still returned success messages, inconsistent with the error policy
      //      of list_subjects.
      //   2. Job is running: when old results exist, clarify that the subject below is from
      //      an older batch.
      //   3. Not detected yet.
      //   4. Has results but every shot is null: frame extraction failed for the entire sample
      //      batch; this does not mean "there are no people in the frame".
      //   5. Has results.
      ...(subjectPending?.error
        ? {
            subjectHint: `Last subject detection failed: ${subjectPending.error}.`
              + (media.subjects ? "The subject of each shot below comes from an earlier successful batch, not this one." : "")
              + "First call subject_status and check engine: null means neither tier works on this machine (there is no fallback tier), "
              + "fall back to see_frames({ source: 'timeline', t }) and judge from the real frames where the person is, **do not keep polling this tool**; "
              + "Only when engine is not null is it worth calling detect_subjects with force:true to retry.",
          }
        : subjectPending
          ? {
              subjectHint: `Subject detection is running (${subjectPending.percent}%); once it finishes, call this tool again to see the people's positions in each shot`
                + (media.subjects ? "; the subject below is from the previous batch and will be replaced when the new batch finishes" : ""),
            }
          : !media.subjects
            ? {
                subjectHint: "These shots have not had subject detection yet, so every subject is null. To decide which side to put the card on, "
                  + "Don't cover people's faces; first call detect_subjects to get the people's positions.",
              }
            : media.shots.shots.every((s) => subjectForRange(media.subjects, s.start, s.end) === null)
              ? {
                  subjectEngine: media.subjects.engine,
                  subjectFailedCount: media.subjects.failedCount ?? 0,
                  subjectHint: `Subject detection finished, but none of the ${media.subjects.samples.length} samples in this batch is usable`
                    + " (all frame extractions failed, see subjectFailedCount), so every subject is null. This does not mean \"there is nobody in the frame\"."
                    + " Re-measure with detect_subjects by passing different times, or fall back to see_frames({ source: 'timeline', t }) and look at the image.",
                }
              : {
                  subjectEngine: media.subjects.engine,
                  ...(media.subjects.failedCount
                    ? { subjectFailedCount: media.subjects.failedCount }
                    : null),
                  ...(media.subjects.fellBackFrom
                    ? {
                        subjectFellBackFrom: media.subjects.fellBackFrom,
                        subjectFallbackNote: `Was meant to run the full tier but fell back to light midway: ${media.subjects.fallbackReason ?? "unknown reason"}.`
                          + "so the prompt has no effect, and label can only be person / face.",
                      }
                    : null),
                  subjectHint: "Each shot's subject.suggestedPosition can be filled directly into the card's params.position"
                    + "(it is only ever left / right / bottom, never center); boxes are the people's boxes in original video pixels."
                    + "suggestedPosition being null means all four slots are occupied by people (see suggestedOccupancy and warning),"
                    + "that shot has no position that avoids covering people, so don't force a fill."
                    + " Whether it can be filled is decided by the controls of list_cards({cardId}); if the card doesn't support this value, switch to another card,"
                    + "and don't fall back to the default center: center is exactly where the face is.",
                }),
    };
  },

  // Motion tracking: ~26 seconds for 250 frames, likewise returns jobId immediately;
  // results are polled with get_track.
  // Results are not written to the project document: query points are specified ad hoc
  // each time, and the same media clip can be tracked for many groups; stuffing them into
  // project would only bloat the project file indefinitely, so they are kept only in memory.
  trackPoints: async (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    if (media.kind !== "video") throw new Error(`${media.name} is not a video, there is no motion to track`);
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} is not in the asset service yet (upload incomplete or failed), try again later or re-import`);
    if (!Array.isArray(args.points) || args.points.length === 0) {
      throw new Error("points needs at least one point, written as [[frameNumber, x, y], ...]");
    }

    const jobId = await startTracking(perceptionMediaRef(media), args.points);
    trackJobs.set(args.mediaId, { jobId, percent: 0 });
    waitForTrack(jobId, (percent, engine) =>
      trackJobs.set(args.mediaId, { jobId, percent, engine }))
      .then((result) => {
        trackResults.set(args.mediaId, result);
        trackJobs.delete(args.mediaId);
      })
      .catch((e: unknown) => {
        trackJobs.set(args.mediaId, {
          jobId, percent: 0,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return {
      jobId, started: true, mediaId: args.mediaId, points: args.points.length,
      hint: "Motion tracking has started in the background, poll this mediaId with get_track",
      // Whether the extension is installed determines which tier is used, and also
      // determines how long to wait: for the same 250 frames, the neural network tier
      // takes ~26 seconds, while template matching takes ~1 second.
      engineHint: "Which tier is running is only known once the result is out, see engine returned by get_track",
    };
  },

  /**
   * By default only returns a summary, not frame-by-frame coordinates.
   *
   * For a 30-second 30fps video, each point has 900 sets of coordinates: emitting them raw
   * to the model costs tens of thousands of tokens, and the model typically does not need
   * them at all: to make a card follow along, call attach_clip_motion; data flows directly
   * within the application without needing to round-trip through the model. full:true is
   * an escape hatch reserved for when "the model really needs to compute something itself",
   * not the default path.
   */
  getTrack: (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    const pending = trackJobs.get(args.mediaId);
    if (pending?.error) throw new Error(pending.error);
    const result = trackResults.get(args.mediaId);
    if (!result) {
      if (pending) return { running: true, percent: pending.percent, engine: pending.engine };
      return null;
    }
    const head = {
      running: false,
      engine: result.engine,
      // The downgraded tier must be visible to the model; otherwise it will make judgments using coarse template matching results as exact data
      engineNote: result.engine === "bootstapir"
        ? "BootsTAPIR, arbitrary point tracking; visible being false means the point is occluded or out of frame in that frame"
        : "Currently using the template matching fallback (motion tracking extension not installed). Rigid targets with clear texture that don't turn can be tracked very accurately,"
          + "but once the target turns, scales or is occluded for a long time, tracking is lost; a point with a note field means it could not be tracked at all",
      width: result.width,
      height: result.height,
      frames: result.frames,
    };
    if (args.full) return { ...head, points: result.points };
    return {
      ...head,
      points: result.points.map((p, i) => {
        const vis = p.visible.filter(Boolean).length;
        const xs = p.xy.map((q) => q[0]);
        const ys = p.xy.map((q) => q[1]);
        return {
          index: i,
          query: p.query,
          visibleFrames: vis,
          totalFrames: p.visible.length,
          // Displacement range: close to 0 indicates the target barely moved, so attaching it will not produce visible effects
          movedX: Math.round(Math.max(...xs) - Math.min(...xs)),
          movedY: Math.round(Math.max(...ys) - Math.min(...ys)),
          from: p.xy[0]?.map((v) => Math.round(v)),
          to: p.xy[p.xy.length - 1]?.map((v) => Math.round(v)),
          ...(p.note ? { note: p.note } : {}),
        };
      }),
      hint: "Only a summary was returned. To make a card follow a point, call attach_clip_motion (no need to read out the coordinates);"
        + "if you really need per-frame coordinates, pass full:true, but that will be a very long list of numbers.",
    };
  },

  trackStatus: async () => {
    const s = await trackStatus();
    return {
      ...s,
      hint: s.engine === "bootstapir"
        ? "Extension installed, using BootsTAPIR."
        : s.engine === "template"
          ? "Extension not installed, using the template matching fallback: it can track, but loses the target when it turns, deforms or is occluded for a long time."
            + " If the user wants more stable results, install the extension with track_install (about 400 MB)."
          : "Neither tier is usable (usually Python can't be found), so tracking is not possible on this machine.",
    };
  },

  // A 400 MB download far exceeds the MCP bridge call timeout, so jobId is returned immediately.
  trackInstall: async () => {
    const jobId = `track-${Date.now().toString(36)}`;
    trackInstallJobs.set(jobId, { done: false, ok: false, logTail: [] });
    void installTrack((line) => {
      const job = trackInstallJobs.get(jobId);
      if (job) job.logTail = [...job.logTail, line].slice(-20);
    })
      .then(({ ok }) => {
        const job = trackInstallJobs.get(jobId);
        trackInstallJobs.set(jobId, { done: true, ok, logTail: job?.logTail ?? [] });
      })
      .catch((e: unknown) => {
        const job = trackInstallJobs.get(jobId);
        trackInstallJobs.set(jobId, {
          done: true, ok: false,
          error: e instanceof Error ? e.message : String(e),
          logTail: job?.logTail ?? [],
        });
      });
    return {
      jobId, started: true,
      hint: "The motion tracking extension is installing in the background (torch + weights, about 400 MB, takes a few minutes)."
        + " Check this jobId with background_job_status, or use track_status to see whether engine has become bootstapir. Do not start it again.",
    };
  },

  // ── Subject detection ────────────────────────────────────────────────
  // The standard approach for requirements like "Don't let cards cover people's faces": sample a few
  // frames to see where people are and which side is empty, and fold the results by shot into
  // suggestedPosition in list_shots.

  /**
   * Frame-sampling detection. Sampling times are calculated by shot by default (20%/50%/80% per
   * shot, midpoint only for short shots); if shot detection has not been run, sample every 2 seconds:
   * see sampleTimesFor.
   *
   * Results are written to the project document and reused by default for the same asset; pass
   * force:true to re-test. A changed prompt is also treated as requiring a re-test: the prompt
   * changed, and the previous batch of results did not include that category at all.
   */
  detectSubjects: async (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    if (media.kind === "audio") throw new Error(`${media.name} is audio, there is no picture to view`);
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} is not in the asset service yet (upload incomplete or failed), try again later or re-import`);

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    const promptChanged = !!media.subjects && prompt !== (media.subjects.prompt ?? "");
    // Reuse cannot just compare prompt strings; it must also check whether stored results
    // **are capable of** answering this prompt. Results run with a prompt on the light tier can only
    // have person/face labels; if the user later installs the full extension package and asks the same
    // prompt again, comparing only strings still gives reused:true + engine light, and the model then
    // continues using a result that never looked for cats to answer "there is no cat in the frame".
    // However, it also depends on **whether this machine can currently** run full. On a machine with
    // only light installed, stored results are light and it can currently only run light, making
    // re-tests pointless: if we only checked the stored result's tier, each query with the same prompt
    // would trigger a full re-test every time, and the model would loop in "re-test → still light →
    // re-test again" (verified in testing). Therefore subjectStatus is checked ahead of time here:
    // the reuse criteria and the subsequent ETA calculation share this single check.
    const st = await subjectStatus().catch(() => null);
    const staleEngine = !!media.subjects && !!prompt
      && media.subjects.engine !== "full" && st?.engine === "full";
    if (media.subjects && !args.force && !promptChanged && !staleEngine) {
      const cannotAnswerPrompt = !!prompt && media.subjects.engine !== "full";
      return {
        reused: true, mediaId: args.mediaId, engine: media.subjects.engine,
        samples: media.subjects.samples.length,
        failedCount: media.subjects.failedCount ?? 0,
        prompt: media.subjects.prompt,
        ...(cannotAnswerPrompt
          ? { engineNote: "The existing result was produced by the light tier, label is only person / face, and it can't answer other nouns in the prompt;"
              + "this machine can only run light right now, so it was not re-measured. After installing the full extension pack, pass force:true to re-measure." }
          : null),
        hint: "This media has already been detected. Use list_subjects to get the result, or list_shots to see each shot's suggestedPosition; to re-detect, pass force:true",
      };
    }

    // The upper limit is clamped in the kernel (MAX_SUBJECT_TIMES, the same constant as the server).
    // Comparing against "how many points would be scheduled without limits" shows whether precision
    // was degraded this time: if degraded, state it explicitly, otherwise the model will treat a
    // thinned-out conclusion as full precision.
    const autoRaw = subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length;
    const times = Array.isArray(args.times) && args.times.length > 0
      ? args.times.map(Number).filter((t) => Number.isFinite(t) && t >= 0)
      : subjectSampleTimes(media);
    if (times.length === 0) throw new Error("Cannot compute sample times, the media may have no duration info; you can pass times yourself");
    const sampledNote = !args.times && autoRaw > times.length
      ? `Media is long or shots are fragmented, sampling was reduced from ${autoRaw} points to ${times.length} points`
        + `(limit ${MAX_SUBJECT_TIMES}); shot-level conclusions will be coarser, and more shots will have approximate set to true.`
      : undefined;

    // Use the engine found by the reuse criteria check above: let the model know which tier is running
    // and roughly how long to wait before polling. The two tiers differ by an order of magnitude
    // (measured light ~0.5 s/frame, full ~3 s/frame); polling at the same pace either asks dozens of
    // times for nothing or leaves it waiting with no clue. Not finding it is not an error; pass
    // undefined.
    const engine = st?.engine ?? null;
    const msPerFrame = engine === "full" ? 3000 : engine === "light" ? 500 : 0;
    const etaSeconds = engine ? Math.ceil((times.length * msPerFrame) / 1000) + 5 : undefined;

    const jobId = await startSubjectDetection(perceptionMediaRef(media), times, prompt || undefined);
    // Old error records must be cleared first: if not cleared, the new job gets contaminated with the
    // previous failure state, and list_shots will hold onto an old error and report "previous subject
    // detection failed".
    subjectJobs.delete(args.mediaId);
    subjectJobs.set(args.mediaId, { jobId, percent: 0 });
    waitForSubjects(jobId, (percent, engine) =>
      subjectJobs.set(args.mediaId, { jobId, percent, engine }))
      .then((result) => {
        actions.setMediaSubjects(args.mediaId, result);
        subjectJobs.delete(args.mediaId);
      })
      .catch((e: unknown) => {
        subjectJobs.set(args.mediaId, {
          jobId, percent: 0,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return {
      jobId, started: true, mediaId: args.mediaId,
      samples: times.length,
      sampledFrom: media.shots ? "By shot (20%/50%/80% of each shot)" : "One point every 2 seconds (shot detection has not been run on this media)",
      ...(sampledNote ? { sampledNote } : null),
      engine,
      ...(etaSeconds ? { etaSeconds } : null),
      ...(staleEngine
        ? { staleEngine: true, engineNote: "The previous batch of results was produced with the light tier and cannot answer the prompt, so this run re-detected (not reused)" }
        : null),
      hint: "Subject detection has started in background mode, poll that mediaId with list_subjects; "
        + (etaSeconds
          ? `Estimated about ${etaSeconds} seconds (engine=${engine}, measured: light about 0.5 s/frame, full about 3 s/frame).`
            + `${engine === "full" ? "the full tier is slow, asking once every 10 seconds is enough" : "asking once every 3 seconds is enough"}, do not ask every second.`
          : "engine being null means neither tier is usable and this job will most likely fail; call subject_status first to confirm.")
        + "After it finishes, each shot from list_shots will carry subject and suggestedPosition.",
    };
  },

  listSubjects: (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    const pending = subjectJobs.get(args.mediaId);
    if (pending?.error) throw new Error(pending.error);
    // If a job is running, report that it is running first: even if the previous batch of results is
    // still on hand. Previously it was "return old results directly if available", so during a re-test
    // with a changed prompt the model read samples from the old prompt and assumed the new one had
    // already finished (verified in testing).
    if (pending) {
      return {
        running: true, percent: pending.percent, engine: pending.engine,
        ...(media.subjects
          ? { stale: true, staleNote: "The previous batch of results is still there, but a new detection is running, so no samples are given here; call this tool again after it finishes" }
          : null),
      };
    }
    if (!media.subjects) return null;
    const s = media.subjects;
    return {
      running: false,
      engine: s.engine,
      // Which tier it is determines what can appear in labels. If not stated clearly, the model will
      // interpret the light tier's "only person/face" as "there is no cat in the frame".
      engineNote: s.engine === "full"
        ? "Grounding DINO. The label is the noun in the prompt; when the prompt is empty it searches for person . face ."
        : "The light tier of YuNet + RT-DETR. It only recognizes person and face; the prompt has no effect (it is echoed back unchanged in prompt)",
      ...(s.fellBackFrom
        ? {
            fellBackFrom: s.fellBackFrom,
            fallbackNote: `Was meant to run the full tier but fell back to light midway: ${s.fallbackReason ?? "unknown reason"}.`
              + "so the prompt has no effect, and label can only be person / face.",
          }
        : null),
      prompt: s.prompt,
      width: s.width,
      height: s.height,
      // Report the count of frame-sampling failures separately. In JSON, they are field-by-field
      // identical to "there is really no person in this frame" (empty boxes, four 0s in occupancy);
      // if not pointed out, the model will interpret "failed to sample" as "no person".
      failedCount: s.failedCount ?? s.samples.filter((sm) => sm.failed).length,
      samples: s.samples.map((sm) => ({
        t: sm.t,
        ...(sm.failed
          ? { failed: true, reason: sm.reason ?? "This frame could not be extracted", boxes: [], boxCount: 0 }
          : {
              safeSide: sm.safeSide,
              ...suggestPosition(sm.safeSide, sm.occupancy),
              occupancy: sm.occupancy,
              boxes: topBoxes(sm.boxes),
              boxCount: sm.boxes.length,
            }),
      })),
      hint: "Coordinates are in original video pixels (the same system as width/height). To arrange cards by shot, look at list_shots directly,"
        + "where each shot has already folded these samples together. suggestedPosition can be filled directly into the card's params.position"
        + "(it is only ever left / right / bottom, never center); null means all four slots are occupied by people,"
        + "see suggestedOccupancy and warning; at that moment there is no position that avoids covering people."
        + " A sample with failed set to true is a frame extraction failure, not \"no person in this frame\"; don't draw conclusions from it.",
    };
  },

  subjectStatus: async () => {
    const s = await subjectStatus();
    return {
      ...s,
      hint: s.engine === "full"
        ? "full tier: YuNet + RT-DETR + Grounding DINO, can find targets from any text prompt (prompt takes effect)."
        : s.engine === "light"
          ? "light tier: YuNet (face) + RT-DETR (body), only recognizes person and face, prompt has no effect."
            + " To find targets by arbitrary words (cat, phone, red car), you need to install the full tier extension pack."
          // There is no fallback tier here, unlike motion tracking: the model must not be led to believe a
          // downgraded engine is running.
          : "Neither tier is usable, so subject detection is not possible on this machine."
            + " For position and occlusion judgments, fall back to looking at the images with see_frames; don't guess \"the person is on the left\" out of thin air."
            + " If the user wants it, install the light tier with subject_install (about 30 MB).",
    };
  },

  // What is installed online is the light tier (onnxruntime, ~30 MB). The full tier is torch +
  // transformers plus 690 MB weights and is only distributed with the extension library package; if
  // an online install is interrupted once, it has to start over from scratch.
  subjectInstall: async () => {
    const jobId = `subject-${Date.now().toString(36)}`;
    subjectInstallJobs.set(jobId, { done: false, ok: false, logTail: [] });
    void installSubject((line) => {
      const job = subjectInstallJobs.get(jobId);
      if (job) job.logTail = [...job.logTail, line].slice(-20);
    })
      .then(({ ok }) => {
        const job = subjectInstallJobs.get(jobId);
        subjectInstallJobs.set(jobId, { done: true, ok, logTail: job?.logTail ?? [] });
      })
      .catch((e: unknown) => {
        const job = subjectInstallJobs.get(jobId);
        subjectInstallJobs.set(jobId, {
          done: true, ok: false,
          error: e instanceof Error ? e.message : String(e),
          logTail: job?.logTail ?? [],
        });
      });
    return {
      jobId, started: true,
      hint: "Subject detection light tier is installing in the background (onnxruntime, about 30 MB)."
        + " Check this jobId with background_job_status, or use subject_status to see whether engine has become light. Do not start it again."
        + " After installing, the weight files (yunet.onnx / rtdetr_r18vd.onnx) may still be missing; those only come from running the extension pack's .exe.",
    };
  },

  /**
   * Bind a card to a track trajectory so it follows a target in the video.
   *
   * This is the true drop target of tracking: before this, tracked coordinates were just a string
   * of numbers with nothing consuming them.
   *
   * Data does not pass through the model: the model only says "clip X follows point 0", and
   * frame-by-frame coordinates are written directly from trackResults into clip inside the
   * application. Having the model read in 900 sets of coordinates and write them back would burn
   * context and inevitably produce errors.
   */
  attachClipMotion: (args) => {
    const p = getState().project;
    const hit = findClip(p, args.clipId);
    if (!hit) throw new Error(`Clip ${args.clipId} not found`);
    if (!hit.clip.cardId) throw new Error(`${args.clipId} is a media clip, not a card clip, so "following" doesn't apply to it`);

    const media = p.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);

    const result = trackResults.get(args.mediaId);
    if (!result) {
      throw new Error(trackJobs.get(args.mediaId)
        ? `Tracking for ${media.name} has not finished, use get_track to wait for its result first`
        : `${media.name} has not been tracked yet, call track_points first`);
    }
    const idx = args.pointIndex ?? 0;
    const point = result.points[idx];
    if (!point) throw new Error(`This tracking has only ${result.points.length} points, no point number ${idx}`);
    if (point.note) throw new Error(`Point ${idx} failed to track: ${point.note}`);

    // Which asset clip the visuals come from: it must genuinely overlap in time with the card,
    // otherwise the card will follow video that was not even playing at that point.
    const source = p.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.mediaId === args.mediaId)
      .find((c) => c.start < hit.clip.end && c.end > hit.clip.start);
    if (!source) {
      throw new Error(`No segment of ${media.name} on the timeline overlaps this card in time: `
        + `the card is placed at ${hit.clip.start.toFixed(2)}~${hit.clip.end.toFixed(2)}s, and this media is not on screen during that time`);
    }

    const built = buildClipMotion({
      xy: point.xy,
      visible: point.visible,
      media: {
        id: media.id,
        width: media.width ?? 0,
        height: media.height ?? 0,
        duration: media.duration ?? 0,
      },
      stage: { width: p.width, height: p.height },
      card: { start: hit.clip.start, end: hit.clip.end },
      clipOfMedia: { start: source.start, mediaOffset: source.mediaOffset ?? 0, ...(source.speed !== undefined ? { speed: source.speed } : {}) },
      pointIndex: idx,
      whenHidden: args.whenHidden === "hide" ? "hide" : "hold",
    });

    if (!actions.setClipMotion(args.clipId, built.motion)) {
      throw new Error(`Binding failed: cannot write to clip ${args.clipId}`);
    }

    const { frames, visibleFrames, rangeX, rangeY } = built.summary;
    return {
      ok: true,
      clipId: args.clipId,
      mediaId: args.mediaId,
      pointIndex: idx,
      engine: result.engine,
      frames,
      visibleFrames,
      movedX: rangeX,
      movedY: rangeY,
      whenHidden: built.motion.whenHidden,
      // The two cases of "bound but does nothing" must be called out on the spot, rather than letting the
      // user discover them in preview
      ...(rangeX < 2 && rangeY < 2
        ? { warning: "This point barely moves (displacement under 2 pixels), so binding to it would show no visible follow effect" }
        : {}),
      ...(visibleFrames < frames * 0.5
        ? { warning2: `The target is not visible in more than half of the frames (${frames - visibleFrames}/${frames}), `
            + `the follow will stall for long stretches${built.motion.whenHidden === "hide" ? " or the whole card will disappear" : ""}` }
        : {}),
    };
  },

  detachClipMotion: (args) => {
    const hit = findClip(getState().project, args.clipId);
    if (!hit) throw new Error(`Clip ${args.clipId} not found`);
    if (!hit.clip.motion) return { ok: true, clipId: args.clipId, changed: false, hint: "This card had no track bound to begin with" };
    actions.setClipMotion(args.clipId, undefined);
    return { ok: true, clipId: args.clipId, changed: true };
  },
  autoWorkflow: (args) => runAutoWorkflow(args),
  autoWorkflowStatus: (args) => getAutoWorkflowStatus(args),

  sttStatus: () => sttStatus(),

  // Installation may far exceed the MCP bridge's 60-second call timeout, so return jobId immediately
  // and let AI poll engines.<engine>.installed via stt_status to determine whether installation is
  // complete.
  sttInstall: async (args) => {
    // Follows the same path as the missing-dependency prompt at startup (including mutex for "only one
    // installation allowed at a time"), so regardless of who initiated it, the progress control on the
    // UI behaves completely consistently.
    const { jobId, engine, finished } = runSttInstall(args.engine || "faster-whisper");
    sttJobs.set(jobId, { done: false, ok: false, logTail: [] });
    finished.then(({ ok, error }) => {
      const job = getInstallJob(jobId);
      sttJobs.set(jobId, { done: true, ok, error, logTail: job?.logTail.slice(-20) ?? [] });
    });
    return {
      jobId, started: true, engine,
      hint: "Installation has started in the background, and the user interface will show an install animation with progress. Check this jobId with background_job_status, or use stt_status to see the engine's installed field. Do not start it again.",
    };
  },

  // Likewise: transcription typically exceeds 60 seconds; return jobId immediately and poll for
  // results using get_transcript.
  transcribeMedia: async (args) => {
    const jobId = `stt-${args.mediaId}-${Date.now().toString(36)}`;
    transcribeMedia(args.mediaId, { engine: args.engine, model: args.model, language: args.language })
      .then((t) => { sttJobs.set(jobId, { done: true, ok: true, segments: t.segments.length }); })
      .catch((e: unknown) => {
        sttJobs.set(jobId, { done: true, ok: false, error: e instanceof Error ? e.message : String(e) });
      });
    sttJobs.set(jobId, { done: false, ok: false });
    return { jobId, started: true, mediaId: args.mediaId, hint: "Transcription has started in the background, poll this mediaId with get_transcript" };
  },

  getTranscript: (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    const t = media.transcript;
    if (!t) return null;
    // Contract: when exceeding 200 segments, return only the first 200 segments + total count
    if (t.segments.length > 200) {
      return { ...t, segments: t.segments.slice(0, 200), total: t.segments.length, truncated: true };
    }
    return { ...t, total: t.segments.length, truncated: false };
  },
  /**
   * Feed the asset transcript directly into a caption card.
   *
   * Caption content is pure transfer; having the model retype dozens or hundreds of
   * `start|end|text` entries one by one is expensive and prone to mismatched lines, wrong
   * timestamps, and missed segments. Here it is computed locally in one pass: the model only needs
   * to say "caption this segment", and it receives already-filled results.
   */
  fillCaptions: (args) => {
    const project = getState().project;
    const media = args.mediaId
      ? project.media.find((m) => m.id === args.mediaId)
      : project.media.find((m) => m.transcript && m.transcript.segments.length > 0);
    if (!media) throw new Error(args.mediaId ? `Asset ${args.mediaId} not found` : "No transcribed media in the media library; transcribe first with transcribe_media.");
    const segments = media.transcript?.segments;
    if (!segments || segments.length === 0) throw new Error(`Media "${media.name}" has no transcript yet. Transcribe it with transcribe_media first.`);

    // If no clip is specified, find the sole caption card on the timeline; when there are multiple,
    // require clarifying which one
    let clipId = args.clipId;
    if (!clipId) {
      const hits = project.tracks.flatMap((t) => t.clips.filter((c) => (c as { cardId?: string }).cardId === "caption-track"));
      if (hits.length === 0) throw new Error("There is no caption-track card on the timeline. Create one with add_clip first, or pass clipId directly.");
      if (hits.length > 1) throw new Error(`There are ${hits.length} captions cards on the timeline, specify which one with clipId: ${hits.map((c) => c.id).join(", ")}`);
      clipId = hits[0].id;
    }
    const hit = findClip(project, clipId);
    if (!hit) throw new Error(`clip ${clipId} not found`);
    const clip = hit.clip as { start: number; end: number; cardId?: string };
    if (clip.cardId !== "caption-track") throw new Error(`clip ${clipId} is ${clip.cardId}, not a captions card.`);

    /*
     * Seconds in the transcript are **within the asset**; they must first be converted based on this
     * asset's position on the timeline (if the asset was moved to second 30, or the beginning was
     * trimmed, captions will be misaligned overall without conversion), then subtract the caption
     * card's start point to become relative seconds. Segments extending beyond the card are cropped
     * within bounds, preventing captions from lighting up early or failing to disappear outside
     * the card.
     */
    const placed = project.tracks.flatMap((t) => t.clips);
    const plan = captionsFromTranscript(placed, media.id, segments, { from: clip.start, to: clip.end });
    if (plan.lines.length === 0) {
      const onTimeline = placed.some((c) => c.mediaId === media.id);
      throw new Error(
        onTimeline
          ? `The transcript has no segments within this card's time range (${clip.start}s-${clip.end}s). Check the clip's start and end times.`
          : `Media "${media.name}" is not on the timeline yet, so captions can't be aligned to time. Place it with add_clip first.`,
      );
    }

    const kept = plan.lines;
    const params = { lines: formatCaptions(kept), showEn: args.showEn === true ? "true" : "false" };
    validateCardParams("caption-track", params, (hit.clip as { params?: Record<string, unknown> }).params);
    actions.setClipParams(clipId, params);
    return { clipId, mediaId: media.id, lines: kept.length, from: clip.start, to: clip.end };
  },
  /**
   * Exactly which entries are in the caption card: index + relative seconds + absolute seconds
   * + text. Check this before editing captions; index is based on this (sorted by time, matching
   * the order drawn on the timeline).
   */
  listCaptions: (args) => {
    const hit = findCaptionClip(args.clipId);
    const clip = hit.clip as { start: number; end: number; params?: Record<string, unknown> };
    const lines = captionsOf(clip);
    return {
      clipId: hit.clip.id,
      from: clip.start,
      to: clip.end,
      count: lines.length,
      captions: lines.map((l, index) => ({
        index,
        start: l.start,
        end: l.end,
        // Relative seconds are easily confused with timeline seconds, so both are provided
        absStart: clip.start + l.start,
        absEnd: clip.start + l.end,
        text: l.zh,
        ...(l.en ? { en: l.en } : {}),
      })),
    };
  },
  /**
   * Add, delete, and edit individual captions. Refilling the entire set goes through fill_captions;
   * this is for cases like "item 3 is wrong".
   *
   * Timing is clamped between left and right neighbors by kernel/captions, so an out-of-bounds
   * second written by the Agent will not create two captions contending for the same second: it will
   * snap to the edge, and the response tells it where it actually landed.
   */
  editCaption: (args) => {
    const hit = findCaptionClip(args.clipId);
    const clipId = hit.clip.id;
    const op = args.op ?? "edit";

    if (op === "remove") {
      if (args.index == null) throw new Error("remove requires index (the index in list_captions)");
      const lines = captionsOf(hit.clip as { params?: Record<string, unknown> });
      const gone = lines[args.index];
      if (!gone) throw new Error(`This captions card has only ${lines.length} entries, no entry ${args.index}`);
      if (!actions.removeCaption(clipId, args.index)) throw new Error("Failed to delete");
      return { clipId, removed: describeCaption(gone, args.index), count: lines.length - 1 };
    }

    if (op === "insert") {
      if (args.start == null) throw new Error("insert requires start (seconds relative to the captions card start)");
      if (!args.text) throw new Error("insert requires text");
      const at = actions.addCaption(clipId, { start: args.start, end: args.end, zh: args.text, en: args.en });
      if (at < 0) throw new Error(`No gap near ${args.start}s is large enough. Use list_captions to see where the free gaps are, or shorten the neighboring entry.`);
      const now = captionsOf(findCaptionClip(clipId).clip as { params?: Record<string, unknown> });
      return { clipId, index: at, caption: describeCaption(now[at], at), count: now.length };
    }

    if (args.index == null) throw new Error("edit requires index (the index in list_captions)");
    if (args.text === undefined && args.en === undefined && args.start === undefined && args.end === undefined) {
      throw new Error("edit requires at least one of text / en / start / end");
    }
    const at = actions.editCaption(clipId, args.index, {
      start: args.start,
      end: args.end,
      zh: args.text,
      en: args.en,
    });
    if (at < 0) throw new Error(`Can't edit entry ${args.index}. Use list_captions to confirm the index`);
    const now = captionsOf(findCaptionClip(clipId).clip as { params?: Record<string, unknown> });
    return { clipId, index: at, caption: describeCaption(now[at], at), count: now.length };
  },
} satisfies Partial<EditorApi>;
