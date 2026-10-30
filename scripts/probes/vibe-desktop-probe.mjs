// First import protects user directories and the shared port file before any fixture import.
import '../lib/no-user-dirs.mjs';
/**
 * 桌面版氛围式的真跑一遍(分支 `claude/editor-vibe-button`)。
 *
 * **跑在真的桌面壳里**,不是浏览器标签页:Tauri 壳给自己的 WebView2 开了调试端口
 * (`desktop/src-tauri/src/agent_webview.rs` 的 `browser_args`,主窗和 agent 子 webview 共用同一个环境),
 * 本脚本连上那个端口、拿到主窗那一页,再点、再截图。截的就是桌面应用窗口里的内容。
 *
 * 怎么让壳里跑的是本分支的代码:壳启动时先探 5210,**探到已经有一份在服务就不自己起 sidecar,直接导航过去**
 * (`desktop/src-tauri/src/lib.rs` 的 `existing_instance`)。所以先在这个 worktree 里起 `vite --port 5210`,
 * 再启动壳,壳里显示的就是本分支。
 *
 *   # 1) 本 worktree 里先起开发服务
 *   PROMPTCUT_NO_PORT_FILE=1 npx vite --port 5210 --strictPort --host 127.0.0.1
 *   # 2) 启动桌面壳(任一份 promptcut.exe 都行,Rust 这一侧本分支没改)
 *   # 3) 找到 WebView2 的调试端口,跑本脚本
 *   node scripts/probes/vibe-desktop-probe.mjs --cdp <端口> --out <目录>
 *
 * 走的路(每步一张图,图名见 `step` 记录):
 *   传统开始页上有「氛围式」→ 点它进氛围式那一屏(地址变成 ?ui=vibe)→ 说一句话建本机项目 → 进聊天页、这句话在里面 →
 *   看本机 Agent 的状态(真回复 / 真的说不出话的原因,两种都如实记)→ 回首页,新项目列在侧栏和那一排里 →
 *   再开一条对话(= AI 栏的第二个 Agent 分页)→ 开右侧拓展栏、进详细编辑看真舞台真时间轴 →
 *   点「进入传统式」进编辑界面 → 编辑界面顶栏那一格「氛围式」不再置灰,点它回到氛围式那一屏 →
 *   顶栏「拓展与存储」回传统开始页
 * 最后一行是一行 JSON:{ ok, steps, fails }。退出码 0 过、1 不过。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 10 * 60_000).unref();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (key, dflt) => { const i = argv.indexOf(key); return i < 0 ? dflt : argv[i + 1]; };
const CDP = Number(arg('--cdp', ''));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'docs/archive/agent-reports/AGENT-claude-editor-vibe-button-shots')));
const EDITOR = arg('--editor', 'http://127.0.0.1:5210');
if (!Number.isInteger(CDP) || CDP <= 0) {
  console.error('要 --cdp <端口>:桌面壳 WebView2 的调试端口。找法见本文件头。');
  process.exit(2);
}
await fs.mkdir(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; console.error(`[step] ${k} ${JSON.stringify(v).slice(0, 400)}`); };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等不到也不算失败的等待:用在「有更好,没有就换个办法」的地方 */
async function soft(fn, ms, every = 500) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}

async function until(what, fn, ms = 30_000, every = 300, pass) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(pass); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}

