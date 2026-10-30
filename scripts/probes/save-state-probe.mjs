/**
 * 保存与修改状态检查的真页面探针(分支 claude/save-state)。
 * 语义:`docs/semantics/mechanism/document-service.md`「保存基准与修改状态检查」——
 * 「保存暂时禁用前台编辑，等待本机写完；失败不覆盖上次有效保存，并恢复编辑」。
 *
 * 用法(编辑器先自己起好,本探针不起服务):
 *   PROMPTCUT_NO_PORT_FILE=1 npx vite --port 5960 --strictPort --host 127.0.0.1
 *   node scripts/probes/save-state-probe.mjs --origin http://127.0.0.1:5960 --out out/save-state-shots [--phases lock,timeout,fail]
 *
 * 「另存为」换成探针自己的:落点是这个页面源的私有文件系统(OPFS)里的真文件,`createWritable` 是浏览器真的那一个,
 * 只在外面包一层好控制时机(hold:等探针放行才开始写;fail:写进一半内容后抛错)。
 *
 * 阶段:
 *   lock     保存停在「写文件」那一步时,从快捷键(Ctrl+Z)、标题栏菜单命令、鼠标点项目名、拖放文件、粘贴、滚轮、
 *            Agent 面板打字回车几条路去改,项目对象一次都没换;放行后文件写成、内容是保存那一刻的项目;之后 Ctrl+Z 又能用。
 *            截图 1-saving.png(保存中)、2-after-save.png。
 *   timeout  一个 Agent 工具调用一直没结束(本机 Agent 还在写):等满时限后不写文件、原文件逐字节不变、顶部提示说明在等什么;
 *            之后编辑恢复。截图 3-waiting.png(等待中)、4-timeout.png(超时提示)。
 *   fail     写进一半时出错:原文件逐字节不变、提示说明原文件没动、编辑恢复。截图 5-write-failed.png。
 *            另记一条「不经我们的代码、只靠浏览器」的对照:同一个句柄直接 createWritable → 写一半 → 不 close 也不 abort,
 *            原文件是不是照样不变(验证「先写临时副本、关闭时才替换」这条浏览器行为)。
 * 结果:每项一行 JSON(`{ check, ok, ... }`),最后一行 `{ summary }`;有失败退出码 1。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的用户目录变量
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const origin = arg('--origin', 'http://127.0.0.1:5960');
const outDir = path.resolve(arg('--out', 'out/save-state-shots'));
const phases = arg('--phases', 'lock,timeout,fail').split(',');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 在页面里拿到编辑器自己用的那份 `userEditing.ts` 模块(mcpExecutor 让 Agent 工具开始 / 结束用的就是它)。
 * 开发服务器改过这个文件之后,页面里的引用带 `?t=` 时间戳;直接 import 不带时间戳的地址会拿到另一份实例。
 */
const AGENT_TOOL = (op) => `(async () => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => u.includes('/src/editor/userEditing.ts'));
  const ue = await import(urls[urls.length - 1] || '/src/editor/userEditing.ts');
  ue.${op}();
  return urls[urls.length - 1] || null;
})()`;

async function waitFor(page, fn, arg, timeout = 30000) {
  return page.waitForFunction(fn, { timeout, polling: 100 }, arg);
}

