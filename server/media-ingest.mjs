/**
 * How server-generated assets enter the content store: **via the asset service store endpoint**,
 * following the same path as user asset imports (`POST /api/media/upload/<filename>?tiers=1`;
 * for page import, see `uploadMediaFile` in `src/editor/io/mediaUpload.ts`).
 * Semantics: `docs/semantics/product/asset-service.md` "Responsibilities" (the store step cannot
 * be omitted; neither side may bypass it to read or write bytes directly),
 * `product/agent.md` "Assets and artifacts".
 *
 * Callers include voiceover (`voice_generate`, TTS output) and media collection
 * (`collect_download`, yt-dlp download output): both first land in their own temporary
 * directories, and once finished, are streamed here to be stored, returning the content hash
 * and `/@media/<hash>`, after which temporary files are deleted by the caller. Previously they
 * wrote directly into the asset catalog.
 *
 * This file does not import vite and is agnostic to the asset catalog;
 * `server/test/media-ingest.test.mjs` tests it directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { AssetSourceError } from './audio-source.mjs';
import { tr } from './i18n.mjs';

/**
 * Time limit for storing a single file. Uploads are streamed writes over the local loopback,
 * taking only about ten seconds even for videos of several hundred MB; leave ample margin for
 * slow disks.
 */
export const INGEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Sends a local temporary file into the content store via the asset service store endpoint.
 * @param {object} p
 * @param {string} p.file Absolute path to the temporary file
 * @param {string} [p.name] Filename used for storing (defaults to the filename of file); the asset
 *   service determines the extension from it
 * @param {() => (string | null)} p.origin Origin of the asset service; null = unreachable
 * @param {boolean} [p.tiers] Include `?tiers=1` (evaluates faststart for video, queues
 *   small-size asset; same as user import, included by default)
 * @param {typeof fetch} [p.fetchImpl]
 * @param {number} [p.timeoutMs]
 * @returns {Promise<{ hash: string, ext: string, name: string, url: string, bytes: number, deduped: boolean, path?: string, tiers?: { original: string, small: string | null }, small?: string }>}
 *   Throws `AssetSourceError` on failure: if the address cannot be obtained, connection fails,
 *   times out, non-2xx status, or the response contains no hash; all state the asset service
 *   address and reason.
 */
export async function ingestFile({ file, name, origin, tiers = true, fetchImpl = globalThis.fetch, timeoutMs = INGEST_TIMEOUT_MS, ownership = null, ticket = null }) {
  await ownership?.assert();
  const token = typeof ticket === 'function' ? await ticket() : ticket;
  if (ownership && !token) throw new AssetSourceError(tr("Project asset ingest is missing an authorization ticket"));
  const base = origin();
  if (!base) throw new AssetSourceError(tr("Asset service unreachable: the editor process could not get the asset service address, so ingest failed"));
  const fileName = name || path.basename(file);
  let size;
  try { size = fs.statSync(file).size; } catch (e) { throw new Error(tr("The file to ingest is missing: {0} ({1})", fileName, e?.code || e?.message || e)); }
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
    const why = e?.name === 'TimeoutError' ? tr("upload not finished after {0} seconds", Math.round(timeoutMs / 1000)) : String(e?.cause?.code || e?.message || e);
    throw new AssetSourceError(tr("Asset service unreachable ({0}), ingest failed: {1}", base, why));
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new AssetSourceError(tr("Asset service rejected the ingest ({0}, HTTP {1}){2}", base, res.status, text ? `:${text.slice(0, 200)}` : ''));
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data?.ok || typeof data.hash !== 'string') throw new AssetSourceError(tr("The asset service ingest response has no content hash ({0})", base));
  await ownership?.assert();
  if (ownership && data.projectId !== ownership.projectId) throw new AssetSourceError(tr("Project asset ingest response ownership does not match"));
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
