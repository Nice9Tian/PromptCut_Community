import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse, IncomingMessage } from "node:http";
import fs from "node:fs";
import path from "node:path";

/**
 * SKILL 模式的开关接口,外加 .proc 的独占锁。
 *
 * 和 vite-plugin-skill.ts 分开:那边管「桌面 APP 怎么接进来」(登记),这边管「SKILL 开没开」(闸门的状态,
 * server/skill-gate.mjs)。
 *
 * 接口:
 *   GET  /api/skill-mode              现在是不是 SKILL 模式(前端每秒问一次,Rust 壳直接读文件)
 *   POST /api/skill-mode/open         开(用户在顶栏切到 SKILL)
 *   POST /api/skill-mode/close        关(用户切回传统式)
 *   POST /api/skill-mode/last-action  页面交回桌面会话上一步动作的画面,给 SKILL 悬浮窗
 *   POST /api/skill-lock/acquire      .proc 独占锁:打开项目时抢
 *   POST /api/skill-lock/release      放锁
 */

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("请求太大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error("读取请求体失败")));
  });
}

interface LockFile {
  pid: number;
  at: string;
  /** 谁占的,给冲突提示用 */
  host: string;
}

function lockPathFor(procPath: string): string {
  return procPath + ".lock";
}

function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 抢一份 .proc 的独占锁。
 *
 * 为什么要独占:两个 PromptCut 同时开着同一个 .proc,各自按自己内存里的状态往回写,
 * 后写的把先写的整份盖掉 —— 不是合并,是丢。所以一个文件只许一个实例写。SKILL 模式下也一样:
 * 桌面 APP 的会话改的就是这个实例里的项目,不另开副本。
 *
 * # 两层判据,顺序不能反
 *
 * 锁是旁路文件 `<name>.proc.lock`(**不是 .proc 本体** —— 实测独占本体之后 Node 连读都读
 * 不了,等于把自己人挡在门外)。判「有没有人占着」按可靠性从高到低试:
 *
 * 1. **内核说的**:`open(lock,'r+')` 拿到 EBUSY,说明有进程正用共享模式 0 握着这个句柄
 *    (桌面版里是 Rust 外壳干的,见 desktop/src-tauri/src/proc_lock.rs)。这个信号最硬 ——
 *    持有者一死内核立刻收走句柄,不存在死锁,也不用判活。
 * 2. **锁文件里的 pid**:没有外壳的时候(开发期 `npm run dev`、浏览器里跑)只能退到这条。
 *    弱在两处:持有者被强杀会留下死锁文件;pid 会被系统回收,死进程的号被新进程占了就
 *    误判成「还有人占着」。所以它只是兜底,能用第 1 条就不用它。
 *
 * 创建用 `open(path,'wx')` 而不是「先 existsSync 再写」—— 后者不是原子的,两个实例能同时
 * 通过检查然后都以为自己拿到了锁。wx 是原子的(实测 20 个进程并发抢,恰好 1 个赢)。
 */