/** 打开编辑器、装上探针自己的「另存为」 */
async function openEditor(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('dialog', (d) => { console.log(JSON.stringify({ dialog: d.message() })); void d.dismiss(); });
  // 编辑器开发版一次载入上千个模块,缺省 250 条的资源计时记不下;找 userEditing.ts 的实际地址要靠它(见 AGENT_TOOL)
  await page.evaluateOnNewDocument(() => performance.setResourceTimingBufferSize(20000));
  await page.goto(`${origin}/?editor`, { waitUntil: 'domcontentloaded' });
  await waitFor(page, () => !!window.__pcStore && !!document.querySelector('.pc-proj-btn'), null, 60000);
  // 页面接上本机文档服务时会整份载入一次(清撤销栈):等它接完再开始改
  await sleep(3000);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const probe = { mode: 'plain', release: null, log: [], createCalls: 0 };
    window.__saveProbe = probe;
    const wrap = (real) => ({
      kind: 'file',
      name: real.name,
      getFile: () => real.getFile(),
      async createWritable(opts) {
        probe.createCalls += 1;
        if (probe.mode === 'hold') await new Promise((r) => { probe.release = r; });
        const w = await real.createWritable(opts);
        if (probe.mode !== 'fail') {
          // 照常写,只记一笔「关上了」:探针等它,不靠被测代码自己的界面信号判断保存结束
          return {
            write: (data) => w.write(data),
            close: async () => { await w.close(); probe.log.push('closed'); },
            abort: (reason) => { probe.log.push('abort'); return w.abort(reason); },
          };
        }
        return {
          async write(data) {
            const text = typeof data === 'string' ? data : await new Blob([data]).text();
            await w.write(text.slice(0, Math.floor(text.length / 2)));
            probe.log.push('half-written');
            throw new DOMException('模拟：写到一半磁盘出错', 'InvalidStateError');
          },
          close: () => { probe.log.push('close'); return w.close(); },
          abort: (reason) => { probe.log.push('abort'); return w.abort(reason); },
        };
      },
    });
    window.showSaveFilePicker = async (opts) => wrap(await root.getFileHandle(opts?.suggestedName || 'probe.proc', { create: true }));
    window.__opfsText = async (name) => {
      try { return await (await (await root.getFileHandle(name)).getFile()).text(); } catch { return null; }
    };
    window.__opfsNames = async () => { const out = []; for await (const [n] of root.entries()) out.push(n); return out; };
  });
  return page;
}

async function clickSave(page) {
  // 点顶栏「项目」→「保存项目」。菜单偶尔一打开就被别处的关闭逻辑收回去:重试几次
  for (let i = 0; i < 4; i += 1) {
    await page.click('.pc-proj-btn');
    const open = await waitFor(page, () => [...document.querySelectorAll('.pc-proj-item')].some((b) => b.textContent.includes('保存项目')), null, 2000).then(() => true, () => false);
    if (open) {
      await page.evaluate(() => {
        const item = [...document.querySelectorAll('.pc-proj-item')].find((b) => b.textContent.includes('保存项目'));
        item.click();
      });
      return 'menu';
    }
    await sleep(300);
  }
  // 退而走桌面版标题栏「文件 → 保存」那条命令(同一个 saveProject)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pc-titlebar-command', { detail: 'save-project' })));
  return 'titlebar';
}

const projectName = (page) => page.evaluate(() => window.__pcStore.getState().project.name);
/** 撤销得了的那一笔用加序列:项目名的修改不进撤销栈 */
const trackCount = (page) => page.evaluate(() => window.__pcStore.getState().project.tracks.length);
const addTrack = (page, name) => page.evaluate((n) => { window.__pcStore.actions.addTrack(n); }, name);
const fileName = (page) => page.evaluate(() => `${window.__pcStore.getState().project.name}.proc`);
const clipCount = (page) => page.evaluate(() => window.__pcStore.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0));
/** 选中第一个片段(Delete 键删的就是选中的片段) */
const selectFirstClip = (page) => page.evaluate(() => {
  const c = window.__pcStore.getState().project.tracks.flatMap((t) => t.clips)[0];
  if (c) window.__pcStore.actions.select([c.id]);
  return c?.id ?? null;
});

