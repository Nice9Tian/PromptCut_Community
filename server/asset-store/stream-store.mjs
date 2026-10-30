/** 素材流库与HTTP读口：从frame-stream纯移动，独立asset入口不加载渲染器。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STREAM_SEGMENT_FRAMES as SEGMENT_FRAMES } from '../bakery/ffmpeg.mjs';
import { atomic } from './atomic.mjs';
import { mergeRanges } from './ranges.mjs';
import { projectStorageKey } from './project-stores.mjs';
import { readProjectFile, publishProjectFile, projectFileAccepted } from './project-io.mjs';
const KEY_RE = /^[a-f0-9]{64}$/;

/** 清单里就绪的分段号(区间,C3 的 `stream` 表单位是分段号) */
export function readySegmentRanges(manifest) {
  return mergeRanges(Object.keys(manifest?.segments ?? {}).map(Number).filter(Number.isInteger));
}

export class StreamStore {
  constructor(root, { ownership = null, projectAccess = null, io = fs } = {}) {
    this.ownership = ownership; this.projectAccess = projectAccess;
    this.io = io;
    this.projectId = ownership?.projectId ?? null;
    this.root = this.projectId ? path.join(root, 'projects', projectStorageKey(this.projectId)) : root;
    this.manifests = new Map();
  }
  dir(key) { return path.join(this.root, key); }
  async load(key, { lease } = {}) {
    if (this.manifests.has(key)) return this.projectId ? structuredClone(this.manifests.get(key)) : this.manifests.get(key);
    let manifest = null;
    try { const file = path.join(this.dir(key), 'stream.json'); if (this.projectId && !await projectFileAccepted(file)) return null; manifest = JSON.parse((await readProjectFile(file, lease, this.io)).toString('utf8')); } catch {}
    if (!manifest || manifest.streamKey !== key || (this.projectId && manifest.projectId !== this.projectId)) manifest = null;
    this.manifests.set(key, this.projectId ? structuredClone(manifest) : manifest);
    return manifest;
  }
  async save(manifest) {
    await this.ownership?.assert();
    if (this.projectId && manifest.projectId && manifest.projectId !== this.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
    if (this.projectId) manifest = { ...manifest, projectId: this.projectId };
    await this.writeFile(path.join(this.dir(manifest.streamKey), 'stream.json'), JSON.stringify(manifest), { replace: true });
    this.manifests.set(manifest.streamKey, this.projectId ? structuredClone(manifest) : manifest);
  }
  async writeFile(target, bytes, { replace = false } = {}) {
    if (!this.ownership) await atomic(target, bytes);
    else {
      const lease = await this.ownership.acquire?.(), temp = `${target}.${randomUUID()}.tmp`;
      const write = async () => { await this.ownership.assert(); await lease?.assert(); await this.io.mkdir(path.dirname(target), { recursive: true }); await this.io.writeFile(temp, bytes); await publishProjectFile({ temp, target, replace, assert: async () => { await this.ownership.assert(); await lease?.assert(); }, lease, io: this.io }); };
      try { if (lease) await lease.run(write); else await write(); }
      finally { await this.io.rm(temp, { force: true }); await lease?.release(); }
    }
  }
  /** 扫盘(F5):每条流的「键 → 就绪分段」 */
  async scan() {
    const out = [];
    let items = [];
    try { items = await fs.readdir(this.root, { withFileTypes: true }); } catch { return out; }
    for (const item of items) {
      if (!item.isDirectory() || !KEY_RE.test(item.name)) continue;
      this.manifests.delete(item.name);
      const manifest = await this.load(item.name);
      if (!manifest) continue;
      const ranges = readySegmentRanges(manifest);
      if (ranges.length) out.push({ key: item.name, ranges, manifest });
    }
    return out;
  }
  initFile(key, id) { return path.join(this.dir(key), `init-${id}.mp4`); }
  segFile(key, file) { return path.join(this.dir(key), file); }
}

/**
 * 页面要的清单形状(不带签名等内部字段)。`originFrame`:清单里记的这条流的第一帧(项目帧号,分段从它起每 15 帧一段);
 * 改分段规则之前落盘的清单没有这一项,这里回 null。
 */
export function publicManifest(manifest) {
  if (!manifest) return null;
  const segments = {};
  // `stride`:1 = 满密度,大于 1 = 稀疏(只截了分段的第一帧,其余样本重复它)。`box`:这个分段的位置矩形(平面坐标,和 `bound` 同一个
  // 坐标系;产稀疏版时量的那一张里不透明像素的外接框,`null` = 那一张全透明;没量过的分段不带这一项)
  for (const [n, s] of Object.entries(manifest.segments ?? {})) segments[n] = { init: s.init, file: s.file, stride: s.stride, samples: s.samples, ...(s.box !== undefined ? { box: s.box } : {}) };
  const inits = {};
  for (const [id, i] of Object.entries(manifest.inits ?? {})) inits[id] = { codec: i.codec, width: i.width, height: i.height, rect: i.rect };
  return { streamKey: manifest.streamKey, kind: manifest.kind, plane: manifest.plane, clipIds: manifest.clipIds, fps: manifest.fps,
    segmentFrames: SEGMENT_FRAMES, originFrame: Number.isInteger(manifest.originFrame) && manifest.originFrame >= 0 ? manifest.originFrame : null, bound: manifest.bound, tight: manifest.tight ?? null, inits, segments };
}

/**
 * 分段字节的读口(C3 的快照字节同源,页面直连预渲染进程):
 *
 *   GET /stream/<streamKey>/manifest            清单(`no-store`:分段会被替换)
 *   GET /stream/<streamKey>/init/<initId>       init.mp4(内容寻址,immutable)
 *   GET /stream/<streamKey>/seg/<n>-<hash>.m4s  分段(内容寻址,immutable)
 *
 * `pathname` 是 `/api/frames` 之后那一段。认得就回 true(已经答了),不认得回 false。
 */
export function handleStreamRequest(store, req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const m = /^\/stream\/([a-f0-9]{64})\/(manifest|init\/([a-f0-9]{16})|seg\/(\d{1,7}-[a-f0-9]{16}\.m4s))$/.exec(pathname);
  if (!m) return false;
  const key = m[1];
  const fail = (status, error) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify({ error })); };
  if (store.projectId && !req[Symbol.for('promptcut.asset.stream-checked.v2')]) {
    void (async () => {
      if (!store.projectAccess) return fail(503, 'project-access-unavailable');
      let lease;
      try {
        lease = await store.projectAccess.resolve(req, { action: 'read', resource: { ns: 'px', streamKey: key }, close: () => { req.destroy(); res.destroy(); } });
        if (lease.projectId !== store.projectId) throw Object.assign(new Error('project-mismatch'), { status: 403 });
        req[Symbol.for('promptcut.asset.stream-checked.v2')] = lease;
        res.once('close', () => lease.release());
        res.once('finish', () => lease.release());
        handleStreamRequest(store, req, res, pathname);
      } catch (error) { lease?.release(); fail(error?.status ?? 503, error?.code ?? 'forbidden'); }
    })();
    return true;
  }
  if (m[2] === 'manifest') {
    store.manifests.delete(key);
    void store.load(key, { lease: req[Symbol.for('promptcut.asset.stream-checked.v2')] }).then(manifest => {
      if (res.destroyed) return;
      if (!manifest) return fail(404, 'Stream is not ready');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(publicManifest(manifest)));
    }, () => fail(404, 'Stream is not ready'));
    return true;
  }
  const file = m[3] ? store.initFile(key, m[3]) : store.segFile(key, m[4]);
  void readProjectFile(file, req[Symbol.for('promptcut.asset.stream-checked.v2')], store.io).then(buf => {
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', store.projectId ? 'no-store' : 'public, max-age=31536000, immutable');
    res.setHeader('Content-Length', buf.length);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }, () => fail(404, 'Stream file is not ready'));
  return true;
}