export function acquireLock(procPath: string, retriesLeft = 3): { ok: boolean; error?: string; stolen?: boolean; by?: "kernel" | "pid" } {
  const file = lockPathFor(procPath);
  const mine = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: "promptcut" });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 原子创建。抢到了就是我的,不用再看任何东西
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    // 文件已经在了。先问内核:有没有人正握着它的句柄
    try {
      fs.closeSync(fs.openSync(file, "r+"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EBUSY") {
        return { ok: false, by: "kernel", error: "这个项目文件正被另一个 PromptCut 打开" };
      }
      // 别的错(权限之类)当作拿不到锁,但说清楚原因
      return { ok: false, error: `锁文件读不了:${(e as Error).message}` };
    }

    // 没人握句柄,退到 pid 那条弱判据。
    // 读不出内容的锁文件当**无主**处理:0 字节的锁是真会出现的 —— Rust 那边探活时用
    // 带 create 的方式开过它就会留下一个空文件。以前 JSON.parse 在这里抛出去,被最外层
    // 那个「锁写不出来不该挡住打开项目」的兜底接住并返回 ok:true —— 于是谁都没真拿到锁,
    // pid 这层防线对这个项目永久失效,还没有任何提示。
    let cur: LockFile | null = null;
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      const parsed = raw ? (JSON.parse(raw) as LockFile) : null;
      if (parsed && typeof parsed.pid === "number") cur = parsed;
    } catch { /* 内容非法 → 无主 */ }

    if (cur && cur.pid === process.pid) return { ok: true };
    if (cur && pidAlive(cur.pid)) {
      return { ok: false, by: "pid", error: `这个项目文件正被另一个 PromptCut 打开(进程 ${cur.pid},自 ${cur.at})` };
    }

    /*
     * 上一个持有者已经不在了(崩溃 / 强杀),或者这压根是个空壳锁 —— 接管。
     *
     * # 接管这件事本身必须是原子的
     *
     * 光「删掉再回头重抢」是不够的,这是上一版栽的地方:删除是**无条件**的,它不检查
     * 文件是不是还是刚才判死的那一个。两个实例错开一点点就会这样 ——
     *
     *   B: 读到死 pid,判定可以接管            (还没删)
     *   A: 读到死 pid → 删掉 → wx 建新锁 → 赢    (锁里现在是 A 的 pid)
     *   B: 接着往下走,把 **A 刚建好的锁**删掉 → wx → 也赢
     *
     * 两边都拿到 ok:true,两份 PromptCut 一起往同一个 .proc 上写。
     * (原来那条测试是 12 个进程齐步走,恰好掩盖了这种错开的时序。)
     *
     * # 改法:先原子认领「接管权」,再接管
     *
     * 用 `wx` 建一个旁路的 `.claim` 文件 —— 这一步是原子的,只有一个进程能建成。
     * 建成的那个才有资格删旧锁;没建成的直接回去重新走一遍正常判定:那时旧锁要么已经
     * 被赢家换成活着的 pid(于是它正确地被拒),要么恰好还没建好(于是它自己 wx 赢)。
     * 两种都只有一个赢家。
     *
     * claim 只在这几微秒里存在。万一持有 claim 的进程正好在这中间被强杀,claim 会残留 ——
     * 所以下面对 claim 也判一次活,死的就清掉,不让一个残留文件把项目永久锁死。
     */
    if (retriesLeft <= 0) {
      return { ok: false, error: "锁文件反复被别人抢走,请稍后再试" };
    }

    const claim = file + ".claim";
    try {
      fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // 有人正在接管同一个死锁。先看看那个人还活着没
      let holder: number | null = null;
      try {
        const raw = fs.readFileSync(claim, "utf8").trim();
        const parsed = raw ? (JSON.parse(raw) as LockFile) : null;
        if (parsed && typeof parsed.pid === "number") holder = parsed.pid;
      } catch { /* 读不出来就当没主 */ }
      if (holder === null || !pidAlive(holder)) {
        try { fs.unlinkSync(claim); } catch { /* 别人抢先清了,无所谓 */ }
      }
      // 回去重新走一遍正常判定 —— 赢家这时多半已经把新锁建好了
      return acquireLock(procPath, retriesLeft - 1);
    }

    try {
      // 只有拿到 claim 的这一个进程会走到这里
      try {
        fs.unlinkSync(file);
      } catch (e) {
        // 删不掉多半是这一瞬间被别人(外壳的内核句柄)握住了 —— 那就是活锁,不是死锁
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          return { ok: false, by: "kernel", error: "这个项目文件正被另一个 PromptCut 打开" };
        }
      }
      const again = acquireLock(procPath, retriesLeft - 1);
      return again.ok ? { ...again, stolen: true } : again;
    } finally {
      try { fs.unlinkSync(claim); } catch { /* 已经没了就算了 */ }
    }
  } catch (e) {
    // 锁写不出来(只读目录之类)不该把「打开项目」这件事整个挡掉
    return { ok: true, error: (e as Error).message };
  }
}

