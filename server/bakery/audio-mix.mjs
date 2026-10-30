/**
 * Chrome 内混音。
 *
 * 从 scripts/export-frames.mjs 拆出来(纯重构,逐字搬运)。
 */

import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'node:fs';
import { spawn } from 'child_process';
import { MISSING_MATERIAL_WAV } from './mux-audio.mjs';

/** Confirmed missing audio always reads the fixed software resource, never project media/path data. */
export function audioClipInput(entry) {
  return entry.missingMaterial ? { file: MISSING_MATERIAL_WAV, offset: 0 } : { file: entry.file, offset: entry.offset };
}

/**
 * 声音在 Chrome 里混:每段先用 ffmpeg 裁出时间轴用到的那一截(48 kHz 立体声 float wav,几 MB),
 * 写一份 plan.json,开混音页(?audioMix=1,src/AudioMixView.tsx)在 OfflineAudioContext 里按位置、音量、
 * 淡入淡出、音频效果渲成整条 mix.wav 交回服务端(POST /api/export/<id>/audio-mix)。
 * 页面和预览用同一份效果链(src/audio/fxChain.ts),所以编辑台听到的就是导出的。
 * 需要页面地址里有 /@export/<id>/project.json —— 裁好的 wav 就靠这个 id 从 dev server 取。
 */
export async function mixAudioInChrome({ ffmpegCmd, outDir, plan, project, pageUrl, durationSec }) {
  const u = new URL(pageUrl);
  const m = /^\/@export\/([^/]+)\/project\.json$/.exec(u.searchParams.get('timeline') || '');
  if (!m) throw new Error('页面地址里没有 /@export/<id>/project.json,混音页取不到裁好的 wav');
  const id = m[1];
  // 时间轴时长之后才开始的段不出声,不用裁(项目 duration 比内容短时 plan 里会有这种段)
  plan = plan.filter((e) => e.start < durationSec);
  const audioDir = path.join(outDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  const run = (args) => new Promise((resolve, reject) => {
    const p = spawn(ffmpegCmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code + ':' + err.trim().slice(-400)))));
    p.on('error', reject);
  });
  // 裁段:4 个并行,每段只解用到的那几秒
  const clips = new Array(plan.length);
  let next = 0;
  let aborted = false;
  const worker = async () => {
    while (next < plan.length && !aborted) {
      const i = next++;
      const e = plan[i];
      if (e.cardAudio) {
        clips[i] = { clipId: e.clipId, url: '', start: e.start, dur: e.dur, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut,
          fx: e.fx, cardAudio: { project, nodeId: e.nodeId, frames: Math.max(1, Math.ceil(e.dur * 48000)) }, ...(e.env ? { env: e.env } : null) };
        continue;
      }
      const wav = path.join(audioDir, 'clip-' + i + '.wav');
      const input = audioClipInput(e);
      await run(['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(input.offset), '-t', String(e.dur), '-i', input.file,
        '-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', wav]);
      clips[i] = { clipId: e.clipId, url: '/@export/' + id + '/audio/clip-' + i + '.wav', start: e.start, dur: e.dur, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx,
        ...(e.env ? { env: e.env } : null) };
    }
  };
  // 一个裁段失败就让其余 worker 停下来,别让孤儿 ffmpeg 继续往 audio/ 里写
  await Promise.all(Array.from({ length: Math.min(4, plan.length) }, worker)).catch((e) => { aborted = true; throw e; });
  const mixPlan = { sampleRate: 48000, duration: Number(durationSec), clips };
  await fs.writeFile(path.join(audioDir, 'plan.json'), JSON.stringify(mixPlan));

  console.log('Mixing ' + clips.length + ' audio clip(s) in Chrome...');
  const browser = await puppeteer.launch({ headless: 'shell', protocolTimeout: 120000, args: ['--window-position=-32000,-32000', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
  let result;
  try {
    const session = await browser.target().createCDPSession();
    let targetId;
    try { ({ targetId } = await session.send('Target.createTarget', { url: 'about:blank', left: -32000, top: -32000, width: 1280, height: 720, focus: false })); }
    finally { await session.detach(); }
    const target = await browser.waitForTarget(t => t._targetId === targetId);
    const page = await target.page();
    page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warn') console.log('MIX LOG:', msg.text()); });
    const mixUrl = u.origin + '/?audioMix=1&plan=' + encodeURIComponent('/@export/' + id + '/audio/plan.json') + '&out=' + encodeURIComponent('/api/export/audio-mix/' + id);
    const resp = await page.goto(mixUrl, { waitUntil: 'load', timeout: 60000 });
    // 拿到的不是混音页(403 说明页、404)就当场失败,别等到超时才退回 ffmpeg
    if (resp && !resp.ok()) throw new Error('混音页打不开:HTTP ' + resp.status());
    const handle = await page.waitForFunction(() => window.__pcAudioMix, { timeout: 90000, polling: 200 }).catch(async (e) => {
      const title = await page.title().catch(() => '');
      throw new Error('混音页 90 秒没有结果(页面标题「' + title + '」):' + e.message);
    });
    result = await handle.jsonValue();
  } finally {
    await browser.close().catch(() => {});
  }
  if (!result?.ok) throw new Error(result?.error || '混音页没有返回结果');
  for (const n of result.notes || []) console.warn('混音:', n);
  const mixWav = path.join(audioDir, 'mix.wav');
  if (!fsSync.existsSync(mixWav)) throw new Error('mix.wav 没交回来');
  const peakDb = 20 * Math.log10(Math.max(result.peak || 0, 1e-9));
  console.log('Chrome mix done in ' + ((result.renderMs || 0) / 1000).toFixed(2) + ' s, peak ' + peakDb.toFixed(1) + ' dBFS' + (peakDb > 0 ? '(削波!挂个 limiter 或压低音量)' : ''));
  return { mixWav, clips: clips.length };
}