/** 从各条路去改项目;回各条路之后项目对象有没有换 */
async function tryEditPaths(page) {
  await page.evaluate(() => { window.__p0 = window.__pcStore.getState().project; });
  const changed = {};
  const snap = () => page.evaluate(() => {
    const s = window.__pcStore.getState();
    return { same: s.project === window.__p0, name: s.project.name, tracks: s.project.tracks.length, clips: s.project.tracks.reduce((n, t) => n + t.clips.length, 0), media: s.project.media.length, renaming: !!document.querySelector('.pc-projname--editing'), canUndo: window.__pcStore.actions.canUndo() };
  });
  // 0 快捷键:Delete 删选中的片段(焦点不在输入框)
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Delete');
  await sleep(150); changed.deleteKey = await snap();
  // 1 快捷键:Ctrl+Z 撤销
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(150); changed.ctrlZ = await snap();
  // 2 标题栏菜单命令(桌面版的「编辑 → 撤销」)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pc-titlebar-command', { detail: 'undo' })));
  await sleep(150); changed.titlebarUndo = await snap();
  // 3 鼠标点项目名(会进入改名)。保存中那层罩子盖在上面,用真鼠标点它的位置
  const box = await page.evaluate(() => { const r = document.querySelector('.pc-projname--btn')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; });
  if (box) await page.mouse.click(box.x, box.y);
  await page.evaluate(() => document.querySelector('.pc-projname--btn')?.click()); // 绕过罩子直接派发到按钮上
  await sleep(150); changed.clickName = await snap();
  // 4 拖放一个文件到时间轴
  await page.evaluate(() => {
    const el = document.querySelector('[data-pc="timeline"]') || document.body;
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], '拖进来的.png', { type: 'image/png' }));
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await sleep(300); changed.drop = await snap();
  // 5 粘贴、滚轮
  await page.evaluate(() => {
    const el = document.querySelector('[data-pc="timeline"]') || document.body;
    const dt = new DataTransfer(); dt.setData('text/plain', '粘贴');
    el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 300, ctrlKey: true }));
  });
  await sleep(150); changed.pasteWheel = await snap();
  // 6 Agent 面板:焦点放进输入框打字。打不进字就发不出去;不按回车 —— 没拦住的话(改之前的代码)回车会真把话发给 Agent
  const hasComposer = await page.evaluate(() => { const t = document.querySelector('.ai-composer-input'); if (!t) return false; t.focus(); return true; });
  if (hasComposer) await page.keyboard.type('把标题改成 X');
  await sleep(200);
  changed.agentPanel = { ...(await snap()), composer: hasComposer, typed: await page.evaluate(() => document.querySelector('.ai-composer-input')?.value ?? null) };
  await page.evaluate(() => document.activeElement?.blur?.());
  return changed;
}

async function phaseLock(browser) {
  const page = await openEditor(browser);
  await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.setProjectMeta({ name: '保存探针改过' });
  });
  const tracks0 = await trackCount(page);
  await addTrack(page, '探针序列');
  const selected = await selectFirstClip(page);
  const clips0 = await clipCount(page);
  // 撤销栈里要真有这一步、有选中的片段,快捷键那两条路才测得出东西
  const undoReady = await waitFor(page, () => window.__pcStore.actions.canUndo(), null, 10000).then(() => true, () => false);
  check('lock.precondition', undoReady && !!selected, { canUndo: undoReady, selected, clips0 });
  const fname = await fileName(page);
  await page.evaluate(() => { window.__saveProbe.mode = 'hold'; });
  await clickSave(page);
  await waitFor(page, () => !!window.__saveProbe.release, null, 30000);
  const overlay = await page.evaluate(() => { const el = document.querySelector('[data-pc="save-lock"]'); return el ? { step: el.getAttribute('data-step'), text: el.textContent } : null; });
  check('lock.overlay-shown', !!overlay, { overlay });
  await page.screenshot({ path: path.join(outDir, '1-saving.png') });
  const tried = await tryEditPaths(page);
  for (const [k, v] of Object.entries(tried)) {
    const ok = v.same && v.name === '保存探针改过' && v.tracks === tracks0 + 1 && v.clips === clips0 && !v.renaming && (k !== 'agentPanel' || !v.composer || !v.typed);
    check(`lock.blocked.${k}`, ok, v);
  }
  await page.evaluate(() => window.__saveProbe.release());
  // 不靠被测代码的界面判断保存结束:等文件真的关上,再等脏标记清掉(最多 10 秒)
  await waitFor(page, () => window.__saveProbe.log.includes('closed'), null, 30000).catch(() => {});
  await waitFor(page, () => window.__pcStore.getState().dirty === false, null, 10000).catch(() => {});
  await sleep(300);
  const text = await page.evaluate((n) => window.__opfsText(n), fname);
  let savedName = null, savedTracks = null;
  try { const doc = JSON.parse(text); savedName = doc.project.name; savedTracks = doc.project.tracks.length; } catch { /* 下面判 */ }
  check('lock.file-written', savedName === '保存探针改过' && savedTracks === tracks0 + 1, { savedName, savedTracks, bytes: text?.length ?? 0 });
  const dirty = await page.evaluate(() => window.__pcStore.getState().dirty);
  check('lock.marked-saved', dirty === false, { dirty });
  await page.evaluate(() => document.activeElement?.blur?.());
  await selectFirstClip(page);
  await page.keyboard.press('Delete');
  await sleep(200);
  const clipsAfter = await clipCount(page);
  check('lock.edit-restored', clipsAfter === clips0 - 1, { clipsAfterDelete: clipsAfter, clips0 });
  await page.screenshot({ path: path.join(outDir, '2-after-save.png') });
  await page.close();
}

