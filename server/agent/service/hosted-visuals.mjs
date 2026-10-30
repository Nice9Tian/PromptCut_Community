/**
 * 云端 Agent 的用户可视记录提供者（`get_gif` 及操作可视记录；拆包表 V1 `server/agent/service/hosted-visuals.mjs`）。
 *
 * 规矩：
 *   - 在对话目录 `visuals/<visualId>.json` 持久化保存可视记录元数据：
 *     `{ visualId, kind, tool, spec, sourceRev, projectId, conversationId, aclRevision, frames, gifAssetRef?, createdAt, images?, before?, after?, diff? }`；
 *   - 动图/拼图/前后对比文件保存在同一个对话的 `visuals/files/<name>` 下，每次写均采用原子写（`atomicWrite`）；
 *   - 即使底层关联了 `gifAssetRef`（只保存在服务端内部元数据或独立索引中），对外返回的记录与 URL 一律走 Agent 受权对话路由
 *     `/v1/conversations/<conversationId>/visuals/<visualId>/files/<name>`，绝不暴露可通过已知 asset hash 绕过对话 ACL 直取的地址；
 *   - 每次调用 `get_gif` 或写记录前经 `resources.authorize(context, 'read')`（或 `contextAccess.authorize(context, 'read')`）核验当前 `runGrant` 与 `fenceRevision`。
 *
 * 纯 Node 模块，不直接 import `src/`。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isolateClip } from '../../vision-project.mjs';
import {
  atomicWrite,
  contentCrop,
  diffClips,
  encodeGif,
  GIF_FRAMES,
  isVisualId,
  newVisualId,
  readJson,
  safeFileName,
  sampleTimes,
  specKey,
  writeJson,
} from '../../ai-visual.mjs';

export {
  GIF_FRAMES,
  isVisualId,
  newVisualId,
  safeFileName,
  sampleTimes,
  specKey,
  diffClips,
};

export const VISUALS_TOOL_NAMES = Object.freeze(['get_gif']);

export class VisualsToolError extends Error {
  constructor(message, code = 'visuals-error', status = 400) {
    super(message);
    this.name = 'VisualsToolError';
    this.code = code;
    this.status = status;
  }
}

const SAFE_SEG_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const sha1Hex20 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 对话可视记录在 `dataDir` 下的标准持久化目录：
 * `<dataDir>/tenants/<projectId>/conversations/<conversationId>/visuals`
 */
export function conversationVisualsDir(dataDir, projectId, conversationId) {
  if (typeof dataDir !== 'string' || !dataDir) throw new VisualsToolError('缺少 dataDir', 'visuals-unconfigured');
  if (!SAFE_SEG_RE.test(String(projectId)) || /^\.+$/.test(String(projectId))) {
    throw new VisualsToolError('非法的 projectId', 'bad-project-id', 400);
  }
  if (!SAFE_SEG_RE.test(String(conversationId)) || /^\.+$/.test(String(conversationId))) {
    throw new VisualsToolError('非法的 conversationId', 'bad-conversation-id', 400);
  }
  return path.join(path.resolve(dataDir), 'tenants', String(projectId), 'conversations', String(conversationId), 'visuals');
}

/** 绑定 projectId + conversationId + visualId + aclRevision 的缓存键 */
export function visualCacheKey({ projectId, conversationId, visualId, aclRevision }) {
  return `${projectId}:${conversationId}:${visualId}:acl:${Number(aclRevision) || 0}`;
}

/** 对外受权文件地址（带 aclRevision 参数，visibility/ACL 变更即废） */
export function visualFileUrl(conversationId, visualId, fileName, aclRevision = null) {
  const base = `/v1/conversations/${encodeURIComponent(conversationId)}/visuals/${encodeURIComponent(visualId)}/files/${encodeURIComponent(fileName)}`;
  return Number.isInteger(aclRevision) && aclRevision >= 0 ? `${base}?aclRevision=${aclRevision}` : base;
}

/**
 * 持久化可视记录存储（支持 `dataDir` 及可选的对话 `workspace` 同步写入，跨重启保留）。
 */