export function releaseLock(procPath: string): void {
  const file = lockPathFor(procPath);
  try {
    // 空壳锁(Rust 探活留下的 0 字节文件)也顺手清掉:留着它下一次 acquire 又要走一趟
    // 「无主 → 删 → 重抢」。别人真握着句柄的话 unlink 自己会失败,不会误删。
    const raw = fs.readFileSync(file, "utf8").trim();
    let cur: LockFile | null = null;
    try { cur = raw ? (JSON.parse(raw) as LockFile) : null; } catch { cur = null; }
    if (!cur || cur.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* 没有锁、不是我的锁、或者外壳正握着它(删不掉),都不用管 */
  }
}

export function skillStatePlugin(): Plugin {
  return {
    name: "promptcut-skill-state",
    configureServer(server: ViteDevServer) {
      /** 本进程持有的锁,退出时一并放掉 */
      const held = new Set<string>();
      const releaseAll = () => {
        for (const p of held) releaseLock(p);
        held.clear();
      };
      server.httpServer?.on("close", releaseAll);
      process.on("exit", releaseAll);

      server.middlewares.use("/api/skill-mode", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const action = url.pathname.replace(/^\/+/, "");
        try {
          const gate = await import(new URL("./skill-gate.mjs", import.meta.url).href);
          if (!action && req.method === "GET") {
            return sendJson(res, 200, { ok: true, state: gate.readState() });
          }
          if (action === "open" && req.method === "POST") {
            await readBody(req);
            return sendJson(res, 200, { ok: true, state: gate.openGate() });
          }
          // 页面交回「桌面会话上一步做成的时间轴动作」的画面(编辑器进程经 SSE 的 skill.preview 要的):
          // 写到 skillRoot/last-action.{png,json},壳的 watcher(desktop/src-tauri/src/skill_shell.rs)盯着 json 的
          // 修改时间推给悬浮窗。SKILL 模式关着时不收 —— 悬浮窗只在 SKILL 模式下存在。
          if (action === "last-action" && req.method === "POST") {
            if (!gate.readState().active) {
              return sendJson(res, 200, { ok: true, skipped: "skill-off" });
            }
            const body = JSON.parse((await readBody(req)) || "{}");
            const base64 = typeof body.base64 === "string" ? body.base64 : "";
            const png = Buffer.from(base64, "base64");
            if (png.length < 8 || png.subarray(0, 8).toString("binary") !== "\x89PNG\r\n\x1a\n") {
              return sendJson(res, 400, { ok: false, error: "base64 不是一张 png" });
            }
            const root = gate.skillRoot();
            fs.mkdirSync(root, { recursive: true });
            // png 先落临时文件再改名:壳每秒都在读,读到半张图就白推一次
            const pngPath = path.join(root, "last-action.png");
            fs.writeFileSync(pngPath + ".tmp", png);
            fs.renameSync(pngPath + ".tmp", pngPath);
            const meta = {
              tool: typeof body.tool === "string" ? body.tool.slice(0, 64) : null,
              clipId: typeof body.clipId === "string" ? body.clipId.slice(0, 64) : null,
              t: typeof body.t === "number" && Number.isFinite(body.t) ? body.t : null,
              at: new Date().toISOString(),
            };
            const jsonPath = path.join(root, "last-action.json");
            fs.writeFileSync(jsonPath + ".tmp", JSON.stringify(meta), "utf8");
            fs.renameSync(jsonPath + ".tmp", jsonPath);
            return sendJson(res, 200, { ok: true, ...meta, bytes: png.length });
          }
          if (action === "close" && req.method === "POST") {
            const body = JSON.parse((await readBody(req)) || "{}");
            const state = gate.closeGate(body.by || "user");
            // 记一行到 sidecar 日志:用户报「关闭中…卡死」时,先看这里有没有收到请求
            console.log(`[skill-mode] close by=${body.by || "user"} at=${state.closedAt}`);
            return sendJson(res, 200, { ok: true, state });
          }
          return sendJson(res, 404, { ok: false, error: "没有这个接口" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });

      server.middlewares.use("/api/skill-lock", async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        const url = new URL(req.url || "/", "http://localhost");
        const action = url.pathname.replace(/^\/+/, "");
        try {
          const body = JSON.parse((await readBody(req)) || "{}");
          /*
           * 前端手里通常只有草稿 id(路径规则在服务端,而且可以被 PROMPTCUT_PROJECTS_DIR
           * 改掉),所以这里两种都收:draftId 由 projects 插件解析成真实路径,path 留给
           * 已经知道绝对路径的调用方。
           */
          let raw = body.path;
          if (!raw && body.draftId) {
            const { draftFileFor } = await import(new URL("./vite-plugin-projects.ts", import.meta.url).href);
            raw = draftFileFor(server.config.root || process.cwd(), String(body.draftId));
            if (!raw) return sendJson(res, 400, { ok: false, error: "草稿 id 不合法" });
          }
          if (!raw) return sendJson(res, 400, { ok: false, error: "path 或 draftId 必填" });
          const target = path.resolve(String(raw));
          if (action === "acquire") {
            const out = acquireLock(target);
            if (out.ok) held.add(target);
            // 把解析出的真实路径回给前端:桌面壳那层要拿它去独占内核句柄
            return sendJson(res, out.ok ? 200 : 409, { ...out, file: target });
          }
          if (action === "release") {
            releaseLock(target);
            held.delete(target);
            return sendJson(res, 200, { ok: true });
          }
          return sendJson(res, 404, { ok: false, error: "没有这个接口" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

export default skillStatePlugin;
