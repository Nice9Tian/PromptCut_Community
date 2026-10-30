import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";

/**
 * 本地草稿:每份草稿就是磁盘上的一个 .proc 文件。
 *
 * 存在项目根的 `.pc-projects/` 下(和 `.pc-chats/` 一个路数,已在 .gitignore 里)。
 * 用真文件而不是 localStorage,是因为草稿要能被备份、拷走、和「保存项目」导出的
 * .proc 互换 —— 两边是同一个格式,导出的文件丢回这个目录就是一份草稿。
 */

const DIR = ".pc-projects";
const EXT = ".proc";

/** 草稿 id 只允许这些字符:直接当文件名用,不能让 ../ 之类跑出目录 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 导出给测试用:这道校验是唯一挡住路径穿越的东西,值得单独钉住 */
export function isValidDraftId(id: string): boolean {
  return ID_RE.test(id);
}

function projectsDir(root: string): string {
  // PROMPTCUT_PROJECTS_DIR:测试与探针把草稿目录指到临时目录,和用户的草稿隔离
  const dir = process.env.PROMPTCUT_PROJECTS_DIR || path.join(root, DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 一份草稿在磁盘上的位置。导出给 vite-plugin-skill-state.ts 用 —— 独占锁要按
 * 草稿 id 找到真实文件,而目录规则(含 PROMPTCUT_PROJECTS_DIR 覆盖)只该有这一份。
 */
export function draftFileFor(root: string, id: string): string | null {
  return fileFor(root, id);
}

/**
 * 原子写草稿:同目录写一份临时文件、落盘、再改名盖上去。写到一半进程没了,旧草稿还是完整的那一份;
 * 任何一步失败都把临时文件清掉,不留半份。
 */
function writeFileAtomic(file: string, body: string): void {
  // 目标已存在却不可写(只读):直接报错,不靠改名绕过只读(各平台改名对只读文件的行为不一样)
  if (fs.existsSync(file)) fs.accessSync(file, fs.constants.W_OK);
  const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, body, "utf8");
    const fd = fs.openSync(tmp, "r+");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉也不改变要报的错 */ }
    throw e;
  }
}

function fileFor(root: string, id: string): string | null {
  if (!isValidDraftId(id)) return null;
  return path.join(projectsDir(root), id + EXT);
}

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: { on: (ev: string, fn: (c?: unknown) => void) => void; destroy: () => void }, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      // 编排文件再大也就几 MB;超了多半是把素材本身塞进来了
      if (body.length > limit) {
        req.destroy();
        reject(new Error("项目文件太大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error("读取请求体失败")));
  });
}

/** 从 .proc 内容里挑出列表要显示的那几样,顺带兜住坏文件 */
function summarize(id: string, file: string) {
  const stat = fs.statSync(file);
  const base = { id, updatedAt: stat.mtime.toISOString(), size: stat.size };
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const project = doc?.project ?? doc;
    // 项目可以有多条剪辑:激活那条在 tracks 里,其余停放在 cuts[].tracks 里,列表里的段数把它们都算上
    const countTracks = (tracks: unknown) =>
      (Array.isArray(tracks) ? (tracks as { clips?: unknown[] }[]) : []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);
    const clips = countTracks(project?.tracks)
      + (Array.isArray(project?.cuts) ? (project.cuts as { tracks?: unknown }[]).reduce((n, c) => n + countTracks(c.tracks), 0) : 0);
    return {
      ...base,
      name: project?.name || id,
      duration: Number(project?.duration) || 0,
      clips,
      thumbnail: typeof doc?.thumbnail === "string" ? doc.thumbnail : null,
      broken: false,
    };
  } catch {
    // 坏文件也列出来,让用户看得见、删得掉,而不是凭空消失
    return { ...base, name: id, duration: 0, clips: 0, thumbnail: null, broken: true };
  }
}

/**
 * 本地备份(C6.5,`docs/plan/c65-design.md` 第 3、8 节):被别人覆盖之前自己那一版的实体、离线时被丢弃的那批修改,
 * 由页面在「换成最新版本之前」存进草稿目录下的 `backups/`,一份一个 JSON 文件。「项目」菜单「本地备份…」按时间列出、
 * 取回单份再以一次新写入恢复。页面按 `docsync.ts` 的 `LocalBackup` 形状交上来,这里只加 id、不解释内容。
 */