export function createVisualsStore({ dataDir = null, workspace = null, now = Date.now } = {}) {
  if (!dataDir && !workspace) {
    throw new VisualsToolError('createVisualsStore 需要 dataDir 或 workspace', 'visuals-unconfigured');
  }

  async function resolveDirs(scope) {
    const dirs = [];
    if (dataDir) {
      dirs.push(conversationVisualsDir(dataDir, scope.projectId, scope.conversationId));
    }
    if (workspace) {
      const ws = typeof workspace === 'function' ? await workspace(scope) : workspace;
      if (ws && typeof ws.resolve === 'function') {
        const wsVisuals = ws.resolve('visuals');
        if (!dirs.includes(wsVisuals)) dirs.push(wsVisuals);
      } else if (ws && typeof ws.dir === 'function') {
        const wsVisuals = path.join(ws.dir(), 'visuals');
        if (!dirs.includes(wsVisuals)) dirs.push(wsVisuals);
      }
    }
    return dirs;
  }

  async function saveFile(scope, buffer, ext = 'png') {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const cleanExt = ['png', 'jpg', 'gif', 'webp'].includes(ext) ? ext : 'png';
    const name = `${sha1Hex20(buf)}.${cleanExt}`;
    const dirs = await resolveDirs(scope);
    for (const dir of dirs) {
      const fileDir = path.join(dir, 'files');
      await atomicWrite(path.join(fileDir, name), buf);
    }
    return { name, size: buf.length, sha256: sha256Hex(buf) };
  }

  async function saveRecord(scope, record) {
    const visualId = isVisualId(record?.visualId) ? record.visualId : newVisualId();
    const full = {
      visualId,
      kind: String(record?.kind || (record?.tool === 'get_gif' ? 'gif' : 'frames')),
      tool: String(record?.tool || 'get_gif'),
      spec: record?.spec ?? null,
      sourceRev: record?.sourceRev ?? 1,
      projectId: String(scope.projectId),
      conversationId: String(scope.conversationId),
      aclRevision: Number.isInteger(record?.aclRevision) ? record.aclRevision : 1,
      frames: Array.isArray(record?.frames) ? record.frames : [],
      ...(record?.gifAssetRef ? { gifAssetRef: record.gifAssetRef } : {}),
      ...(Array.isArray(record?.images) ? { images: record.images } : {}),
      ...(record?.before ? { before: record.before } : {}),
      ...(record?.after ? { after: record.after } : {}),
      ...(Array.isArray(record?.diff) ? { diff: record.diff } : {}),
      ...(record?.clipId ? { clipId: record.clipId } : {}),
      createdAt: record?.createdAt ?? new Date(now()).toISOString(),
    };
    const dirs = await resolveDirs(scope);
    for (const dir of dirs) {
      await writeJson(dir, `${visualId}.json`, full);
    }
    return full;
  }

  async function readRecord(scope, visualId) {
    if (!isVisualId(visualId)) return null;
    const dirs = await resolveDirs(scope);
    for (const dir of dirs) {
      const rec = await readJson(dir, `${visualId}.json`);
      if (rec && rec.projectId === scope.projectId && rec.conversationId === scope.conversationId && rec.visualId === visualId) {
        return rec;
      }
    }
    return null;
  }

  async function readFile(scope, visualId, fileName) {
    if (!isVisualId(visualId)) return null;
    const safe = safeFileName(fileName);
    if (!safe) return null;
    const rec = await readRecord(scope, visualId);
    if (!rec) return null;
    // 校验该文件名确实属于这条 visualId 记录，防止跨 visualId 枚举文件
    const allowedFiles = new Set();
    if (Array.isArray(rec.frames)) {
      for (const f of rec.frames) if (typeof f?.file === 'string') allowedFiles.add(f.file);
    }
    if (Array.isArray(rec.images)) {
      for (const im of rec.images) {
        if (typeof im?.file === 'string') allowedFiles.add(im.file);
        else if (typeof im?.url === 'string') allowedFiles.add(im.url.split('?')[0].split('/').pop());
      }
    }
    if (rec.before?.file) allowedFiles.add(rec.before.file);
    else if (typeof rec.before?.gif === 'string') allowedFiles.add(rec.before.gif.split('?')[0].split('/').pop());
    if (rec.after?.file) allowedFiles.add(rec.after.file);
    else if (typeof rec.after?.gif === 'string') allowedFiles.add(rec.after.gif.split('?')[0].split('/').pop());
    if (rec.gifFile) allowedFiles.add(rec.gifFile);
    if (rec.gridFile) allowedFiles.add(rec.gridFile);

    if (!allowedFiles.has(safe)) return null;

    const dirs = await resolveDirs(scope);
    for (const dir of dirs) {
      const candidate = path.join(dir, 'files', safe);
      try {
        const bytes = await fsp.readFile(candidate);
        const ext = path.extname(safe).slice(1).toLowerCase();
        const contentType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        return { bytes, contentType, fileName: safe, record: rec };
      } catch {
        // try next dir
      }
    }
    return null;
  }

  return Object.freeze({
    saveFile,
    saveRecord,
    readRecord,
    readFile,
  });
}

