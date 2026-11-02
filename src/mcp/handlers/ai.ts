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

  // 镜头识别:5 分钟素材约 36 秒,同样立刻返回 jobId,结果用 list_shots 轮询。
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
    // 每个镜头带上这段区间里的主体情况。**这是「别遮住人脸」那条路的落点**:
    // 模型拿到 suggestedPosition 就能直接填进卡片的 position,不用靠看图猜。
    // 没检测过就是 null,并在返回里给一句 hint 指向 detect_subjects ——
    // 不给这句的话模型只会看到一堆 subject: null,以为「这素材里没有人」。
    const subjectPending = subjectJobs.get(args.mediaId);
    return {
      running: false,
      engine: media.shots.engine,
      // 没装拓展时只有硬切,这一句要让模型看见,免得它以为片子里真的没有溶解
      engineNote: media.shots.engine === "scdet"
        ? "Currently using the ffmpeg scdet fallback, which only detects hard cuts and cannot detect gradual transitions such as dissolves"
        : "TransNetV2, recognizes both hard cuts and dissolves",
      shots: media.shots.shots.map((s) => ({
        ...s,
        subject: subjectDigest(subjectForRange(media.subjects, s.start, s.end)),
      })),
      transitions: media.shots.transitions.map(({ thumbs, ...rest }) => rest),
      // 顺序有讲究(复查实测):
      //   1. 上次作业失败 —— 不管手里有没有旧结果都先说。失败的作业留在表里,以前会一直回
      //      「正在跑(0%)」,模型照着无限轮询一个死掉的作业;有旧结果时以前还会回成功那套话,
      //      和 list_subjects 抛错的口径对不上。
      //   2. 作业在跑 —— 有旧结果时下面的 subject 是旧批次的,要说明。
      //   3. 没检测过。
      //   4. 有结果但每个镜头都是 null —— 整批采样全抽帧失败,这不是「画面里没有人」。
      //   5. 有结果。
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
                    + "Re-measure with detect_subjects by passing different times, or fall back to see_frames({ source: 'timeline', t }) and look at the image.",
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
                    + "Whether it can be filled is decided by the controls of list_cards({cardId}); if the card doesn't support this value, switch to another card,"
                    + "and don't fall back to the default center: center is exactly where the face is.",
                }),
    };
  },

  // 运动追踪:250 帧约 26 秒,同样立刻返回 jobId,结果用 get_track 轮询。
  // 结果不写进项目文档——查询点是每次现指的,同一段素材能追很多组,
  // 塞进 project 只会让工程文件无限膨胀,所以只留在内存里。
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
      // 装没装拓展决定用哪一档,也决定要等多久:同样 250 帧,
      // 神经网络档约 26 秒,模板匹配约 1 秒。
      engineHint: "Which tier is running is only known once the result is out, see engine returned by get_track",
    };
  },

  /**
   * 默认只回摘要,不回逐帧坐标。
   *
   * 一段 30 秒 30fps 的片子,每个点是 900 组坐标 —— 原样吐给模型是好几万
   * token,而模型通常根本不需要它们:要让卡片跟着走就调 attach_clip_motion,
   * 数据在应用内部直接流转,不必绕模型一圈。full:true 是留给「模型真的要
   * 自己算点什么」的口子,不是默认路径。
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
      // 降级档要让模型看见,否则它会拿模板匹配的粗结果当准数据下判断
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
          // 位移范围:接近 0 说明目标基本没动,绑上去也看不出效果
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
            + "If the user wants more stable results, install the extension with track_install (about 400 MB)."
          : "Neither tier is usable (usually Python can't be found), so tracking is not possible on this machine.",
    };
  },

  // 400 MB 的下载,远超 MCP 桥的调用超时,所以立刻返回 jobId。
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
        + "Check this jobId with background_job_status, or use track_status to see whether engine has become bootstapir. Do not start it again.",
    };
  },

  // ── 主体检测 ────────────────────────────────────────────────
  // 「别让卡片遮住人物的脸」这类要求的正路:抽几帧看人在哪、哪边是空的,
  // 结果按镜头折进 list_shots 的 suggestedPosition。

  /**
   * 抽帧检测。采样时刻默认按镜头算(每镜头 20%/50%/80%,短镜头只取中点),
   * 没做过镜头识别就每 2 秒一点 —— 见 sampleTimesFor。
   *
   * 结果写进项目文档,同一素材默认复用,要重测才传 force:true。
   * 换了 prompt 也当成要重测:提示词变了,上一批结果里根本没有那个类别。
   */
  detectSubjects: async (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`Asset ${args.mediaId} not found`);
    if (media.kind === "audio") throw new Error(`${media.name} is audio, there is no picture to view`);
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} is not in the asset service yet (upload incomplete or failed), try again later or re-import`);

    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    const promptChanged = !!media.subjects && prompt !== (media.subjects.prompt ?? "");
    // 复用不能只比 prompt 字符串,还要看已存结果**有没有能力**回答这个 prompt。
    // light 档带 prompt 跑出来的结果 label 只可能是 person/face;用户之后装上
    // full 拓展包再问同一句,只比字符串的话仍然 reused:true + engine light,
    // 模型于是继续拿一份根本没找过猫的结果回答「画面里没有猫」。
    // 但还要看**这台机器现在**能不能跑到 full。只装了 light 的机器上,已存结果是 light、
    // 现在也只能跑出 light,重测毫无意义 —— 只看已存结果的档位的话,同一句 prompt 每问
    // 一次全量重测一次,模型会「重测→还是 light→再重测」地绕圈(复查实测)。
    // 所以 subjectStatus 提前到这里查:复用判据和后面算 ETA 共用这一次。
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

    // 上限夹在 kernel 里(MAX_SUBJECT_TIMES,和服务端同一个常数)。
    // 拿「不设限时会排出多少点」一比,就知道这次降没降精度 —— 降过要说出来,
    // 不然模型会拿一份被抽稀过的结论当满精度用。
    const autoRaw = subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length;
    const times = Array.isArray(args.times) && args.times.length > 0
      ? args.times.map(Number).filter((t) => Number.isFinite(t) && t >= 0)
      : subjectSampleTimes(media);
    if (times.length === 0) throw new Error("Cannot compute sample times, the media may have no duration info; you can pass times yourself");
    const sampledNote = !args.times && autoRaw > times.length
      ? `Media is long or shots are fragmented, sampling was reduced from ${autoRaw} points to ${times.length} points`
        + `(limit ${MAX_SUBJECT_TIMES}); shot-level conclusions will be coarser, and more shots will have approximate set to true.`
      : undefined;

    // engine 用上面复用判据查到的那一次:轮询之前就让模型知道跑的是哪一档,以及大概要等多久。
    // 两档差一个数量级(实测 light 约 0.5 s/帧、full 约 3 s/帧),按同一个节奏
    // 轮询的话不是白问几十次就是等得莫名其妙。查不到不算错,给 undefined。
    const engine = st?.engine ?? null;
    const msPerFrame = engine === "full" ? 3000 : engine === "light" ? 500 : 0;
    const etaSeconds = engine ? Math.ceil((times.length * msPerFrame) / 1000) + 5 : undefined;

    const jobId = await startSubjectDetection(perceptionMediaRef(media), times, prompt || undefined);
    // 旧的 error 记录要先清掉:不清的话新作业和上一次的失败状态串味,
    // list_shots 会拿着一条陈年错误报「上次主体检测失败」。
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
    // 有作业在跑就先报在跑 —— 哪怕手里还有上一批结果。以前是「有旧结果就直接回旧结果」,
    // 换了 prompt 重测期间模型读到的是旧 prompt 的样本,还以为新的已经跑完了(复查实测)。
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
      // 哪一档决定了 label 里能出现什么。不说清楚的话,模型会把 light 档
      // 「只有 person/face」读成「画面里没有猫」。
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
      // 抽帧失败的采样单独报个数。它们在 JSON 里和「这一帧真的没有人」逐字段相同
      // (boxes 空、occupancy 四个 0),不点出来的话模型会把「没抽到」读成「没有人」。
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
        + "A sample with failed set to true is a frame extraction failure, not \"no person in this frame\"; don't draw conclusions from it.",
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
            + "To find targets by arbitrary words (cat, phone, red car), you need to install the full tier extension pack."
          // 这里没有兜底档,和运动追踪不一样 —— 不能让模型以为还有个降级引擎在跑。
          : "Neither tier is usable, so subject detection is not possible on this machine."
            + "For position and occlusion judgments, fall back to looking at the images with see_frames; don't guess \"the person is on the left\" out of thin air."
            + "If the user wants it, install the light tier with subject_install (about 30 MB).",
    };
  },

  // 在线装的是 light 档(onnxruntime,约 30 MB)。full 档是 torch + transformers
  // 加 690 MB 权重,只随拓展库包发,在线装中断一次就得从头来。
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
        + "Check this jobId with background_job_status, or use subject_status to see whether engine has become light. Do not start it again."
        + "After installing, the weight files (yunet.onnx / rtdetr_r18vd.onnx) may still be missing; those only come from running the extension pack's .exe.",
    };
  },

  /**
   * 把一张卡绑到一条轨迹上,让它跟着画面里的目标走。
   *
   * 这是追踪功能真正的落点 —— 在此之前,追出来的坐标只是一串数字,
   * 没有任何东西消费它。
   *
   * 数据不经过模型:模型只说「clip X 跟 point 0」,逐帧坐标在应用内部
   * 从 trackResults 直接写进 clip。让模型把 900 组坐标读进来再写回去,
   * 既烧上下文又必然出错。
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

    // 画面来自哪一段素材:必须和卡片在时间上真的重叠,否则卡片会跟着
    // 一个当时根本没在播的画面走。
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
      // 两种「绑了等于没绑」要当场说破,不能让用户自己去预览里发现
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

  // 安装可能远超 MCP 桥的 60 秒调用超时,所以立刻返回 jobId,
  // 让 AI 用 stt_status 轮询 engines.<engine>.installed 判断是否装完。
  sttInstall: async (args) => {
    // 和启动时那个缺依赖提示走同一条路径(含「同时只许一个安装」的互斥),
    // 所以不管谁发起的,界面上的进度控件表现完全一致。
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

  // 同理:转写通常超过 60 秒,立刻返回 jobId,结果用 get_transcript 轮询。
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
    // 契约:超过 200 段时只返回前 200 段 + 总数
    if (t.segments.length > 200) {
      return { ...t, segments: t.segments.slice(0, 200), total: t.segments.length, truncated: true };
    }
    return { ...t, total: t.segments.length, truncated: false };
  },
  /**
   * 把素材文字稿直接灌进一张字幕卡。
   *
   * 字幕内容是纯搬运,让模型把几十上百条 `起|止|文字` 一条条重打一遍
   * 既贵又容易错行、错时间、漏段。这里在本地一次算完,模型只需要说
   * "给这段配字幕",拿到的是已经填好的结果。
   */
  fillCaptions: (args) => {
    const project = getState().project;
    const media = args.mediaId
      ? project.media.find((m) => m.id === args.mediaId)
      : project.media.find((m) => m.transcript && m.transcript.segments.length > 0);
    if (!media) throw new Error(args.mediaId ? `Asset ${args.mediaId} not found` : "No transcribed media in the media library; transcribe first with transcribe_media.");
    const segments = media.transcript?.segments;
    if (!segments || segments.length === 0) throw new Error(`Media "${media.name}" has no transcript yet. Transcribe it with transcribe_media first.`);

    // 没指定 clip 就找时间轴上唯一那张字幕卡;有多张时要求说清楚是哪一张
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
     * 文字稿的秒数是**素材内**的,得先按这份素材在时间轴上的位置换算过去
     * (素材被挪到第 30 秒、或者修掉了开头,不换算字幕就整体错位),
     * 再减去字幕卡起点变成相对秒。跨出卡片的段落裁到边界内,
     * 免得字幕在卡片外提前亮或不消失。
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
   * 字幕卡里到底有哪几条:下标 + 相对秒 + 绝对秒 + 文字。
   * 改字幕前先看这个,index 以它为准(按时间排,和时间轴上画出来的顺序一致)。
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
        // 相对秒容易和时间轴上的秒搞混,两个都给
        absStart: clip.start + l.start,
        absEnd: clip.start + l.end,
        text: l.zh,
        ...(l.en ? { en: l.en } : {}),
      })),
    };
  },
  /**
   * 单条字幕的增删改。整份重灌走 fill_captions,这里是给「第 3 条说错了」用的。
   *
   * 时间由 kernel/captions 夹在左右邻居之间,所以 Agent 写一个越界的秒数不会
   * 弄出两条抢同一秒的字幕 —— 会贴到边上,并在返回里告诉它实际落在哪。
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
