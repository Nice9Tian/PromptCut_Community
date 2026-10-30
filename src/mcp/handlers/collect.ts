import { EditorApi } from "../../ai/mcpExecutor";
import { getState } from "../../store/project";
import { importVideoFromServer } from "../../editor/io";
import {
  collectStatus, installCollect, probeLink, startDownload, waitForDownload, collectLoginCheck, collectLogout, cookieStatus, searchVideos
} from "../../ai/collect";
import { openCollectLogin } from "../../ai/collectLoginStore";

import { collectInstallJobs, collectJobs } from "../common";

export const collectHandlers = {
  /**
   * 把用户用「+」发进来的附件装进素材库。
   *
   * 附件落在对话的工作目录(.pc-work)里,那和项目素材库是两回事 ——
   * 模型能在提示词里看到附件的地址和磁盘路径,却没有任何工具能把它搬过去,
   * 于是 list_media 一直是空的,只能回一句「请你先手动导入」。这个工具补上那一步。
   *
   * 实现上取回文件再走 importVideoFiles,也就是用户拖拽导入走的同一条路:
   * 同样探测时长宽高、同样登记 MediaAsset、同样落到视频轨、同样上传拿到磁盘路径。
   * 多一次取回的开销,换的是「AI 导入」和「人工导入」结果完全一致。
   */
  // ── 素材收集:从网页链接抓视频 ──────────────────────────────────
  collectStatus: () => collectStatus(),

  // 站内搜索:给「从 B 站找素材」用。每条要单独探测,limit 封顶 10
  collectSearch: async (args) => {
    if (!args.query) throw new Error("要传 query(关键词)");
    const r = await searchVideos(args.query, { site: args.site, limit: args.limit });
    if (!r.ok) {
      throw new Error(
        (r.error || "搜索失败")
        + (r.notInstalled ? "(拓展没装,先 collect_install)" : "")
        + (r.notes?.length ? `;过程:${r.notes.join(" / ")}` : ""),
      );
    }
    const results = r.results ?? [];
    return {
      query: r.query, site: r.site, count: results.length, results, notes: r.notes,
      hint: results.length
        ? "按标题、时长、播放量挑一条,把它的 url 交给 collect_probe(看清晰度)或直接 collect_download。"
        : "没搜到可下载的视频,换个关键词再搜;B 站搜索结果里的课程、番剧不算。",
    };
  },

  // 安装是 pip 装 yt-dlp,几十秒,立刻回 jobId,和 subject_install 一个路数
  collectInstall: async () => {
    const jobId = `collect-${Date.now().toString(36)}`;
    collectInstallJobs.set(jobId, { done: false, ok: false, logTail: [] });
    void installCollect((line) => {
      const job = collectInstallJobs.get(jobId);
      if (job) job.logTail = [...job.logTail, line].slice(-20);
    })
      .then(({ ok }) => {
        const job = collectInstallJobs.get(jobId);
        collectInstallJobs.set(jobId, { done: true, ok, logTail: job?.logTail ?? [] });
      })
      .catch((e: unknown) => {
        const job = collectInstallJobs.get(jobId);
        collectInstallJobs.set(jobId, {
          done: true, ok: false,
          error: e instanceof Error ? e.message : String(e),
          logTail: job?.logTail ?? [],
        });
      });
    return {
      jobId, started: true,
      hint: "yt-dlp 正在后台安装(约 3 MB)。用 background_job_status 查这个 jobId,或用 collect_status 看 ready 有没有变 true。不要重复启动。",
    };
  },

  collectProbe: async (args) => {
    if (!args.url) throw new Error("要传 url(视频页链接、BV 号或短链)");
    const info = await probeLink(args.url, { site: args.site, quality: args.quality });
    if (!info.ok) {
      throw new Error(
        (info.error || "探测失败")
        + (info.notInstalled ? "(拓展没装,先 collect_install)" : "")
        + (info.notes?.length ? `;过程:${info.notes.join(" / ")}` : ""),
      );
    }
    return {
      ...info,
      hint: info.parts
        ? `这是多 P 稿件(${info.parts.length} P),collect_download 默认只取链接指定的那一 P,要全部就传 allParts: true。`
        : "可以 collect_download 了;不指定 quality 就是 1080。",
    };
  },

  // 下载几十秒到几分钟,立刻回 jobId,结果用 collect_job 轮询;下完自动登记进素材库
  collectDownload: async (args) => {
    if (!args.url) throw new Error("要传 url(视频页链接、BV 号或短链)");
    const { jobId, reused } = await startDownload(args.url, {
      quality: args.quality, site: args.site,
      audioOnly: args.audioOnly, allParts: args.allParts, cookies: args.cookies,
    });
    if (!collectJobs.has(jobId)) {
      collectJobs.set(jobId, { imported: false, mediaIds: [] });
      waitForDownload(jobId, (job) => {
        const rec = collectJobs.get(jobId);
        if (rec) rec.job = job;
      })
        .then(async (job) => {
          const rec = collectJobs.get(jobId);
          if (!rec || rec.imported) return;
          rec.imported = true;
          rec.job = job;
          for (const item of job.items) {
            try {
              // 服务端已经经素材服务的入库接口把文件送进内容库(server/vite-plugin-collect.ts),按回来的标识登记
              rec.mediaIds.push(await importVideoFromServer({ url: item.url, name: item.filename, uploaded: item.media ?? null }));
            } catch (e: unknown) {
              rec.error = `下载好了但登记素材失败:${e instanceof Error ? e.message : String(e)}`;
            }
          }
        })
        .catch((e: unknown) => {
          const rec = collectJobs.get(jobId);
          if (rec) rec.error = e instanceof Error ? e.message : String(e);
        });
    }
    return {
      jobId, started: true, reused: !!reused,
      hint: reused
        ? "这条链接已经在下了,直接用 collect_job 轮询这个 jobId。"
        : "下载已在服务端后台开始。用 collect_job 轮询(隔 3 秒问一次),done 且带 mediaIds 才算收进素材库。",
    };
  },

  collectJob: async ({ jobId }) => {
    const rec = collectJobs.get(jobId);
    if (!rec) throw new Error("找不到这个下载作业。它不是本页发起的,或者页面刷新过 —— 重新 collect_download 一次(同样内容的文件入库时按内容哈希去重,素材库里不会多出一份)。");
    const job = rec.job;
    if (rec.error) {
      return { jobId, status: "error", message: rec.error, notes: job?.notes ?? [], stage: job?.stage };
    }
    if (!job) return { jobId, status: "running", stage: "starting", percent: 0 };
    const base = {
      jobId, status: job.status, stage: job.stage, percent: job.percent,
      speed: job.speed, eta: job.eta, info: job.info, notes: job.notes,
    };
    if (job.status === "error") return { ...base, message: job.message };
    if (job.status !== "done" || !rec.imported) {
      return { ...base, status: "running", hint: job.status === "done" ? "文件下好了,正在登记进素材库" : undefined };
    }
    const media = getState().project.media;
    return {
      ...base,
      mediaIds: rec.mediaIds,
      items: job.items.map((it, i) => {
        const m = media.find((x) => x.id === rec.mediaIds[i]);
        return {
          mediaId: rec.mediaIds[i], title: it.title, hash: it.hash, bytes: it.bytes,
          duration: m?.duration ?? it.duration, width: m?.width ?? it.width, height: m?.height ?? it.height,
          vcodec: it.vcodec, transcoded: !!it.transcoded, uploader: it.uploader, webpage_url: it.webpage_url,
        };
      }),
      hint: "已装进素材库并放到视频轨上。要做字幕就 transcribe_media,要配动效先 detect_shots。",
    };
  },

  // ── 登录:把站点登录页挪到用户面前扫码,扫完取 cookie 存盘,之后下载自动带上 ──
  // 登录框弹在编辑台里:扫码(二维码就画在框里)或浏览器(站点自己的登录页,账号密码也行)
  collectLogin: async (args) => {
    const site = args.site || "bilibili";
    const method = args.method === "browser" ? "browser" : "qr";
    if (!args.force) {
      const saved = (await cookieStatus().catch(() => ({} as Record<string, never>)))[site];
      if (saved?.loggedIn) {
        return {
          ok: true, alreadyLoggedIn: true, site, userId: saved.userId, expiresAt: saved.expiresAt,
          hint: `已经登录(用户 ${saved.userId ?? "?"},${saved.expiresAt ? `到 ${saved.expiresAt} 过期` : "会话有效"}),不用再登;要换账号传 force: true。`,
        };
      }
    }
    openCollectLogin(site, method);
    return {
      ok: true, site, method, opened: true,
      hint: method === "qr"
        ? "登录框已经在编辑台里弹出来,二维码在框里。**现在停下来**,用中文告诉用户:用手机客户端扫框里的二维码并确认;想用账号密码就点框里的「账号密码 / 短信」。登录完回一句,之后再调 collect_login_check。不要替用户输账号密码和验证码。"
        : "登录框已经弹出来,用户点「打开登录页」后会出现站点自己的登录页。**现在停下来**,告诉用户在那里登录(账号密码 / 短信 / 扫码都行),登录完回一句,之后再调 collect_login_check。不要替用户输账号密码和验证码。",
    };
  },

  collectLoginCheck: async (args) => {
    const r = await collectLoginCheck(args.site || "bilibili", args.hide !== false);
    if (!r.ok) throw new Error(r.error || "读不到浏览器里的登录态");
    if (!r.loggedIn) {
      return { ...r, hint: `${r.hint ?? "还没登录"}。缺:${(r.missing ?? []).join(", ") || "无"}。让用户在窗口里完成登录后回话,再查一次;不要连着轮询。` };
    }
    return {
      ...r,
      hint: `登录态已存盘(用户 ${r.userId ?? "?"},${r.expiresAt ? `到 ${r.expiresAt} 过期` : "会话有效"}),窗口已藏回。之后 collect_probe / collect_download 会自动带上,不用传 cookies。`,
    };
  },

  collectLogout: async (args) => {
    const r = await collectLogout(args.site || "bilibili");
    return { ...r, hint: r.removed ? "登录态已删除,之后按未登录画质下载。" : "本来就没有存盘的登录态。" };
  },
} satisfies Partial<EditorApi>;
