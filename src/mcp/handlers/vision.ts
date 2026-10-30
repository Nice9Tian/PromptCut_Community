import { startShotDetection, waitForShots } from "../../ai/shots";
import { scenesOf, planSequences, frameTimes, transcriptFor } from "../../ai/sequences";
import { EditorApi } from "../../ai/mcpExecutor";
import { prerenderUrl } from "../../render/prerender";
import { getState, actions } from "../../store/project";
import { subjectForRange } from "../../kernel/project";
import { cutLookView } from "../../kernel/agentScopes.mjs";
import { mediaCardUrl, isImageMedia } from "../../ai/mediaRef";
import { mediaReadyForServer, perceptionMediaRef } from "../../ai/perceptionMedia";

import { shotJobs, subjectDigest } from "../common";
import { apiUrl } from "../apiUrl";

export const visionHandlers = {
  seePreview: async (args) => {
    const state = getState();
    /*
     * cutId(2026-10-21 用户定):看没激活的剪辑不用切换。交给渲染的是「那条剪辑当激活」的项目视图,
     * 只在这次出图时用:不进 store、不进文档同步、播放头和激活剪辑都不动。不给 t 时取那条剪辑上次离开时的播放头。
     */
    if (args?.cutId !== undefined && args?.cutId !== null && typeof args.cutId !== "string") throw new Error("cutId 要是字符串(list_cuts 里的剪辑 id);不传就看当前激活的剪辑。");
    const look = cutLookView(state.project, args?.cutId);
    const project = look.project;
    const playheadT = look.active ? state.t : (look.parkedT ?? 0);
    /*
     * 这条是兜底:有数据镜像时 see_frames 由服务端直接问预渲染(vite-plugin-ai 的服务端工具),
     * 根本不经过这个页面。走到这里时也发到预渲染的源上,并且和工具上限一样 180 秒就放手 ——
     * 放手之后连接断开,预渲染会把还在排队的活摘掉,不会白占一个 Chrome。
     */
    const snap = async (t: number | undefined) => {
      const res = await fetch(await prerenderUrl("/api/vision/snapshot"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          t: t ?? (args?.clipId ? undefined : playheadT),
          clipId: args?.clipId,
        }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `渲染画面失败(HTTP ${res.status})`);
      return { ...data, cut: look.cut };
    };
    /*
     * times:一次看多个时刻。reviewer 判断镜头节奏要对比好几个时刻,一张一张调太慢,
     * 也容易看漏。**一次请求、服务端一趟渲完**(从第 0 帧顺推,沿途截这几帧),每张标上时刻。
     * 以前逐个时刻各请求一次,每张都从第 0 帧重推,推进的成本按时刻数成倍涨。
     * 上限 10 张,和 harness 里保留的截图数对齐 —— 多了前面的会被挤掉。
     */
    const times = Array.isArray(args?.times) ? args.times.filter((x: unknown) => typeof x === "number").slice(0, 10) : [];
    if (times.length) {
      const res = await fetch(await prerenderUrl("/api/vision/snapshot"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, times, clipId: args?.clipId }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `渲染画面失败(HTTP ${res.status})`);
      return { ok: true, frames: data.frames, note: data.note, __images: data.__images, cut: look.cut };
    }
    return snap(typeof args?.t === "number" ? args.t : undefined);
  },
  /**
   * 把画面渲染成图交给模型看。
   *
   * project 是从这里带过去的,不是让服务端自己去读:时间轴的真身在浏览器 store 里,
   * 服务端手上那份(上次保存的)可能已经是旧的 —— 让模型看一张过时的画面,比不给它看更糟。
   */
  /**
   * 看素材:按镜头拼图分页交给模型(规划在 src/ai/sequences.ts,拼图由 /api/vision/sheet 用 ffmpeg 做)。
   * 没跑过镜头识别就在这里跑并等它 —— 模型要看的是画面,别让它先学一套「起作业、轮询」的流程;
   * 识别失败退回固定 10 秒一段,返回里标 fallback 让它知道边界不是真镜头。
   */
  seeSequences: async (args) => {
    let media = getState().project.media.find((m) => m.id === args.mediaId);
    if (!media) throw new Error(`找不到素材 ${args.mediaId}`);
    /*
     * 图片直接把图本身交回去。以前只认视频:图片要么被拒,要么(被错登记成 video 的老 jpg)
     * 跑一遍镜头识别得到一个 0.04 秒的「镜头」—— 模型认定「抽不出画面」,转头去 Read 磁盘路径。
     * 在编辑器页面里取,blob: 和 /@media 都取得到;长边缩到 1280,够看清又不撑爆上下文。
     */
    if (isImageMedia(media)) {
      const src = media.url || mediaCardUrl(media);
      if (!src) throw new Error(`${media.name} 没有可取的地址(上传没完成?),稍后再试`);
      const r = await fetch(src);
      if (!r.ok) throw new Error(`取图片失败(HTTP ${r.status}):${media.name}`);
      const bmp = await createImageBitmap(await r.blob());
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1] ?? "";
      return {
        ok: true,
        mediaId: media.id,
        name: media.name,
        kind: "image",
        width: bmp.width,
        height: bmp.height,
        cardUrl: mediaCardUrl(media),
        note: "这是一张图片,下面就是它本身(长边缩到 1280 以内)。卡片参数里要用它就填 cardUrl。",
        __images: [{ sceneIndex: 1, label: "原图", mime: "image/jpeg", base64 }],
      };
    }
    if (media.kind !== "video") throw new Error(`${media.name} 不是视频,没有画面可看`);
    // 刚导入的素材要等入库完(import_media 一返回模型就可能接着调这里):最多等 15 秒。
    // 镜头识别经素材服务取字节,看的是 pending / 哈希 / 地址,不是磁盘路径(见 ai/perceptionMedia.ts)
    for (let i = 0; i < 30 && !mediaReadyForServer(media); i++) {
      await new Promise((r) => setTimeout(r, 500));
      media = getState().project.media.find((m) => m.id === args.mediaId) ?? media;
    }
    if (!mediaReadyForServer(media)) throw new Error(`${media.name} 还没进素材服务(上传没完成或失败),稍后再试或重新导入`);
    const notes: string[] = [];
    let shots = media.shots ?? null;
    if (!shots) {
      const pending = shotJobs.get(args.mediaId);
      try {
        let jobId = pending && !pending.error ? pending.jobId : "";
        if (!jobId) {
          jobId = await startShotDetection(perceptionMediaRef(media));
          shotJobs.set(args.mediaId, { jobId, percent: 0, engine: "scdet" });
        }
        const result = await waitForShots(jobId, (percent, engine) => shotJobs.set(args.mediaId, { jobId, percent, engine }));
        actions.setMediaShots(args.mediaId, result);
        shotJobs.delete(args.mediaId);
        shots = result;
        notes.push(`刚跑完镜头识别(${result.engine}),共 ${result.shots.length} 个镜头。`);
      } catch (e) {
        notes.push(`镜头识别没成功(${e instanceof Error ? e.message : String(e)}),下面按每 10 秒一段切,边界不是真镜头。`);
      }
    }
    const { scenes: all, fallback } = scenesOf(shots, media.duration ?? 0);
    if (!all.length) throw new Error(`${media.name} 没有可看的画面(时长为 0?)`);
    const plan = planSequences(all, args);
    // 拼图一张一张要,最多 3 张并行:每张是一次 ffmpeg,全开会把机器压死
    const results: any[] = new Array(plan.scenes.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= plan.scenes.length) return;
        const sc = plan.scenes[i];
        try {
          const r = await fetch(await prerenderUrl("/api/vision/sheet"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ media: { id: media.id, name: media.name, kind: media.kind, url: media.url, path: media.path }, start: sc.start, end: sc.end, grid: plan.grid }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
          results[i] = d;
        } catch (e) {
          results[i] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const images: { sceneIndex: number; mime: string; base64: string }[] = [];
    const scenesOut = plan.scenes.map((sc, i) => {
      const r = results[i];
      if (r?.__image?.base64) images.push({ sceneIndex: sc.index, mime: r.__image.mime || "image/jpeg", base64: r.__image.base64 });
      const text = transcriptFor(media.transcript, sc.start, sc.end);
      return {
        index: sc.index,
        start: sc.start,
        end: sc.end,
        duration: Math.round((sc.end - sc.start) * 100) / 100,
        in: sc.inTransition,
        out: sc.outTransition,
        frames: r?.frames ?? frameTimes(sc.start, sc.end, plan.grid),
        ...(text ? { transcript: text } : {}),
        subject: subjectDigest(subjectForRange(media.subjects, sc.start, sc.end)),
        ...(r?.error ? { imageError: r.error } : {}),
      };
    });
    return {
      ok: true,
      mediaId: media.id,
      name: media.name,
      engine: shots?.engine ?? null,
      ...(fallback ? { fallback } : {}),
      page: plan.page, pages: plan.pages, perPage: plan.perPage, grid: plan.grid,
      nextPage: plan.nextPage, prevPage: plan.prevPage,
      matched: plan.matched, totalScenes: plan.totalScenes,
      scenes: scenesOut,
      note: [
        ...notes,
        `每张拼图对应 scenes 里同序号的镜头,格子按行从左到右对应 frames 里的秒数。`,
        plan.nextPage ? `还有 ${plan.pages - plan.page} 页:see_frames({ source: "media", mediaId, page: ${plan.nextPage} })。` : "这是最后一页。",
        "某个镜头看不清:see_frames({ source: 'media', mediaId, scene: 序号, grid: 9 })。",
        !media.transcript ? "这个素材还没转写,想对照说了什么先 transcribe_media。" : "",
      ].filter(Boolean).join(" "),
      __images: images,
    };
  },
  bakeCard: async (args) => {
    // 兜底路径:有数据镜像时 bake_card 由服务端直接问预渲染。这里也发到预渲染的源上,150 秒(工具上限)就放手
    const res = await fetch(await prerenderUrl("/api/vision/bake"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: getState().project,
        clipId: args.clipId,
        t: args.t,
        size: args.size,
        bg: args.bg,
      }),
      signal: AbortSignal.timeout(150000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `渲染失败(HTTP ${res.status})`);
    return data;
  },
  /**
   * 只读地看一张卡某一刻的 DOM 树(每个节点标出源码位置)。project 从这里带过去,理由和 see_frames 一样:
   * 时间轴的真身在浏览器 store 里,服务端手上那份(上次保存的)可能已经是旧的。
   */
  inspectCardDom: async (args) => {
    const ref = typeof args.ref === "string" ? Number(String(args.ref).replace(/^ref_/, "")) : args.ref;
    // 兜底路径:有数据镜像时服务端直接问预渲染。这里也发到预渲染的源上,60 秒(工具上限)就放手
    const res = await fetch(await prerenderUrl("/api/cards/dom"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: getState().project, clipId: args.clipId, t: args.t, ref, depth: args.depth }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `读不到 DOM 树(HTTP ${res.status})`);
    return data;
  },
  cardAuthoringGuide: async () => {
    const res = await fetch(apiUrl("/api/cards/guide"));
    if (!res.ok) throw new Error(`拿不到建卡指南(HTTP ${res.status})`);
    return { guide: await res.text() };
  },
} satisfies Partial<EditorApi>;
