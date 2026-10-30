import type { Plugin, ViteDevServer } from "vite";
import { originOk, jsonContentType, apiPath, isAssetServicePath, fromLocalClient, lanApiAllowed } from "./http-guard.mjs";

/**
 * `/api/**` 的同源守卫。**一个卡口,不是十二个。**
 *
 * # 为什么要有
 *
 * sidecar 监听 127.0.0.1,很容易觉得「只有自己人访问得到」。不对:用户浏览器里**任何一个
 * 网页**都能往 127.0.0.1 发请求。跨源的响应它读不到(同源策略挡的是「读」),但请求照发,
 * **副作用照发生** —— 只要那是一个「简单请求」(GET/HEAD,或 POST 且 Content-Type 属于
 * text/plain、application/x-www-form-urlencoded、multipart/form-data 三者之一),浏览器
 * 连预检都不发,服务端这边根本没有拒绝的机会。
 *
 * 0.3.0 评审实际打穿的一条:恶意页面对 `/api/ai/config` 发一个 `text/plain` 的 POST,
 * body 是 `{"api":{"baseUrl":"https://攻击者"}}`。writeConfig 是局部合并,payload 里没有
 * apiKey 就沿用旧的 —— 用户真实的 Key 原样留着,下一次对话连着 Key 一起打到攻击者服务器。
 * 攻击者全程不需要读到任何响应。同类的还有任意文件读(`/api/chats/attach/import`、
 * `/api/skill/open-path`)、任意写(`/api/media/upload/`)、强制弹资源管理器
 * (`/api/ai/diagnostics/save`)、递归删目录(当时 Skill 任务目录的删除接口,已归档)、改用户级 MCP 配置
 * (`/api/skill/desktop-register`)。
 * (注:上一行的路径别写成星号通配 —— 那会在块注释里造出一个 `*` 加 `/`,把注释提前闭合。)
 *
 * # 为什么放在一个中间件里,而不是每个 handler 开头加一句
 *
 * 全仓 14 个插件、几十条路由,靠「每个人记得加」这件事已经失败过一次 —— 改之前整个仓库
 * 只有 2 处调了 originOk。卡口放在最前面,新加的路由**默认就是受保护的**,忘不掉。
 *
 * # 两道判据
 *
 * 1. **Origin**:跨源 POST 浏览器必带 Origin,和本站对不上就 403。同源 GET 和 curl /
 *    sidecar / MCP 脚本不带 Origin —— 放行,CSRF 讲的是「浏览器替用户发的请求」。
 * 2. **带 body 就必须是 application/json**:那三种「简单类型」一律拒。这一道比第 1 道硬,
 *    它不依赖 Origin 头存在:攻击页想带 body 就必须声明 Content-Type,声明 json 就会触发
 *    预检,而我们不回 CORS 头,预检过不去。
 *    没有 Content-Type 的请求(无 body 的 POST,如 `/api/shots/install`)豁免这一道 ——
 *    自家界面就是这么发的 —— 它们由第 1 道兜。
 *
 * 上传原始字节的两条路由豁免第 2 道:它们的 body 是一个 File,Content-Type 由浏览器按文件
 * 类型填(传 .txt 就正好是 text/plain)。它们仍受第 1 道保护。
 */

/** body 是原始字节、Content-Type 由文件类型决定的路由前缀 */
// 对话附件的「+」上传也是把 File 原样当 body(Content-Type 按文件类型填,视频就是 video/mp4)。
// 漏了这一条的后果是附件一个都传不上去,界面只说「导入失败」。
// 听写(transcribe_media)也是先把素材原样 POST 到 /api/stt/upload/<job>/<名字>,同一个道理。
// 导出的混音页把渲好的 mix.wav 原样 POST 回来(/api/export/audio-mix/<id>,见 src/AudioMixView.tsx),也是原始体。
// 这五条就是全部原始体路由:服务端里只有它们直接把 req 往文件里灌(见 api-guard.test.mjs)。
const RAW_BODY_PREFIXES = ["/api/media/upload/", "/api/export/media/", "/api/chats/attach/upload", "/api/stt/upload/", "/api/export/audio-mix/"];

export function apiGuardPlugin(): Plugin {
  return {
    name: "promptcut-api-guard",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        // 必须走 apiPath 归一化(转小写 + 折斜杠)。connect 匹配路由不区分大小写,
        // 用区分大小写的 startsWith 判断的话,一个 `/aPi/ai/config` 就能把整道卡口穿掉 ——
        // 实测真的改掉了 ai.json 里的 baseUrl。详见 http-guard.mjs 里 apiPath 的说明。
        const url = apiPath(req.url);
        if (!url.startsWith("/api/")) return next();
        // 素材服务的路由允许跨源(局域网里的其它设备要能直接访问),由它自己回 CORS 头和预检。
        // 只豁免严格匹配的那几种路径,判据见 http-guard.mjs 的 isAssetServicePath。
        if (isAssetServicePath(req.url)) return next();

        const deny = (error: string) => {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ ok: false, error }));
        };

        // 局域网监听之后「不带 Origin 当自己人」只对本机成立,理由见 http-guard.mjs 的 fromLocalClient
        if (!lanApiAllowed() && !fromLocalClient(req)) {
          return deny("局域网设备只能访问素材服务;要开放其它接口,启动时设 PROMPTCUT_LAN_API=1");
        }

        if (!originOk(req)) {
          return deny(`跨源请求被拒绝(Origin: ${req.headers.origin})`);
        }

        const method = String(req.method || "GET").toUpperCase();
        const hasCt = !!req.headers["content-type"];
        // url 已经转过小写,前缀表本来就是全小写的
        const rawBody = RAW_BODY_PREFIXES.some((p) => url.startsWith(p));
        if (method !== "GET" && method !== "HEAD" && hasCt && !rawBody && !jsonContentType(req)) {
          return deny("这个接口只接受 Content-Type: application/json");
        }

        next();
      });
    },
  };
}

export default apiGuardPlugin;
