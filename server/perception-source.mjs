/**
 * 感知工具(`detect_shots`、`track_points`、`detect_subjects`)从哪儿读素材:**只经素材服务的 HTTP 接口**
 * (`docs/semantics/product/agent.md`「素材与产物」;`product/asset-service.md`「职责」第三条)。
 *
 * 页面只递素材的标识(`media: { id, name, kind, url, hash }`),服务端经 `audio-source.mjs` 的解析器换成素材服务上的
 * HTTP 地址,ffmpeg / ffprobe 直接拿地址当输入。请求体里的 `path`(以及 `media.path`)**一概不看**:
 * 原来这三条接口收任意绝对路径、`existsSync` 后交 ffmpeg,等于一个任意读文件的口子;共享项目里没有本机路径的素材也用不了。
 *
 * Python 那一半(TransNetV2、BootsTAPIR / 模板匹配、YuNet + RT-DETR / Grounding DINO)解码也是起 ffmpeg 子进程,
 * 新包认 http 地址(包里 `ACCEPTS_URL = True`);老包(桌面版只打了 Node 这一半的补丁、运行时里的 Python 包还是旧的)
 * 见到地址会报「找不到视频文件」,这时先把字节从素材服务流到临时文件、递临时路径、作业结束删掉。
 *
 * 本文件不 import vite、不认目录,`server/test/perception-asset-path.test.mjs` 直接测它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AssetSourceError } from './audio-source.mjs';

/** 请求体里的素材标识。只取这几项;`path` 不取(见文件头) */
const REF_KEYS = ['id', 'name', 'kind', 'url', 'hash'];

/**
 * 请求体 → 素材标识。页面发 `{ mediaId, media: { id, name, kind, url, hash } }`;拿不到 url 也拿不到 hash 回 null。
 * @returns {{ id?: string, name?: string, kind?: string, url?: string, hash?: string } | null}
 */
export function mediaRefOf(body) {
  const m = body && typeof body.media === 'object' && body.media ? body.media : null;
  if (!m) return null;
  const ref = {};
  for (const k of REF_KEYS) if (typeof m[k] === 'string' && m[k]) ref[k] = m[k];
  if (!ref.id && typeof body.mediaId === 'string' && body.mediaId) ref.id = body.mediaId;
  return ref.url || ref.hash ? ref : null;
}

/** 给人看的素材名:报错里点名用 */
export function mediaLabel(ref) {
  return ref?.name || ref?.id || ref?.hash || ref?.url || '(未命名素材)';
}

/**
 * 请求体 → 素材服务上的地址,三种结果分清(同 `audio-source.mjs`):
 * - `{ ok: true, src, media }`:素材服务答了 2xx;
 * - `{ ok: false, status: 404 }`:素材服务上没有这份素材(或拼不出地址,例如还在上传、只有 blob: 地址);
 * - `{ ok: false, status: 502, kind: 'asset-service' }`:素材服务不可达或拒绝读取,报错里写明地址与原因;
 * - `{ ok: false, status: 400 }`:请求体里没有素材标识(老页面只发 `path` 的也落在这里)。
 * @param {any} body
 * @param {(m: any) => Promise<string | null>} resolveSource `createAssetSourceResolver` 做出来的解析器
 */
export async function resolveMediaSource(body, resolveSource) {
  const ref = mediaRefOf(body);
  if (!ref) {
    return { ok: false, status: 400, error: '没给素材:请求体要带 media(素材的 id / url / hash);本机文件路径不再接受,字节一律经素材服务取' };
  }
  try {
    const src = await resolveSource(ref);
    if (!src) return { ok: false, status: 404, error: `素材服务上没有这份素材:${mediaLabel(ref)}(还在上传就等传完再试;否则重新导入一次)` };
    return { ok: true, src, media: ref };
  } catch (e) {
    if (e instanceof AssetSourceError) return { ok: false, status: 502, kind: 'asset-service', error: e.message };
    throw e;
  }
}

export const isHttpSource = (src) => /^https?:\/\//i.test(String(src || ''));

/** 问 Python 包认不认地址的那一行代码。不含双引号:`.cmd` 当解释器时 spawnPython 会拒绝带 cmd 元字符的参数 */
export const acceptsUrlCode = (pkg) =>
  `import importlib,sys;m=importlib.import_module('${pkg}');sys.stdout.write('1' if getattr(m,'ACCEPTS_URL',False) else '0')`;

/**
 * 这份 Python 包认不认 http 地址(包里 `ACCEPTS_URL = True`)。问不出来(解释器起不来、import 失败、超时)按不认处理,
 * 退回临时文件那条路 —— 那条路对新老包都成立,只是多拷一遍字节。
 * @param {{ python: string, env: NodeJS.ProcessEnv, pkg: string, spawnPython: Function, timeoutMs?: number }} p
 * @returns {Promise<boolean>}
 */
export function pythonAcceptsUrl({ python, env, pkg, spawnPython, timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnPython(python, ['-c', acceptsUrlCode(pkg)], env); } catch { return resolve(false); }
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退 */ } finish(false); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0 && out.trim() === '1'));
  });
}

/** 临时文件的扩展名:照素材名,拿不到就不带(ffmpeg 按内容探格式,不靠扩展名) */
function extOf(ref) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(ref?.name || ''));
  return m ? `.${m[1].toLowerCase()}` : '';
}

/**
 * 把素材服务上的字节流到临时文件。回 `{ file, cleanup }`;失败抛 `AssetSourceError`(连不上、非 2xx、写盘失败都算取字节失败)。
 * 临时目录各作业一份(`os.tmpdir()/pc-perception-*`),cleanup 连目录一起删。
 */
export async function downloadToTemp(src, ref, { fetchImpl = globalThis.fetch, tmpRoot = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'pc-perception-'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 删不掉就留给系统清 */ } };
  const file = path.join(dir, `media${extOf(ref)}`);
  try {
    const res = await fetchImpl(src);
    if (!res.ok || !res.body) {
      try { await res.body?.cancel(); } catch { /* 已读完 */ }
      throw new AssetSourceError(`素材服务拒绝了读取(HTTP ${res.status})`);
    }
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    return { file, cleanup };
  } catch (e) {
    cleanup();
    if (e instanceof AssetSourceError) throw e;
    throw new AssetSourceError(`从素材服务取字节失败:${String(e?.cause?.code || e?.message || e)}`);
  }
}

/**
 * 给 Python 的视频参数:包认地址就原样递地址;不认就先流到临时文件递路径。回 `{ input, cleanup, via }`,
 * `via` 是 `'url'` 或 `'temp'`(测试、日志用)。src 不是 http 地址时原样递(不会发生:解析器只拼 http 地址)。
 */
export async function pythonInput({ src, ref, python, env, pkg, spawnPython, fetchImpl, tmpRoot }) {
  const noop = () => {};
  if (!isHttpSource(src)) return { input: src, cleanup: noop, via: 'url' };
  if (await pythonAcceptsUrl({ python, env, pkg, spawnPython })) return { input: src, cleanup: noop, via: 'url' };
  const t = await downloadToTemp(src, ref, { fetchImpl, tmpRoot });
  return { input: t.file, cleanup: t.cleanup, via: 'temp' };
}
