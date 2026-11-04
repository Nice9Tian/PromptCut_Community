/**
 * Asset source resolution: where ffmpeg should read assets that the page fetches by URL, and asset
 * layer planning before frame rendering.
 *
 * Split out from scripts/export-frames.mjs (pure refactor, moved verbatim).
 */

import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { execFileSync } from 'child_process';
import { clipFrameRange, composeLayers } from '../export-compose.mjs';
import { DEFAULT_URL } from './chrome.mjs';
import { ffprobeOf } from './ffmpeg.mjs';

const isInside = (file, dir) => {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Where ffmpeg reads assets from. The page fetches via m.url, and we look up via the same URL here:
 *   /@export/<id>/media/<file> → <out>/media/<file> (assets uploaded by browser during export,
 *   residing in this export pass's own output directory);
 *   everything else goes over HTTP like the page, requesting from the page origin (/@media/<hash>
 *   and /api/media/file?path=… both support Range, so ffmpeg can seek).
 * In the prerender process spawned by the editor, the page origin is the prerender process itself,
 * which forwards /@media/* and /api/media/* as-is to the asset service (mediaRoutes in
 * vite.prerender.config.ts); standalone scripts load the page from the dev server, where /@media is
 * the asset service itself. Therefore, we **do not read the local content store directory** here,
 * nor do we recognize m.path (docs/semantics/product/asset-service.md "Responsibilities": the
 * prerender process only reads assets through asset service interfaces). Whitelisting disk paths is
 * guarded on the asset service side; HTTP here only accepts same-origin URLs from the page:
 * project.json comes from the browser, and must not direct ffmpeg to read arbitrary addresses.
 */
export function mediaSourceOf(m, { outDir, pageUrl }) {
  const url = String(m?.url || '');
  if (!url || /^(blob|data):/i.test(url)) return null;
  const exportMedia = path.resolve(outDir, 'media');
  const marker = url.lastIndexOf('/media/');
  if (url.startsWith('/@export/') && marker !== -1) {
    const f = path.join(exportMedia, decodeURIComponent(url.slice(marker + '/media/'.length).split('?')[0]));
    if (isInside(f, exportMedia) && fsSync.existsSync(f)) return f;
  }
  try {
    const u = new URL(url, pageUrl);
    if (u.origin === new URL(pageUrl).origin && /^https?:$/.test(u.protocol)) return u.href;
  } catch { /* Invalid URL */ }
  return null;
}

/**
 * ffprobe inspects the asset: whether there is an alpha channel (determines if emphasis applies),
 * color space (unspecified ones are decoded as bt709, matching Chrome), and whether to switch
 * decoders (VP8/VP9 with alpha drops alpha using ffmpeg's built-in decoder, requiring libvpx).
 * Returns null if unreadable.
 */
function probeVisual(ffprobeCmd, src) {
  try {
    const out = execFileSync(ffprobeCmd, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt,color_space:stream_tags=alpha_mode', '-of', 'json', src,
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const s = JSON.parse(out).streams?.[0];
    if (!s) return null;
    const alphaTag = String(s.tags?.alpha_mode ?? s.tags?.ALPHA_MODE ?? '') === '1';
    const pix = String(s.pix_fmt || '');
    return {
      hasAlpha: alphaTag || /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/.test(pix),
      colorSpace: s.color_space || 'unknown',
      decoder: alphaTag ? ({ vp8: 'libvpx', vp9: 'libvpx-vp9' })[s.codec_name] : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * ffmpeg uses whichever project the page took: fetch by timeline in the export page URL; if not
 * found, check <out>/project.json.
 */
async function loadProject(url, outDir) {
  try {
    const u = new URL(url);
    const tl = u.searchParams.get('timeline');
    if (tl) {
      const r = await fetch(new URL(tl, u));
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.tracks)) return j;
      }
    }
  } catch (e) {
    console.warn('Failed to fetch the project, reading project.json from the output directory instead:', e.message);
  }
  const f = path.join(outDir, 'project.json');
  if (fsSync.existsSync(f)) {
    const j = JSON.parse(fsSync.readFileSync(f, 'utf8'));
    if (j && Array.isArray(j.tracks)) return j;
  }
  return null;
}

/**
 * Plan asset layers before frame rendering: where each asset clip is read from, whether it has
 * alpha, and which frames have assets underneath (those frames need frosted-glass mask captures; for
 * frames without assets underneath, behind the glass is just a gray background, blur makes no
 * difference).
 */
async function planMedia(opts, outDir, ffmpegCmd) {
  const url = opts.url || DEFAULT_URL;
  const project = await loadProject(url, outDir);
  if (!project) return null;
  const all = composeLayers(project);
  if (!all.length) return { project, layers: [], glassFrames: new Set() };
  const ffprobeCmd = ffprobeOf(ffmpegCmd);
  const probed = new Map();
  const layers = all.map((l) => {
    const state = l.media?.missingMaterial;
    const confirmedMissing = state?.v === 1 && state.reason === 'confirmed-missing' && state.mediaId === l.media.id
      && state.original?.kind === l.media.kind && state.original?.name === l.media.name
      && state.original?.url === l.media.url && state.original?.hash === l.media.hash
      && typeof state.visual === 'boolean' && typeof state.audio === 'boolean';
    if (confirmedMissing && state.visual === true) return { ...l, src: null, missingMaterial: true, hasAlpha: false };
    let src = mediaSourceOf(l.media, { outDir, pageUrl: url });
    let info = null;
    if (src) {
      if (!probed.has(src)) probed.set(src, probeVisual(ffprobeCmd, src));
      info = probed.get(src);
      if (!info) {
        console.warn(`Media "${l.media.name || l.media.id}" cannot be read by ffprobe (${src}), this layer has no picture`);
        src = null;
      }
    } else {
      console.warn(`Media "${l.media.name || l.media.id}" file not found (${l.media.url || 'no URL'}), this layer has no picture`);
    }
    return { ...l, src, hasAlpha: !!info?.hasAlpha, colorSpace: info?.colorSpace, decoder: info?.decoder };
  });
  const fps = opts.fps || project.fps || 30;
  let [f0, f1] = [0, Math.floor((project.duration || 20) * fps) - 1];
  if (opts.frames) [f0, f1] = opts.frames.split('-').map(Number);
  const glassFrames = new Set();
  for (const l of layers) {
    if (!l.src) continue;
    const r = clipFrameRange(l.clip, fps, f0, f1);
    if (r) for (let i = r[0]; i <= r[1]; i++) glassFrames.add(i);
  }
  return { project, layers, glassFrames };
}

/**
 * The mask sequence must have one image per frame (image2 input cannot skip numbers): pad a fully
 * transparent image for frames without glass.
 */
async function fillGlassGaps(dir, startFrame, endFrame, width, height) {
  const { PNG } = await import('pngjs');
  const empty = PNG.sync.write(new PNG({ width, height }));
  const writes = [];
  for (let i = startFrame; i <= endFrame; i++) {
    const f = path.join(dir, `${String(i).padStart(6, '0')}.png`);
    if (!fsSync.existsSync(f)) writes.push(fs.writeFile(f, empty));
  }
  await Promise.all(writes);
}

export { loadProject, planMedia, fillGlassGaps };
