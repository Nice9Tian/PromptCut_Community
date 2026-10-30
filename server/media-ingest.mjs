/**
 * 服务端生成的素材怎么进内容库:**经素材服务的入库接口**,和用户导入素材走同一条路
 * (`POST /api/media/upload/<文件名>?tiers=1`,页面导入见 `src/editor/io/mediaUpload.ts` 的 uploadMediaFile)。
 * 语义:`docs/semantics/product/asset-service.md`「职责」(入库这一步不能省,任何一方不得绕过它直接读写字节)、
 * `product/agent.md`「素材与产物」。
 *
 * 用它的是配音(`voice_generate`,TTS 结果)与素材收集(`collect_download`,yt-dlp 的下载结果):两者都先落在自己的临时目录,
 * 完成后由这里流式上传入库,拿回内容哈希与 `/@media/<hash>`,临时文件随后由调用方删掉。原来它们直接写进素材目录。
 *
 * 本文件不 import vite、不认素材目录,`server/test/media-ingest.test.mjs` 直接测它。
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AssetSourceError } from './audio-source.mjs';

/** 一份文件入库的时限。上传是本机回环上的流式写入,几百 MB 的视频也就十几秒;慢盘上留足余量 */
export const INGEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 把本机一个临时文件经素材服务的入库接口送进内容库。
 * @param {object} p
 * @param {string} p.file 临时文件的绝对路径
 * @param {string} [p.name] 入库用的文件名(缺省取 file 的文件名);素材服务按它定扩展名
 * @param {() => (string | null)} p.origin 素材服务的源;null = 不可达
 * @param {boolean} [p.tiers] 带 `?tiers=1`(视频做 faststart 判定、排素材小尺寸;和用户导入一样,缺省带)
 * @param {typeof fetch} [p.fetchImpl]
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{ hash: string, ext: string, name: string, url: string, bytes: number, deduped: boolean, path?: string, tiers?: { original: string, small: string | null }, small?: string }>}
 *   失败抛 `AssetSourceError`:取不到地址、连不上、超时、非 2xx、回包里没有哈希,都写明素材服务地址与原因。
 */
export async function ingestFile({ file, name, origin, tiers = true, fetchImpl = globalThis.fetch, timeoutMs = INGEST_TIMEOUT_MS, ownership = null, ticket = null }) {
  await ownership?.assert();
  const token = typeof ticket === 'function' ? await ticket() : ticket;
  if (ownership && !token) throw new AssetSourceError('项目素材入库缺少授权票据');
  const base = origin();
  if (!base) throw new AssetSourceError('素材服务不可达:编辑器进程取不到素材服务的地址,没能入库');
  const fileName = name || path.basename(file);
  let size;
  try { size = fs.statSync(file).size; } catch (e) { throw new Error(`要入库的文件不见了:${fileName}(${e?.code || e?.message || e})`); }
  const url = `${base}/api/media/upload/${encodeURIComponent(fileName)}${tiers ? '?tiers=1' : ''}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: Readable.toWeb(fs.createReadStream(file)),
      duplex: 'half',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `${Math.round(timeoutMs / 1000)} 秒没有传完` : String(e?.cause?.code || e?.message || e);
    throw new AssetSourceError(`素材服务不可达(${base}),没能入库:${why}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new AssetSourceError(`素材服务拒绝了入库(${base},HTTP ${res.status})${text ? `:${text.slice(0, 200)}` : ''}`);
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data?.ok || typeof data.hash !== 'string') throw new AssetSourceError(`素材服务的入库回包里没有内容哈希(${base})`);
  await ownership?.assert();
  if (ownership && data.projectId !== ownership.projectId) throw new AssetSourceError('项目素材入库回包归属不匹配');
  return {
    ...(ownership ? { projectId: ownership.projectId } : {}),
    hash: data.hash,
    ext: String(data.ext || ''),
    name: String(data.name || fileName),
    url: String(data.url || `/@media/${data.hash}`),
    bytes: Number(data.bytes) || size,
    deduped: !!data.deduped,
    ...(typeof data.path === 'string' ? { path: data.path } : null),
    ...(data.tiers && typeof data.tiers.original === 'string'
      ? { tiers: { original: data.tiers.original, small: typeof data.tiers.small === 'string' ? data.tiers.small : null } }
      : null),
    ...(typeof data.small === 'string' ? { small: data.small } : null),
  };
}
