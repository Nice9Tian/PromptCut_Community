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
    if (!args.query) throw new Error("query (keywords) is required");
    const r = await searchVideos(args.query, { site: args.site, limit: args.limit });
    if (!r.ok) {
      throw new Error(
        (r.error || "Search failed")
        + (r.notInstalled ? "(extension not installed, run collect_install first)" : "")
        + (r.notes?.length ? `; process: ${r.notes.join(" / ")}` : ""),
      );
    }
    const results = r.results ?? [];
    return {
      query: r.query, site: r.site, count: results.length, results, notes: r.notes,
      hint: results.length
        ? "Pick one by title, duration and view count, then pass its url to collect_probe (to check quality) or straight to collect_download."
        : "No downloadable video found; try another keyword. Courses and anime series in Bilibili search results do not count.",
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
      hint: "yt-dlp is installing in the background (about 3 MB). Check this jobId with background_job_status, or use collect_status to see whether ready has become true. Do not start it again.",
    };
  },

  collectProbe: async (args) => {
    if (!args.url) throw new Error("url is required (video page link, BV id or short link)");
    const info = await probeLink(args.url, { site: args.site, quality: args.quality });
    if (!info.ok) {
      throw new Error(
        (info.error || "Probe failed")
        + (info.notInstalled ? "(extension not installed, run collect_install first)" : "")
        + (info.notes?.length ? `; process: ${info.notes.join(" / ")}` : ""),
      );
    }
    return {
      ...info,
      hint: info.parts
        ? `This is a multi-part upload (${info.parts.length} parts). collect_download only takes the part given by the link by default; pass allParts: true to get all of them.`
        : "Ready for collect_download; if quality is not specified, it is 1080.",
    };
  },

  // 下载几十秒到几分钟,立刻回 jobId,结果用 collect_job 轮询;下完自动登记进素材库
  collectDownload: async (args) => {
    if (!args.url) throw new Error("url is required (video page link, BV id or short link)");
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
              rec.error = `Downloaded, but registering the asset failed: ${e instanceof Error ? e.message : String(e)}`;
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
        ? "This link is already downloading; just poll this jobId with collect_job."
        : "The download has started in the background on the server. Poll with collect_job (once every 3 seconds); it only counts as added to the media library when it is done and carries mediaIds.",
    };
  },

  collectJob: async ({ jobId }) => {
    const rec = collectJobs.get(jobId);
    if (!rec) throw new Error("Download job not found. It was not started from this page, or the page was refreshed. Run collect_download again (files with identical content are deduplicated by content hash on import, so the media library will not get a second copy).");
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
      return { ...base, status: "running", hint: job.status === "done" ? "File downloaded, registering it into the media library" : undefined };
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
      hint: "Added to the media library and placed on the video track. For captions, run transcribe_media; for motion graphics, run detect_shots first.",
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
          hint: `Already logged in (user ${saved.userId ?? "?"}, ${saved.expiresAt ? `expires ${saved.expiresAt}` : "Session valid"}), no need to log in again; to switch account pass force: true.`,
        };
      }
    }
    openCollectLogin(site, method);
    return {
      ok: true, site, method, opened: true,
      hint: method === "qr"
        ? "The login dialog has popped up in the editor, with a QR code in it. **Stop now** and tell the user in Chinese: scan the QR code in the dialog with the mobile app and confirm; to use account and password instead, click \"Account password / SMS\" in the dialog. Reply with one line once logged in, then call collect_login_check. Do not enter the user's account, password or verification code for them."
        : "The login dialog has popped up; after the user clicks \"Open login page\", the site's own login page will appear. **Stop now** and tell the user to log in there (account password / SMS / QR scan all work). Reply with one line once logged in, then call collect_login_check. Do not enter the user's account, password or verification code for them.",
    };
  },

  collectLoginCheck: async (args) => {
    const r = await collectLoginCheck(args.site || "bilibili", args.hide !== false);
    if (!r.ok) throw new Error(r.error || "Cannot read the login state in the browser");
    if (!r.loggedIn) {
      return { ...r, hint: `${r.hint ?? "Not logged in yet"}. Missing: ${(r.missing ?? []).join(", ") || "none"}. Have the user finish logging in in the window and reply, then check once more; do not poll continuously.` };
    }
    return {
      ...r,
      hint: `Login state saved (user ${r.userId ?? "?"}, ${r.expiresAt ? `expires ${r.expiresAt}` : "Session valid"}), window hidden again. collect_probe / collect_download will use it automatically from now on, no need to pass cookies.`,
    };
  },

  collectLogout: async (args) => {
    const r = await collectLogout(args.site || "bilibili");
    return { ...r, hint: r.removed ? "Login state deleted; downloads will use the logged-out quality from now on." : "There was no saved login state to begin with." };
  },
} satisfies Partial<EditorApi>;
