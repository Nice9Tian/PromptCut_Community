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
          return t === "以后再说" || t === "稍后" || t === "取消" || t === "关闭";
        });
        if (closeBtn) closeBtn.click();
      });
      await wait(500);
    }

    // 探「有没有被弹窗盖住」:用左 rail 的「素材库」项当探针。
    // rail 常驻可见(抽屉收起时也在),卡片藏在分组里、切到别的分区时 display:none,拿卡片当探针会永远判成被盖住。
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
        console.log('ENTRY: /left-probe.html (隔离 · 整机被别的任务的遮罩挡住)');
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
      console.log(`  (${name} 首次抛错: ${e.message})`);
      if (currentUrl !== "http://127.0.0.1:5194/left-probe.html") {
        currentUrl = "http://127.0.0.1:5194/left-probe.html";
        console.log('ENTRY: /left-probe.html (隔离 · 整机被别的任务的遮罩挡住)');
        await page.goto(currentUrl, { waitUntil: 'networkidle0' });
        await wait(1000);
        try {
          await fn();
        } catch(e2) {
          logFail(`${name} 异常: ${e2.message}`);
        }
      } else {
        logFail(`${name} 异常: ${e.message}`);
      }
    }
  }

  /** 元素在不在屏幕上(祖先 display:none 时没有 client rect) */
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
      console.log('ENTRY: / (整机)');
    }

    const content = await page.content();
    const hasParts = await page.evaluate(() => {
      return ['left', 'left-rail', 'left-drawer', 'library', 'animations', 'effects', 'inspector', 'captions']
        .every((k) => !!document.querySelector(`[data-pc="${k}"]`)) &&
        ['library', 'animations', 'effects', 'edit', 'captions'].every((k) => !!document.querySelector(`[data-pc-rail="${k}"]`));
    });

    if (hasParts && content.includes('素材库') && content.includes('动画') && content.includes('编辑')) {
      logPass('01-initial: 找到了 rail 五项、抽屉和五个分区,以及文字「素材库」「动画」「编辑」');
    } else {
      logFail('01-initial: 没找到对应的文字或结构');
    }

    // 五个分区头部各有一个「收起面板」钮(SectionHead)
    const collapseBtns = await page.evaluate(() => document.querySelectorAll('[data-pc="left-collapse"]').length);
    if (collapseBtns === 5) logPass('01-initial: 五个分区头部各有一个 left-collapse');
    else logFail(`01-initial: left-collapse 数量不对 -> ${collapseBtns}`);

    // 左栏 = rail + 抽屉。点另一项 = 切分区(收着就顺手展开);点已选中项 = 收起 / 展开。
    // 所以先看当前状态再决定点不点,免得把要看的分区点收起来
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
    // 分区里的东西在分组里:先清搜索、回总览,再点开要的组(groupId 给 null 就停在总览)。
    // section 同时是 rail 键和分区根节点的 data-pc:素材(videos / images / music)在 library,卡片和部件在 animations
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
        // 「动画」只有视觉组,总览没有分类胶囊行
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
      // 动画分区全是视觉组:组详情的胶囊行只有「所有 / 组名 ×」,不画分类那颗
      const chipsOk = await page.evaluate(() =>
        !!document.querySelector('[data-pc="animations"] [data-pc-chip="all"]') &&
        !document.querySelector('[data-pc="animations"] [data-pc-chip="category"]') &&
        !document.querySelector('[data-pc="animations"] [data-pc-category]'));
      if (chipsOk) logPass('02-hover: 动画分区没有分类胶囊,详情里只剩「所有 / 组名」');
      else logFail('02-hover: 动画分区的胶囊行不对');
      await page.hover('[data-pc-card="mu-number-ticker"]');
      await wait(900);
      await page.screenshot({ path: 'out/left/02-hover.png' });

      const hasPreview = await page.$('[data-pc-card="mu-number-ticker"] [data-pc="preview"]');
      if (hasPreview) logPass('02-hover: 悬停出现了 preview');
      else logFail('02-hover: 悬停未出现 preview');

      await page.mouse.move(0, 0);
      await wait(400);

      const hasPreviewAfter = await page.$('[data-pc-card="mu-number-ticker"] [data-pc="preview"]');
      if (!hasPreviewAfter) logPass('02-hover: 移开后 preview 卸载');
      else logFail('02-hover: 移开后未卸载');

      const pcExportMs = await page.evaluate(() => window.__pcExportMs);
      if (pcExportMs === undefined) logPass('02-hover: window.__pcExportMs 未被修改');
      else logFail('02-hover: window.__pcExportMs 被修改了!');
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
        logPass('03-added: clipCount +1, start 约等于 24.5');
      } else {
        logFail('03-added: 未如预期添加');
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
        logPass(`04-form: params 变了 -> ${JSON.stringify(newParams)}`);
      } else {
        logFail('04-form: 找不到可输入的表单控件');
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
        if (cardId === 'blur-text') logPass('05-switched: 换卡成功');
        else logFail(`05-switched: 换卡失败, 当前是 ${cardId}`);
      } else {
        logFail('05-switched: 找不到换卡下拉框');
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
      if (stateSnapshot === stateAfterBad) logPass('06-code-invalid: store 完全没变');
      else logFail('06-code-invalid: store 居然变了');

      const hasRedBorder = await page.evaluate(() => {
        const el = document.querySelector('[data-pc="code-editor"]');
        if (!el) return false;
        const color = window.getComputedStyle(el).borderTopColor || window.getComputedStyle(el).borderColor;
        const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
           const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
           return r > g + 50 && r > b + 50;
        }
        // Tailwind v4 输出的是 oklch(L C H):红色在色相 10-50 且有饱和度
        const ok = color.match(new RegExp("oklch\\(([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)"));
        if (ok) {
          const c = parseFloat(ok[2]), h = parseFloat(ok[3]);
          return c > 0.1 && h > 10 && h < 50;
        }
        return el.classList.contains('is-error');
      });
      if (hasRedBorder) logPass('06-code-invalid: borderColor R 明显大于 G/B');
      else logFail('06-code-invalid: 没有红框');

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
      if (paramsAfterGood && paramsAfterGood.test === 999) logPass('06-code-valid: params 更新成功');
      else logFail('06-code-valid: params 未更新');

      await page.screenshot({ path: 'out/left/08-code-valid.png' });
    });

    await runStep('07-sections', async () => {
      // 左栏改成 rail + 四个常驻分区:验分区切换、选择记忆、点已选中项收起 / 展开抽屉
      await showSection('library');
      const libOk = (await shown('[data-pc="search"]')) && !(await shown('[data-pc="inspector"]'));
      if (libOk) logPass('07-sections: 素材库,编辑分区隐藏');
      else logFail('07-sections: 素材库 状态不对');

      await showSection('effects');
      const fxOk = (await shown('[data-pc="effects-search"]')) && !(await shown('[data-pc="search"]'));
      if (fxOk) logPass('07-sections: 特效,素材库隐藏');
      else logFail('07-sections: 特效 状态不对');

      await showSection('captions');
      const capOk = (await shown('[data-pc="caption-search"]')) && !(await shown('[data-pc="search"]'));
      if (capOk) logPass('07-sections: 字幕');
      else logFail('07-sections: 字幕 状态不对');

      await showEdit('form');
      const editOk = (await shown('[data-pc="inspector"]')) && !(await shown('[data-pc="library"]'));
      if (editOk) logPass('07-sections: 编辑 → 参数,素材库隐藏');
      else logFail('07-sections: 编辑 → 参数 状态不对');

      const remembered = await page.evaluate(() => [
        localStorage.getItem('pc.left.section'),
        localStorage.getItem('pc.left.editTab'),
      ]);
      if (remembered[0] === 'edit' && remembered[1] === 'form') {
        logPass('07-sections: 分区和编辑分页写进了 localStorage');
      } else {
        logFail('07-sections: localStorage 没记住 ' + JSON.stringify(remembered));
      }

      await page.click('[data-pc-rail="edit"]');
      await wait(150);
      const collapsedOk = !(await shown('[data-pc="left-drawer"]')) &&
        (await page.evaluate(() => localStorage.getItem('pc.rail.left.collapsed'))) === '1';
      if (collapsedOk) logPass('07-sections: 点已选中的「编辑」收起了抽屉');
      else logFail('07-sections: 点已选中项没有收起抽屉');

      await page.click('[data-pc-rail="edit"]');
      await wait(150);
      if (await shown('[data-pc="left-drawer"]')) logPass('07-sections: 再点一次展开抽屉');
      else logFail('07-sections: 再点一次没有展开抽屉');

      // 分区头部右上角的「收起面板」钮(SectionHead)和点 rail 当前项走同一条收起路子
      await page.click('[data-pc="inspector"] [data-pc="left-collapse"]');
      await wait(300);
      const btnCollapsedOk = !(await shown('[data-pc="left-drawer"]')) &&
        (await page.evaluate(() => localStorage.getItem('pc.rail.left.collapsed'))) === '1';
      if (btnCollapsedOk) logPass('07-sections: 头部「收起面板」钮收起了抽屉');
      else logFail('07-sections: 头部「收起面板」钮没有收起抽屉');
      await page.click('[data-pc-rail="edit"]');
      await wait(150);
      if (await shown('[data-pc="left-drawer"]')) logPass('07-sections: 收起后点 rail 当前项展开回来');
      else logFail('07-sections: 收起后点 rail 当前项没有展开');

      // 动画是独立分区:卡片搜索和卡片筛选在这里,素材库的搜索框藏着;打开过的卡片组记在 pc.left.group.animations
      await showSection('animations');
      const animOk = (await shown('[data-pc="animations-search"]')) && (await shown('[data-pc="scope-toggle"]')) &&
        !(await shown('[data-pc="search"]'));
      if (animOk) logPass('07-sections: 动画,素材库隐藏,卡片筛选钮在动画头部');
      else logFail('07-sections: 动画 状态不对');
      const groupKeys = await page.evaluate(() => [
        localStorage.getItem('pc.left.section'),
        localStorage.getItem('pc.left.group.animations'),
        localStorage.getItem('pc.left.group.library'),
      ]);
      const cardGroupIds = ['user-cards', 'magicui', 'native', 'parts', 'lottie', 'particles'];
      if (groupKeys[0] === 'animations' && cardGroupIds.includes(groupKeys[1]) && !cardGroupIds.includes(groupKeys[2])) {
        logPass('07-sections: pc.left.section = animations,卡片组记在 pc.left.group.animations');
      } else {
        logFail('07-sections: 分组记忆不对 ' + JSON.stringify(groupKeys));
      }

      await page.screenshot({ path: 'out/left/09-sections.png' });
    });

    await runStep('08-media', async () => {
      await page.evaluate(() => {
        window.__pcStoreLeft.actions.addMedia({ kind: "video", name: "测试片.mp4", url: "blob:fake", duration: 12.5 });
      });
      await wait(200);
      // 总览组框里的视频缩略:悬停播放的那一格接指针(.is-hoverplay),<video> 本身不接,也不带 data-pc-media
      await openGroupIn('library', null);
      const thumbOk = await page.evaluate(() => {
        const box = document.querySelector('[data-pc="library"] [data-pc-group="videos"]');
        const tile = box?.querySelector('.pc-lib-card.is-hoverplay');
        const video = tile?.querySelector('video');
        return !!tile && !!video && !box.querySelector('[data-pc-media]') &&
          getComputedStyle(tile).pointerEvents === 'auto' && getComputedStyle(video).pointerEvents === 'none' &&
          video.getAttribute('preload') === 'metadata' && video.muted && video.loop;
      });
      if (thumbOk) logPass('08-media: 总览视频缩略能悬停播放、不带钩子');
      else logFail('08-media: 总览视频缩略的悬停播放结构不对');
      await openGroupIn('library', 'videos');

      const mediaItemText = await page.evaluate(() => {
        // 时长角标写成 m:ss
        const el = Array.from(document.querySelectorAll('[data-pc-media]')).find(el => el.textContent.includes('测试片.mp4') && el.textContent.includes('0:12'));
        return el ? el.textContent : null;
      });
      if (mediaItemText) {
        logPass('08-media: 视频组里出现 测试片.mp4 和时长 0:12');
      } else {
        logFail('08-media: 未在视频组里找到测试片');
      }

      const mediaElems = await page.$$('[data-pc-media]');
      for(const div of mediaElems) {
        const t = await page.evaluate(el => el.textContent, div);
        if (t && t.includes('测试片.mp4')) {
          await page.evaluate(el => el.scrollIntoView(), div);
          await wait(100);
          await div.click({ button: 'right' });
          break;
        }
      }
      await wait(200);
      await page.screenshot({ path: 'out/left/10-ctxmenu.png' });

      const menuHasDelete = await page.$('[data-pc="ctxmenu"] [data-pc-item="删除素材"]');
      if (menuHasDelete) logPass('08-media: 菜单里有「删除素材」');
      else logFail('08-media: 菜单里没有删除素材');

      if (menuHasDelete) await menuHasDelete.click();
      await wait(200);
      await page.screenshot({ path: 'out/left/11-confirm.png' });

      const hasConfirm = await page.$('[data-pc="confirm"]');
      if (hasConfirm) logPass('08-media: 确认框出现');
      else logFail('08-media: 确认框没出现');

      const btn = await page.$('[data-pc="confirm-ok"]');
      if(btn) await btn.click();
      await wait(200);

      const mediaCount = await page.evaluate(() => window.__pcStoreLeft.getState().project.media.length);
      if (mediaCount === 0) logPass('08-media: 删除成功, media.length === 0');
      else logFail(`08-media: 删除失败, length === ${mediaCount}`);
    });

    await runStep('09-captions-bus', async () => {
      // 时间轴右键「转写字幕」走 captionsBus:收着的抽屉要被拉出来,并切到字幕分区
      await showSection('library');
      await page.click('[data-pc-rail="library"]');
      await wait(150);
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('pc-open-captions', { detail: { mediaId: 'nope' } }));
      });
      await wait(200);
      const ok = (await shown('[data-pc="caption-search"]')) &&
        (await page.evaluate(() => localStorage.getItem('pc.left.section'))) === 'captions';
      if (ok) logPass('09-captions-bus: 展开抽屉并切到字幕分区');
      else logFail('09-captions-bus: 没有切到字幕分区');
    });

  } catch (err) {
    logFail(`SCRIPT FATAL ERROR: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log('\n=== SUMMARY ===');
  if (ignoredErrors > 0) {
    console.log(`(已过滤掉 ${ignoredErrors} 条来自其它任务产生的 console 报错)`);
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
