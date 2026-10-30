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
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
    if (media.kind !== "video") throw new Error(`${media.name} 不是视频,没有镜头可分`);
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`);
    if (media.shots && !args.force) {
      return {
        reused: true, mediaId: args.mediaId, engine: media.shots.engine,
        shots: media.shots.shots.length, transitions: media.shots.transitions.length,
        hint: "这个素材已经检测过了,直接用 list_shots 取结果;要重测传 force:true",
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
      hint: "镜头识别已在后台开始,请用 list_shots 轮询该 mediaId",
    };
  },

  listShots: (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
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
        ? "当前用的是 ffmpeg scdet 兜底,只认硬切,溶解等渐变转场检测不出来"
        : "TransNetV2,硬切和溶解都认得",
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
            subjectHint: `上次主体检测失败:${subjectPending.error}。`
              + (media.subjects ? "下面每个镜头的 subject 来自更早成功的那一批,不是这次的。" : "")
              + "先调 subject_status 看 engine:为 null 说明这台机器上两档都用不了(没有兜底档),"
              + "退回 see_frames({ source: 'timeline', t }) 看真实画面判断人在哪,**不要继续轮询本工具**;"
              + "engine 不为 null 才值得调 detect_subjects 并传 force:true 重试。",
          }
        : subjectPending
          ? {
              subjectHint: `主体检测正在跑(${subjectPending.percent}%),跑完再调一次本工具就能看到每个镜头的人物位置`
                + (media.subjects ? ";下面的 subject 是上一批的结果,新一批跑完会替换" : ""),
            }
          : !media.subjects
            ? {
                subjectHint: "这些镜头还没做主体检测,所以每个 subject 都是 null。要决定卡片放哪边、"
                  + "别遮住人物的脸,先调 detect_subjects 拿人物位置。",
              }
            : media.shots.shots.every((s) => subjectForRange(media.subjects, s.start, s.end) === null)
              ? {
                  subjectEngine: media.subjects.engine,
                  subjectFailedCount: media.subjects.failedCount ?? 0,
                  subjectHint: `主体检测跑完了,但这一批 ${media.subjects.samples.length} 个采样没有一个可用`
                    + "(全部抽帧失败,见 subjectFailedCount),所以每个 subject 都是 null —— 这不是「画面里没有人」。"
                    + "换几个时刻用 detect_subjects 传 times 重测,或退回 see_frames({ source: 'timeline', t }) 看图。",
                }
              : {
                  subjectEngine: media.subjects.engine,
                  ...(media.subjects.failedCount
                    ? { subjectFailedCount: media.subjects.failedCount }
                    : null),
                  ...(media.subjects.fellBackFrom
                    ? {
                        subjectFellBackFrom: media.subjects.fellBackFrom,
                        subjectFallbackNote: `本来要跑 full 档,中途退回了 light:${media.subjects.fallbackReason ?? "原因未知"}。`
                          + "所以 prompt 没生效,label 只可能是 person / face。",
                      }
                    : null),
                  subjectHint: "每个镜头的 subject.suggestedPosition 可以直接填进卡片的 params.position"
                    + "(只会是 left / right / bottom,不会返回 center);boxes 是原始视频像素的人物框。"
                    + "suggestedPosition 为 null 表示四档全被人物占住(看 suggestedOccupancy 和 warning),"
                    + "那个镜头没有不遮人的位置,别硬填。"
                    + "能不能填以 list_cards({cardId}) 的 controls 为准,卡片不支持这个值就换一张卡,"
                    + "不要退回默认的居中 —— 居中正是人脸所在。",
                }),
    };
  },

  // 运动追踪:250 帧约 26 秒,同样立刻返回 jobId,结果用 get_track 轮询。
  // 结果不写进项目文档——查询点是每次现指的,同一段素材能追很多组,
  // 塞进 project 只会让工程文件无限膨胀,所以只留在内存里。
  trackPoints: async (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
    if (media.kind !== "video") throw new Error(`${media.name} 不是视频,没有运动可追`);
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`);
    if (!Array.isArray(args.points) || args.points.length === 0) {
      throw new Error("points 至少要有一个点,写成 [[帧号, x, y], ...]");
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
      hint: "运动追踪已在后台开始,请用 get_track 轮询该 mediaId",
      // 装没装拓展决定用哪一档,也决定要等多久:同样 250 帧,
      // 神经网络档约 26 秒,模板匹配约 1 秒。
      engineHint: "哪一档在跑要等结果出来才知道,看 get_track 返回的 engine",
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
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
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
        ? "BootsTAPIR,任意点追踪,visible 为 false 表示该帧被遮挡或移出画面"
        : "当前是模板匹配兜底(未装运动追踪拓展)。刚体、纹理清晰、不转向的目标能追得很准,"
          + "但目标一旦转向、缩放或长时间被挡就会跟丢;某个点带 note 字段表示它压根没追成",
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
      hint: "只给了摘要。要让卡片跟着某个点走就调 attach_clip_motion(不用把坐标读出来);"
        + "确实需要逐帧坐标时传 full:true,但那会是很长一串数字。",
    };
  },

  trackStatus: async () => {
    const s = await trackStatus();
    return {
      ...s,
      hint: s.engine === "bootstapir"
        ? "已装拓展,走 BootsTAPIR。"
        : s.engine === "template"
          ? "未装拓展,走模板匹配兜底 —— 能追,但目标转向、形变或长时间被挡时会跟丢。"
            + "用户要更稳的结果就用 track_install 装拓展(约 400 MB)。"
          : "两档都用不了(通常是找不到 Python),这台机器上追不了。",
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
      hint: "运动追踪拓展正在后台安装(torch + 权重约 400 MB,要几分钟)。"
        + "用 background_job_status 查这个 jobId,或用 track_status 看 engine 有没有变成 bootstapir。不要重复启动。",
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
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
    if (media.kind === "audio") throw new Error(`${media.name} 是音频,没有画面可看`);
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`);

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
          ? { engineNote: "已有结果是 light 档跑的,label 只有 person / face,答不了提示词里别的名词;"
              + "这台机器现在也只能跑 light,所以没有重测。装了 full 拓展包之后再传 force:true 重测。" }
          : null),
        hint: "这个素材已经检测过了,直接用 list_subjects 取结果,或用 list_shots 看每个镜头的 suggestedPosition;要重测传 force:true",
      };
    }

    // 上限夹在 kernel 里(MAX_SUBJECT_TIMES,和服务端同一个常数)。
    // 拿「不设限时会排出多少点」一比,就知道这次降没降精度 —— 降过要说出来,
    // 不然模型会拿一份被抽稀过的结论当满精度用。
    const autoRaw = subjectSampleTimes(media, Number.MAX_SAFE_INTEGER).length;
    const times = Array.isArray(args.times) && args.times.length > 0
      ? args.times.map(Number).filter((t) => Number.isFinite(t) && t >= 0)
      : subjectSampleTimes(media);
    if (times.length === 0) throw new Error("算不出采样时刻,素材可能没有时长信息;可以自己传 times");
    const sampledNote = !args.times && autoRaw > times.length
      ? `素材偏长或镜头偏碎,采样已从 ${autoRaw} 点降到 ${times.length} 点`
        + `(上限 ${MAX_SUBJECT_TIMES});镜头级的结论会更粗,approximate 为 true 的镜头会变多。`
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
      sampledFrom: media.shots ? "按镜头(每个镜头 20%/50%/80%)" : "每 2 秒一点(这段素材还没做镜头识别)",
      ...(sampledNote ? { sampledNote } : null),
      engine,
      ...(etaSeconds ? { etaSeconds } : null),
      ...(staleEngine
        ? { staleEngine: true, engineNote: "上一批结果是 light 档跑的,答不了提示词,所以这次重测(不是复用)" }
        : null),
      hint: "主体检测已在后台开始,用 list_subjects 轮询该 mediaId;"
        + (etaSeconds
          ? `预计 ${etaSeconds} 秒左右(engine=${engine},实测 light 约 0.5 秒/帧、full 约 3 秒/帧)。`
            + `${engine === "full" ? "full 档慢,隔 10 秒问一次就够" : "隔 3 秒问一次就够"},别每秒都问。`
          : "engine 为 null 表示两档都用不了,这个作业多半会失败;先调 subject_status 确认。")
        + "跑完之后 list_shots 的每个镜头会带上 subject 和 suggestedPosition。",
    };
  },

  listSubjects: (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
    const pending = subjectJobs.get(args.mediaId);
    if (pending?.error) throw new Error(pending.error);
    // 有作业在跑就先报在跑 —— 哪怕手里还有上一批结果。以前是「有旧结果就直接回旧结果」,
    // 换了 prompt 重测期间模型读到的是旧 prompt 的样本,还以为新的已经跑完了(复查实测)。
    if (pending) {
      return {
        running: true, percent: pending.percent, engine: pending.engine,
        ...(media.subjects
          ? { stale: true, staleNote: "上一批结果还在,但新一次检测正在跑,这里不给样本;跑完再调一次本工具" }
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
        ? "Grounding DINO,label 是提示词里的名词;prompt 为空时按 person . face . 找"
        : "YuNet + RT-DETR 的 light 档,只认 person 和 face,提示词不生效(原样回显在 prompt 里)",
      ...(s.fellBackFrom
        ? {
            fellBackFrom: s.fellBackFrom,
            fallbackNote: `本来要跑 full 档,中途退回了 light:${s.fallbackReason ?? "原因未知"}。`
              + "所以 prompt 没生效,label 只可能是 person / face。",
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
          ? { failed: true, reason: sm.reason ?? "这一帧没抽出来", boxes: [], boxCount: 0 }
          : {
              safeSide: sm.safeSide,
              ...suggestPosition(sm.safeSide, sm.occupancy),
              occupancy: sm.occupancy,
              boxes: topBoxes(sm.boxes),
              boxCount: sm.boxes.length,
            }),
      })),
      hint: "坐标是原始视频像素(和 width/height 同一套)。要按镜头排卡片就直接看 list_shots,"
        + "那边每个镜头已经把这些采样折好了。suggestedPosition 可直接填进卡片的 params.position"
        + "(只会是 left / right / bottom,不会返回 center);为 null 表示四档都被人物占住,"
        + "看 suggestedOccupancy 和 warning,那一刻没有不遮人的位置。"
        + "failed 为 true 的采样是抽帧失败,不是「这一帧没有人」,不要拿它下结论。",
    };
  },

  subjectStatus: async () => {
    const s = await subjectStatus();
    return {
      ...s,
      hint: s.engine === "full"
        ? "full 档:YuNet + RT-DETR + Grounding DINO,能按任意文字提示找目标(prompt 生效)。"
        : s.engine === "light"
          ? "light 档:YuNet(人脸) + RT-DETR(人体),只认 person 和 face,prompt 不生效。"
            + "要按任意词找目标(猫、手机、红色的车)得装 full 档拓展库包。"
          // 这里没有兜底档,和运动追踪不一样 —— 不能让模型以为还有个降级引擎在跑。
          : "两档都用不了,这台机器上检测不了主体。"
            + "位置和遮挡的判断退回 see_frames 看图,不要凭空猜「人在左边」。"
            + "用户想要就用 subject_install 装 light 档(约 30 MB)。",
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
      hint: "主体检测 light 档正在后台安装(onnxruntime,约 30 MB)。"
        + "用 background_job_status 查这个 jobId,或用 subject_status 看 engine 有没有变成 light。不要重复启动。"
        + "装完还可能缺权重文件(yunet.onnx / rtdetr_r18vd.onnx),那要跑拓展库包的 .exe 才有。",
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
    if (!hit) throw new Error(`找不到片段 ${args.clipId}`);
    if (!hit.clip.cardId) throw new Error(`${args.clipId} 是素材段,不是卡片段,没有「跟着走」这回事`);

    const media = p.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);

    const result = trackResults.get(args.mediaId);
    if (!result) {
      throw new Error(trackJobs.get(args.mediaId)
        ? `${media.name} 的追踪还没跑完,先用 get_track 等它出结果`
        : `${media.name} 还没追过,先调 track_points`);
    }
    const idx = args.pointIndex ?? 0;
    const point = result.points[idx];
    if (!point) throw new Error(`这次追踪只有 ${result.points.length} 个点,没有第 ${idx} 个`);
    if (point.note) throw new Error(`第 ${idx} 个点没追成:${point.note}`);

    // 画面来自哪一段素材:必须和卡片在时间上真的重叠,否则卡片会跟着
    // 一个当时根本没在播的画面走。
    const source = p.tracks
      .flatMap((t) => t.clips)
      .filter((c) => c.mediaId === args.mediaId)
      .find((c) => c.start < hit.clip.end && c.end > hit.clip.start);
    if (!source) {
      throw new Error(`时间轴上没有一段 ${media.name} 和这张卡在时间上重叠 —— `
        + `卡片放在 ${hit.clip.start.toFixed(2)}~${hit.clip.end.toFixed(2)}s,那段时间画面上没有这个素材`);
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
      throw new Error(`绑定失败:写不进片段 ${args.clipId}`);
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
        ? { warning: "这个点几乎没动(位移不到 2 像素),绑上去看不出跟随效果" }
        : {}),
      ...(visibleFrames < frames * 0.5
        ? { warning2: `一半以上的帧(${frames - visibleFrames}/${frames})目标不可见,`
            + `跟随会大段停住${built.motion.whenHidden === "hide" ? "或整张卡消失" : ""}` }
        : {}),
    };
  },

  detachClipMotion: (args) => {
    const hit = findClip(getState().project, args.clipId);
    if (!hit) throw new Error(`找不到片段 ${args.clipId}`);
    if (!hit.clip.motion) return { ok: true, clipId: args.clipId, changed: false, hint: "这张卡本来就没绑轨迹" };
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
      hint: "安装已在后台开始,用户界面上会显示带进度的安装动画。用 background_job_status 查这个 jobId,或用 stt_status 看该引擎的 installed 字段。不要重复启动。",
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
    return { jobId, started: true, mediaId: args.mediaId, hint: "转写已在后台开始,请用 get_transcript 轮询该 mediaId" };
  },

  getTranscript: (args) => {
    const media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
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
    if (!media) throw new Error(args.mediaId ? `找不到素材 ${args.mediaId}` : "素材库里没有已转写的素材,先用 transcribe_media 转写。");
    const segments = media.transcript?.segments;
    if (!segments || segments.length === 0) throw new Error(`素材「${media.name}」还没有文字稿,先用 transcribe_media 转写。`);

    // 没指定 clip 就找时间轴上唯一那张字幕卡;有多张时要求说清楚是哪一张
    let clipId = args.clipId;
    if (!clipId) {
      const hits = project.tracks.flatMap((t) => t.clips.filter((c) => (c as { cardId?: string }).cardId === "caption-track"));
      if (hits.length === 0) throw new Error("时间轴上没有 caption-track 卡片。先 add_clip 建一张,或直接传 clipId。");
      if (hits.length > 1) throw new Error(`时间轴上有 ${hits.length} 张字幕卡,请用 clipId 指明是哪一张:${hits.map((c) => c.id).join(", ")}`);
      clipId = hits[0].id;
    }
    const hit = findClip(project, clipId);
    if (!hit) throw new Error(`找不到 clip ${clipId}`);
    const clip = hit.clip as { start: number; end: number; cardId?: string };
    if (clip.cardId !== "caption-track") throw new Error(`clip ${clipId} 是 ${clip.cardId},不是字幕卡。`);

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
          ? `文字稿里没有落在这张卡时段(${clip.start}s–${clip.end}s)内的段落,检查一下 clip 的起止时间。`
          : `素材「${media.name}」还没放到时间轴上,字幕对不上时间。先 add_clip 把它放上去。`,
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
      if (args.index == null) throw new Error("remove 要给 index(list_captions 里的下标)");
      const lines = captionsOf(hit.clip as { params?: Record<string, unknown> });
      const gone = lines[args.index];
      if (!gone) throw new Error(`这张字幕卡只有 ${lines.length} 条,没有第 ${args.index} 条`);
      if (!actions.removeCaption(clipId, args.index)) throw new Error("删除失败");
      return { clipId, removed: describeCaption(gone, args.index), count: lines.length - 1 };
    }

    if (op === "insert") {
      if (args.start == null) throw new Error("insert 要给 start(相对字幕卡起点的秒)");
      if (!args.text) throw new Error("insert 要给 text");
      const at = actions.addCaption(clipId, { start: args.start, end: args.end, zh: args.text, en: args.en });
      if (at < 0) throw new Error(`${args.start}s 附近没有放得下的空当了 —— 先用 list_captions 看看哪儿是空的,或者把邻近那条改短。`);
      const now = captionsOf(findCaptionClip(clipId).clip as { params?: Record<string, unknown> });
      return { clipId, index: at, caption: describeCaption(now[at], at), count: now.length };
    }

    if (args.index == null) throw new Error("edit 要给 index(list_captions 里的下标)");
    if (args.text === undefined && args.en === undefined && args.start === undefined && args.end === undefined) {
      throw new Error("edit 至少要给 text / en / start / end 里的一个");
    }
    const at = actions.editCaption(clipId, args.index, {
      start: args.start,
      end: args.end,
      zh: args.text,
      en: args.en,
    });
    if (at < 0) throw new Error(`改不了第 ${args.index} 条,先用 list_captions 确认下标`);
    const now = captionsOf(findCaptionClip(clipId).clip as { params?: Record<string, unknown> });
    return { clipId, index: at, caption: describeCaption(now[at], at), count: now.length };
  },
} satisfies Partial<EditorApi>;