let shotNo = 0;
async function shot(page, name) {
  const file = path.join(OUT, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  return path.basename(file);
}

/** 这一刻页面上那几样东西各是什么样 */
const snapshot = (page) => page.evaluate(() => {
  const pick = (sel) => document.querySelector(sel);
  const text = (sel) => pick(sel)?.textContent?.trim() ?? null;
  const rows = (sel) => [...document.querySelectorAll(sel)].map((el) => el.textContent.trim().replace(/^›\s*/, ''));
  const mode = pick('[data-pc="mode-switch"]');
  return {
    url: location.href,
    classic: !!pick('[data-pc="start-join"]') || !!pick('[data-pc="start-go-vibe"]'),
    vibe: !!pick('[data-pc="start-desktop"]'),
    editor: !!mode,
    chat: !!pick('[data-pc="start-chat"]'),
    detail: !!pick('[data-pc="start-detail"]'),
    ext: !!pick('[data-pc="start-ext"]'),
    agentBtn: text('[data-pc="start-agent-setup"]'),
    note: text('[data-pc="start-notice"]'),
    chatNote: text('[data-pc="start-chat-note"]'),
    banner: text('[data-pc="start-chat-banner"]'),
    title: text('[data-pc="start-chat-name"]'),
    where: text('.ps-top-where'),
    sideNotice: text('[data-pc="start-side-notice"]'),
    projects: rows('[data-pc="start-side-project"]'),
    agents: rows('[data-pc="start-side-agent"]'),
    tiles: [...document.querySelectorAll('[data-pc="start-project-tile"]')].map((el) => el.textContent.trim()),
    railCount: text('[data-pc="start-rail-count"]'),
    msgs: [...document.querySelectorAll('[data-pc="start-chat-msg"]')].map((el) => ({
      from: el.dataset.from, send: el.dataset.send ?? null, text: el.textContent.trim().slice(0, 160),
    })),
    // 顶栏那三格:各自的字、按下没有、置灰没有
    modes: mode ? [...mode.querySelectorAll('button')].map((b) => ({
      label: b.textContent.trim(), on: b.getAttribute('aria-pressed') === 'true', off: b.disabled, title: b.title,
    })) : null,
    // 账号那一块桌面版不该有
    account: !!pick('[data-pc="start-top-account"]'),
  };
});

const clickPc = (page, pc) => page.click(`[data-pc="${pc}"]`);

/* ---------------- 连上桌面壳 ---------------- */
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => p.url().startsWith(EDITOR));
if (!page) {
  console.error(`桌面壳里没有 ${EDITOR} 那一页。现在开着的是:`, pages.map((p) => p.url()));
  await browser.disconnect();
  process.exit(2);
}
page.setDefaultTimeout(30_000);
// 脏数据确认框(切氛围式、回首页时弹)会把点击卡住,一律按「继续」并记下弹过什么
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); void d.accept(); });
step('connect', { cdp: CDP, url: page.url(), pages: pages.map((p) => p.url()) });

