/**
 * vision 的 HTTP 路由。从 server/vite-plugin-vision.ts 的 `configureServer` 逐字搬来。
 *
 * 两侧分开注册:`registerEditorSide`(编辑器进程,走热备渲染器 + 老地址转发)和
 * `registerPrerenderSide`(预渲染进程,看图 / 预渲染 / 盘点 / 清理)。
 *
 * **路由处理体保留搬运前的缩进(6 个空格)**:它们原来嵌在 `configureServer` 里,
 * 不重排缩进,是为了让「这次只是搬家、一个字没改」能被逐字比对证明。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ViteDevServer } from "vite";
import { isolateClip } from "../vision-project.mjs";
import { overLimit } from "../http-guard.mjs";
import { exportsRunning } from "../render-pool-state.mjs";
import { proxyToPrerender } from "../prerender-client.mjs";
import { EXTRACT_TIMEOUT_MS, ffmpegCommand, mediaHashOf, mediaSourceOf } from "./ffmpeg-frames";
import { abortOnClose, originOf, outRoot, resolveMediaUrls, sendJson } from "./http";
import { enqueue, maxConcurrentRenders, renderRunning } from "./render-queue";
import { renderFrames, renderOneFrame } from "./render";
import { bakeClip, bakeOne, bakeTarget } from "./bake";
import { bakedOf, evictBakes, listBakes } from "./bake-cache";
import { renderWorkers } from "./worker-pool";
import { createUiRenderer } from "./ui-renderer";

/**
 * 编辑器这一端的 vision 接口。
 *
 * 渲染池、导出、Agent 看图都在预渲染进程里(vite.prerender.config.ts),这里只留:
 *   - /api/ui-render/bake-batch:用户前台渲染,走上面那对热备渲染器;
 *   - 老地址(/api/vision/*、/api/ai/visual):原样转给预渲染,给还没改成直连的调用方兜底。
 */
export function registerEditorSide(server: ViteDevServer, root: string) {
  const ui = createUiRenderer(root, () => originOf(server));
  server.httpServer?.on("close", () => ui.stop());
  server.httpServer?.once("listening", () => {
    // 一开机就把两台热备起好 —— 等用户第一次拖动才开机,他要多等几秒
    setTimeout(() => { try { ui.prewarm(); } catch { /* 起不来就等第一次用的时候再起 */ } }, 1000);
  });

  server.middlewares.use("/api/ui-render/status", (_req, res) => sendJson(res, 200, { ok: true, ...ui.status() }));

  server.middlewares.use("/api/ui-render/bake-batch", (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
    let body = "";
    let over = false;
    req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
    req.on("end", async () => {
      if (over) return;
      try {
        const { project, clips, size, bg } = JSON.parse(body || "{}");
        if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
        if (!Array.isArray(clips) || !clips.length) return sendJson(res, 400, { ok: false, error: "缺少 clips" });
        const resolved = resolveMediaUrls(project).project;
        const signal = abortOnClose(res);
        const byClip = new Map<string, number[]>();
        for (const c of clips) {
          if (!c || typeof c.clipId !== "string") continue;
          const arr = byClip.get(c.clipId);
          if (arr) arr.push(Number(c.t)); else byClip.set(c.clipId, [Number(c.t)]);
        }
        const baked: any[] = [];
        const failed: any[] = [];
        /*
         * **同一个请求里的几张卡按顺序渲**,一张渲完再交下一张。
         *
         * 热备渲染器的打断 / 挤掉规则是给「用户又换了一个时刻」用的:新请求来了,旧请求才开始的那张就不要了。
         * 要是把同一批的几张一起交出去,它们会互相打断、互相挤掉 —— 实测一批 N 张只成两三张,其余回
         * 「被新请求替换」,3D 视图还会弹一句「N 张没渲出来」。一个请求的几张是一体的,不该互相竞争。
         * 顺序渲不慢:热备是为「立刻有人接」,不是为一批里的并行。
         */
        for (const [clipId, ts] of byClip) {
          if (signal.aborted) {
            failed.push({ clipId, error: "请求方已经不要了", cancelled: true });
            continue;
          }
          try {
            baked.push(...await bakeClip(root, originOf(server), resolved, clipId, ts, size, bg, "box", 1, { signal, runner: ui.run }));
          } catch (e: any) {
            failed.push({ clipId, error: e?.message || String(e), cancelled: !!e?.cancelled });
          }
        }
        sendJson(res, 200, { ok: true, baked, failed });
      } catch (e: any) {
        sendJson(res, 500, { ok: false, error: e?.message || String(e) });
      }
    });
  });

  // 老地址兜底:原样转给预渲染(断开会传过去,预渲染按断开摘掉排队的活)
  server.middlewares.use("/api/vision", (req, res) => proxyToPrerender(req, res));
  server.middlewares.use("/api/ai/visual", (req, res) => proxyToPrerender(req, res));
}

