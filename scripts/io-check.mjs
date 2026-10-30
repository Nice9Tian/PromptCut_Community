import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

// 地址必须显式给(--url <地址> 或环境变量 PROMPTCUT_BASE),不给就报用法退出:
// 永不缺省连用户常驻的编辑器(5190～5192)。
const urlArg = process.argv.indexOf('--url');
const BASE = ((urlArg >= 0 ? process.argv[urlArg + 1] : '') || process.env.PROMPTCUT_BASE || '').replace(/\/+$/, '');
if (!BASE || BASE.startsWith('--')) {
  console.error('用法: node scripts/io-check.mjs --url http://127.0.0.1:<自己起的 dev server 端口>\n  或设环境变量 PROMPTCUT_BASE。不给地址不跑:不缺省连用户常驻的编辑器。');
  process.exit(2);
}

(async () => {
  console.log('Launching Puppeteer...');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  let warnCount = 0;
  page.on('console', msg => {
    if (msg.type() === 'warning') warnCount++;
    console.log(`PAGE [${msg.type()}]:`, msg.text());
  });

  await page.exposeFunction('__reportProgress', (done, total) => {
    console.log(`Export Progress: ${done}/${total}`);
  });

  console.log(`Opening ${BASE}/`);
  await page.goto(`${BASE}/`);

  console.log('Waiting for window.__pcIo and initial clips...');
  await page.waitForFunction(() => {
    if (!window.__pcIo) return false;
    try {
      const jsonStr = window.__pcIo.exportProjectJson();
      const p = JSON.parse(jsonStr);
      return p.tracks.some(t => t.clips.length > 0);
    } catch (e) {
      return false;
    }
  }, { timeout: 10000 });

  console.log('\n--- Step 2: Import test.mp4 ---');
  const importResult = await page.evaluate(async () => {
    const r = await fetch('/out/test.mp4');
    const b = await r.blob();
    const f = new File([b], 'test.mp4', { type: 'video/mp4' });
    await window.__pcIo.importVideoFiles([f]);
    const jsonStr = window.__pcIo.exportProjectJson();
    const p = JSON.parse(jsonStr);
    const videoTrack = p.tracks.find(t => t.kind === 'video');
    const videoClip = videoTrack.clips.find(c => c.mediaId === p.media[0].id);
    return {
      mediaCount: p.media.length,
      videoClipCount: videoTrack.clips.length,
      clipStart: videoClip?.start,
      clipEnd: videoClip?.end,
      duration: p.duration
    };
  });
  console.log('Import result:', importResult);

  console.log('\n--- Step 3: exportProjectJson ---');
  const jsonStr = await page.evaluate(() => window.__pcIo.exportProjectJson());
  const p = JSON.parse(jsonStr);
  console.log('media[0].url:', p.media[0].url);
  console.log('_note field exists:', '_note' in p);
  if (p.media[0].url !== 'test.mp4') console.error('Media URL is not test.mp4!');

  console.log('\n--- Step 4: Re-import exported JSON ---');
  const reimportResult = await page.evaluate(async (jsonString) => {
    const f = new File([jsonString], 'reimport.json', { type: 'application/json' });
    const proj = await window.__pcIo.importProjectFile(f);
    const videoTrack = proj.tracks.find(t => t.kind === 'video');
    return {
      mediaName: proj.media[0].name,
      mediaUrl: proj.media[0].url,
      videoClipCount: videoTrack.clips.length
    };
  }, jsonStr);
  console.log('Reimport result:', reimportResult);
  console.log('Has missing prefix:', reimportResult.mediaName.includes('(缺失)'));
  console.log('Is url empty string:', reimportResult.mediaUrl === '');
  console.log('Are video clips preserved:', reimportResult.videoClipCount > 0);

  console.log('\n--- Step 5: Import old cards format ---');
  const oldFormatWarnCountBefore = warnCount;
  const oldFormatResult = await page.evaluate(async () => {
    const currentJson = JSON.parse(window.__pcIo.exportProjectJson());
    const validCardId = currentJson.tracks.find(t => t.kind === 'overlay').clips[0].cardId;
    
    const oldFormat = {
      cards: [
        { cardId: validCardId, start: 0, end: 2, params: {} },
        { cardId: 'definitely-not-exist', start: 2, end: 4 }
      ]
    };
    const f = new File([JSON.stringify(oldFormat)], 'old.json', { type: 'application/json' });
    const proj = await window.__pcIo.importProjectFile(f);
    const overlayTrack = proj.tracks.find(t => t.kind === 'overlay');
    return {
      clipCount: overlayTrack.clips.length
    };
  });
  console.log('Old format clip count:', oldFormatResult.clipCount);
  console.log('Warnings caught during this step:', warnCount - oldFormatWarnCountBefore);

  console.log('\n--- Step 6: Final exportVideo ---');
  // 第 5 步把项目换成了只含 1 张卡(0-2s)的旧编排,直接导 0-89 帧的话第 89 帧上没有卡片。
  // reload 一次让 Editor 重新自动铺满 10 张演示卡,保证 0-3s 全程都有动效叠在视频上。
  await page.reload();
  await page.waitForFunction(() => {
    if (!window.__pcIo) return false;
    try {
      const p = JSON.parse(window.__pcIo.exportProjectJson());
      return p.tracks.some(t => t.clips.length > 0);
    } catch (e) {
      return false;
    }
  }, { timeout: 15000 });
  const overlayClips = await page.evaluate(() => {
    const p = JSON.parse(window.__pcIo.exportProjectJson());
    return p.tracks.filter(t => t.kind === 'overlay').flatMap(t => t.clips.map(c => ({ cardId: c.cardId, start: c.start, end: c.end })));
  });
  console.log('Overlay clips after reload:', JSON.stringify(overlayClips));

  const exportPromise = page.evaluate(async () => {
    const r = await fetch('/out/test.mp4');
    const b = await r.blob();
    const f = new File([b], 'test.mp4', { type: 'video/mp4' });
    await window.__pcIo.importVideoFiles([f]);
    
    return await window.__pcIo.exportVideo({
      frames: '0-89',
      onProgress: (done, total) => {
        window.__reportProgress(done, total);
      }
    });
  });
  
  const { outDir } = await exportPromise;
  console.log('Export finished. outDir:', outDir);
  await browser.close();

  console.log('\n--- Step 7: Verify files ---');
  const framesDir = path.join(outDir, 'frames');
  const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.png'));
  console.log(`Found ${files.length} png files in frames dir.`);
  
  const movPath = path.join(outDir, 'overlay.mov');
  const mp4Path = path.join(outDir, 'preview.mp4');
  if (fs.existsSync(movPath)) console.log(`overlay.mov size: ${fs.statSync(movPath).size} bytes`);
  else console.log('overlay.mov NOT FOUND');
  if (fs.existsSync(mp4Path)) console.log(`preview.mp4 size: ${fs.statSync(mp4Path).size} bytes`);
  else console.log('preview.mp4 NOT FOUND');

  console.log('\n--- Step 8 & 9: Inspect and copy selected frames ---');
  const testFrames = ['000000.png', '000045.png', '000089.png'];
  for (const name of testFrames) {
    const p = path.join(framesDir, name);
    if (!fs.existsSync(p)) {
      console.log(`${name} does not exist.`);
      continue;
    }
    
    const buffer = fs.readFileSync(p);
    const png = PNG.sync.read(buffer);
    let nonZeroAlpha = 0;
    let rSum = 0, gSum = 0, bSum = 0;
    const colors = new Set();
    
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const idx = (png.width * y + x) << 2;
        const r = png.data[idx];
        const g = png.data[idx+1];
        const b = png.data[idx+2];
        const a = png.data[idx+3];
        
        if (a > 0) {
          nonZeroAlpha++;
          rSum += r;
          gSum += g;
          bSum += b;
          colors.add(`${r},${g},${b}`);
        }
      }
    }
    
    const totalPixels = png.width * png.height;
    console.log(`[${name}] Non-zero alpha pixels: ${nonZeroAlpha} (${((nonZeroAlpha/totalPixels)*100).toFixed(2)}%)`);
    if (nonZeroAlpha > 0) {
      console.log(`[${name}] Avg RGB: ${Math.round(rSum/nonZeroAlpha)}, ${Math.round(gSum/nonZeroAlpha)}, ${Math.round(bSum/nonZeroAlpha)}`);
    }
    console.log(`[${name}] Unique colors count: ${colors.size}`);
    
    const targetName = `check-frame-${name.substring(3)}`;
    const targetPath = path.join('out', targetName);
    fs.copyFileSync(p, targetPath);
    console.log(`Copied to ${targetPath}`);
  }

})().catch(console.error);
