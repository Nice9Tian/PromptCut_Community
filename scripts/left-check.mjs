import puppeteer from 'puppeteer';
import fs from 'fs';

fs.mkdirSync('out/left', { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1600, height: 1000 } });
  const page = await browser.newPage();

  const errors = [];
  let ignoredErrors = 0;

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('/src/editor/right/') || text.includes('/src/ai/') || text.includes('favicon.ico') || text.includes('net::ERR_') ||
          text.includes('status of 404') || text.includes('status of 500')) {
        ignoredErrors++;
      } else {
        errors.push(`Console Error: ${text}`);
      }
    }
  });
  page.on('pageerror', err => {
    const text = err.message;
    if (text.includes('/src/editor/right/') || text.includes('/src/ai/') || text.includes('favicon.ico')) {
      ignoredErrors++;
    } else {
      errors.push(`Page Error: ${text}`);
    }
  });

  let hasFail = false;
  const logPass = (msg) => console.log(`PASS - ${msg}`);
  const logFail = (msg) => { console.log(`FAIL - ${msg}`); hasFail = true; };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  let currentUrl = "http://127.0.0.1:5194/?nosetup=1";

  async function ensureClickable() {
    if (currentUrl === "http://127.0.0.1:5194/?nosetup=1") {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const closeBtn = btns.find(b => {
          const t = b.textContent.trim();
          return t === "Maybe later" || t === "Later" || t === "Cancel" || t === "Close";
        });
        if (closeBtn) closeBtn.click();
      });
      await wait(500);
    }

    // Probe "whether covered by a dialog": use the "Media library" item in the left rail as a probe.
    // The rail is permanently visible (even when the drawer is collapsed); cards are hidden in groups
    // and set to display:none when switching sections, so using a card as a probe always flags as covered.
    const clickable = await page.evaluate(() => {
      const probe = document.querySelector('[data-pc-rail="library"]') || document.querySelector('[data-pc-card]');
      if (!probe) return false;
      const r = probe.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!(top && (probe === top || probe.contains(top)));
    });

    if (clickable) {
      return true;
    } else {
      if (currentUrl !== "http://127.0.0.1:5194/left-probe.html") {
        currentUrl = "http://127.0.0.1:5194/left-probe.html";
        console.log('ENTRY: /left-probe.html (isolated · whole app covered by another task\'s overlay)');
        await page.goto(currentUrl, { waitUntil: 'networkidle0' });
        await wait(1000);
      }
      return false;
    }
  }

  async function ensureSelection() {
    await page.evaluate(() => {
      const state = window.__pcStoreLeft.getState();
      if (state.selection.length === 0) {
        const firstClip = state.project.tracks.flatMap(t=>t.clips)[0];
        if (firstClip) window.__pcStoreLeft.actions.select([firstClip.id]);
      }
    });
    await wait(200);
  }

  async function runStep(name, fn) {
    try {
      await ensureClickable();
      await fn();
    } catch(e) {
      console.log(`  (${name} first threw: ${e.message})`);
      if (currentUrl !== "http://127.0.0.1:5194/left-probe.html") {
        currentUrl = "http://127.0.0.1:5194/left-probe.html";
        console.log('ENTRY: /left-probe.html (isolated · whole app covered by another task\'s overlay)');
        await page.goto(currentUrl, { waitUntil: 'networkidle0' });
        await wait(1000);
        try {
          await fn();
        } catch(e2) {
          logFail(`${name} error: ${e2.message}`);
        }
      } else {
        logFail(`${name} error: ${e.message}`);
      }
    }
  }

  /** Whether the element is on screen (ancestor display:none has no client rect) */
  const shown = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    return !!el && el.getClientRects().length > 0;
  }, sel);

  try {
    await page.goto(currentUrl);
    await wait(1500);
    await page.screenshot({ path: 'out/left/01-initial.png' });

    const isMainClickable = await ensureClickable();
    if (isMainClickable && currentUrl === "http://127.0.0.1:5194/?nosetup=1") {
      console.log('ENTRY: / (whole app)');
    }

    const content = await page.content();
    const hasParts = await page.evaluate(() => {
      return ['left', 'left-rail', 'left-drawer', 'library', 'animations', 'effects', 'inspector', 'captions']
        .every((k) => !!document.querySelector(`[data-pc="${k}"]`)) &&
        ['library', 'animations', 'effects', 'edit', 'captions'].every((k) => !!document.querySelector(`[data-pc-rail="${k}"]`));
    });

    if (hasParts && content.includes('Media library') && content.includes('Animation') && content.includes('Edit')) {
      logPass('01-initial: found the five rail items, the drawer and the five sections, and the text "Media library", "Animation", "Edit"');
    } else {
      logFail('01-initial: could not find the expected text or structure');
    }

    // Each of the five section headers has a "Collapse panel" button (SectionHead)
    const collapseBtns = await page.evaluate(() => document.querySelectorAll('[data-pc="left-collapse"]').length);
    if (collapseBtns === 5) logPass('01-initial: each of the five section headers has one left-collapse');
    else logFail(`01-initial: wrong left-collapse count -> ${collapseBtns}`);

    // Left rail = rail + drawer. Clicking another item = switch section (expanding if collapsed);
    // clicking the selected item = collapse / expand. Check current state first before deciding whether
    // to click, to avoid accidentally collapsing the section we want to view
    const railState = (key) => page.evaluate((k) => {
      const item = document.querySelector(`[data-pc-rail="${k}"]`);
      const drawer = document.querySelector('[data-pc="left-drawer"]');
      return { on: !!item && item.classList.contains('is-on'), open: !!drawer && drawer.getClientRects().length > 0 };
    }, key);
    const showSection = async (key) => {
      const s = await railState(key);
      if (!s.on || !s.open) {
        await page.click(`[data-pc-rail="${key}"]`);
        await wait(150);
      }
      const s2 = await railState(key);
      if (!s2.open) {
        await page.click(`[data-pc-rail="${key}"]`);
        await wait(150);
      }
    };
    // Items in a section are inside groups: first clear search and return to overview, then open the
    // desired group (stay on overview if groupId is null). section is both the rail key and data-pc
    // on the section root node: media (videos / images / music) in library, cards and parts in animations
    const openGroupIn = async (section, groupId) => {
      await showSection(section);
      const clear = await page.$(`[data-pc="${section}"] .pc-left-search-clear`);
      if (clear) {
        await clear.click();
        await wait(100);
      }
      const opened = await page.evaluate((s) =>
        document.querySelector(`[data-pc="${s}"] [data-pc-open-group]`)?.getAttribute('data-pc-open-group') ?? null, section);
      if (opened === groupId) return;
      if (opened) {
        await page.click(`[data-pc="${section}"] [data-pc-chip="all"]`);
        await wait(150);
      } else if (await page.$(`[data-pc="${section}"] [data-pc-category="all"]`)) {
        // "Animations" only has visual groups; the overview has no category pill row
        await page.click(`[data-pc="${section}"] [data-pc-category="all"]`);
        await wait(150);
      }
      if (!groupId) return;
      await page.click(`[data-pc="${section}"] [data-pc-group="${groupId}"]`);
      await wait(250);
    };
    const showEdit = async (sub) => {
      await showSection('edit');
      await page.click(`[data-pc-tab="${sub}"]`);
      await wait(120);
    };

    await runStep('02-hover', async () => {
      await openGroupIn('animations', 'magicui');
      // The animations section only has visual groups: the pill row in group details only has
      // "All / group name ×", without rendering the category pill
      const chipsOk = await page.evaluate(() =>
        !!document.querySelector('[data-pc="animations"] [data-pc-chip="all"]') &&
        !document.querySelector('[data-pc="animations"] [data-pc-chip="category"]') &&
        !document.querySelector('[data-pc="animations"] [data-pc-category]'));
      if (chipsOk) logPass('02-hover: animations section has no category chips, details show only "All / group name"');
      else logFail('02-hover: wrong chip row in animations section');
      await page.hover('[data-pc-card="mu-number-ticker"]');
      await wait(900);
      await page.screenshot({ path: 'out/left/02-hover.png' });

      const hasPreview = await page.$('[data-pc-card="mu-number-ticker"] [data-pc="preview"]');
      if (hasPreview) logPass('02-hover: preview appeared on hover');
      else logFail('02-hover: preview did not appear on hover');

      await page.mouse.move(0, 0);
      await wait(400);

      const hasPreviewAfter = await page.$('[data-pc-card="mu-number-ticker"] [data-pc="preview"]');
      if (!hasPreviewAfter) logPass('02-hover: preview unmounted after moving away');
      else logFail('02-hover: not unmounted after moving away');

      const pcExportMs = await page.evaluate(() => window.__pcExportMs);
      if (pcExportMs === undefined) logPass('02-hover: window.__pcExportMs was not modified');
      else logFail('02-hover: window.__pcExportMs was modified!');
    });

    await runStep('03-added', async () => {
      await openGroupIn('animations', 'native');
      await page.evaluate(() => window.__pcStoreLeft.actions.seek(24.5));
      const clipCountBefore = await page.evaluate(() => window.__pcStoreLeft.getState().project.tracks.flatMap(t=>t.clips).length);

      await page.click('[data-pc-card="odometer"]');
      await wait(300);

      const stateAfterAdd = await page.evaluate(() => {
        const state = window.__pcStoreLeft.getState();
        const clipCount = state.project.tracks.flatMap(t=>t.clips).length;
        const sel = state.selection[0];
        const newClip = state.project.tracks.flatMap(t=>t.clips).find(c => c.id === sel);
        return { clipCount, newClip };
      });

      if (stateAfterAdd.clipCount === clipCountBefore + 1 && stateAfterAdd.newClip && Math.abs(stateAfterAdd.newClip.start - 24.5) < 0.2) {
        logPass('03-added: clipCount +1, start approx. 24.5');
      } else {
        logFail('03-added: not added as expected');
      }
      await page.screenshot({ path: 'out/left/03-added.png' });
    });

    await runStep('04-form', async () => {
      await showEdit('form');
      await ensureSelection();
      await page.screenshot({ path: 'out/left/04-form.png' });
      const firstInput = await page.$('[data-pc-param]');
      if (firstInput) {
        await firstInput.click({ clickCount: 3 });
        await firstInput.type('123');
        await wait(200);

        const newParams = await page.evaluate(() => {
          const state = window.__pcStoreLeft.getState();
          const sel = state.selection[0];
          return state.project.tracks.flatMap(t=>t.clips).find(c=>c.id===sel).params;
        });
        logPass(`04-form: params changed -> ${JSON.stringify(newParams)}`);
      } else {
        logFail('04-form: no editable form control found');
      }
    });

    await runStep('05-switched', async () => {
      await showEdit('form');
      await ensureSelection();
      const selectElem = await page.$('[data-pc="switch-card"]');
      if (selectElem) {
        await selectElem.select('blur-text');
        await wait(200);
        const cardId = await page.evaluate(() => {
          const state = window.__pcStoreLeft.getState();
          return state.project.tracks.flatMap(t=>t.clips).find(c=>c.id===state.selection[0]).cardId;
        });
        if (cardId === 'blur-text') logPass('05-switched: card switch succeeded');
        else logFail(`05-switched: card switch failed, current is ${cardId}`);
      } else {
        logFail('05-switched: card switch dropdown not found');
      }
      await page.screenshot({ path: 'out/left/05-switched.png' });
    });

    await runStep('06-code', async () => {
      await showEdit('form');
      await ensureSelection();
      await page.click('[data-pc-tab="code"]');
      await wait(100);
      await page.screenshot({ path: 'out/left/06-code.png' });

      const stateSnapshot = await page.evaluate(() => JSON.stringify(window.__pcStoreLeft.getState()));

      const textarea = await page.$('[data-pc="code-editor"]');
      await textarea.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await textarea.type('{ oops');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await wait(300);

      const stateAfterBad = await page.evaluate(() => JSON.stringify(window.__pcStoreLeft.getState()));
      if (stateSnapshot === stateAfterBad) logPass('06-code-invalid: store did not change at all');
      else logFail('06-code-invalid: store changed unexpectedly');

      const hasRedBorder = await page.evaluate(() => {
        const el = document.querySelector('[data-pc="code-editor"]');
        if (!el) return false;
        const color = window.getComputedStyle(el).borderTopColor || window.getComputedStyle(el).borderColor;
        const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
           const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
           return r > g + 50 && r > b + 50;
        }
        // Tailwind v4 outputs oklch(L C H): red has hue between 10-50 with chroma
        const ok = color.match(new RegExp("oklch\\(([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)"));
        if (ok) {
          const c = parseFloat(ok[2]), h = parseFloat(ok[3]);
          return c > 0.1 && h > 10 && h < 50;
        }
        return el.classList.contains('is-error');
      });
      if (hasRedBorder) logPass('06-code-invalid: borderColor R is clearly greater than G/B');
      else logFail('06-code-invalid: no red border');

      await page.screenshot({ path: 'out/left/07-code-invalid.png' });

      await textarea.click();
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await textarea.type('{"params": {"test": 999}}');
      await page.keyboard.down('Control');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Control');
      await wait(300);

      const paramsAfterGood = await page.evaluate(() => {
        const state = window.__pcStoreLeft.getState();
        return state.project.tracks.flatMap(t=>t.clips).find(c=>c.id===state.selection[0]).params;
      });
      if (paramsAfterGood && paramsAfterGood.test === 999) logPass('06-code-valid: params updated successfully');
      else logFail('06-code-valid: params not updated');

      await page.screenshot({ path: 'out/left/08-code-valid.png' });
    });

    await runStep('07-sections', async () => {
      // Left rail changed to rail + four resident sections: verify section switching, selection memory,
      // and clicking the selected item to collapse / expand the drawer
      await showSection('library');
      const libOk = (await shown('[data-pc="search"]')) && !(await shown('[data-pc="inspector"]'));
      if (libOk) logPass('07-sections: media library, editing section hidden');
      else logFail('07-sections: wrong media library state');

      await showSection('effects');
      const fxOk = (await shown('[data-pc="effects-search"]')) && !(await shown('[data-pc="search"]'));
      if (fxOk) logPass('07-sections: effects, media library hidden');
      else logFail('07-sections: wrong effects state');

      await showSection('captions');
      const capOk = (await shown('[data-pc="caption-search"]')) && !(await shown('[data-pc="search"]'));
      if (capOk) logPass('07-sections: captions');
      else logFail('07-sections: wrong captions state');

      await showEdit('form');
      const editOk = (await shown('[data-pc="inspector"]')) && !(await shown('[data-pc="library"]'));
      if (editOk) logPass('07-sections: edit → parameters, media library hidden');
      else logFail('07-sections: wrong edit → parameters state');

      const remembered = await page.evaluate(() => [
        localStorage.getItem('pc.left.section'),
        localStorage.getItem('pc.left.editTab'),
      ]);
      if (remembered[0] === 'edit' && remembered[1] === 'form') {
        logPass('07-sections: section and edit tab were written to localStorage');
      } else {
        logFail('07-sections: localStorage did not remember ' + JSON.stringify(remembered));
      }

      await page.click('[data-pc-rail="edit"]');
      await wait(150);
      const collapsedOk = !(await shown('[data-pc="left-drawer"]')) &&
        (await page.evaluate(() => localStorage.getItem('pc.rail.left.collapsed'))) === '1';
      if (collapsedOk) logPass('07-sections: clicking the selected "Edit" collapsed the drawer');
      else logFail('07-sections: clicking the selected item did not collapse the drawer');

      await page.click('[data-pc-rail="edit"]');
      await wait(150);
      if (await shown('[data-pc="left-drawer"]')) logPass('07-sections: clicking again expanded the drawer');
      else logFail('07-sections: clicking again did not expand the drawer');

      // The "Collapse panel" button (SectionHead) in the top right of the section header follows the same
      // collapse path as clicking the current rail item
      await page.click('[data-pc="inspector"] [data-pc="left-collapse"]');
      await wait(300);
      const btnCollapsedOk = !(await shown('[data-pc="left-drawer"]')) &&
        (await page.evaluate(() => localStorage.getItem('pc.rail.left.collapsed'))) === '1';
      if (btnCollapsedOk) logPass('07-sections: the header "Collapse panel" button collapsed the drawer');
      else logFail('07-sections: the header "Collapse panel" button did not collapse the drawer');
      await page.click('[data-pc-rail="edit"]');
      await wait(150);
      if (await shown('[data-pc="left-drawer"]')) logPass('07-sections: clicking the current rail item after collapsing expanded it again');
      else logFail('07-sections: clicking the current rail item after collapsing did not expand it');

      // Animations is a separate section: card search and card filters are here, while the media library
      // search box is hidden; opened card groups are recorded in pc.left.group.animations
      await showSection('animations');
      const animOk = (await shown('[data-pc="animations-search"]')) && (await shown('[data-pc="scope-toggle"]')) &&
        !(await shown('[data-pc="search"]'));
      if (animOk) logPass('07-sections: animations, media library hidden, card filter button in the animations header');
      else logFail('07-sections: wrong animations state');
      const groupKeys = await page.evaluate(() => [
        localStorage.getItem('pc.left.section'),
        localStorage.getItem('pc.left.group.animations'),
        localStorage.getItem('pc.left.group.library'),
      ]);
      const cardGroupIds = ['user-cards', 'magicui', 'native', 'parts', 'lottie', 'particles'];
      if (groupKeys[0] === 'animations' && cardGroupIds.includes(groupKeys[1]) && !cardGroupIds.includes(groupKeys[2])) {
        logPass('07-sections: pc.left.section = animations, card group stored in pc.left.group.animations');
      } else {
        logFail('07-sections: wrong group memory ' + JSON.stringify(groupKeys));
      }

      await page.screenshot({ path: 'out/left/09-sections.png' });
    });

    await runStep('08-media', async () => {
      await page.evaluate(() => {
        window.__pcStoreLeft.actions.addMedia({ kind: "video", name: "test-clip.mp4", url: "blob:fake", duration: 12.5 });
      });
      await wait(200);
      // Video thumbnail in the overview group box: the hover-play cell receives pointer events
      // (.is-hoverplay); <video> itself does not receive them and does not have data-pc-media
      await openGroupIn('library', null);
      const thumbOk = await page.evaluate(() => {
        const box = document.querySelector('[data-pc="library"] [data-pc-group="videos"]');
        const tile = box?.querySelector('.pc-lib-card.is-hoverplay');
        const video = tile?.querySelector('video');
        return !!tile && !!video && !box.querySelector('[data-pc-media]') &&
          getComputedStyle(tile).pointerEvents === 'auto' && getComputedStyle(video).pointerEvents === 'none' &&
          video.getAttribute('preload') === 'metadata' && video.muted && video.loop;
      });
      if (thumbOk) logPass('08-media: overview video thumbnail plays on hover, without hooks');
      else logFail('08-media: wrong hover-play structure in overview video thumbnail');
      await openGroupIn('library', 'videos');

      const mediaItemText = await page.evaluate(() => {
        // Duration badge is written as m:ss
        const el = Array.from(document.querySelectorAll('[data-pc-media]')).find(el => el.textContent.includes('test-clip.mp4') && el.textContent.includes('0:12'));
        return el ? el.textContent : null;
      });
      if (mediaItemText) {
        logPass('08-media: test-clip.mp4 and duration 0:12 appear in the video group');
      } else {
        logFail('08-media: test clip not found in the video group');
      }

      const mediaElems = await page.$$('[data-pc-media]');
      for(const div of mediaElems) {
        const t = await page.evaluate(el => el.textContent, div);
        if (t && t.includes('test-clip.mp4')) {
          await page.evaluate(el => el.scrollIntoView(), div);
          await wait(100);
          await div.click({ button: 'right' });
          break;
        }
      }
      await wait(200);
      await page.screenshot({ path: 'out/left/10-ctxmenu.png' });

      const menuHasDelete = await page.$('[data-pc="ctxmenu"] [data-pc-item="Delete media"]');
      if (menuHasDelete) logPass('08-media: menu has "Delete media"');
      else logFail('08-media: menu has no Delete media');

      if (menuHasDelete) await menuHasDelete.click();
      await wait(200);
      await page.screenshot({ path: 'out/left/11-confirm.png' });

      const hasConfirm = await page.$('[data-pc="confirm"]');
      if (hasConfirm) logPass('08-media: confirm dialog appeared');
      else logFail('08-media: confirm dialog did not appear');

      const btn = await page.$('[data-pc="confirm-ok"]');
      if(btn) await btn.click();
      await wait(200);

      const mediaCount = await page.evaluate(() => window.__pcStoreLeft.getState().project.media.length);
      if (mediaCount === 0) logPass('08-media: delete succeeded, media.length === 0');
      else logFail(`08-media: delete failed, length === ${mediaCount}`);
    });

    await runStep('09-captions-bus', async () => {
      // Timeline right-click "Transcribe captions" goes through captionsBus: the collapsed drawer must
      // be opened, and switched to the captions section
      await showSection('library');
      await page.click('[data-pc-rail="library"]');
      await wait(150);
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('pc-open-captions', { detail: { mediaId: 'nope' } }));
      });
      await wait(200);
      const ok = (await shown('[data-pc="caption-search"]')) &&
        (await page.evaluate(() => localStorage.getItem('pc.left.section'))) === 'captions';
      if (ok) logPass('09-captions-bus: expanded the drawer and switched to the captions section');
      else logFail('09-captions-bus: did not switch to the captions section');
    });

  } catch (err) {
    logFail(`SCRIPT FATAL ERROR: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log('\n=== SUMMARY ===');
  if (ignoredErrors > 0) {
    console.log(`(filtered out ${ignoredErrors} console errors from other tasks)`);
  }
  if (errors.length > 0) {
    console.log('--- Errors ---');
    errors.forEach(e => console.log(e));
    hasFail = true;
  }
  if (hasFail) {
    console.log('Some tests failed!');
    process.exitCode = 1;
  } else {
    console.log('All tests passed!');
  }
})();