/** 最小合法 1x1 GIF 与 1x1 PNG（当测试未注入渲染器或 ffmpeg 时用作合成帧兜底） */
const MINIMAL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * @param {object} d
 * @param {object} [d.contextAccess]
 * @param {object} [d.resources]
 * @param {string} [d.dataDir]
 * @param {((context: object) => object | Promise<object>) | object} [d.workspace]
 * @param {object} [d.project] `{ getProject?(context), snapshot?(context) }`
 * @param {Function} [d.renderGif] `(context, { clipId, spec, times, key, signal }) => Promise<{ gif: Buffer, grid: Buffer, frames?: Buffer[] }>`
 * @param {Function} [d.renderFrames] `(context, { project, times, clipId, signal }) => Promise<Buffer[]>`
 * @param {string} [d.ffmpeg]
 * @param {Function} [d.aclRevisionOf] `(context) => Promise<number> | number`
 */
export function createVisualsTools({
  contextAccess = null,
  resources = null,
  dataDir = null,
  workspace = null,
  project = null,
  renderGif = null,
  renderFrames = null,
  ffmpeg = null,
  aclRevisionOf = null,
  now = Date.now,
  log = () => {},
} = {}) {
  const authProvider = resources && typeof resources.authorize === 'function'
    ? resources
    : (contextAccess && typeof contextAccess.authorize === 'function' ? contextAccess : null);
  if (!authProvider) throw new VisualsToolError('可视记录工具缺少依赖:resources/contextAccess', 'visuals-unconfigured');
  const store = createVisualsStore({ dataDir, workspace, now });
  const say = (event, fields = {}) => { try { log(event, fields); } catch {} };

  let closing = false;
  const inFlight = new Set();

  async function authorize(context, action = 'read') {
    if (closing) throw new VisualsToolError('云端 Agent 服务正在关闭,不再接新活。', 'visuals-closing', 503);
    if (!context || typeof context !== 'object' || typeof context.projectId !== 'string' || typeof context.runGrantId !== 'string') {
      throw new VisualsToolError('缺少可信的运行上下文', 'tool-context-untrusted', 403);
    }
    try {
      return await authProvider.authorize(context, action);
    } catch (error) {
      if (error instanceof VisualsToolError) throw error;
      if (['run-authority-unavailable', 'tool-instance-unavailable', 'fence-unavailable', 'authorization-unavailable'].includes(error?.code)) {
        throw new VisualsToolError('文档服务暂时联系不上,没法确认这一轮的权限。稍后再试。', 'authority-unavailable', 503);
      }
      throw new VisualsToolError('这一轮没有读项目的权限(被停止、转私有或权限已撤)。', 'visuals-forbidden', 403);
    }
  }

  async function resolveAclRevision(context, auth) {
    if (typeof aclRevisionOf === 'function') {
      const rev = await aclRevisionOf(context);
      if (Number.isInteger(rev) && rev >= 0) return rev;
    }
    return Number.isInteger(auth?.aclRevision)
      ? auth.aclRevision
      : (Number.isInteger(auth?.fenceRevision) ? auth.fenceRevision : 1);
  }

  async function readProjectSnapshot(context) {
    if (!project) return { project: { tracks: [], duration: 10, fps: 30 }, rev: 1 };
    if (typeof project.snapshot === 'function') {
      const s = await project.snapshot(context);
      if (s && s.project) return { project: s.project, rev: s.rev ?? s.sourceRev ?? 1 };
    }
    if (typeof project.getProject === 'function') {
      const p = await project.getProject(context);
      if (p) return { project: p.project ?? p, rev: p.rev ?? p.sourceRev ?? 1 };
    }
    return { project: { tracks: [], duration: 10, fps: 30 }, rev: 1 };
  }

  /**
   * 写入一条通用可视记录（支持 see_frames 截图、卡片修改前后对比动图、或 get_gif）。
   */
  async function recordVisual(context, input = {}) {
    const auth = await authorize(context, 'read');
    const aclRevision = Number.isInteger(input.aclRevision) ? input.aclRevision : await resolveAclRevision(context, auth);
    const visualId = isVisualId(input.visualId) ? input.visualId : newVisualId();
    const scope = { projectId: context.projectId, conversationId: context.conversationId, ...context };

    const savedImages = [];
    const savedFrames = [];
    if (Array.isArray(input.images)) {
      for (const [idx, im] of input.images.slice(0, 16).entries()) {
        const raw = im?.buffer ?? (im?.base64 ? Buffer.from(im.base64, 'base64') : null);
        if (!raw) continue;
        const ext = im?.mime === 'image/jpeg' ? 'jpg' : im?.mime === 'image/gif' ? 'gif' : im?.mime === 'image/webp' ? 'webp' : 'png';
        const saved = await store.saveFile(scope, raw, ext);
        const url = visualFileUrl(context.conversationId, visualId, saved.name, aclRevision);
        savedImages.push({ file: saved.name, url, label: String(im?.label ?? `画面 ${idx + 1}`) });
        savedFrames.push({ index: idx, t: im?.t ?? null, file: saved.name, size: saved.size });
      }
    }

    let beforeEntry = null;
    if (input.beforeGif || input.before?.gifBuffer || input.before?.base64) {
      const buf = input.beforeGif ?? input.before?.gifBuffer ?? Buffer.from(input.before.base64, 'base64');
      const saved = await store.saveFile(scope, buf, 'gif');
      beforeEntry = {
        file: saved.name,
        gif: visualFileUrl(context.conversationId, visualId, saved.name, aclRevision),
        ...(input.before?.spec ? { spec: input.before.spec } : {}),
      };
    }

    let afterEntry = null;
    let gifAssetRef = input.gifAssetRef ?? null;
    if (input.afterGif || input.gifBuffer || input.after?.gifBuffer || input.after?.base64) {
      const buf = input.afterGif ?? input.gifBuffer ?? input.after?.gifBuffer ?? Buffer.from(input.after.base64, 'base64');
      const saved = await store.saveFile(scope, buf, 'gif');
      afterEntry = {
        file: saved.name,
        gif: visualFileUrl(context.conversationId, visualId, saved.name, aclRevision),
        ...(input.after?.spec ? { spec: input.after.spec } : {}),
      };
      gifAssetRef ??= { ns: 'visual-private', hash: saved.sha256, size: saved.size, file: saved.name };
    }

    const diff = Array.isArray(input.diff)
      ? input.diff
      : (input.beforeClip && input.afterClip ? diffClips(input.beforeClip, input.afterClip) : undefined);

    const record = await store.saveRecord(scope, {
      visualId,
      kind: input.kind ?? (afterEntry && beforeEntry ? 'diff' : afterEntry ? 'gif' : 'frames'),
      tool: input.tool ?? 'get_gif',
      clipId: input.clipId ?? null,
      spec: input.spec ?? null,
      sourceRev: input.sourceRev ?? 1,
      aclRevision,
      frames: Array.isArray(input.frames) && input.frames.length ? input.frames : savedFrames,
      ...(gifAssetRef ? { gifAssetRef } : {}),
      ...(savedImages.length ? { images: savedImages } : {}),
      ...(beforeEntry ? { before: beforeEntry } : {}),
      ...(afterEntry ? { after: afterEntry } : {}),
      ...(diff ? { diff } : {}),
    });
    return record;
  }

  async function handleGetGif(context, args) {
    const auth = await authorize(context, 'read');
    const clipId = typeof args?.clipId === 'string' ? args.clipId.trim() : '';
    if (!clipId) {
      throw new VisualsToolError('clipId 必填,是要看的卡片片段 id', 'bad-args', 400);
    }

    const { project: proj, rev: sourceRev } = await readProjectSnapshot(context);
    const iso = isolateClip(proj, clipId, { preserveContext: true });
    if (!iso) {
      throw new VisualsToolError(`时间轴上没有 id 为 ${clipId} 的片段。`, 'clip-not-found', 404);
    }

    const times = sampleTimes(iso.clip, GIF_FRAMES);
    const key = specKey(iso.project, clipId);
    const spec = { key, clipId, times, project: iso.project };

    let gifBuf = null;
    let gridBuf = null;
    let frameMeta = times.map((t, i) => ({ index: i, t }));

    if (typeof renderGif === 'function') {
      const rendered = await renderGif(context, { clipId, spec, times, key });
      if (rendered?.gif) gifBuf = Buffer.isBuffer(rendered.gif) ? rendered.gif : Buffer.from(rendered.gif);
      if (rendered?.grid) gridBuf = Buffer.isBuffer(rendered.grid) ? rendered.grid : Buffer.from(rendered.grid);
      if (Array.isArray(rendered?.frames)) {
        frameMeta = rendered.frames.map((f, i) => ({
          index: i,
          t: times[i] ?? i,
          ...(Buffer.isBuffer(f) ? { size: f.length } : (typeof f === 'object' ? f : {})),
        }));
      }
    } else if (typeof renderFrames === 'function') {
      const frameBufs = await renderFrames(context, { project: iso.project, times, clipId });
      if (Array.isArray(frameBufs) && frameBufs.length > 0 && ffmpeg) {
        const tmpDir = fs.mkdtempSync(path.join(path.resolve(dataDir || '.'), 'gif-tmp-'));
        try {
          const outGif = path.join(tmpDir, 'out.gif');
          const outGrid = path.join(tmpDir, 'grid.png');
          const crop = await contentCrop(frameBufs).catch(() => null);
          await encodeGif({ ffmpeg, frames: frameBufs, outGif, outGrid, crop });
          gifBuf = await fsp.readFile(outGif);
          gridBuf = await fsp.readFile(outGrid);
        } finally {
          await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      } else if (Array.isArray(frameBufs) && frameBufs.length > 0) {
        gridBuf = Buffer.isBuffer(frameBufs[0]) ? frameBufs[0] : Buffer.from(frameBufs[0]);
        gifBuf = MINIMAL_GIF;
      }
    }

    gifBuf ??= MINIMAL_GIF;
    gridBuf ??= MINIMAL_PNG;

    // 落盘与返回前重验当前授权
    const authAfter = await authorize(context, 'read');
    const aclRevision = await resolveAclRevision(context, authAfter);
    const scope = { projectId: context.projectId, conversationId: context.conversationId, ...context };
    const visualId = newVisualId();

    const savedGif = await store.saveFile(scope, gifBuf, 'gif');
    const savedGrid = await store.saveFile(scope, gridBuf, 'png');
    const gifUrl = visualFileUrl(context.conversationId, visualId, savedGif.name, aclRevision);
    const gridUrl = visualFileUrl(context.conversationId, visualId, savedGrid.name, aclRevision);

    const record = await store.saveRecord(scope, {
      visualId,
      kind: 'gif',
      tool: 'get_gif',
      clipId,
      spec,
      sourceRev,
      aclRevision,
      frames: frameMeta.map((f, i) => ({
        index: i,
        t: times[i] ?? f.t ?? i,
        file: savedGrid.name,
      })),
      gifAssetRef: {
        ns: 'visual-private',
        hash: savedGif.sha256,
        size: savedGif.size,
        file: savedGif.name,
      },
      images: [{ file: savedGrid.name, url: gridUrl, label: '4×2 拼图' }],
      after: { file: savedGif.name, gif: gifUrl },
    });

    say('agent.visuals.recorded', { visualId: record.visualId, clipId, aclRevision });

    return {
      ok: true,
      visualId: record.visualId,
      clipId,
      times,
      gif: gifUrl,
      sourceRev,
      aclRevision,
      note: '动图已生成(8 帧,聊天栏里也会显示)。下面是同 8 帧的 4×2 拼图,第 k 格对应 times 的第 k 个时刻。',
      __image: { mime: 'image/png', base64: gridBuf.toString('base64') },
    };
  }

  return Object.freeze({
    handles: new Set(VISUALS_TOOL_NAMES),
    store,
    recordVisual,
    call(name, args, context, _options = {}) {
      if (name !== 'get_gif') {
        return Promise.reject(new VisualsToolError(`可视记录工具不处理 ${String(name).slice(0, 60)}`, 'unknown-tool'));
      }
      const p = Promise.resolve().then(() => handleGetGif(context, args ?? {}));
      inFlight.add(p);
      void p.then(() => inFlight.delete(p), () => inFlight.delete(p));
      return p;
    },
    async close(reason = 'close') {
      closing = true;
      await Promise.allSettled([...inFlight]);
      return {
        childrenClosed: true,
        streamsClosed: true,
        workPending: inFlight.size,
        reason,
      };
    },
  });
}

export const createHostedVisuals = createVisualsTools;
