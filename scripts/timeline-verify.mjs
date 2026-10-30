import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// 地址必须显式给(--url <地址> 或环境变量 PROMPTCUT_BASE),不给就报用法退出:
// 永不缺省连用户常驻的编辑器(5190～5192)。
const urlArg = process.argv.indexOf('--url');
const BASE = ((urlArg >= 0 ? process.argv[urlArg + 1] : '') || process.env.PROMPTCUT_BASE || '').replace(/\/+$/, '');
if (!BASE || BASE.startsWith('--')) {
  console.error('用法: node scripts/timeline-verify.mjs --url http://127.0.0.1:<自己起的 dev server 端口>\n  或设环境变量 PROMPTCUT_BASE。不给地址不跑:不缺省连用户常驻的编辑器。');
  process.exit(2);
}

const OUT_DIR = path.join(process.cwd(), 'out', 'timeline');
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const summaryTable = [];
function addSummary(step, screenshot, before, after, passed) {
  summaryTable.push({ step, screenshot, before: JSON.stringify(before), after: JSON.stringify(after), passed });
}

async function run() {
  console.log('Launching puppeteer...');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.setViewport({ width: 1280, height: 800 });
  
  console.log(`Navigating to ${BASE}/`);
  await page.goto(`${BASE}/`);
  
  // dismiss AI dialog mask
  try {
    await page.waitForSelector('.ais-backdrop', { timeout: 2000 });
    console.log('Found .ais-backdrop, dismissing...');
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const closeBtn = btns.find(b => b.textContent && b.textContent.includes('以后再说'));
      if (closeBtn) {
        closeBtn.click();
      }
    });
    await page.waitForFunction(() => !document.querySelector('.ais-backdrop'), { timeout: 2000 });
    console.log('Dialog dismissed.');
  } catch (e) {
    console.log('No .ais-backdrop found or failed to dismiss, proceeding...');
    const backdrop = await page.$('.ais-backdrop');
    if (backdrop) {
       throw new Error("Found .ais-backdrop but could not dismiss it.");
    }
  }

  await page.waitForFunction('!!window.__pcStore');
  
  async function takeScreenshot(name) {
    const p = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: p });
    console.log(`Saved screenshot: ${p}`);
    return p;
  }

  async function getStoreState() {
    return await page.evaluate(() => {
      const state = window.__pcStore.getState();
      return {
        tracks: state.project.tracks,
        t: state.t
      };
    });
  }

  let state = await getStoreState();
  // 序列不分种类了,演示片段都在第一条有内容的序列上
  const overlayTrackIndex = Math.max(0, state.tracks.findIndex(t => t.clips.length > 0));
  
  try {
    // 1. 拖动改时段（能动的情形）
    console.log('1. Drag last clip to change time...');
    const lastClip = state.tracks[overlayTrackIndex].clips[state.tracks[overlayTrackIndex].clips.length - 1];
    let clipSelector = `[data-clip-id="${lastClip.id}"]`;
    await page.waitForSelector(clipSelector);
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView(), clipSelector);
    
    let clipBox = await (await page.$(clipSelector)).boundingBox();
    const originalDur = lastClip.end - lastClip.start;
    
    await page.mouse.move(clipBox.x + 20, clipBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(clipBox.x + 220, clipBox.y + 10, { steps: 10 });
    await page.mouse.up();
    let img1 = await takeScreenshot('01-drag-free');
    
    state = await getStoreState();
    let afterDragClip = state.tracks[overlayTrackIndex].clips.find(c => c.id === lastClip.id);
    let newDur = afterDragClip.end - afterDragClip.start;
    assert(afterDragClip.start > lastClip.start, "Start time should increase");
    assert(Math.abs(newDur - originalDur) < 0.05, "Duration should remain the same");
    addSummary("Drag clip (free)", img1, lastClip, afterDragClip, true);

    // 2. 拖动被邻居挡住（防压扁回归测试）
    console.log('2. Drag first clip blocked by neighbor...');
    const firstClip = state.tracks[overlayTrackIndex].clips[0];
    clipSelector = `[data-clip-id="${firstClip.id}"]`;
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView(), clipSelector);
    clipBox = await (await page.$(clipSelector)).boundingBox();
    const firstDur = firstClip.end - firstClip.start;
    
    await page.mouse.move(clipBox.x + 20, clipBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(clipBox.x + 320, clipBox.y + 10, { steps: 10 });
    await page.mouse.up();
    let img2 = await takeScreenshot('02-drag-blocked');
    
    state = await getStoreState();
    let afterBlockedDrag = state.tracks[overlayTrackIndex].clips.find(c => c.id === firstClip.id);
    let afterBlockedDur = afterBlockedDrag.end - afterBlockedDrag.start;
    assert(Math.abs(afterBlockedDur - firstDur) < 0.05, "Duration should not be squashed");
    assert(afterBlockedDrag.start >= 0 && afterBlockedDrag.start <= 2, "Start should stay in valid range");
    addSummary("Drag clip (blocked)", img2, firstClip, afterBlockedDrag, true);

    // 3. 左把手 / 右把手
    console.log('3. Resize left/right handles...');
    clipSelector = `[data-clip-id="${afterDragClip.id}"]`; // use the last clip again
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView(), clipSelector);
    
    let handleBox = await page.evaluate((sel) => {
       const el = document.querySelector(sel);
       const rightHandle = el.lastElementChild;
       const rect = rightHandle.getBoundingClientRect();
       return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, clipSelector);
    
    // right handle
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 100, handleBox.y + handleBox.height / 2, { steps: 10 });
    await page.mouse.up();
    
    state = await getStoreState();
    let afterRightResize = state.tracks[overlayTrackIndex].clips.find(c => c.id === afterDragClip.id);
    assert(afterRightResize.end > afterDragClip.end, "End time should increase after right resize");
    assert(Math.abs(afterRightResize.start - afterDragClip.start) < 0.05, "Start time should not change on right resize");
    
    // left handle
    let handleLeftBox = await page.evaluate((sel) => {
       const el = document.querySelector(sel);
       const leftHandle = el.firstElementChild;
       const rect = leftHandle.getBoundingClientRect();
       return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }, clipSelector);
    
    await page.mouse.move(handleLeftBox.x + handleLeftBox.width / 2, handleLeftBox.y + handleLeftBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleLeftBox.x + 50, handleLeftBox.y + handleLeftBox.height / 2, { steps: 10 });
    await page.mouse.up();
    let img3 = await takeScreenshot('03-resize');
    
    state = await getStoreState();
    let afterLeftResize = state.tracks[overlayTrackIndex].clips.find(c => c.id === afterDragClip.id);
    assert(afterLeftResize.start > afterRightResize.start, "Start time should increase after left resize");
    assert(Math.abs(afterLeftResize.end - afterRightResize.end) < 0.05, "End time should not change on left resize");
    addSummary("Resize handles", img3, afterDragClip, afterLeftResize, true);

    // 4. 跨轨拖动
    console.log('4. Cross track drag...');
    // create a new track
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent && b.textContent.includes('+ 动效轨'));
      if (btn) btn.click();
    });
    await new Promise(r => setTimeout(r, 500));
    
    state = await getStoreState();
    const newTrackId = state.tracks[state.tracks.length - 1].id;
    const targetTrackSelector = `[data-track-id="${newTrackId}"]`;
    const targetTrackBox = await (await page.$(targetTrackSelector)).boundingBox();
    
    clipBox = await (await page.$(clipSelector)).boundingBox();
    await page.mouse.move(clipBox.x + 20, clipBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(clipBox.x + 20, targetTrackBox.y + 10, { steps: 10 });
    await page.mouse.up();
    let img4 = await takeScreenshot('04-crosstrack');
    
    state = await getStoreState();
    const sourceTrackClips = state.tracks[overlayTrackIndex].clips;
    const newTrackClips = state.tracks[state.tracks.length - 1].clips;
    assert(!sourceTrackClips.some(c => c.id === afterLeftResize.id), "Clip should not be in original track");
    assert(newTrackClips.some(c => c.id === afterLeftResize.id), "Clip should be in new track");
    addSummary("Cross track drag", img4, { track: state.tracks[overlayTrackIndex].id }, { track: newTrackId }, true);

    // 5. 右键分割
    console.log('5. Split clip...');
    const clipToSplit = newTrackClips[0];
    const midTime = clipToSplit.start + (clipToSplit.end - clipToSplit.start) / 2;
    await page.evaluate((t) => window.__pcStore.actions.seek(t), midTime);
    
    const finalClipSelector = `[data-clip-id="${clipToSplit.id}"]`;
    clipBox = await (await page.$(finalClipSelector)).boundingBox();
    await page.mouse.click(clipBox.x + 20, clipBox.y + 10, { button: 'right' });
    
    await page.evaluate(() => {
       const items = Array.from(document.querySelectorAll('div')).filter(el => el.textContent === '在播放头处分割');
       if (items.length > 0) items[0].click();
    });
    await new Promise(r => setTimeout(r, 500));
    let img5 = await takeScreenshot('05-split');
    
    state = await getStoreState();
    const splitTrackClips = state.tracks[state.tracks.length - 1].clips;
    assert(splitTrackClips.length === 2, "Track should have 2 clips after split");
    assert(Math.abs(splitTrackClips[0].end - midTime) < 0.05, "Left clip end should equal playhead time");
    assert(Math.abs(splitTrackClips[1].start - midTime) < 0.05, "Right clip start should equal playhead time");
    addSummary("Split clip", img5, { count: 1 }, { count: 2 }, true);

    // 6. 删除
    console.log('6. Delete clip...');
    clipBox = await (await page.$(`[data-clip-id="${splitTrackClips[1].id}"]`)).boundingBox();
    await page.mouse.click(clipBox.x + 5, clipBox.y + 10);
    await page.keyboard.press('Delete');
    await new Promise(r => setTimeout(r, 100));
    let img6 = await takeScreenshot('06-delete');
    
    state = await getStoreState();
    assert(state.tracks[state.tracks.length - 1].clips.length === 1, "Track should have 1 clip after delete");
    addSummary("Delete clip", img6, { count: 2 }, { count: 1 }, true);

    // 7. 新增轨道
    console.log('7. Add tracks...');
    const trackCountBefore = state.tracks.length;
    // 序列统一后只剩一个「＋ 序列」按钮，点两次
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('序列'));
      if (btn) { btn.click(); btn.click(); }
    });
    await new Promise(r => setTimeout(r, 500));
    let img7 = await takeScreenshot('07-add-tracks');
    
    state = await getStoreState();
    assert(state.tracks.length === trackCountBefore + 2, "Track count should increase by 2");
    addSummary("Add tracks", img7, { count: trackCountBefore }, { count: state.tracks.length }, true);

    // 8. Ctrl+滚轮缩放
    console.log('8. Zoom...');
    clipSelector = `[data-clip-id="${firstClip.id}"]`;
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView(), clipSelector);
    
    let oldWidth = await page.evaluate((sel) => document.querySelector(sel).offsetWidth, clipSelector);
    
    await page.mouse.move(500, 700);
    await page.keyboard.down('Control');
    await page.mouse.wheel({ deltaY: -500 });
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 500));
    let img8 = await takeScreenshot('08-zoom');
    
    let newWidth = await page.evaluate((sel) => document.querySelector(sel).offsetWidth, clipSelector);
    assert(newWidth > oldWidth, "Clip width should increase after zoom in");
    addSummary("Zoom", img8, { width: oldWidth }, { width: newWidth }, true);

    // 9. 播放头拖动
    // 上一步缩放后播放头停在 20 秒开外、又被横向滚动挡在视口右侧之外，
    // 鼠标事件根本落不到它身上。所以先 seek 回 2 秒并把轨道区滚回最左边，
    // 保证播放头在视口内，再测拖动。
    await page.evaluate(() => {
      window.__pcStore.actions.seek(2);
      const sc = document.querySelector('.flex-1.flex.min-h-0.overflow-auto');
      if (sc) { sc.scrollLeft = 0; sc.scrollTop = 0; }
    });
    await new Promise(r => setTimeout(r, 300));
    state = await getStoreState();
    const tBefore = state.t;
    console.log(`9. Drag playhead... from ${tBefore}`);
    // 前面加过轨道又缩放过，轨道区可能横竖都被滚动过，播放头元素的 rect 有一截在视口外。
    // 这里取「播放头矩形 ∩ 滚动容器可见区域」的中点作为落点，并且真的用 elementsFromPoint
    // 确认那一点命中的是播放头本身，否则直接报错而不是静默拖了个空。
    const phPick = await page.evaluate(() => {
      const el = document.querySelector('.clip-playhead').parentElement;
      const sc = document.querySelector('.flex-1.flex.min-h-0.overflow-auto');
      const r = el.getBoundingClientRect();
      const v = sc.getBoundingClientRect();
      const x = r.x + r.width / 2;
      const yTop = Math.max(r.top, v.top) + 12;
      const yBot = Math.min(r.bottom, v.bottom);
      const y = Math.min(yTop, yBot - 4);
      const top = document.elementsFromPoint(x, y)[0];
      return { x, y, hit: top === el, hitCls: (top && top.className || '').toString().slice(0, 70) };
    });
    if (!phPick.hit) throw new Error(`播放头落点 (${phPick.x}, ${phPick.y}) 命中的是别的元素: ${phPick.hitCls}`);
    await page.mouse.move(phPick.x, phPick.y);
    await page.mouse.down();
    // 往右拖 300px
    await page.mouse.move(phPick.x + 300, phPick.y, { steps: 5 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 200));
    let img9 = await takeScreenshot('09-playhead');
    
    state = await getStoreState();
    console.log(`Playhead t changed to ${state.t}`);
    assert(Math.abs(state.t - tBefore) > 0.1, "Playhead t should change significantly");
    addSummary("Playhead drag", img9, { t: tBefore }, { t: state.t }, true);

    // 10. 接收卡片 drop
    console.log('10. Drop card (Match)...');
    const overlayTrackForDrop = state.tracks.find(t => t.clips.length > 0) || state.tracks[0];
    const overlayTrackId = overlayTrackForDrop.id;
    const overlayClipsBefore = overlayTrackForDrop.clips.length;
    const cardToDrop = firstClip.cardId;
    await page.evaluate((trackId, cardId) => {
      const trackEl = document.querySelector(`[data-track-id="${trackId}"]`);
      const dt = new DataTransfer();
      dt.setData("application/x-promptcut-card", cardId);
      Object.defineProperty(dt, 'types', { value: ['application/x-promptcut-card'] });
      
      const dragEnterEvent = new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, clientX: 400 });
      trackEl.dispatchEvent(dragEnterEvent);
      
      const dragOverEvent = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX: 400 });
      trackEl.dispatchEvent(dragOverEvent);
      
      const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: 400 });
      trackEl.dispatchEvent(dropEvent);
    }, overlayTrackId, cardToDrop);
    
    await new Promise(r => setTimeout(r, 500));
    let img10 = await takeScreenshot('10-drop-match');
    
    state = await getStoreState();
    const overlayTrackAfter = state.tracks.find(t => t.id === overlayTrackId);
    assert(overlayTrackAfter.clips.length === overlayClipsBefore + 1, "Drop match should add 1 clip");
    addSummary("Drop Match", img10, { count: overlayClipsBefore }, { count: overlayTrackAfter.clips.length }, true);

    // 11. 锁定的序列不接受落卡（以前这一步验的是 overlay/video kind 不匹配，序列统一后那条规则没有了）
    console.log('11. Drop card onto locked sequence...');
    const lockedTrack = state.tracks.find(t => t.id !== overlayTrackForDrop.id) || state.tracks[0];
    await page.evaluate((id) => window.__pcStore.actions.updateTrack(id, { locked: true }), lockedTrack.id);
    await new Promise(r => setTimeout(r, 100));
    const videoTrack = lockedTrack;
    const videoClipsBefore = videoTrack.clips.length;
    await page.evaluate((trackId, cardId) => {
      const trackEl = document.querySelector(`[data-track-id="${trackId}"]`);
      const dt = new DataTransfer();
      dt.setData("application/x-promptcut-card", cardId);
      Object.defineProperty(dt, 'types', { value: ['application/x-promptcut-card'] });
      
      const dragEnterEvent = new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, clientX: 400 });
      trackEl.dispatchEvent(dragEnterEvent);
      
      const dragOverEvent = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX: 400 });
      trackEl.dispatchEvent(dragOverEvent);
      
      const dropEvent = new DragEvent('drop', { dataTransfer: dt, bubbles: true, clientX: 400 });
      trackEl.dispatchEvent(dropEvent);
    }, videoTrack.id, cardToDrop);
    
    await new Promise(r => setTimeout(r, 500));
    let img11 = await takeScreenshot('11-drop-mismatch');
    
    state = await getStoreState();
    const videoTrackAfter = state.tracks.find(t => t.id === videoTrack.id);
    assert(videoTrackAfter.clips.length === videoClipsBefore, "锁定的序列不该接受落卡");
    await page.evaluate((id) => window.__pcStore.actions.updateTrack(id, { locked: false }), videoTrack.id);
    addSummary("Drop onto locked", img11, { count: videoClipsBefore }, { count: videoTrackAfter.clips.length }, true);

    // 12. 性能
    console.log('12. Performance (100+ clips)...');
    // addCardClip 不传 trackId 时落在第一条序列，所以待会儿要去第一条序列上找，
    // 不是最后一条（最后一条是第 7 步新建的空轨）。
    // 间隔 5 秒、时长 3 秒，故意留出 2 秒空档，这样被测的 clip 是真的能拖动的。
    await page.evaluate((cardId) => {
      for (let i = 0; i < 110; i++) {
        window.__pcStore.actions.addCardClip(cardId, 20 + i * 5, { duration: 3 });
      }
    }, cardToDrop);
    await new Promise(r => setTimeout(r, 1000));

    state = await getStoreState();
    const perfTrack = state.tracks[0];
    assert(perfTrack.clips.length >= 100, `性能用例需要 100+ clip，实际只有 ${perfTrack.clips.length}`);
    console.log(`Clips on track for perf test: ${perfTrack.clips.length}`);
    // 取中间偏后的一张，保证它左右都有空档
    const testClip = perfTrack.clips[perfTrack.clips.length - 5];
    clipSelector = `[data-clip-id="${testClip.id}"]`;
    await page.waitForSelector(clipSelector);
    await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ inline: 'center', block: 'center' }), clipSelector);
    await new Promise(r => setTimeout(r, 300));
    
    clipBox = await (await page.$(clipSelector)).boundingBox();
    await page.mouse.move(clipBox.x + 10, clipBox.y + 10);
    await page.mouse.down();
    
    const startDragTime = Date.now();
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(clipBox.x + 10 - i, clipBox.y + 10);
    }
    const endDragTime = Date.now();
    await page.mouse.up();
    
    const timeTaken = endDragTime - startDragTime;
    console.log(`Drag with 100+ clips took ${timeTaken}ms for 60 mousemove events.`);
    const avg = (timeTaken / 60).toFixed(2);
    console.log(`Average time per mousemove: ${avg}ms`);
    addSummary("Performance", "", { clips: 100 }, { timeMs: timeTaken, avgMs: avg }, true);
    
  } finally {
    console.log('\n--- VERIFICATION SUMMARY ---');
    console.table(summaryTable);
    await browser.close();
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