try {
  /* ---------------- 1. 传统开始页:多了一颗「氛围式」 ---------------- */
  // 从头来:地址清成干净的 /,刷新
  await page.goto(`${EDITOR}/`, { waitUntil: 'domcontentloaded' });
  await until('传统开始页', () => page.$('[data-pc="start-go-vibe"]'));
  let s = await snapshot(page);
  check(s.classic && !s.vibe, '开始页该是传统那一页', s);
  step('classic', { ...s, shot: await shot(page, 'classic-start') });

  /* ---------------- 2. 点「氛围式」进那一屏 ---------------- */
  await clickPc(page, 'start-go-vibe');
  await until('氛围式那一屏', () => page.$('[data-pc="start-desktop"]'));
  s = await snapshot(page);
  check(s.vibe, '该进氛围式那一屏', s);
  check(s.url.includes('ui=vibe'), '地址该记成 ?ui=vibe(刷新后还在这一屏)', s.url);
  check(!s.account, '桌面版顶栏不该有账号那一块', s);
  check(!!s.agentBtn, '顶栏该有 Agent 那一颗', s);
  step('vibe', { ...s, shot: await shot(page, 'vibe-home') });

  // 刷新一次:地址记住了,还该落在这一屏
  await page.reload({ waitUntil: 'domcontentloaded' });
  const back = await until('刷新后还在氛围式', () => page.$('[data-pc="start-desktop"]'));
  check(!!back, '刷新后该还在氛围式那一屏');
  step('reload', { vibe: !!back });

  /* ---------------- 3. 说一句话:建本机项目、进聊天页 ---------------- */
  const SAY = `做一支 15 秒的产品短片，开头一句话点题 ${Date.now().toString(36).slice(-4)}`;
  const projectsBefore = (await snapshot(page)).projects.length;
  await page.click('[data-pc="start-prompt-input"]');
  await page.type('[data-pc="start-prompt-input"]', SAY);
  // 画幅选 9:16(竖屏):顺带验「建出来的项目按选的画幅定尺寸」。点完要等 React 重渲再读按下状态
  await page.evaluate(() => {
    [...document.querySelectorAll('.ps-prompt-foot .ps-chip')].find((x) => x.textContent.trim() === '9:16')?.click();
  });
  const picked = await until('9:16 按下', () => page.evaluate(() =>
    [...document.querySelectorAll('.ps-prompt-foot .ps-chip')].find((x) => x.textContent.trim() === '9:16')?.getAttribute('aria-pressed') === 'true' || null), 5_000);
  check(!!picked, '9:16 该被选上');
  await clickPc(page, 'start-prompt-send');
  const entered = await until('进聊天页', () => page.$('[data-pc="start-chat"]'), 60_000);
  check(!!entered, '说一句话之后该进这个新项目的聊天页');
  // 开始页那句话要等 Agent 就绪才发得出去(`ChatView` 的 pending),所以等它真出现在对话里
  const said = await until('那句话进对话', () => page.evaluate((want) =>
    [...document.querySelectorAll('[data-pc="start-chat-msg"][data-from="me"]')].some((el) => el.textContent.includes(want)) || null, SAY), 90_000);
  check(!!said, '刚说的那句话该在对话里');
  s = await snapshot(page);
  check((s.where ?? '').includes('做一支'), '项目名该取自这句话', s.where);
  check(s.projects.length === projectsBefore + 1, '侧栏该多出一个项目', { projectsBefore, now: s.projects });
  // 这一次建出来的项目叫什么(名字取自那句话,长了会截断加省略号)。下面核对自动保存时按它找,别认成上一轮留下的
  const madeName = (s.where ?? '').replace(/^项目「/, '').replace(/」$/, '');
  step('say', { ...s, dialogs: [...dialogs], shot: await shot(page, 'chat-after-say') });

  /* ---------------- 4. 本机 Agent 此刻说得出话吗 ---------------- */
  // 两种都算跑通,但要如实记是哪一种:配好了就等真回复,没配好就把那句原因记下来
  const agentState = await page.evaluate(() => ({
    canSend: !document.querySelector('[data-pc="start-chat-input"]')?.disabled,
    why: document.querySelector('[data-pc="start-chat-note"]')?.textContent?.trim() ?? null,
    agentBtn: document.querySelector('[data-pc="start-agent-setup"]')?.textContent?.trim() ?? null,
  }));
  check(agentState.canSend, '这台机器上有 Agent,这时该能发(发不了的话下面那句写了原因)', agentState);
  // 等它开口:真回复、或者真错误 —— 两种都算接上了,但要如实记是哪一种
  const replied = await until('本机 Agent 的回应', async () => {
    const r = await page.evaluate(() => ({
      agent: [...document.querySelectorAll('[data-pc="start-chat-msg"][data-from="agent"]')].length,
      say: document.querySelector('[data-pc="start-chat-msg"][data-from="agent"]')?.textContent?.trim().slice(0, 200) ?? null,
      err: document.querySelector('[data-pc="start-chat-send-error"]')?.textContent?.trim()
        ?? document.querySelector('[data-pc="start-chat-banner"]')?.textContent?.trim() ?? null,
    }));
    return r.agent > 0 || r.err ? r : null;
  }, 120_000);
  check(!!replied, '本机 Agent 该有回应');
  step('agent', { ...agentState, ...(replied ?? {}), shot: await shot(page, 'agent-reply') });

  /* ---------------- 4b. 自动保存:Agent 改了就落盘,不用用户按「保存项目」 ---------------- */
  // `workflow/project.md`「草稿自动保存在本机」。等 store 的 dirty 落回去,再从服务端读一遍草稿核对
  const saved = await until('自动保存落盘', async (want) => {
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      const body = await res.json();
      return { list: (body.projects ?? []).map((d) => ({ name: d.name, clips: d.clips, at: d.updatedAt })) };
    });
    const hit = r.list.find((d) => d.name === want);
    return hit ? { hit } : null;
  }, 60_000, 1000, madeName);
  check(!!saved, '这个项目该已经自己落盘了(不用用户按「保存项目」)');
  step('autosave', { madeName, ...(saved ?? {}) });

  /* ---------------- 4c. 再开一条对话(= AI 栏的第二个 Agent 分页) ---------------- */
  // 要等第一条消息真发出去之后再点:一条真会话都没有时侧栏那一条是占位的开始页,
  // `addTab()` 这时按设计不新建(和 AI 栏一个行为)
  const agentsBefore = (await snapshot(page)).agents.length;
  if (await page.$('[data-pc="start-side-new-chat"]')) {
    await clickPc(page, 'start-side-new-chat');
    await until('第二条对话', async () => {
      const n = await page.$$eval('[data-pc="start-side-agent"]', (a) => a.length).catch(() => 0);
      return n > agentsBefore ? n : null;
    }, 15_000);
  }
  s = await snapshot(page);
  check(s.agents.length === agentsBefore + 1, '该多出一条对话', { agentsBefore, now: s.agents });
  step('chats', { agentsBefore, agents: s.agents, shot: await shot(page, 'two-chats') });

  /* ---------------- 5. 回首页:新项目列在侧栏和那一排里 ---------------- */
  await clickPc(page, 'start-home');
  await until('回到开始页', async () => (await page.$('[data-pc="start-prompt"]')) && !(await page.$('[data-pc="start-chat"]')));
  s = await snapshot(page);
  check(s.projects.length >= 1, '侧栏该列出刚建的本机项目', s.projects);
  check(s.tiles.length >= 1, '那一排该有刚建的项目', s.tiles);
  step('home', { ...s, shot: await shot(page, 'home-with-project') });

  /* ---------------- 6. 右侧拓展栏 + 详细编辑 ---------------- */
  if (!(await page.$('[data-pc="start-chat"]'))) {
    // 回到聊天页:点侧栏里第一条对话
    await clickPc(page, 'start-side-agent');
    await until('聊天页', () => page.$('[data-pc="start-chat"]'));
  }
  // 进会话之后拓展栏自己就展开了(issue #6):已经开着就别再点,点了反而关上
  await page.evaluate(() => { if (!document.querySelector('[data-pc="start-ext"]')) document.querySelector('[data-pc="start-chat-ext-toggle"]')?.click(); });
  const extOn = await until('右侧拓展栏', () => page.$('[data-pc="start-ext"]'));
  check(!!extOn, '拓展栏该打得开');
  step('ext', { ...(await snapshot(page)), shot: await shot(page, 'ext-panel') });

  await clickPc(page, 'start-ext-detail');
  const detail = await until('详细编辑', () => page.$('[data-pc="start-detail"]'));
  check(!!detail, '详细编辑该打得开(里面是真舞台真时间轴)');
  // 挂的得是编辑界面那条**真**时间轴,不是自己画的一条只读轨道
  const realTl = await until('真时间轴', () => page.$('[data-pc="start-detail-tl"] [data-pc="timeline"]'), 20_000);
  check(!!realTl, '详细编辑里该挂编辑界面那条真时间轴(`src/editor/timeline/`)');
  // 舞台那一格的宽高比就是项目的宽高(`VibeStage` 用 store 的 width/height):验开始页上点的 9:16 真落下去了
  const ratio = await page.evaluate(() => {
    const el = document.querySelector('.ps-stage');
    return el ? getComputedStyle(el).aspectRatio : null;
  });
  check(ratio === '1080 / 1920' || ratio === '1080/1920', '项目该按开始页上点的 9:16 建', ratio);
  step('detail', { ratio, realTimeline: !!realTl, ...(await snapshot(page)), shot: await shot(page, 'detail-edit') });

  /* ---------------- 6b. 时间轴真的可调:拖一段,它的起点真的变了 ---------------- */
  // `user-workflow.md`「工作方式」:氛围式里「从右侧拓展栏的「画面」进详细编辑，那里的时间轴可调」。
  // 只看 DOM 不算数 —— 要拖一下,再从 store 里读这一段的起点,变了才算可调
  const pickClip = () => page.evaluate(() => {
    const st = window.__pcStore?.getState?.();
    const c = st?.project?.tracks?.flatMap((t) => t.clips)?.[0];
    return c ? { id: c.id, start: c.start, end: c.end } : null;
  });
  // `__pcStore` 是时间轴模块挂的(`src/editor/timeline/index.tsx`);挂得上就说明那条真时间轴真的载进来了
  const hasStore = await until('__pcStore', () => page.evaluate(() => !!window.__pcStore), 20_000);
  check(!!hasStore, '真时间轴的调试口子该在(它是时间轴模块挂的)');
  // 先等 Agent 自己往里放东西;它这一轮慢的话就自己放一段,这一步验的是「拖得动」,不该卡在等模型
  let seeded = false;
  let beforeDrag = await soft(pickClip, 30_000);
  if (!beforeDrag && hasStore) {
    seeded = true;
    await page.evaluate(() => { window.__pcStore.actions.addCardClip('av-pulse', 1, { duration: 2 }); });
    beforeDrag = await until('自己放的那一段', pickClip, 10_000);
  }
  let dragged = null;
  const diag = {};
  if (beforeDrag) {
    const box = await page.$eval(`[data-clip-id="${beforeDrag.id}"]`, (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    // 从片段中间按下、往右挪一截再松开(useDrag 挂的是原生 pointer 事件,分几步移动才有中间态)
    diag.at = await page.evaluate((b) => document.elementsFromPoint(b.x, b.y).slice(0, 4).map((el) => `${el.tagName}.${el.className}`.slice(0, 60)), box);
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    diag.selAfterDown = await page.evaluate(() => window.__pcStore?.getState?.().selection ?? null);
    await page.mouse.move(box.x + 60, box.y + 4, { steps: 6 });
    diag.leftDuring = await page.$eval(`[data-clip-id="${beforeDrag.id}"]`, (el) => el.style.left);
    await page.mouse.move(box.x + 120, box.y + 4, { steps: 6 });
    await page.mouse.up();
    dragged = await until('起点真的变了', async () => {
      const now = await pickClip();
      return now && Math.abs(now.start - beforeDrag.start) > 1e-6 ? now : null;
    }, 10_000);
  }
  check(!!dragged, '拖一段之后它的起点该变(时间轴可调)', { beforeDrag, dragged });
  step('drag', { seeded, beforeDrag, afterDrag: dragged, ...diag, shot: await shot(page, 'timeline-dragged') });

  /* ---------------- 6c. 右键菜单里有这一页独有的「引用到输入框」 ---------------- */
  let menuItems = [];
  if (beforeDrag) {
    await page.click(`[data-clip-id="${beforeDrag.id}"]`, { button: 'right' });
    await until('右键菜单', () => page.$('[data-pc="tl-ctxmenu"]'), 10_000);
    menuItems = await page.$$eval('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item', (a) => a.map((el) => el.textContent.trim()));
    await page.keyboard.press('Escape');
  }
  check(menuItems.includes('引用到输入框'), '右键菜单该有这一页独有的「引用到输入框」', menuItems);
  check(menuItems.some((m) => m === '删除' || m.startsWith('在播放头处分割')), '右键菜单该是真时间轴那一套(有删除、分割)', menuItems);
  step('ctxmenu', { items: menuItems });

  /* ---------------- 7. 「进入传统式」→ 编辑界面 ---------------- */
  await clickPc(page, 'start-enter-traditional');
  const inEditor = await until('编辑界面', () => page.$('[data-pc="mode-switch"]'), 90_000);
  check(!!inEditor, '该进编辑界面');
  s = await snapshot(page);
  const vibeSlot = (s.modes ?? []).find((m) => m.label === '氛围式');
  check(!!vibeSlot, '顶栏该有「氛围式」那一格', s.modes);
  check(vibeSlot && !vibeSlot.off, '桌面版这一格不该再置灰', vibeSlot);
  step('editor', { ...s, shot: await shot(page, 'editor-modeswitch') });

  /* ---------------- 8. 顶栏那一格「氛围式」:回氛围式那一屏 ---------------- */
  /*
   * 点之前先把 `confirm` 换成记一笔就放行的版本。两个原因:
   *   - 这一屏自动保存过了,`goVibe` 本来就不该弹「有未保存的改动」—— 弹没弹本身就是要验的一条;
   *   - WebView2 里真弹出来是个原生模态框,CDP 按不掉,探针会一直卡在那儿。
   */
  await page.evaluate(() => {
    window.__pcConfirms = [];
    window.confirm = (m) => { window.__pcConfirms.push(String(m)); return true; };
  });
  await clickPc(page, 'mode-vibe');
  const backVibe = await until('回到氛围式', () => page.$('[data-pc="start-desktop"]'), 60_000);
  const confirms = await page.evaluate(() => window.__pcConfirms ?? []);
  check(confirms.length === 0, '自动保存过了,切氛围式不该再问「有未保存的改动」', confirms);
  check(!!backVibe, '点「氛围式」该离开编辑界面、回到氛围式那一屏');
  s = await snapshot(page);
  check(s.url.includes('ui=vibe'), '回去之后地址仍记着 ?ui=vibe', s.url);
  step('back', { confirms, ...s, shot: await shot(page, 'back-to-vibe') });

  /* ---------------- 9. 「拓展与存储」回传统开始页 ---------------- */
  await clickPc(page, 'start-go-classic');
  const classicAgain = await until('传统开始页', () => page.$('[data-pc="start-go-vibe"]'));
  check(!!classicAgain, '「拓展与存储」该回到传统开始页');
  s = await snapshot(page);
  check(!s.url.includes('ui=vibe'), '回传统页之后地址上的 ?ui=vibe 该去掉', s.url);
  step('classic-again', { ...s, shot: await shot(page, 'classic-again') });
  step('dialogs', dialogs);
} catch (e) {
  fails.push(`抛了:${e instanceof Error ? e.message : String(e)}`);
  try { await shot(page, 'threw'); } catch { /* 截不到就算了 */ }
} finally {
  // 只断开,不关浏览器 —— 这是用户的桌面应用窗口,关掉就把应用关了
  await browser.disconnect();
}

out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
