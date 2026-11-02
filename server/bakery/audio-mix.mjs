/**
 * Audio mixing in Chrome.
 *
 * Split out from scripts/export-frames.mjs (pure refactor, verbatim move).
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
 * Audio is mixed in Chrome: each segment is first trimmed with ffmpeg to the section used on the
 * timeline (48 kHz stereo float wav, a few MB), writes a plan.json, opens the audio mix page
 * (?audioMix=1, src/AudioMixView.tsx) to render into a full mix.wav in OfflineAudioContext based
 * on position, volume, fade in/out, and audio effects, and sends it back to the server
 * (POST /api/export/<id>/audio-mix).
 * The page and preview share the same effects chain (src/audio/fxChain.ts), so what is heard in the
 * editor is what gets exported.
 * Requires /@export/<id>/project.json in the page URL: the trimmed wav relies on this id to be
 * fetched from the dev server.
 */
export async function mixAudioInChrome({ ffmpegCmd, outDir, plan, project, pageUrl, durationSec }) {
  const u = new URL(pageUrl);
  const m = /^\/@export\/([^/]+)\/project\.json$/.exec(u.searchParams.get('timeline') || '');
  if (!m) throw new Error('The page URL has no /@export/<id>/project.json, so the mix page cannot get the trimmed wav');
  const id = m[1];
  // Segments starting after timeline duration produce no sound and need no trimming (such segments
  // can appear in the plan when project duration is shorter than content)
  plan = plan.filter((e) => e.start < durationSec);
  const audioDir = path.join(outDir, 'audio');
  await fs.mkdir(audioDir, { recursive: true });
  const run = (args) => new Promise((resolve, reject) => {
    const p = spawn(ffmpegCmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit code ' + code + ':' + err.trim().slice(-400)))));
    p.on('error', reject);
  });
  // Trim segments: 4 in parallel, decoding only the few seconds used for each segment
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
  // If any segment trim fails, stop the remaining workers so orphaned ffmpeg won't keep writing to audio/
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
    // If response is not the mix page (403 info page, 404), fail immediately rather than waiting for
    // timeout to fall back to ffmpeg
    if (resp && !resp.ok()) throw new Error('Mix page failed to open: HTTP ' + resp.status());
    const handle = await page.waitForFunction(() => window.__pcAudioMix, { timeout: 90000, polling: 200 }).catch(async (e) => {
      const title = await page.title().catch(() => '');
      throw new Error('Mix page produced no result in 90 s (page title "' + title + '"): ' + e.message);
    });
    result = await handle.jsonValue();
  } finally {
    await browser.close().catch(() => {});
  }
  if (!result?.ok) throw new Error(result?.error || 'Mix page returned no result');
  for (const n of result.notes || []) console.warn('Mix: ', n);
  const mixWav = path.join(audioDir, 'mix.wav');
  if (!fsSync.existsSync(mixWav)) throw new Error('mix.wav was not returned');
  const peakDb = 20 * Math.log10(Math.max(result.peak || 0, 1e-9));
  console.log('Chrome mix done in ' + ((result.renderMs || 0) / 1000).toFixed(2) + ' s, peak ' + peakDb.toFixed(1) + ' dBFS' + (peakDb > 0 ? '(clipping! add a limiter or lower the volume)' : ''));
  return { mixWav, clips: clips.length };
}