const BACKUP_DIR = "backups";
const BACKUP_ID_RE = /^[0-9]{13}-[a-z0-9]{6}$/;
/** 备份最多留这么多份,再多删最旧的 */
const BACKUP_KEEP = 500;

function backupsDir(root: string): string {
  const dir = path.join(projectsDir(root), BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 列表只要摘要:不带实体的值、不带整份项目 */
function backupSummary(id: string, file: string) {
  try {
    const b = JSON.parse(fs.readFileSync(file, "utf8"));
    const entities = b.kind === "offline-discard"
      ? [...new Set((Array.isArray(b.batch) ? b.batch : []).flatMap((x: { entities?: string[] }) => (Array.isArray(x?.entities) ? x.entities : [])))]
      : [b.entity].filter((e: unknown) => typeof e === "string");
    return { id, kind: b.kind, projectId: b.projectId ?? null, projectName: b.projectName ?? null, entity: b.entity ?? null, entities, by: b.by ?? null, rev: b.rev ?? b.baseRev ?? null, at: Number(b.at) || 0, pageSession: typeof b.pageSession === "string" ? b.pageSession : null, broken: false };
  } catch {
    return { id, kind: null, projectId: null, projectName: null, entity: null, entities: [], by: null, rev: null, at: 0, broken: true };
  }
}

function handleBackups(root: string, req: import("node:http").IncomingMessage, res: ServerResponse): Promise<void> | void {
  const url = new URL(req.url || "/", "http://localhost");
  const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const dir = backupsDir(root);
  if (req.method === "GET" && !id) {
    const items = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => backupSummary(f.slice(0, -5), path.join(dir, f)));
    items.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    return sendJson(res, 200, { ok: true, backups: items });
  }
  if (req.method === "POST" && !id) {
    return readBody(req as never, 128 * 1024 * 1024).then((body) => {
      const b = JSON.parse(body);
      if (!b || typeof b !== "object" || (b.kind !== "overwritten" && b.kind !== "offline-discard")) {
        return sendJson(res, 400, { ok: false, error: "不认识的备份" });
      }
      const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
      const file = path.join(dir, `${newId}.json`);
      fs.writeFileSync(`${file}.tmp`, body, "utf8");
      fs.renameSync(`${file}.tmp`, file);
      const all = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
      for (const f of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
      return sendJson(res, 200, { ok: true, id: newId, file });
    });
  }
  if (req.method === "GET") {
    if (!BACKUP_ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: "备份 id 不合法" });
    const file = path.join(dir, `${id}.json`);
    if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: "备份不存在" });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(fs.readFileSync(file, "utf8"));
    return;
  }
  return sendJson(res, 405, { ok: false, error: "只支持 GET / POST" });
}

export function projectsPlugin(): Plugin {
  return {
    name: "promptcut-projects",
    configureServer(server: ViteDevServer) {
      const root = server.config.root || process.cwd();

      server.middlewares.use("/api/project-backups", async (req, res) => {
        try {
          await handleBackups(root, req, res);
        } catch (e) {
          sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });

      server.middlewares.use("/api/projects", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        // middlewares.use 会把挂载前缀吃掉,所以这里的 pathname 是 "/" 或 "/<id>"
        const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

        try {
          if (req.method === "GET" && !id) {
            const dir = projectsDir(root);
            const items = fs
              .readdirSync(dir)
              .filter((f) => f.endsWith(EXT))
              .map((f) => summarize(f.slice(0, -EXT.length), path.join(dir, f)))
              // 最近改的排最前,和「本地草稿」的直觉一致
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return sendJson(res, 200, { ok: true, projects: items });
          }

          const file = fileFor(root, id);
          if (!file) return sendJson(res, 400, { ok: false, error: "草稿 id 不合法" });

          if (req.method === "GET") {
            if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: "草稿不存在" });
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            return res.end(fs.readFileSync(file, "utf8"));
          }

          if (req.method === "PUT") {
            const body = await readBody(req as never);
            // 先解析一次:宁可这里报错,也不要把坏 JSON 写成草稿
            JSON.parse(body);
            writeFileAtomic(file, body);
            return sendJson(res, 200, { ok: true, ...summarize(id, file) });
          }

          if (req.method === "DELETE") {
            if (fs.existsSync(file)) fs.unlinkSync(file);
            return sendJson(res, 200, { ok: true });
          }

          return sendJson(res, 405, { ok: false, error: "只支持 GET / PUT / DELETE" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

export default projectsPlugin;