/**
 * 预渲染进程这一端的全部 vision 路由。原来直接写在 `visionPlugin` 的 `configureServer` 里,
 * 现在整段搬到这里;插件外壳只负责在 `isPrerender` 时调用它。
 */
export function registerPrerenderSide(server: ViteDevServer, root: string) {
      // 编辑器那一端靠它判断预渲染起来了没有(vite-plugin-prerender 的就绪检查)
      server.middlewares.use("/api/prerender/health", (_req, res) => sendJson(res, 200, {
        ok: true, role: "prerender", concurrency: maxConcurrentRenders(), running: renderRunning, exporting: exportsRunning(),
      }));

      /*
       * POST /api/vision/sheet { media, start, end, grid } —— see_frames 素材模式(source: "media")用的镜头拼图。
       * 一个镜头一张 JPEG:从 start 到 end 等间隔抽 grid 帧(4 = 2×2,9 = 3×3),每格 480 宽,
       * ffmpeg 一趟做完(fps 滤镜取帧 + tile 拼格),不落中间帧。media 是项目里那条素材记录;
       * 字节只经素材服务的 HTTP 取(ffmpeg-frames.ts 的 mediaSourceOf),本进程不读本地内容库的目录
       * (docs/semantics/product/asset-service.md「职责」)。
       * 按素材内容哈希、区间、格数缓存在 out/sheets 下,翻页回看不重抽:按哈希寻址的内容不可变,哈希一样画面就一样。
       * 没有哈希的素材(迁移期按文件名存的、老 .proc 的绝对路径)同一个地址可能换过内容,不进缓存、每次现抽。
       */
      server.middlewares.use("/api/vision/sheet", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 1024 * 1024, "请求体超过 1MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { media, start, end, grid } = JSON.parse(body || "{}");
            const file = mediaSourceOf(media);
            if (!file) return sendJson(res, 404, { ok: false, error: "素材服务不可达,或这条素材记录没有地址" });
            const s0 = Number(start), s1 = Number(end);
            if (!Number.isFinite(s0) || !Number.isFinite(s1) || s1 <= s0) return sendJson(res, 400, { ok: false, error: "start / end 要是秒数且 end > start" });
            const g = grid === 9 ? 9 : 4;
            const cols = g === 9 ? 3 : 2;
            const ffmpeg = ffmpegCommand();
            if (!ffmpeg) return sendJson(res, 500, { ok: false, error: "这台机器上找不到 ffmpeg" });
            const eps = 0.05;
            const dur = Math.max(0.1, s1 - s0 - eps);
            const hash = mediaHashOf(media);
            const dir = path.join(outRoot(root), "sheets");
            await fsp.mkdir(dir, { recursive: true });
            const key = hash
              ? createHash("sha1").update(`media:${hash}|${s0.toFixed(2)}|${s1.toFixed(2)}|${g}`).digest("hex").slice(0, 20)
              : `once-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            const out = path.join(dir, `${key}.jpg`);
            let cached = !!hash && fs.existsSync(out);
            if (!cached) {
              // 先问素材服务有没有这份字节:没有就如实回 404,别让 ffmpeg 对着一个 404 地址报一串看不懂的错。
              // 用 GET + Range 只取 1 字节 —— /api/media/file 这条老路由不答 HEAD
              const probe = await fetch(file, { headers: { Range: "bytes=0-0" } }).catch(() => null);
              probe?.body?.cancel().catch(() => {});
              if (!probe || !probe.ok) return sendJson(res, 404, { ok: false, error: `素材服务上取不到这份素材(${probe ? `HTTP ${probe.status}` : "连不上"}),重新导入一次再试` });
            }
            if (!cached) {
              await new Promise<void>((resolve, reject) => {
                const args = [
                  "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
                  "-ss", (s0 + eps).toFixed(3), "-t", dur.toFixed(3), "-i", file,
                  // fps 取 grid 帧、缩到 480 宽、tile 拼成 cols 列;不够 grid 帧(镜头太短)时剩下的格子留底色
                  "-vf", `fps=${(g / dur).toFixed(6)},scale=480:-2:flags=fast_bilinear,tile=${cols}x${cols}:padding=2:margin=2:color=0x111318`,
                  "-frames:v", "1", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", out,
                ];
                const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
                let err = "";
                child.stderr.on("data", (c) => { err += c; });
                const timer = setTimeout(() => { child.kill(); reject(new Error("ffmpeg 拼图超时")); }, EXTRACT_TIMEOUT_MS * 2);
                child.on("error", (e) => { clearTimeout(timer); reject(e); });
                child.on("close", (code) => {
                  clearTimeout(timer);
                  // 失败时写了一半的图别留下:有哈希的那张下次会被当成缓存命中
                  if (code !== 0 || !fs.existsSync(out)) {
                    fs.rmSync(out, { force: true });
                    return reject(new Error(`ffmpeg 退出码 ${code}${err ? `:${err.trim().slice(-300)}` : ""}`));
                  }
                  resolve();
                });
              });
            }
            let base64: string;
            try {
              base64 = (await fsp.readFile(out)).toString("base64");
            } finally {
              // 不进缓存的那一张用完就删
              if (!hash) await fsp.rm(out, { force: true }).catch(() => {});
            }
            const frames = Array.from({ length: g }, (_, k) => Math.round((s0 + eps + (dur * k) / g) * 100) / 100);
            sendJson(res, 200, { ok: true, grid: g, cols, frames, cached, __image: { mime: "image/jpeg", base64 } });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /*
       * /api/ai/visual —— 聊天栏里「看得见的工具结果」(执行这一侧见 src/ai/mcpExecutor.ts 的 withVisual)。
       *
       *   POST /                    { tool, images?, clipId?, before?, after?, render? } → { visualId, … }
       *   GET  /<visualId>.json     这条记录
       *   GET  /file/<name>         存下来的位图(see_frames 当时返回的那几张)
       *   GET  /gif/<key>.gif       一张卡的 8 帧动图
       *
       * 动图**用户点开时才渲**:POST 只存「怎么渲」(那张卡当时的样子,isolateClip 之后的迷你工程),
       * 第一次 GET 才渲染、编码、落盘,之后读缓存 —— Agent 调工具只多一次本地写文件。
       *
       * 谁要的决定排哪条队(`docs/semantics/product/rendering.md`「AI 栏的操作预览可以插队」、
       * `mechanism/rendering.md`「查询渲染与预渲染进程」):
       *   - 用户点开的 GET 是**用户触发的**:`lane: "preview"`,插在普通预渲染队列(FramePipeline 的 `'queue'` lane)所有待办之前,
       *     正在跑的那一项不打断;**不占用 Agent 的专用实例**,也不经 vision 的优先级队列(那是另一个队列,
       *     排在它前面插不到预渲染待办之前,导出期间还会把优先级 0 整个停住)。
       *   - 模型的 get_gif(`/render`)是 Agent 自己要的:照旧走 Agent 专用实例(`lane: "agent"`),vision 队列前台优先级(1)。
       * 两边同一个 key 同时在渲时共用那一趟(`gifInflight`):后到的一方等先开工的那一趟,不再另渲一遍。
       */
      // 搬进 server/vision/ 之后这条相对路径要多退一级(原文件在 server/ 下,写的是 "./ai-visual.mjs")
      const visualLib = () => import(new URL("../ai-visual.mjs", import.meta.url).href);
      /*
       * 渲染规格(spec-<key>.json)、可视化记录(v-*.json)、位图和动图都落在这一个**几个进程共用的目录**里
       * (T1a 审查 #13):`outRoot` = `PROMPTCUT_EXPORT_DIR`(缺省 `<root>/out`),编辑器进程拉起的预渲染进程
       * 继承同一个值,拆分(cloud-task.md I4(d))时 `user` / `agent` 两个进程也一样。所以模型的 `get_gif` 在
       * `agent` 进程里写下的规格,用户点开动图的 GET、模型要的 `/render` 路由到 `user` 进程照样读得到;
       * 像素只在 `user` 进程渲(cloud-task.md 决议 12)。
       * 写一律先写临时文件再改名(`ai-visual.mjs` 的 `atomicWrite`),另一个进程读不到半截。
       * `gifInflight` 只在本进程里去重:两个进程同时点开同一张没渲过的动图会各渲一遍,结果一样,后改名的覆盖先到的。
       */
      const visualDir = () => path.join(outRoot(root), "ai-visual");
      const gifInflight = new Map<string, Promise<{ gif: string; grid: string; times: number[] }>>();

      async function saveCardSpec(project: any, clipId: string) {
        const visual = await visualLib();
        const iso = isolateClip(resolveMediaUrls(project).project, clipId, { preserveContext: true });
        if (!iso) return null;
        const times = visual.sampleTimes(iso.clip);
        const key = visual.specKey(iso.project, clipId);
        const dir = visualDir();
        await visual.writeJson(dir, visual.gifPaths(dir, key).spec, { project: iso.project, clipId, times });
        return { key, clip: iso.clip, gif: `/api/ai/visual/gif/${key}.gif` };
      }

      function ensureGif(key: string, who: "user" | "model") {
        const running = gifInflight.get(key);
        if (running) return running;
        const job = (async () => {
          const visual = await visualLib();
          const dir = visualDir();
          const p = visual.gifPaths(dir, key);
          const spec = await visual.readJson(dir, p.spec);
          if (!spec) throw Object.assign(new Error("找不到这张动图的渲染规格(可能是清理过 out/ai-visual)"), { status: 404 });
          if (fs.existsSync(p.gif) && fs.existsSync(p.grid)) return { gif: p.gif, grid: p.grid, times: spec.times };
          const ffmpeg = ffmpegCommand();
          if (!ffmpeg) throw new Error("这台机器上找不到 ffmpeg,做不了动图");
          const notes: string[] = [];
          const fps = spec.project.fps || 30;
          const maxFrame = Math.max(0, Math.floor((spec.project.duration || 0) * fps) - 1);
          const frameOf = (t: number) => Math.min(maxFrame, Math.max(0, Math.round(t * fps)));
          const frames = who === "user"
            ? await renderFrames(root, originOf(server), spec.project, spec.times, notes, 0, { lane: "preview" })
            : await enqueue(() => renderFrames(root, originOf(server), spec.project, spec.times, notes, 1, { lane: "agent" }), 1, 25000);
          const bufs = spec.times.map((t: number) => frames.get(frameOf(t))?.buf).filter(Boolean) as Buffer[];
          if (!bufs.length) throw new Error("一帧都没渲出来");
          // 给用户看的动图裁到这张卡出现过的区域(整屏缩到一百来像素宽字就看不清了);交给 Agent 的拼图照旧整屏
          const crop = await visual.contentCrop(bufs).catch(() => null);
          await visual.encodeGif({ ffmpeg, frames: bufs, outGif: p.gif, outGrid: p.grid, crop });
          return { gif: p.gif, grid: p.grid, times: spec.times };
        })().finally(() => gifInflight.delete(key));
        gifInflight.set(key, job);
        return job;
      }

      server.middlewares.use("/api/ai/visual", (req, res) => {
        const url = String(req.url || "/").split("?")[0];
        // `code`:模式不接时(预渲染进程的 `NO_AGENT_LANE` / `NO_PRERENDER`,`prerender-mode.mjs`)原样带出,调用方分得清
        const fail = (e: any) => sendJson(res, e?.status || 500, { ok: false, error: e?.message || String(e), ...(typeof e?.code === "string" ? { code: e.code } : {}) });

        if (req.method === "GET") {
          (async () => {
            const visual = await visualLib();
            const dir = visualDir();
            let m: RegExpExecArray | null;
            if ((m = /^\/(v-[0-9a-z]{6,40})\.json$/.exec(url))) {
              const rec = await visual.readJson(dir, `${m[1]}.json`);
              return rec ? sendJson(res, 200, { ok: true, record: rec }) : sendJson(res, 404, { ok: false, error: "没有这条可视化记录" });
            }
            if ((m = /^\/file\/([^/]+)$/.exec(url))) {
              const name = visual.safeFileName(m[1]);
              const file = name && path.join(dir, name);
              if (!file || !fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: "没有这个文件" });
              const ext = path.extname(file).slice(1);
              res.setHeader("Content-Type", ext === "jpg" ? "image/jpeg" : `image/${ext}`);
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
              return fs.createReadStream(file).pipe(res);
            }
            if ((m = /^\/gif\/([0-9a-f]{16})\.gif$/.exec(url))) {
              const g = await ensureGif(m[1], "user");
              res.setHeader("Content-Type", "image/gif");
              res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
              return fs.createReadStream(g.gif).pipe(res);
            }
            sendJson(res, 404, { ok: false, error: "没有这个接口" });
          })().catch(fail);
          return;
        }
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "GET / POST only" });

        /*
         * `POST /api/ai/visual/render { key }`:按已写好的规格渲一张动图,回拼图(给模型看)和动图地址。
         * **这是动图像素渲染唯一的入口之一(另一个是上面用户点开的 GET),都属 `user` 角色**
         * (cloud-task.md 决议 12:Agent 进程只写 Spec,渲染一律由用户本机的 `user` 进程负责)。
         * 模型的 `get_gif` 分两步:先 `POST /api/ai/visual` 只写规格(`'agent'`),再打这里渲(`'user'`);
         * 拆分(I4)之后这条路由到 `user` 进程,Agent 进程不做任何动图渲染。
         */
        if (url === "/render") {
          let raw = "";
          let tooBig = false;
          req.on("data", (c) => { if (tooBig) return; raw += c; tooBig = overLimit(req, res, raw.length, 64 * 1024, "请求体超过 64KB"); });
          req.on("end", async () => {
            if (tooBig) return;
            try {
              const { key } = JSON.parse(raw || "{}");
              if (typeof key !== "string" || !/^[0-9a-f]{16}$/.test(key)) return sendJson(res, 400, { ok: false, error: "缺少合法的 key" });
              const g = await ensureGif(key, "model");
              const grid = (await fsp.readFile(g.grid)).toString("base64");
              sendJson(res, 200, { ok: true, times: g.times, gifUrl: `/api/ai/visual/gif/${key}.gif`, grid });
            } catch (e: any) {
              fail(e);
            }
          });
          return;
        }

        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const visual = await visualLib();
            const dir = visualDir();
            // 这条只写规格和记录,不渲动图(决议 12);老调用方带的 `render` 字段不再触发渲染,渲染走 `/render`
            const { tool, images, clipId, before, after } = JSON.parse(body || "{}");
            const record: any = { tool: String(tool || ""), createdAt: new Date().toISOString() };
            if (Array.isArray(images) && images.length) {
              record.images = [];
              for (const im of images.slice(0, 16)) {
                if (!im?.base64) continue;
                const saved = await visual.saveImage(dir, { mime: im.mime, base64: im.base64 });
                record.images.push({ url: saved.url, label: String(im.label || "") });
              }
            }
            let afterSpec: any = null;
            if (typeof clipId === "string" && clipId) {
              record.clipId = clipId;
              const beforeSpec = before && Array.isArray(before.tracks) ? await saveCardSpec(before, clipId) : null;
              afterSpec = after && Array.isArray(after.tracks) ? await saveCardSpec(after, clipId) : null;
              if (beforeSpec) record.before = { gif: beforeSpec.gif };
              if (afterSpec) record.after = { gif: afterSpec.gif };
              if (beforeSpec && afterSpec) record.diff = visual.diffClips(beforeSpec.clip, afterSpec.clip);
            }
            const visualId = visual.newVisualId();
            await visual.writeJson(dir, `${visualId}.json`, record);

            // 有规格就把键带回去,`get_gif` 拿它去 `/render`;没有(片段不在)由调用方如实报错
            sendJson(res, 200, { ok: true, visualId, ...(afterSpec ? { gifKey: afterSpec.key, gifUrl: afterSpec.gif } : {}) });
          } catch (e: any) {
            fail(e);
          }
        });
      });

      server.middlewares.use("/api/vision/snapshot", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, t, clipId, times } = JSON.parse(body || "{}");
            // 调用方断开(Agent 那边放弃等待、页面掐了请求)就不渲了:排队的摘掉,在跑的叫停
            const signal = abortOnClose(res);
            if (!project || !Array.isArray(project.tracks)) {
              return sendJson(res, 400, { ok: false, error: "缺少 project" });
            }

            const resolved = resolveMediaUrls(project);
            let target = resolved.project;
            let at = Number(t);
            const notes: string[] = [];
            if (resolved.unresolved.length) {
              notes.push(`这些素材服务端取不到文件,画面里它们那一层是空的(不是卡片的问题):${resolved.unresolved.join("、")}。`);
            }
            if (clipId) {
              const iso = isolateClip(target, clipId, { preserveContext: true });
              if (!iso) return sendJson(res, 404, { ok: false, error: `时间轴上没有 id 为 ${clipId} 的片段。` });
              target = iso.project;
              // 没指定时间就取这一段的中点:起止两端常常正卡在进场 / 退场动画上,
              // 拿那一帧去判断「这张卡长什么样」会看到一个半透明的中间态。
              if (!Number.isFinite(at)) at = (iso.clip.start + iso.clip.end) / 2;
              notes.push(iso.context ? `渲染了片段 ${clipId}，并保留它需要的下方合成背景。` : `只显示片段 ${clipId}，其他片段仅保留为不可见的输入依赖。`);
            }
            if (!Number.isFinite(at)) at = 0;

            /*
             * 先把 at 夹到项目时长内,**再**拿去渲、也拿它回话。
             *
             * renderOneFrame 内部本来就会夹(帧号超出时长会渲到一个空舞台),但以前回话里的
             * `t` 回的是**入参**。于是「你要 t=30、实际渲的是片尾那一帧」时,返回值还理直气壮地
             * 说 t:30 —— 模型对着一张不是它要的画面,却没有任何线索知道发生了截断,
             * 只会以为「这一刻长这样」。报一个渲另一个,是最难查的那种错。
             */
            const fpsOf = target.fps || 30;
            const lastT = Math.max(0, Math.floor((target.duration || 0) * fpsOf) - 1) / fpsOf;
            if (at > lastT) {
              notes.push(`要看的 ${at} 秒超过了整条片子的长度(${target.duration} 秒),实际渲的是最后一帧 ${lastT.toFixed(2)} 秒。`);
              at = lastT;
            }

            notes.push("画面里的灰色棋盘格是**透明**,不是画面内容 —— 那里什么都没画。卡片盖住的地方看不到格子。") ;
            /*
             * times:一次看多个时刻,**合成一趟渲**(renderFrames:从第 0 帧顺推,沿途截这几帧)。
             *
             * 以前前端逐个时刻调本接口,每张都从第 0 帧重推 —— 看 8 个时刻就推 8 遍。
             * 推进才是大头:一帧约 20ms,第 19 秒就是 570 帧;而准备一趟(常驻 worker 里换页)只要约 0.3 秒。
             * 一趟推到最晚那个时刻,成本从「各时刻帧数之和」降到「最大帧数」。
             * 截出来的画面和逐张渲逐字节相同:单张走的 frames `F-F` 同样是从第 0 帧推到 F。
             */
            const list = Array.isArray(times) ? times.map(Number).filter(Number.isFinite).slice(0, 10) : [];
            if (list.length) {
              const maxFrame = Math.round(lastT * fpsOf);
              const clamped = list.map((x) => Math.min(Math.max(0, x), lastT));
              if (clamped.some((x, i) => x !== list[i])) {
                notes.push(`有的时刻超出了片子的长度(${target.duration} 秒),按最后一帧 ${lastT.toFixed(2)} 秒渲。`);
              }
              // 缩图在渲染 worker 里做(post.shrink),这里拿到的就是给模型看的那张,只做 base64
              const shots = await enqueue(
                () => renderFrames(root, originOf(server), target, clamped, notes, 1, { signal, post: { shrink: true } }),
                1, 25000, signal,
              );
              const frames: any[] = [];
              const images: any[] = [];
              clamped.forEach((x, i) => {
                const r = shots.get(Math.min(maxFrame, Math.max(0, Math.round(x * fpsOf))));
                if (!r) return;
                // D3:实体矩形(舞台像素坐标),文字那份已经由 renderFrames 写进 notes
                frames.push({ t: x, clipId: clipId || null, width: r.width, height: r.height, rects: r.rects ?? null });
                images.push({ mime: "image/png", base64: r.buf.toString("base64"), label: `t=${list[i]}s` });
              });
              return sendJson(res, 200, {
                ok: true,
                frames,
                // 素材层按帧各抽各的,取不到文件时每一帧都会记一条同样的话 —— 去重
                note: [`${images.length} 张画面按 times 的顺序排列,每张标着时刻。`, ...new Set(notes)].join(" "),
                __images: images,
              });
            }
            /*
             * **前台优先级(1),不是默认的 0。**
             *
             * see_frames 是模型正阻塞着等的那一张 —— 前台里最前台的。可它原来用默认
             * priority,于是掉进 pumpRenderQueue 给后台留的那道限制里:后台只能用到
             * `max - 1` 个槽位,而且要和空闲预渲染按先来后到排。也就是说,那个「永远给
             * 前台留一个槽位」的设计恰好把真正的前台挡在了外面。
             *
             * 排队看门狗给 25 秒:加上渲染自己的 120 秒上限,合起来 145 秒,刚好落在
             * see_frames 那 150 秒工具上限之内 —— 保证超时之前一定能给出一句
             * **说得清原因**的话,而不是让上层回一句无从下手的「没有返回」。
             */
            const shot = await enqueue(
              () => renderOneFrame(root, originOf(server), target, at, notes, 1, { signal, post: { shrink: true } }),
              1, 25000, signal,
            );
            const { width, height } = shot;
            const base64 = shot.buf.toString("base64");

            sendJson(res, 200, {
              ok: true,
              t: at,
              clipId: clipId || null,
              width,
              height,
              // D3:实体矩形(舞台像素坐标),文字那份已经由 renderOneFrame 写进 notes
              rects: shot.rects ?? null,
              note: notes.join(" "),
              // 这个形状是和 harness/agent.mjs(以及走 CLI 那条路的 mcp-server.mjs)
              // 约好的:看到 __image 就把它当图片块送进上下文,而不是让 base64
              // 混在工具结果的 JSON 文本里 —— 那样模型看不见画面,还白烧几十万字符。
              __image: { mime: "image/png", base64 },
            });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /**
       * POST /api/vision/bake { project, clipId, t, size } —— 把一张卡预渲染成透明底 PNG,经素材服务存进 `px`。
       *
       * 和 /snapshot 是同一条渲染管线(isolateClip + renderOneFrame),差别只有两点:
       * 不缩图(纹理要原尺寸),以及把结果**经素材服务入库**成 `/api/asset/px/<内容哈希>` 而不是塞进上下文给模型看
       * (`bake.ts` 的 bakeOne、`server/bake-store.mjs`)。素材服务不可达时回 500,`error` 写明地址与原因。
       *
       * # 为什么这条路不会让预览和导出分叉
       *
       * 因为预渲染是**一次性的、发生在更早**的一步:画这张图的就是导出成片的那个渲染器
       * (server/bakery/)。之后预览和导出都只是加载同一个文件,谁都不做栅格化。
       * 「浏览器里没有 DOM → 位图的原语」这句话是对的,但它推不出「所以做不了」——
       * 只要不要求**当场**栅格化,服务端这条管线本来就产得出那张位图。
       *
       * # 它是快照,不是活的
       *
       * 卡片的动画定格在 t 那一帧;卡片参数改了纹理不会跟着变,要重新渲。
       * 这个限制看得见(画面明显停住),所以可以接受 —— 静默的分叉才是不能接受的那种。
       */
      /**
       * POST /api/vision/bake-batch { project, clips: [{clipId, t}], size, bg } —— 一次问一批。
       *
       * 给 3D 视图用的(不是 MCP 工具,Agent 那边用单张的 bake_card 就够)。
       * 实现上就是**顺着渲**,快在缓存:缓存键按「输入」算哈希(卡片内容 + t + size + bg),
       * 所以同一张卡同样的参数只会真渲一次,之后开多少次 3D 视图都是索引命中、直接返回。
       *
       * 试过把 N 张摊进一个项目的 N 个时间槽、一趟渲完,实测 4 张 18.7 秒,而单张 4.7~6.5 秒 ——
       * 一点没快:瓶颈不是起 Chrome,是那条路要**逐帧走完整条时间轴**(4 张卡摊开就是 120 帧),
       * 而 bakeFrames 的 --frames 只收连续区间,挑不出那 4 帧。所以那条路撤掉了,
       * 真正的快法是命中缓存 —— 用户手里的卡大多是预渲染过的,这也正是「一般不用代理」的前提。
       */
      server.middlewares.use("/api/vision/bake-batch", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clips, size, bg, priority } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
            if (!Array.isArray(clips) || !clips.length) return sendJson(res, 400, { ok: false, error: "缺少 clips" });
            const resolved = resolveMediaUrls(project).project;
            const baked: any[] = [];
            const failed: any[] = [];
            const pri = Number(priority) > 0 ? 1 : 0;
            /*
             * 3D 视图的贴图不是 Agent 的请求,不进 Agent 专用实例(`mechanism/rendering.md`「Agent 优先只是插队」):
             * 空闲预取(优先级 0)是普通预渲染,排普通预渲染队列的队尾,Agent 专用实例空闲时可以接;
             * 用户正等着看的(优先级 1)插在普通预渲染待办之前。
             */
            const lane = pri > 0 ? "preview" : "prerender";
            // 预渲染那边一换计划就会掐掉在飞的批次:断开之后这一批还没开渲的全部摘掉,别占着 Chrome
            const signal = abortOnClose(res);
            /*
             * **先按卡分组。** 同一张卡的几个时刻合成一趟渲(见 bakeClip):导出脚本从第 0 帧顺推,
             * 「渲第 F 帧」已经把 0..F 推了一遍,同一张卡里其余 ≤F 的时刻是顺路白捡的。
             * 实测同一张卡 7 个时刻:分趟 31.0s → 一趟 2.7s,而且逐字节相同。
             *
             * 分组**不改批次的先后**:调用方按离播放头的距离排好序发过来,这里用 Map 保持首次出现的
             * 顺序,所以最近的那张卡仍然第一个开渲 —— 「先渲播放头附近」这条没有被牺牲。
             */
            const byClip = new Map<string, number[]>();
            for (const c of clips) {
              if (!c || typeof c.clipId !== "string") continue;
              const arr = byClip.get(c.clipId);
              if (arr) arr.push(Number(c.t)); else byClip.set(c.clipId, [Number(c.t)]);
            }
            /*
             * **一次全放进去,让渲染池去并行**,不要在这儿一张张 await。
             * 一张失败不拖垮整批,所以用 allSettled —— 3D 视图那边拿到几张就先贴几张。
             */
            const settled = await Promise.allSettled(
              [...byClip].map(([clipId, ts]) => bakeClip(root, originOf(server), resolved, clipId, ts, size, bg, "box", pri, { signal, lane })
                .then((r) => r, (e) => { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { clipId }); })),
            );
            for (const s of settled) {
              if (s.status === "fulfilled") baked.push(...s.value);
              else failed.push({ clipId: (s.reason as any)?.clipId, error: (s.reason as any)?.message || String(s.reason) });
            }
            sendJson(res, 200, { ok: true, baked, failed });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });
      /**
       * POST /api/vision/bake-status { project, clips: [{clipId, t}], size, bg } —— 预渲染的「盘点」。
       *
       * 只查不渲:告诉调度器**哪些已经渲好了、各自多大**,以及索引里还记着哪些
       * 这个项目里已经用不到的旧快照(orphans)。
       *
       * 为什么必须由服务端来答:缓存记在服务端(字节在素材服务,「输入哈希 → 内容哈希」在索引),而浏览器关一次页面
       * 就全忘了 —— 上次开编辑器预渲染出来的,前端一个都不认识。
       * 「渲好了」要索引里有、且素材服务上这一块收全(`bakedOf`,同步状态只问素材服务);素材服务不可达时回 500。
       *
       * 键的算法只有 bakeTarget 一处(预渲染、盘点、清理三方共用),所以不会出现
       * 「明明预渲染过却当成没渲」或者「把正在用的文件删了」这种对不上账的事。
       */
      server.middlewares.use("/api/vision/bake-status", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clips, size, bg } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
            const resolved = resolveMediaUrls(project).project;
            const onDisk = new Map((await listBakes(root)).map((f) => [f.key, f]));
            const items: any[] = [];
            const mine = new Set<string>();
            for (const c of Array.isArray(clips) ? clips : []) {
              if (!c || typeof c.clipId !== "string") continue;
              try {
                const { key, name } = bakeTarget(resolved, c.clipId, Number(c.t), size, bg, "box");
                mine.add(key);
                items.push({ clipId: c.clipId, t: Number(c.t), key, name, url: null, bytes: null });
              } catch (e: any) {
                // 素材段之类渲不了的,如实报出来,别让调度器一直重试
                items.push({ clipId: c.clipId, t: Number(c.t), key: null, bytes: null, error: e?.message || String(e) });
              }
            }
            // 这个项目要的那些键里哪些渲好了:索引里有、且素材服务上收全(素材服务里没了的,索引条目当场删掉)
            const baked = await bakedOf(root, [...mine]);
            for (const it of items) {
              const hit = it.key ? baked.get(it.key) : undefined;
              if (hit) { it.url = hit.url; it.bytes = hit.bytes; }
              else if (it.key) onDisk.delete(it.key);
            }
            /*
             * 这个项目当前用不到的快照。绝大多数是**改过参数之后留下的旧版本** ——
             * 缓存键是卡片内容的哈希,改一次参数就多一条,旧的再也不会被命中。
             * 编辑期这才是文件数增长的主因,比「片子太长装不下」常见得多。
             */
            const orphans = [...onDisk.values()].filter((f) => !mine.has(f.key));
            const totalBytes = [...onDisk.values()].reduce((s, f) => s + f.bytes, 0);
            /*
             * concurrency:池子多大,预渲染按它决定一次发几张才喂得满。
             * running:此刻真有几个渲染在跑。后台最多用到 concurrency-1(留一个给前台),
             *   所以这两个数是「槽位有没有留住」唯一可信的观测口。
             *
             * 别拿 out/export-vision-* 的目录数去数并发:那些目录是 fire-and-forget 删的
             * (见 renderOneFrame 的 finally),跑完还没删掉的会和在跑的叠在一起 ——
             * 实测 7 个槽位数出来 10 个,那是量具错了,不是并发超了。
             */
            sendJson(res, 200, {
              ok: true, items, orphans, totalBytes, fileCount: onDisk.size,
              concurrency: maxConcurrentRenders(), running: renderRunning,
              // 常驻 worker 有几个活着。冷的时候是 0,渲过之后应该稳定在并发用到的那个数上;
              // 要是它一直等于 running 又不停变,说明 worker 在被反复杀掉重开(见 killWorker)
              workers: renderWorkers.length,
              // 前台专属的那个热 Chrome 在不在。它应该长期是 1 —— 掉到 0 就说明常驻没留住
              reservedWorkers: renderWorkers.filter((w) => w.reserved && !w.dead).length,
            });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      /**
       * POST /api/vision/bake-evict { keys: ["a1b2c3d4e5f6", ...] } —— 淘汰这些 PNG 快照。
       *
       * 传的是键(12 位哈希),不是路径:要删哪条由服务端拿自己的索引比对,删的只是索引条目,
       * 碰不到索引以外的文件。字节留在素材服务里(没有删除接口),见 bake-cache.ts 的 evictBakes。
       */
      server.middlewares.use("/api/vision/bake-evict", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 4 * 1024 * 1024, "请求体超过 4MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { keys } = JSON.parse(body || "{}");
            const out = await evictBakes(root, keys);
            sendJson(res, 200, { ok: true, ...out });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      server.middlewares.use("/api/vision/bake", (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        let body = "";
        let over = false;
        req.on("data", (c) => { if (over) return; body += c; over = overLimit(req, res, body.length, 64 * 1024 * 1024, "请求体超过 64MB"); });
        req.on("end", async () => {
          if (over) return;
          try {
            const { project, clipId, t, size, bg } = JSON.parse(body || "{}");
            if (!project || !Array.isArray(project.tracks)) return sendJson(res, 400, { ok: false, error: "缺少 project" });
            if (!clipId) return sendJson(res, 400, { ok: false, error: "缺少 clipId:一次只能渲染一张卡" });
            // 和 /snapshot 同理:bake_card 是模型正阻塞着等的一次调用,在预渲染池里排最前(priority 1),
            // 不该排在空闲预渲染后面。fit 保持默认的 square —— 贴图要正方形
            const signal = abortOnClose(res);
            const out = await bakeOne(root, originOf(server), resolveMediaUrls(project).project, clipId, Number(t), size, bg, "square", 1, undefined, { signal });
            sendJson(res, 200, { ok: true, ...out });
          } catch (e: any) {
            sendJson(res, 500, { ok: false, error: e?.message || String(e) });
          }
        });
      });
}
