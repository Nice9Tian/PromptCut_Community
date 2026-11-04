import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// URL must be explicitly provided (--url <url> or environment variable PROMPTCUT_BASE);
// if omitted, report usage and exit: never connect to the user's resident editor by default (5190-5192).
const urlArg = process.argv.indexOf('--url');
const BASE = ((urlArg >= 0 ? process.argv[urlArg + 1] : '') || process.env.PROMPTCUT_BASE || '').replace(/\/+$/, '');
if (!BASE || BASE.startsWith('--')) {
  console.error('Usage: node scripts/timeline-verify.mjs --url http://127.0.0.1:<port of your own dev server>\n  or set the environment variable PROMPTCUT_BASE. It does not run without an address: it never defaults to the editor the user keeps running.');
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
      const closeBtn = btns.find(b => b.textContent && b.textContent.includes('Maybe later'));
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
  // Tracks are no longer differentiated by type; demo clips are all on the first track with content
  const overlayTrackIndex = Math.max(0, state.tracks.findIndex(t => t.clips.length > 0));
  
  try {
    // 1. Drag to change time range (cases where it can move)
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

    // 2. Drag blocked by neighbors (anti-squish regression test)
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

    // 3. Left handle / right handle
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

    // 4. Cross-track drag
    console.log('4. Cross track drag...');
    // create a new track
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => b.textContent && b.textContent.includes('+ Motion graphics track'));
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

    // 5. Right-click split
    console.log('5. Split clip...');
    const clipToSplit = newTrackClips[0];
    const midTime = clipToSplit.start + (clipToSplit.end - clipToSplit.start) / 2;
    await page.evaluate((t) => window.__pcStore.actions.seek(t), midTime);
    
    const finalClipSelector = `[data-clip-id="${clipToSplit.id}"]`;
    clipBox = await (await page.$(finalClipSelector)).boundingBox();
    await page.mouse.click(clipBox.x + 20, clipBox.y + 10, { button: 'right' });
    
    await page.evaluate(() => {
       const items = Array.from(document.querySelectorAll('div')).filter(el => el.textContent === 'Split at playhead');
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

    // 6. Delete
    console.log('6. Delete clip...');
    clipBox = await (await page.$(`[data-clip-id="${splitTrackClips[1].id}"]`)).boundingBox();
    await page.mouse.click(clipBox.x + 5, clipBox.y + 10);
    await page.keyboard.press('Delete');
    await new Promise(r => setTimeout(r, 100));
    let img6 = await takeScreenshot('06-delete');
    
    state = await getStoreState();
    assert(state.tracks[state.tracks.length - 1].clips.length === 1, "Track should have 1 clip after delete");
    addSummary("Delete clip", img6, { count: 2 }, { count: 1 }, true);

    // 7. Add track
    console.log('7. Add tracks...');
    const trackCountBefore = state.tracks.length;
    // After tracks were unified, only one "+ Track" button remains; click it twice
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent && b.textContent.includes('track'));
      if (btn) { btn.click(); btn.click(); }
    });
    await new Promise(r => setTimeout(r, 500));
    let img7 = await takeScreenshot('07-add-tracks');
    
    state = await getStoreState();
    assert(state.tracks.length === trackCountBefore + 2, "Track count should increase by 2");
    addSummary("Add tracks", img7, { count: trackCountBefore }, { count: state.tracks.length }, true);

    // 8. Ctrl+wheel zoom
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

    // 9. Playhead scrub
    // After zooming in the previous step, the playhead stopped beyond 20 seconds and was pushed outside
    // the right side of the viewport by horizontal scrolling, so mouse events cannot reach it at all.
    // Therefore, first seek back to 2 seconds and scroll the track area back to the far left to ensure
    // the playhead is inside the viewport before testing scrubbing.
    await page.evaluate(() => {
      window.__pcStore.actions.seek(2);
      const sc = document.querySelector('.flex-1.flex.min-h-0.overflow-auto');
      if (sc) { sc.scrollLeft = 0; sc.scrollTop = 0; }
    });
    await new Promise(r => setTimeout(r, 300));
    state = await getStoreState();
    const tBefore = state.t;
    console.log(`9. Drag playhead... from ${tBefore}`);
    // Tracks were added and zoomed earlier, so the track area may have been scrolled both horizontally
    // and vertically, leaving part of the playhead element's rect outside the viewport.
    // Here we take the midpoint of "playhead rectangle ∩ scroll container visible area" as the drop
    // target, and actually use elementsFromPoint to confirm that the point hits the playhead itself,
    // otherwise throw an error directly instead of silently dragging into thin air.
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
    if (!phPick.hit) throw new Error(`Playhead landing point (${phPick.x}, ${phPick.y}) hit a different element: ${phPick.hitCls}`);
    await page.mouse.move(phPick.x, phPick.y);
    await page.mouse.down();
    // Drag right by 300px
    await page.mouse.move(phPick.x + 300, phPick.y, { steps: 5 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 200));
    let img9 = await takeScreenshot('09-playhead');
    
    state = await getStoreState();
    console.log(`Playhead t changed to ${state.t}`);
    assert(Math.abs(state.t - tBefore) > 0.1, "Playhead t should change significantly");
    addSummary("Playhead drag", img9, { t: tBefore }, { t: state.t }, true);

    // 10. Accept card drop
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

    // 11. Locked tracks do not accept card drops (previously this step verified overlay/video kind
    // mismatch; after tracks were unified that rule no longer exists)
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
    assert(videoTrackAfter.clips.length === videoClipsBefore, "A locked track should not accept a dropped card");
    await page.evaluate((id) => window.__pcStore.actions.updateTrack(id, { locked: false }), videoTrack.id);
    addSummary("Drop onto locked", img11, { count: videoClipsBefore }, { count: videoTrackAfter.clips.length }, true);

    // 12. Performance
    console.log('12. Performance (100+ clips)...');
    // When addCardClip is called without trackId, it lands on the first track, so we need to look for it
    // on the first track later, not the last track (the last track is the empty track created in step 7).
    // With a 5-second interval and a 3-second duration, leaving a 2-second gap deliberately, the clip
    // under test can genuinely be dragged.
    await page.evaluate((cardId) => {
      for (let i = 0; i < 110; i++) {
        window.__pcStore.actions.addCardClip(cardId, 20 + i * 5, { duration: 3 });
      }
    }, cardToDrop);
    await new Promise(r => setTimeout(r, 1000));

    state = await getStoreState();
    const perfTrack = state.tracks[0];
    assert(perfTrack.clips.length >= 100, `The performance case needs 100+ clips, but there are only ${perfTrack.clips.length}`);
    console.log(`Clips on track for perf test: ${perfTrack.clips.length}`);
    // Pick one toward the middle-back to ensure it has gaps on both its left and right
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