async function phaseTimeout(browser) {
  const page = await openEditor(browser);
  await page.evaluate(() => { window.__pcStore.actions.setProjectMeta({ name: '超时探针' }); });
  const fname = await fileName(page);
  // 先正常存一版,作为「上次有效保存」
  await clickSave(page);
  await waitFor(page, () => window.__saveProbe.log.includes('closed') && window.__pcStore.getState().dirty === false, null, 30000);
  await sleep(300);
  const before = await page.evaluate((n) => window.__opfsText(n), fname);
  check('timeout.baseline-saved', !!before && before.includes('超时探针'), { bytes: before?.length ?? 0 });
  await page.evaluate(() => { window.__pcStore.actions.setProjectMeta({ name: '超时探针改过' }); });
  const tracks0 = await trackCount(page);
  await addTrack(page, '超时序列');
  // 本机 Agent 有一个工具调用开始了、一直没结束(和 mcpExecutor 用的是同一个模块实例)
  const moduleUrl = await page.evaluate(AGENT_TOOL('beginAgentTool'));
  check('timeout.precondition-agent-module', !!moduleUrl, { moduleUrl });
  const createBefore = await page.evaluate(() => window.__saveProbe.createCalls);
  const t0 = Date.now();
  await clickSave(page);
  await waitFor(page, () => !!document.querySelector('[data-pc="save-lock-waiting"]'), null, 15000).catch(() => {});
  const waitingText = await page.evaluate(() => document.querySelector('[data-pc="save-lock-waiting"]')?.textContent ?? '');
  check('timeout.waiting-shown', waitingText.includes('Agent'), { waitingText });
  await page.screenshot({ path: path.join(outDir, '3-waiting.png') });
  // 等的时候改不动
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(150);
  check('timeout.blocked-while-waiting', (await trackCount(page)) === tracks0 + 1, { tracks: await trackCount(page), tracks0 });
  await waitFor(page, () => !!document.querySelector('[data-pc="save-notice"]'), null, 30000).catch(() => {});
  const elapsed = Date.now() - t0;
  const notice = await page.evaluate(() => { const el = document.querySelector('[data-pc="save-notice"]'); return { tone: el?.getAttribute('data-tone'), text: el?.textContent ?? '' }; });
  check('timeout.notice', notice.tone === 'error' && notice.text.includes('Agent') && notice.text.includes('没有保存') && notice.text.includes('原来的文件没有改动'), { notice, elapsedMs: elapsed });
  await page.screenshot({ path: path.join(outDir, '4-timeout.png') });
  const createAfter = await page.evaluate(() => window.__saveProbe.createCalls);
  const afterText = await page.evaluate((n) => window.__opfsText(n), fname);
  check('timeout.no-write', createAfter === createBefore && afterText === before, { createBefore, createAfter, unchanged: afterText === before });
  const dirty = await page.evaluate(() => window.__pcStore.getState().dirty);
  check('timeout.still-dirty', dirty === true, { dirty });
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(200);
  check('timeout.edit-restored', (await trackCount(page)) === tracks0, { tracks: await trackCount(page), tracks0 });
  await page.evaluate(AGENT_TOOL('endAgentTool'));
  await page.close();
}

async function phaseFail(browser) {
  const page = await openEditor(browser);
  await page.evaluate(() => { window.__pcStore.actions.setProjectMeta({ name: '失败探针' }); });
  const fname = await fileName(page);
  await clickSave(page);
  await waitFor(page, () => window.__saveProbe.log.includes('closed') && window.__pcStore.getState().dirty === false, null, 30000);
  await sleep(300);
  const before = await page.evaluate((n) => window.__opfsText(n), fname);
  check('fail.baseline-saved', !!before && before.includes('失败探针'), { bytes: before?.length ?? 0 });
  // 改得多一点,让新内容比旧的长、写一半时一定和旧内容不同
  const tracks0 = await trackCount(page);
  await addTrack(page, '失败序列'.repeat(20));
  await page.evaluate(() => { window.__saveProbe.mode = 'fail'; window.__saveProbe.log = []; });
  await clickSave(page);
  await waitFor(page, () => !!document.querySelector('[data-pc="save-notice"]') || (!document.querySelector('[data-pc="save-lock"]') && window.__saveProbe.log.includes('half-written')), null, 30000);
  await sleep(300);
  const notice = await page.evaluate(() => { const el = document.querySelector('[data-pc="save-notice"]'); return el ? { tone: el.getAttribute('data-tone'), text: el.textContent } : null; });
  check('fail.notice', !!notice && notice.tone === 'error' && notice.text.includes('原来的文件'), { notice });
  await page.screenshot({ path: path.join(outDir, '5-write-failed.png') });
  const log = await page.evaluate(() => window.__saveProbe.log);
  check('fail.aborted', log.includes('abort') && !log.includes('close'), { log });
  const afterText = await page.evaluate((n) => window.__opfsText(n), fname);
  check('fail.original-byte-identical', afterText === before, { beforeBytes: before?.length ?? 0, afterBytes: afterText?.length ?? 0 });
  const names = await page.evaluate(() => window.__opfsNames());
  check('fail.no-leftover-files', names.filter((n) => n !== fname && n.startsWith('失败探针')).length === 0, { names });
  const dirty = await page.evaluate(() => window.__pcStore.getState().dirty);
  check('fail.still-dirty', dirty === true, { dirty });
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  await sleep(200);
  check('fail.edit-restored', (await trackCount(page)) === tracks0, { tracks: await trackCount(page), tracks0 });

  // 对照:不经我们的代码,只看浏览器——写一半、既不 close 也不 abort,原文件是不是照样不变
  const raw = await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const h = await root.getFileHandle(n);
    const orig = await (await h.getFile()).text();
    const w = await h.createWritable();
    await w.write('半截'.repeat(50));
    const midway = await (await h.getFile()).text();
    // 不 close、不 abort,丢掉这个流
    const w2 = await h.createWritable(); // 再开一个流也不受影响
    await w2.abort();
    const later = await (await h.getFile()).text();
    return { origBytes: orig.length, midwayUnchanged: midway === orig, laterUnchanged: later === orig, w: typeof w };
  }, fname);
  check('browser.swap-file-semantics', raw.midwayUnchanged && raw.laterUnchanged, raw);
  await page.close();
}

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-size=1440,900'] });
try {
  if (phases.includes('lock')) await phaseLock(browser).catch((e) => check('lock.crashed', false, { error: String(e?.stack || e) }));
  if (phases.includes('timeout')) await phaseTimeout(browser).catch((e) => check('timeout.crashed', false, { error: String(e?.stack || e) }));
  if (phases.includes('fail')) await phaseFail(browser).catch((e) => check('fail.crashed', false, { error: String(e?.stack || e) }));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ summary: { total: results.length, passed: results.length - failed.length, failed: failed.map((r) => r.check) } }));
process.exit(failed.length ? 1 : 0);
