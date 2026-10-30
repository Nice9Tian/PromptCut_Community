/**
 * C6.5 页面一侧的验收探针(c65-editor 分支):真浏览器里点一遍同步、撤销、离线、本地备份、共享项目,并截图。
 *
 * 用法:
 *   node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5510 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots [--phases local,shared]
 *   node scripts/probes/c65-editor-probe.mjs --origin http://127.0.0.1:5513 --hosted http://127.0.0.1:5518 --out out/c65-editor-shots --phases lan
 *
 * - `--origin`:本分支的编辑器(`?editor` 页面);`--hosted`:本机起的托管组合(`server/hosted/main.mjs`),
 *   代替阿里云,绝不连真正的托管端;`lan` 阶段要求编辑器以 `PROMPTCUT_LAN_HOST=1` 启动。
 * - 阶段:
 *   local  V2 真实页面版(两页交错编辑,两页与文档服务三份摘要相同)、部分没撤 / 全部没撤提示条、别人改动描边、
 *          离线对话框(丢弃 / 重放)、被覆盖的备份与气泡、本地备份列表、AI 栏「撤销这一步」(注入事件)
 *   shared 新建共享项目(托管)、打开共享项目、成员列表(重名、Agent 展开)、创建者操作(验证、改密码、踢人、禁入列表、删项目)、
 *          被踢的阻断弹窗、密码被改气泡、局域网模式要重启的提示
 *   lan    局域网模式新建 + 同名托管项目 → 打开对话框里并列两个候选
 * 结果:每项一行 JSON(`{ check, ok, ... }`),最后一行 `{ summary }`;有失败退出码 1。截图写进 `--out`。
 *
 * ## 跨机模式(C6.5 验收 U2):`--role creator|member`
 *
 * U2:另一台机器用「打开共享项目」进入后,看到的项目与局域网主机(或托管端)的 projectRev 相同;在上面改一处,创建者 5 s 内收到。
 * 两个角色各开一个真 Chrome 页面,只经协调口(`probe-coord.mjs`)交换进入信息与完成信号,不共享文件系统。
 *
 *   creator(局域网主机那台):
 *     node scripts/probes/c65-editor-probe.mjs --role creator --mode lan|hosted (--coord-port <n> [--coord-host 0.0.0.0] | --coord <url>)
 *          (--origin <编辑器> | --spawn-editor <端口>) [--hosted <托管地址>] [--hosted-public <给成员的托管地址>] [--out <目录>] [--keep]
 *   member(另一台,只需出站):
 *     node scripts/probes/c65-editor-probe.mjs --role member --coord <url> (--origin <编辑器> | --spawn-editor <端口>) [--hosted <托管地址>] [--out <目录>]
 *
 * - `--spawn-editor <端口>`:探针自己在仓库根起编辑器(`vite --port <端口> --strictPort`,`PROMPTCUT_PUSH=0`),跑完连进程树结束;
 *   creator 的局域网模式另加 `PROMPTCUT_LAN_HOST=1`(编辑器绑 `0.0.0.0`),其余绑 `127.0.0.1`。
 *   `--device-id` / `--device-name` 覆盖本机设备信息(`PROMPTCUT_DEVICE_ID` / `_NAME`,一台机器起两个实例时用)。
 * - `--mode lan`:creator 的编辑器必须是局域网主机;member 的页面靠本机编辑器的组播发现找到它。托管地址(member 这边查找时
 *   会同时查托管端)缺省设成一个连不上的回环地址 `http://127.0.0.1:9`,避免碰真正的托管端;给了 `--hosted` 就用它。
 * - `--mode hosted`:`--hosted` 必给(本机或局域网里起的托管组合,不要指真正的阿里云);`--hosted-public` 是写进协调口给成员的
 *   地址(缺省同 `--hosted`),member 的 `--hosted` 优先于协调口里的。
 * - 协调口的键:`u2-join`(creator → member:项目名、项目密码、模式、托管地址、创建后的 rev / sha256)、`u2-entered`、
 *   `u2-go`(creator 叫 member 改,带记号)、`u2-member-edit`(member 改完、文档服务确认后)、`u2-creator-edit`、`u2-member-result`。
 *   协调口不清键:每轮用 creator 新起的口(`--coord-port`),或新起一个 `shared-project-probe.mjs --role coord`。
 * - 计时都只用本机时钟,不跨机比时间戳:
 *     creator 的 `memberEditSeenMs` = 本页面 store 里出现成员那一处的时刻 − 收到成员「已提交」报告的时刻(先看到就记 0);
 *     另记 `memberEditSinceGoMs` = 看到的时刻 − 自己发出 `u2-go` 的时刻(含协调口往返与成员动手的时间,是上界)。
 *     member 的 `creatorEditSeenMs` 同理。两者都**只记录、不判**(2026-10-23 探针总审按 verification.md「耗时只记录,不当闸门」改;
 *     原先要求 ≤ 5000 ms,语义里没有这条时间承诺)。看到的是哪一处、是不是那张卡照旧判。
 * - projectRev 核对:member 进入后,页面的 rev / 项目 sha256 与「探针另开一条凭证连接直接向主机(托管端)project.open」读到的相同,
 *   且与 creator 报的相同;结束时两边再各核一次最终版本。
 * - 截图:`<role>-1-*.png`(creator 创建后 / member 进入后)、`<role>-2-*.png`(看到对方改动后)。
 * - 结束时 creator 以创建者身份删掉这个共享项目(免得局域网主机以后启动时还在广播);`--keep` 不删。
 * 结果:过程每步一行 JSON,最后一行 `{ ok, role, mode, projectId, rev, memberEditSeenMs | creatorEditSeenMs, ..., fails }`;有失败退出码 1。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildAuthProtocols } from '../../server/auth/client.mjs';
import { createSharedProject, wsBaseOf } from '../../server/auth/route.mjs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startCoordServer, coordClient } from './probe-coord.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
let origin = arg('--origin', 'http://127.0.0.1:5510');
const hosted = arg('--hosted', 'http://127.0.0.1:5518');
/** 跨机模式(U2):creator | member;不给就是原来的三个阶段 */
const ROLE = arg('--role', null);
const outDir = path.resolve(arg('--out', 'out/c65-editor-shots'));
const phases = arg('--phases', 'local,shared').split(',');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, extra = {}) => {
  const r = { check: name, ok: !!ok, ...extra };
  results.push(r);
  console.log(JSON.stringify(r));
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10_000, what = '条件') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时`);
    await sleep(100);
  }
}

const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
});

/**
 * 编辑器可以看了没有:卡片测量遮罩(`ProbeGate`,「正在测量卡片」)不在,且项目里有片段时时间轴上至少一个片段
 * 真的排出来了(有宽高、在视口里)。回 { ready, gate, clips, visible }。
 */
const readyState = (page) => P(page, async () => {
  const gate = document.querySelector('[data-pc="probe-gate"]');
  const S = await import('/src/store/project.ts');
  const clips = (S.getState().project?.tracks ?? []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);
  const vw = innerWidth, vh = innerHeight;
  const visible = [...document.querySelectorAll('[data-clip-id]')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  }).length;
  return { ready: !gate && (clips === 0 || visible > 0), gate: gate ? gate.innerText.replace(/\s+/g, ' ').slice(0, 80) : null, clips, visible };
});
/**
 * 等编辑器可以看:连续两次(间隔 300 ms)都 ready 才算,免得撞上测量一轮刚完、下一轮还没排上的空档。
 * 慢机器上测量遮罩可能挂几十秒;超时不抛,回最后一次的状态由调用方判。
 */
async function waitEditorReady(page, ms) {
  const t0 = Date.now();
  let last = null, streak = 0;
  for (;;) {
    last = await readyState(page).catch((e) => ({ ready: false, error: String(e?.message ?? e).slice(0, 120) }));
    streak = last.ready ? streak + 1 : 0;
    if (streak >= 2) return { ...last, waitedMs: Date.now() - t0 };
    if (Date.now() - t0 > ms) return { ...last, waitedMs: Date.now() - t0 };
    await sleep(300);
  }
}
/** 截图前没等到编辑器可以看的那几张(名字 + 状态);两种模式各自收尾时判失败 */
const shotsNotReady = [];
const SHOT_READY_MS = Number(arg('--shot-ready-timeout', '90')) * 1000;

async function shot(page, name) {
  await page.bringToFront();
  const ready = await waitEditorReady(page, SHOT_READY_MS);
  if (!ready.ready) shotsNotReady.push({ name, ...ready });
  await sleep(150);
  await closeAiSetup(page);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(JSON.stringify({ shot: file, ready: ready.ready, waitedMs: ready.waitedMs, ...(ready.ready ? {} : { gate: ready.gate, clips: ready.clips, visible: ready.visible }) }));
  return file;
}

/** 开一个编辑器页面,等同步接上;顺手关掉首次打开的「选择 AI 助手」对话框 */
async function openEditor(query = '') {
  if (process.env.PROBE_TRACE) console.error('[step] open', query);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(JSON.stringify({ pageerror: String(e?.message ?? e).slice(0, 300) })));
  // 原生弹框会卡住页面里的 evaluate:记下来并关掉
  page.on('dialog', (d) => { console.log(JSON.stringify({ dialog: d.type(), message: d.message().slice(0, 300) })); void d.dismiss(); });
  // 后台页面里 page.click / page.type 要等滚动与可见性,会一直挂着:点、打字之前先把它放到前面
  for (const m of ['click', 'type']) {
    const orig = page[m].bind(page);
    page[m] = async (...a) => { await page.bringToFront(); return orig(...a); };
  }
  await page.goto(`${origin}/?editor${query}`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.evaluate(() => !!window.__pcSyncTest && window.__pcSyncTest.view().status === 'online'), 30_000, '页面同步接上');
  // 打开项目时的卡片测量遮罩挡着整个编辑器(点、打字都落不下去),慢机器上能挂几十秒:等它退下、时间轴排出来
  const ready = await waitEditorReady(page, Number(arg('--open-ready-timeout', '300')) * 1000);
  if (!ready.ready) throw new Error(`编辑器打开后没等到可操作(测量遮罩/时间轴):${JSON.stringify(ready)}`);
  say('editor.ready', { url: page.url(), waitedMs: ready.waitedMs, clips: ready.clips, visible: ready.visible });
  await sleep(800);
  await closeAiSetup(page);
  return page;
}

async function closeAiSetup(page) {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click();
  });
  await sleep(200);
}

const P = (page, fn, ...args) => {
  if (process.env.PROBE_TRACE) console.error('[eval]', page.url().slice(-40), String(fn).slice(0, 80).replace(/\s+/g, ' '));
  return page.evaluate(fn, ...args);
};

/** 页面里当前项目的摘要 */
const pageDigest = (page) => P(page, async () => {
  const S = await import('/src/store/project.ts');
  const json = JSON.stringify(S.getState().project);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return { sha256: [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''), rev: window.__pcSyncTest.rev(), status: window.__pcSyncTest.view().status };
});

/** 文档服务里的真身(本机 local 空间):一条回环连接 project.open */
function docState(projectId, base = origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/docservice`, ['promptcut.v1']);
    const parts = [];
    const done = (project, rev) => {
      const json = JSON.stringify(project);
      resolve({ rev, sha256: createHash('sha256').update(json).digest('hex'), project });
      ws.close();
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'project.open', projectId })));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.state' && m.project) done(m.project, m.rev);
      else if (m.type === 'project.state.part') parts[m.index] = m.data;
      else if (m.type === 'project.state.end') done(JSON.parse(parts.join('')), m.rev);
    });
    ws.addEventListener('error', () => reject(new Error('连不上文档服务')));
    setTimeout(() => reject(new Error('project.open 超时')), 8000);
  });
}

const clipIds = (page) => P(page, async () => {
  const S = await import('/src/store/project.ts');
  return S.getState().project.tracks.flatMap((t) => t.clips.map((c) => c.id));
});
const clipOf = (page, id) => P(page, async (id) => {
  const S = await import('/src/store/project.ts');
  return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id) ?? null;
}, id);
const setParam = (page, id, params) => P(page, async (id, params) => {
  const S = await import('/src/store/project.ts');
  S.actions.setClipParams(id, params);
}, id, params);
/** 一次提交里改两个片段的参数(撤销时是一步) */
const setTwo = (page, a, b, text) => P(page, async (a, b, text) => {
  const S = await import('/src/store/project.ts');
  S.actions.editCardProject((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === a || c.id === b ? { ...c, params: { ...c.params, text } } : c)) })) }));
}, a, b, text);
async function pressUndo(page, redo = false) {
  await P(page, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.down('Control');
  if (redo) await page.keyboard.down('Shift');
  await page.keyboard.press('KeyZ');
  if (redo) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
}
const settle = async (...pages) => {
  for (const p of pages) {
    await waitFor(() => P(p, () => window.__pcSyncTest.view().status === 'online'), 15_000, '回到 online').catch(async (e) => {
      throw new Error(`${e.message}:${JSON.stringify(await P(p, () => ({ status: window.__pcSyncTest.view().status, url: location.search })))}`);
    });
  }
  await sleep(600);
};
/** 按文字点按钮(在 selector 范围里) */
async function clickText(page, text, scope = 'body') {
  if (process.env.PROBE_TRACE) console.error('[step] click', text);
  const ok = await P(page, (text, scope) => {
    const root = document.querySelector(scope) ?? document.body;
    const el = [...root.querySelectorAll('button, [role=menuitem]')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim().includes(text) && !b.disabled);
    if (!el) return false;
    el.click();
    return true;
  }, text, scope);
  if (!ok) throw new Error(`找不到按钮「${text}」`);
  await sleep(250);
}
async function typeInto(page, selector, text) {
  if (process.env.PROBE_TRACE) console.error('[step] type', selector);
  await page.click(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await page.type(selector, text);
}
async function openProjectMenu(page) {
  for (let i = 0; i < 3; i++) {
    await closeAiSetup(page);
    await page.click('.pc-proj-btn');
    await sleep(300);
    if (await P(page, () => !!document.querySelector('.pc-proj-menu'))) return;
  }
  throw new Error('项目菜单没打开');
}

/* ======================================================================== local */

async function phaseLocal() {
  const A = await openEditor();
  const docId = await P(A, () => window.__pcSyncTest.docProjectId());
  const B = await openEditor(`&join=${encodeURIComponent(docId)}`);
  check('join-page-gets-docservice-content', (await pageDigest(A)).sha256 === (await pageDigest(B)).sha256, { docId });

  // ---------- V2 真实页面版:两页交错各 100 次(拖动 / 改参数)
  const run = (page, seed, n) => P(page, async (seed, n) => {
    const S = await import('/src/store/project.ts');
    let x = seed >>> 0;
    const rnd = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    let edits = 0;
    for (let i = 0; i < n; i++) {
      const clips = S.getState().project.tracks.flatMap((t) => t.clips);
      const c = clips[Math.floor(rnd() * clips.length)];
      if (rnd() < 0.5) {
        const dt = (rnd() - 0.5) * 0.6;
        S.actions.moveClip(c.id, { start: Math.max(0, c.start + dt), end: Math.max(0.1, c.end + dt) });
      } else S.actions.setClipParams(c.id, { v2: `s${seed}-${i}` });
      edits++;
      await new Promise((r) => setTimeout(r, 3 + Math.floor(rnd() * 25)));
    }
    return edits;
  }, seed, n);
  const [ea, eb] = await Promise.all([run(A, 101, 100), run(B, 202, 100)]);
  await settle(A, B);
  const [da, db, ds] = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('V2-page-real', da.sha256 === db.sha256 && db.sha256 === ds.sha256 && da.rev === ds.rev && db.rev === ds.rev, { edits: [ea, eb], a: da, b: db, doc: { rev: ds.rev, sha256: ds.sha256 } });
  await shot(A, 'v2-page-a');
  await shot(B, 'v2-page-b');

  const ids = await clipIds(A);
  const [c1, c2, c3, c4, c5, c6, c7, c8] = ids;

  // ---------- 撤销:部分没撤(A 一步改片段 1、2;B 随后改片段 2;A 撤销)
  await setTwo(A, c1, c2, 'A改');
  await settle(A, B);
  const beforeC1 = (await docState(docId)).project.tracks.flatMap((t) => t.clips).find((c) => c.id === c1);
  await setParam(B, c2, { text: 'B改' });
  await settle(A, B);
  await pressUndo(A);
  await sleep(500);
  const notice = await P(A, () => document.querySelector('[data-pc=undo-notice]')?.innerText ?? null);
  const a1 = await clipOf(A, c1);
  const a2 = await clipOf(A, c2);
  check('undo-partial-notice', !!notice && notice.includes('撤销了，但这几处被后续的新修改覆盖，未做退回：') && a2.params.text === 'B改' && a1.params.text !== 'A改', { notice, c1: a1.params.text, c2: a2.params.text, c1WasBefore: beforeC1?.params?.text });
  await shot(A, 'undo-partial-notice');
  // 点实体名跳过去并选中
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-entity')?.click());
  await sleep(300);
  const sel = await P(A, async () => (await import('/src/store/project.ts')).getState().selection);
  check('undo-notice-jump-selects', sel[0] === c2, { selection: sel });
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-bar-close')?.click());

  // ---------- 撤销:全部没撤
  await settle(A, B);
  await setParam(A, c3, { text: 'A3' });
  await settle(A, B);
  await setParam(B, c3, { text: 'B3' });
  await settle(A, B);
  await pressUndo(A);
  await sleep(500);
  const none = await P(A, () => document.querySelector('[data-pc=undo-notice]')?.innerText ?? null);
  check('undo-none-notice', !!none && none.includes('没撤成。这几处后来都被改过了，保留了现在的样子：') && none.includes('查看被修改处的现状'), { notice: none, c3: (await clipOf(A, c3)).params.text });
  await shot(A, 'undo-none-notice');
  await P(A, () => document.querySelector('[data-pc=undo-notice] .pc-undo-bar-close')?.click());

  // ---------- 按钮禁用态与悬停提示
  const btn = await P(A, () => ({
    undoTitle: document.querySelector('[data-pc=undo-btn]')?.getAttribute('title'),
    redoTitle: document.querySelector('[data-pc=redo-btn]')?.getAttribute('title'),
    undoDisabled: document.querySelector('[data-pc=undo-btn] button')?.disabled,
    redoDisabled: document.querySelector('[data-pc=redo-btn] button')?.disabled,
  }));
  check('undo-buttons', btn.undoTitle === '撤销 (Ctrl+Z) —— 只撤你自己在这个页面做的' && btn.redoTitle === '重做 (Ctrl+Shift+Z / Ctrl+Y) —— 恢复刚撤销的操作（有新操作后即失效）', btn);
  const fresh = await openEditor(`&join=${encodeURIComponent(docId)}`);
  const freshBtn = await P(fresh, () => ({ undo: document.querySelector('[data-pc=undo-btn] button')?.disabled, redo: document.querySelector('[data-pc=redo-btn] button')?.disabled }));
  check('undo-buttons-disabled-when-empty', freshBtn.undo === true && freshBtn.redo === true, freshBtn);
  await fresh.close();

  // Ctrl+Y 重做
  await setParam(A, c4, { text: 'A4' });
  await settle(A, B);
  await pressUndo(A);
  await settle(A, B);
  const afterUndo = (await clipOf(A, c4)).params.text;
  await P(A, () => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await A.keyboard.down('Control');
  await A.keyboard.press('KeyY');
  await A.keyboard.up('Control');
  await settle(A, B);
  check('ctrl-y-redo', afterUndo !== 'A4' && (await clipOf(A, c4)).params.text === 'A4', { afterUndo });

  // ---------- 别人的改动:时间轴描边 1.5 s
  await A.bringToFront();
  await setParam(B, c4, { text: 'B 改了这里' });
  await sleep(300);
  const flashed = await P(A, (id) => !!document.querySelector(`[data-clip-id="${id}"][data-remote-flash]`), c4);
  await A.screenshot({ path: path.join(outDir, 'remote-flash.png') });
  await sleep(1700);
  const gone = await P(A, (id) => !document.querySelector(`[data-clip-id="${id}"][data-remote-flash]`), c4);
  check('remote-flash-1.5s', flashed && gone, { flashed, goneAfter: gone });

  // ---------- 被覆盖:A 改了片段 6,B 随后改同一片段 → A 先存本地备份,出气泡
  await setParam(A, c6, { text: 'A6' });
  await settle(A, B);
  await setParam(B, c6, { text: 'B6' });
  await settle(A, B);
  const toast = await waitFor(() => P(A, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('覆盖')) ?? null), 5000, '覆盖气泡').catch(() => null);
  check('overwritten-toast', !!toast && toast.startsWith('你的近期修改已被 你在另一个页面 覆盖。'), { toast });
  await shot(A, 'overwritten-toast');

  // ---------- 离线:A 断网期间改 3 次,B 期间也改;A 回来 → 第一条被拒 → 冲突合并窗口
  // 2026-10-22 起整份「加进去 / 不要了」的离线对话框换成逐项的「冲突合并」(conflict-merge 报告第十节):
  // 「不要了」= 全勾 → 删除选中;「加进去」= 全勾 → 合并;关窗(下次再说)后顶栏是「冲突合并」按钮(原「同步已暂停」)
  const offline = async (value) => {
    await P(A, () => window.__pcSyncTest.drop(4000));
    await waitFor(() => P(A, () => window.__pcSyncTest.view().status === 'offline'), 5000, 'A 离线');
    for (let i = 0; i < 3; i++) await setParam(A, c5, { text: `${value}${i}` });
    await setParam(B, c7, { text: `B7-${value}` });
    await setParam(B, c5, { text: `B5-${value}` });
    await sleep(300);
    const chip = await P(A, () => document.querySelector('[data-pc=sync-offline]')?.innerText ?? null);
    await waitFor(() => P(A, () => !!document.querySelector('[data-pc=conflict-merge]')), 15_000, 'A 的冲突合并窗口');
    await sleep(300);
    const dlg = await P(A, () => document.querySelector('[data-pc=conflict-merge]')?.innerText ?? null);
    const row = await P(A, (id) => document.querySelector(`[data-pc=merge-thing][data-key="offline:clip:${id}"]`)?.innerText ?? null, c5);
    return { chip, dlg, row };
  };
  const mergeAll = async (button) => {
    await P(A, () => { for (const i of document.querySelectorAll('[data-pc=merge-thing-check]')) if (!i.checked) i.click(); });
    await P(A, (b) => document.querySelector(`[data-pc="${b}"]`)?.click(), button);
    await waitFor(() => P(A, () => document.querySelector('[data-pc=merge-close]')?.textContent?.trim() === '完成'), 5000, '列表清空');
    await P(A, () => document.querySelector('[data-pc=merge-close]')?.click());
  };
  const off1 = await offline('离线');
  check('conflict-merge-window', !!off1.dlg && off1.dlg.includes('冲突合并') && !!off1.row && off1.row.includes('「离线2」') && off1.row.includes('云端现在是 「B5-离线」') && off1.chip === '离线', off1);
  await shot(A, 'conflict-merge-window');
  await P(A, () => document.querySelector('[data-pc=merge-close]')?.click());
  await sleep(300);
  const navChip = await P(A, () => document.querySelector('[data-pc=conflict-merge-open]')?.innerText ?? null);
  check('merge-button-after-close', !!navChip && navChip.includes('冲突合并'), { navChip });
  await shot(A, 'conflict-merge-button');
  await P(A, () => document.querySelector('[data-pc=conflict-merge-open]')?.click());
  await sleep(300);
  check('merge-button-reopens-window', await P(A, () => !!document.querySelector('[data-pc=conflict-merge]')));
  await mergeAll('merge-delete');
  await settle(A, B);
  const afterDiscard = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('offline-discard', afterDiscard[0].sha256 === afterDiscard[2].sha256 && afterDiscard[1].sha256 === afterDiscard[2].sha256 && (await clipOf(A, c5)).params.text === 'B5-离线', { c5: (await clipOf(A, c5)).params.text });

  const off2 = await offline('重放');
  check('conflict-merge-window-2', !!off2.dlg);
  await mergeAll('merge-apply');
  await settle(A, B);
  const afterReplay = [await pageDigest(A), await pageDigest(B), await docState(docId)];
  check('offline-replay', afterReplay[0].sha256 === afterReplay[2].sha256 && afterReplay[1].sha256 === afterReplay[2].sha256 && (await clipOf(A, c5)).params.text === '重放2' && (await clipOf(A, c7)).params.text === 'B7-重放', { c5: (await clipOf(A, c5)).params.text, c7: (await clipOf(A, c7)).params.text });

  // ---------- 本地备份列表(丢弃前的那批 + 被覆盖的那一版);恢复 = 一次新写入
  await openProjectMenu(A);
  await clickText(A, '本地备份…', '.pc-proj-menu');
  await waitFor(() => P(A, () => document.querySelectorAll('[data-pc=backup-row]').length > 0), 5000, '备份列表');
  const rows = await P(A, () => [...document.querySelectorAll('[data-pc=backup-row]')].map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('backups-list', rows.some((r) => r.includes('离线时丢弃')) && rows.some((r) => r.includes('覆盖')), { rows: rows.slice(0, 6) });
  await shot(A, 'backups-dialog');
  // 恢复被覆盖的那一版(片段 6 回到 A6)
  const revBefore = (await docState(docId)).rev;
  await P(A, (c6) => {
    const row = [...document.querySelectorAll('[data-pc=backup-row]')].find((r) => r.dataset.entity?.endsWith(`/@${c6}`) && r.innerText.includes('被 你在另一个页面 覆盖'));
    row?.querySelector('button')?.click();
  }, c6);
  await settle(A, B);
  const d6 = await docState(docId);
  check('backup-restore-is-new-write', d6.project.tracks.flatMap((t) => t.clips).find((c) => c.id === c6)?.params.text === 'A6' && d6.rev > revBefore && (await clipOf(B, c6)).params.text === 'A6', { revBefore, revAfter: d6.rev });
  await clickText(A, '关闭', '[data-pc=backups-dialog]');

  // ---------- AI 栏「撤销这一步」:Agent 的提交(一条回环连接模拟) + 注入带 opId 的完成事件
  const agentOp = (ops) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/docservice`, ['promptcut.v1']);
    const opId = `agent-op-${Date.now()}`;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'project.open', projectId: docId }));
      ws.send(JSON.stringify({ type: 'project.op', projectId: docId, opId, session: 'agent-conv-1', ops }));
    });
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.op.ok' && m.opId === opId) { resolve({ opId, rev: m.rev }); ws.close(); }
      if (m.type === 'project.op.rejected' && m.opId === opId) { reject(new Error(JSON.stringify(m))); ws.close(); }
    });
  });
  const path8 = (await docState(docId)).project.tracks.map((t, ti) => ({ t, ti })).find(({ t }) => t.clips.some((c) => c.id === c8));
  const before8 = (await clipOf(A, c8)).params.text ?? null;
  const { opId: agentOpId, rev: agentRev } = await agentOp([{ op: 'set', path: `/tracks/@${path8.t.id}/clips/@${c8}/params/text`, value: 'Agent 改的' }]);
  await settle(A, B);
  await P(A, (opId, rev) => window.__pcSyncTest.inject({ type: 'events.event', phase: 'complete', eventId: 'ev-probe-1', callId: 'call-probe-1', opId, rev, status: 'ok' }), agentOpId, agentRev);
  const reverted = await P(A, async () => {
    const m = await import('/src/editor/sync/syncManager.ts');
    const rec = m.agentOpFor('call-probe-1');
    const r = rec ? m.revertAgentOp(rec) : null;
    return { found: !!rec, done: r?.done ?? null, state: m.agentOpFor('call-probe-1')?.state ?? null };
  });
  await settle(A, B);
  const d8 = await docState(docId);
  const log8 = d8.project.tracks.flatMap((t) => t.clips).find((c) => c.id === c8).params.text ?? null;
  const canUndo = await P(A, async () => (await import('/src/store/project.ts')).actions.canUndo());
  check('agent-undo-step', reverted.found && reverted.done && reverted.state === 'done' && log8 === before8 && canUndo, { reverted, before8, now: log8 });
  // 进了用户自己的撤销栈:Ctrl+Z 把 Agent 的改动恢复回来
  await pressUndo(A);
  await settle(A, B);
  check('agent-undo-in-user-stack', (await clipOf(B, c8)).params.text === 'Agent 改的');

  await B.close();
  return { A, docId };
}

/* ======================================================================== shared */

async function setHosted(page) {
  await P(page, (u) => localStorage.setItem('pc.shared.hostedUrl', u), hosted);
}

async function phaseShared() {
  const A = await openEditor();
  const B = await openEditor();
  await setHosted(A);
  await setHosted(B);
  const name = `c65-demo-${Date.now().toString(36)}`;

  // ---------- 新建共享项目:先看限定进入的名单表,再以自由进入建成
  await openProjectMenu(A);
  await clickText(A, '新建共享项目', '.pc-proj-menu');
  await typeInto(A, '#pc-ns-name', name);
  await typeInto(A, '#pc-ns-creator', 'alice');
  await typeInto(A, '#pc-ns-cpw', 'alice-pw');
  await clickText(A, '限定进入', '[data-pc=new-shared-dialog]');
  await A.type('[data-pc=list-editor] .pc-sync-list-row:last-child input:nth-child(1)', 'render-host');
  await A.type('[data-pc=list-editor] .pc-sync-list-row:last-child input:nth-child(2)', 'rh-pw');
  await clickText(A, '添加', '[data-pc=list-editor]');
  await P(A, () => document.querySelector('[data-pc=new-shared-dialog]')?.scrollTo(0, 9999));
  await shot(A, 'new-shared-restricted');
  await clickText(A, '局域网模式', '[data-pc=new-shared-dialog]');
  await sleep(200);
  const lanHint = await P(A, () => document.querySelector('[data-pc=lan-restart-hint]')?.innerText ?? null);
  check('lan-needs-restart-hint', !!lanHint && lanHint.includes('PROMPTCUT_LAN_HOST=1'), { lanHint });
  await shot(A, 'new-shared-lan-restart');
  await clickText(A, '互联网模式', '[data-pc=new-shared-dialog]');
  await clickText(A, '自由进入', '[data-pc=new-shared-dialog]');
  await typeInto(A, '#pc-ns-ppw', 'team-pw');
  await P(A, () => document.querySelector('[data-pc=new-shared-dialog]')?.scrollTo(0, 0));
  await shot(A, 'new-shared-dialog');
  await clickText(A, '创建', '[data-pc=new-shared-dialog] .pc-dialog-foot');
  const created = await waitFor(() => P(A, () => document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line')?.innerText.includes('创建成功') ? document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line').innerText : null), 20_000, '创建成功').catch(() => null);
  const aView = await P(A, () => { const v = window.__pcSyncTest.view(); return { kind: v.kind, shared: v.shared, status: v.status }; });
  check('new-shared-hosted', created === '创建成功，已进入项目。' && aView.kind === 'shared', { created, aView });
  await shot(A, 'new-shared-done');
  await clickText(A, '返回', '[data-pc=new-shared-dialog]');
  const sharedId = aView.shared?.projectId;

  // ---------- 打开共享项目(B):查找 → 验证 → 进入
  await openProjectMenu(B);
  await clickText(B, '打开共享项目', '.pc-proj-menu');
  await B.type('#pc-os-name', name);
  await clickText(B, '托管地址', '[data-pc=open-shared-dialog]');
  await shot(B, 'open-shared-find');
  await clickText(B, '查找', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  await waitFor(() => P(B, () => !!document.querySelector('#pc-os-user')), 15_000, '进入验证步');
  await shot(B, 'open-shared-verify');
  await typeInto(B, '#pc-os-pw', 'wrong-pw');
  await typeInto(B, '#pc-os-user', 'bob');
  await clickText(B, '进入', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  const wrong = await waitFor(() => P(B, () => document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText ?? null), 15_000, '密码错提示').catch(() => null);
  check('open-shared-wrong-password', wrong === '用户名或密码不对。忘了的话找创建者问一下。', { wrong });
  await typeInto(B, '#pc-os-pw', 'team-pw');
  await clickText(B, '进入', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  await waitFor(() => P(B, () => window.__pcSyncTest.view().kind === 'shared'), 15_000, 'B 进入共享项目').catch(async (e) => {
    throw new Error(`${e.message}:${JSON.stringify(await P(B, () => ({ line: document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText, pw: document.querySelector('#pc-os-pw')?.value, user: document.querySelector('#pc-os-user')?.value })))}`);
  });
  await settle(A, B);
  check('open-shared-enter', (await pageDigest(A)).sha256 === (await pageDigest(B)).sha256, { a: await pageDigest(A), b: await pageDigest(B) });

  // ---------- 成员列表:同名不同设备、Agent 对话
  const device = await P(B, () => window.__pcSyncTest.view().device);
  const wsBase = hosted.replace(/^http/, 'ws');
  const extra = [];
  const conn = async (o) => {
    const protocols = await buildAuthProtocols({ base: hosted, projectId: sharedId, deviceName: o.deviceName ?? device.deviceName, ...o });
    const ws = new WebSocket(wsBase, protocols);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    extra.push(ws);
    return ws;
  };
  await conn({ username: 'bob', deviceId: device.deviceId, password: 'team-pw', role: 'agent', conversation: 2 });
  await conn({ username: 'bob', deviceId: 'pc-macbook-probe-0001', deviceName: 'MacBook', password: 'team-pw', role: 'page' });
  await sleep(800);
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.includes('Agent'));
    row?.click();
  });
  await sleep(200);
  const pop = await P(A, () => document.querySelector('[data-pc=members-pop]')?.innerText ?? '');
  check('members-list', pop.includes('alice (自己)') && pop.includes('[创建者]') && pop.includes('[编辑中]') && pop.includes('[Agent ×1]') && pop.includes('bob (MacBook)') && pop.includes('bob · Agent · 第 2 个对话') && pop.includes('项目管理（仅创建者可见）'), { pop });
  await shot(A, 'members-list');
  const btnText = await P(A, () => document.querySelector('[data-pc=members-button]')?.innerText ?? '');
  check('members-button-badge', /成员[:：] ?\d+ 人/.test(btnText), { btnText });

  // ---------- 创建者操作:改项目密码(验证 → 改),成员收到气泡
  await clickText(A, '改项目密码', '[data-pc=members-pop]');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, '验证弹窗');
  await typeInto(A, '#pc-cv-pw', 'wrong');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  const verr = await waitFor(() => P(A, () => document.querySelector('[data-pc=creator-verify] .pc-sync-err')?.innerText ?? null), 8000, '密码错误').catch(() => null);
  check('creator-verify-wrong', verr === '密码错误。', { verr });
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await shot(A, 'creator-verify');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=project-password]')), 8000, '改密码弹窗');
  await typeInto(A, '#pc-pw-a', 'team-pw-2');
  await typeInto(A, '#pc-pw-b', 'team-pw-2');
  await shot(A, 'creator-change-password');
  await clickText(A, '确认修改', '[data-pc=project-password]');
  const pwToast = await waitFor(() => P(B, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('项目密码已被修改')) ?? null), 8000, '密码被改气泡').catch(() => null);
  check('member-password-changed-toast', pwToast?.startsWith('项目密码已被修改。你当前的连接不受影响，但下次进入需要新密码。'), { pwToast });
  await shot(B, 'member-password-changed-toast');

  // ---------- 踢人(踢 MacBook 上的 bob):验证 → 确认
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.includes('bob (MacBook)'));
    row?.querySelector('.pc-members-kick')?.click();
  });
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, '验证弹窗');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=kick-dialog]')), 8000, '踢人确认');
  const kickText = await P(A, () => document.querySelector('[data-pc=kick-dialog]')?.innerText ?? '');
  check('kick-confirm-text', kickText.includes('确定要把 bob (MacBook) 踢出项目吗？'), { kickText });
  await shot(A, 'creator-kick-confirm');
  await clickText(A, '踢出', '[data-pc=kick-dialog] .pc-dialog-foot');
  const kickToast = await waitFor(() => P(A, () => [...document.querySelectorAll('.pc-toast')].map((t) => t.innerText).find((t) => t.includes('已踢出')) ?? null), 8000, '踢人气泡').catch(() => null);
  check('kick-free-mode-hint', kickToast?.startsWith('已踢出。自由进入模式下，想彻底挡住，要改项目密码。'), { kickToast });

  // ---------- 已禁入的设备
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, '已禁入的设备', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=bans-dialog]')), 8000, '禁入列表');
  const bans = await P(A, () => document.querySelector('[data-pc=bans-dialog]')?.innerText ?? '');
  check('bans-list', bans.includes('pc-macbook-probe-0001') && bans.includes('撤销'), { bans });
  await shot(A, 'creator-bans');
  await clickText(A, '返回', '[data-pc=bans-dialog]');

  // ---------- 删项目对话框(手打项目名)
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, '删除项目', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=delete-dialog]')), 8000, '删项目弹窗');
  const delDisabled = await P(A, () => [...document.querySelectorAll('[data-pc=delete-dialog] button')].find((b) => b.textContent.includes('永久删除项目'))?.disabled);
  await A.type('[data-pc=delete-dialog] input', name);
  const delEnabled = await P(A, () => !([...document.querySelectorAll('[data-pc=delete-dialog] button')].find((b) => b.textContent.includes('永久删除项目'))?.disabled));
  check('delete-needs-typed-name', delDisabled === true && delEnabled === true);
  await shot(A, 'creator-delete');
  await clickText(A, '取消', '[data-pc=delete-dialog] .pc-dialog-foot');

  // ---------- 踢 B:B 看到阻断弹窗
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await P(A, () => {
    const row = [...document.querySelectorAll('.pc-members-row-main')].find((r) => r.innerText.startsWith('bob') && !r.innerText.includes('MacBook'));
    row?.querySelector('.pc-members-kick')?.click();
  });
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=creator-verify]')), 5000, '验证弹窗');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=kick-dialog]')), 8000, '踢人确认');
  await clickText(A, '踢出', '[data-pc=kick-dialog] .pc-dialog-foot');
  const blocked = await waitFor(() => P(B, () => document.querySelector('[data-pc=blocked-dialog]')?.innerText ?? null), 8000, 'B 的阻断弹窗').catch(() => null);
  check('kicked-blocking-dialog', blocked?.includes('你已被创建者踢出该项目，无法继续编辑。想回来，找创建者撤销。') && blocked.includes('开始页'), { blocked });
  await shot(B, 'blocked-kicked');

  // 收尾:真的删掉(验证删除流程与自己回开始页)
  await A.click('[data-pc=members-button]');
  await sleep(300);
  await clickText(A, '删除项目', '[data-pc=members-pop]');
  await typeInto(A, '#pc-cv-pw', 'alice-pw');
  await clickText(A, '验证', '[data-pc=creator-verify] .pc-dialog-foot');
  await waitFor(() => P(A, () => !!document.querySelector('[data-pc=delete-dialog]')), 8000, '删项目弹窗');
  await A.type('[data-pc=delete-dialog] input', name);
  await clickText(A, '永久删除项目', '[data-pc=delete-dialog] .pc-dialog-foot');
  const gone = await waitFor(async () => (await fetch(`${hosted}/shared/lookup?name=${encodeURIComponent(name)}`)).status === 404, 8000, '项目删掉').catch(() => false);
  const aAfter = await P(A, () => window.__pcSyncTest.view().kind);
  check('delete-project', gone && aAfter === 'local', { aAfter });
  for (const ws of extra) ws.close();
  await A.close();
  await B.close();
}

/* ======================================================================== lan */

async function phaseLan() {
  const C = await openEditor();
  await setHosted(C);
  const lan = await P(C, () => window.__pcSyncTest.view().device);
  if (!check('lan-host-editor', lan?.lanHost === true, { device: lan })) return;
  const name = `c65-lan-${Date.now().toString(36)}`;
  // 同名的托管项目(直接经托管端建)
  await createSharedProject({ where: 'hosted', hostedUrl: hosted, name, mode: 'free', creator: { username: 'zed', password: 'zed-pw' }, password: 'x-pw', kdf: { alg: 'pbkdf2-sha256', iter: 100000 } });
  // 局域网模式新建(本机当主机)
  await openProjectMenu(C);
  await clickText(C, '新建共享项目', '.pc-proj-menu');
  await typeInto(C, '#pc-ns-name', name);
  await typeInto(C, '#pc-ns-creator', 'carol');
  await typeInto(C, '#pc-ns-cpw', 'carol-pw');
  await clickText(C, '局域网模式', '[data-pc=new-shared-dialog]');
  await typeInto(C, '#pc-ns-ppw', 'lan-pw');
  await shot(C, 'new-shared-lan');
  await clickText(C, '创建', '[data-pc=new-shared-dialog] .pc-dialog-foot');
  const created = await waitFor(() => P(C, () => { const t = document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line')?.innerText; return t?.includes('创建成功') ? t : null; }), 20_000, '局域网建成').catch(() => null);
  check('new-shared-lan', created === '创建成功。让成员在同一个网段下查项目名就能进。记住本机要保持开着。', { created });
  await clickText(C, '返回', '[data-pc=new-shared-dialog]');
  await sleep(1500);
  // 另一个页面查找:局域网(本机主机经组播应答)+ 托管端各一个 → 并列
  const D = await openEditor();
  await setHosted(D);
  await openProjectMenu(D);
  await clickText(D, '打开共享项目', '.pc-proj-menu');
  await D.type('#pc-os-name', name);
  await clickText(D, '查找', '[data-pc=open-shared-dialog] .pc-dialog-foot');
  const cands = await waitFor(() => P(D, () => { const el = document.querySelector('[data-pc=shared-candidates]'); return el ? el.innerText : null; }), 15_000, '并列候选').catch(() => null);
  check('open-shared-two-candidates', !!cands && cands.includes('[互联网模式] 托管在阿里云') && cands.includes('[局域网模式] 主机：'), { cands, title: await P(D, () => document.querySelector('[data-pc=open-shared-dialog] .pc-dialog-body')?.innerText.split('\n')[0]) });
  await shot(D, 'open-shared-choose');
  await C.close();
  await D.close();
}

/* ======================================================================== U2 跨机 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const say = (step, fields = {}) => console.log(JSON.stringify({ step, t: Date.now(), ...fields }));

/** worktree 没有自己的 node_modules(往上解析到主仓库那一份):按模块解析 vite,再回到包根找 bin */
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editorProc = null;
const editorLog = [];
/** 在仓库根起一个编辑器;`lan` 时以局域网主机身份(PROMPTCUT_LAN_HOST=1,编辑器自己改绑 0.0.0.0) */
async function spawnEditor(port, { lan }) {
  const env = { ...process.env, PROMPTCUT_PUSH: '0' };
  if (lan) env.PROMPTCUT_LAN_HOST = '1';
  else delete env.PROMPTCUT_LAN_HOST;
  const id = arg('--device-id', null);
  const nm = arg('--device-name', null);
  if (id) env.PROMPTCUT_DEVICE_ID = id;
  if (nm) env.PROMPTCUT_DEVICE_NAME = nm;
  editorProc = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 300) editorLog.shift(); };
  editorProc.stdout.on('data', keep);
  editorProc.stderr.on('data', keep);
  origin = `http://127.0.0.1:${port}`;
  say('editor.spawn', { pid: editorProc.pid, origin, lan: !!lan });
  await waitFor(async () => {
    if (editorProc.exitCode !== null) throw new Error(`编辑器进程退出了(${editorProc.exitCode}):${editorLog.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, '编辑器起来');
}
async function stopEditor() {
  if (!editorProc || editorProc.exitCode !== null || !editorProc.pid) return;
  const exited = new Promise((r) => editorProc.once('exit', r));
  // 编辑器还拉着预渲染进程和 Chrome:连进程树一起结束(只结束自己起的这一棵)
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editorProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editorProc.kill('SIGKILL');
  await Promise.race([exited, sleep(10_000)]);
  say('editor.stopped', { pid: editorProc.pid });
}

/** 探针另开一条凭证连接,直接向主机(托管端)读项目:{ rev, sha256 } */
async function hostRead(base, projectId, cred, tag) {
  const protocols = await buildAuthProtocols({
    base, projectId, username: cred.username, as: cred.as, password: cred.password, role: 'page',
    deviceId: `u2-reader-${tag}`.padEnd(16, '0').slice(0, 64), deviceName: 'u2-probe-reader',
  });
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBaseOf(base), protocols);
    const parts = [];
    const timer = setTimeout(() => { reject(new Error('主机 project.open 超时')); ws.close(); }, 10_000);
    const done = (project, rev) => {
      clearTimeout(timer);
      resolve({ rev, sha256: createHash('sha256').update(JSON.stringify(project)).digest('hex') });
      ws.close();
    };
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'project.open', projectId })));
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'project.state' && m.project) done(m.project, m.rev);
      else if (m.type === 'project.state.part') parts[m.index] = m.data;
      else if (m.type === 'project.state.end') done(JSON.parse(parts.join('')), m.rev);
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`连不上主机 ${wsBaseOf(base)}`)); });
  });
}

/** 在同一次 evaluate 里改片段参数并等文档服务确认(DocSync.whenSettled);回从改到确认的毫秒(页面时钟) */
const editAndSave = (page, id, params) => P(page, async (id, params) => {
  const S = await import('/src/store/project.ts');
  const M = await import('/src/editor/sync/syncManager.ts');
  const t0 = performance.now();
  S.actions.setClipParams(id, params);
  await M.whenSaved(10_000);
  return Math.round((performance.now() - t0) * 10) / 10;
}, id, params);

/**
 * 盯着页面 store:哪个片段的 params.text 变成 value。回 { at(本机时刻), clipId, flash(时间轴上有「别人的改动」描边) }。
 * 立即开始盯(不等报告),所以对方的改动先于协调口的报告到达也记得到。
 */
function watchFor(page, value, ms, shotName) {
  return (async () => {
    const hit = await waitFor(() => P(page, async (value) => {
      const S = await import('/src/store/project.ts');
      const c = S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.params?.text === value);
      if (!c) return null;
      return { clipId: c.id, flash: !!document.querySelector(`[data-clip-id="${c.id}"][data-remote-flash]`) };
    }, value), ms, `页面出现 ${value}`);
    const at = Date.now();
    const file = await shot(page, shotName);
    return { at, ...hit, shot: file };
  })();
}

async function openSharedMenu(page, item) {
  await openProjectMenu(page);
  await clickText(page, item, '.pc-proj-menu');
}

async function runCreator(res, fails) {
  const mode = arg('--mode', null);
  if (mode !== 'lan' && mode !== 'hosted') throw new Error('--mode 要 lan 或 hosted');
  if (mode === 'hosted' && !argv.includes('--hosted')) throw new Error('托管模式要 --hosted <托管组合地址>');
  res.mode = mode;
  const runId = res.runId;
  const timeoutMs = Number(arg('--timeout', '900')) * 1000;

  // 协调口:自己起(跨机时 --coord-host 0.0.0.0),或用现成的
  let coordUrl = arg('--coord', null);
  const coordPort = arg('--coord-port', null);
  if (coordPort) {
    const server = await startCoordServer({ port: Number(coordPort), host: arg('--coord-host', '127.0.0.1') });
    res._coordServer = server;
    coordUrl = server.url;
    say('coord.listen', { port: server.port, host: arg('--coord-host', '127.0.0.1') });
  }
  if (!coordUrl) throw new Error('要 --coord-port <n>(本进程起协调口)或 --coord <url>');
  res.coord = coordUrl;
  const coord = coordClient(coordUrl);

  if (arg('--spawn-editor', null)) await spawnEditor(Number(arg('--spawn-editor')), { lan: mode === 'lan' });
  res.origin = origin;
  const A = await openEditor();
  const device = await P(A, () => window.__pcSyncTest.view().device);
  res.device = device;
  if (mode === 'lan' && !(device?.lanHost && device?.localEditor)) throw new Error(`局域网模式要编辑器以 PROMPTCUT_LAN_HOST=1 启动、页面从回环打开:${JSON.stringify(device)}`);
  if (mode === 'hosted') await P(A, (u) => localStorage.setItem('pc.shared.hostedUrl', u), hosted);

  // ---------- D11 界面「新建共享项目」(自由进入)
  const name = `u2-${runId}`;
  const creatorPw = `cpw-${randomBytes(6).toString('hex')}`;
  const projectPw = `ppw-${randomBytes(6).toString('hex')}`;
  res.name = name;
  await openSharedMenu(A, '新建共享项目');
  await typeInto(A, '#pc-ns-name', name);
  await typeInto(A, '#pc-ns-creator', 'alice');
  await typeInto(A, '#pc-ns-cpw', creatorPw);
  await clickText(A, mode === 'lan' ? '局域网模式' : '互联网模式', '[data-pc=new-shared-dialog]');
  await clickText(A, '自由进入', '[data-pc=new-shared-dialog]');
  await typeInto(A, '#pc-ns-ppw', projectPw);
  await clickText(A, '创建', '[data-pc=new-shared-dialog] .pc-dialog-foot');
  const created = await waitFor(() => P(A, () => {
    const t = document.querySelector('[data-pc=new-shared-dialog] .pc-sync-status-line')?.innerText;
    return t && !t.includes('正在创建') ? t : null;
  }), 30_000, '创建结果');
  const shared = await P(A, () => window.__pcSyncTest.view().shared);
  say('creator.created', { created, shared });
  if (!created.includes('创建成功') || !shared) throw new Error(`没建成:${created}`);
  res.projectId = shared.projectId;
  res.where = shared.where;
  await clickText(A, '返回', '[data-pc=new-shared-dialog]');
  await settle(A);

  const cred = { as: 'creator', username: 'alice', password: creatorPw };
  const page0 = await pageDigest(A);
  const host0 = await hostRead(shared.base, shared.projectId, cred, `creator-${runId}`);
  say('creator.state', { page: page0, host: host0 });
  if (page0.rev !== host0.rev || page0.sha256 !== host0.sha256) fails.push('creator-page-vs-host');
  res.rev = host0.rev;
  res.sha256 = host0.sha256;
  res.shots.push(await shot(A, 'creator-1-created'));

  const hostedPublic = mode === 'hosted' ? arg('--hosted-public', hosted) : null;
  const memberToken = `u2-member-${runId}`;
  const creatorToken = `u2-creator-${runId}`;
  await coord.put('u2-join', { runId, name, mode, username: 'bob', projectPassword: projectPw, hosted: hostedPublic, rev: host0.rev, sha256: host0.sha256, hostDeviceName: device.deviceName });
  say('creator.join-posted', { coord: coordUrl });

  // ---------- 成员进入
  const entered = await coord.take('u2-entered', Date.now() + timeoutMs);
  if (!entered) throw new Error('等成员进入超时');
  say('creator.member-entered', entered);
  res.member = { entered };
  if (!entered.ok) fails.push('member-enter');

  // ---------- 成员改一处 → 本页面 5 s 内看到
  const seenMember = watchFor(A, memberToken, 120_000, 'creator-2-saw-member-edit');
  const tGo = Date.now();
  await coord.put('u2-go', { memberToken, creatorToken });
  const report = await coord.take('u2-member-edit', Date.now() + 120_000);
  const tReport = Date.now();
  if (!report) throw new Error('等成员「已提交」超时');
  const seen = await seenMember;
  res.memberEditSeenMs = Math.max(0, seen.at - tReport);
  res.memberEditSinceGoMs = seen.at - tGo;
  res.memberEdit = { clipId: report.clipId, value: report.value, memberCommitMs: report.commitMs, seenClipId: seen.clipId, flash: seen.flash };
  res.shots.push(seen.shot);
  say('creator.saw-member-edit', { memberEditSeenMs: res.memberEditSeenMs, memberEditSinceGoMs: res.memberEditSinceGoMs, ...res.memberEdit });
  // memberEditSeenMs 量的是改动从一边到另一边要多久（含协调口往返），语义里没有这条时间承诺：耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审改
  if (seen.clipId !== report.clipId) fails.push('member-edit-wrong-clip');

  // ---------- 本页面改一处,交成员核对
  const ids = await clipIds(A);
  const target = ids.find((id) => id !== report.clipId) ?? ids[0];
  const commitMs = await editAndSave(A, target, { text: creatorToken });
  await coord.put('u2-creator-edit', { clipId: target, key: 'text', value: creatorToken, commitMs });
  res.creatorEdit = { clipId: target, value: creatorToken, commitMs };
  say('creator.edit-committed', res.creatorEdit);

  const memberResult = await coord.take('u2-member-result', Date.now() + 120_000);
  if (!memberResult) throw new Error('等成员结果超时');
  res.member.result = memberResult;
  res.creatorEditSeenMs = memberResult.creatorEditSeenMs ?? null;
  if (!memberResult.ok) fails.push(`member:${(memberResult.fails ?? []).join('|')}`);

  // ---------- 最终三方一致:本页面、主机、成员页面
  await settle(A);
  const page1 = await pageDigest(A);
  const host1 = await hostRead(shared.base, shared.projectId, cred, `creator-${runId}`);
  res.final = { page: page1, host: host1, member: memberResult.final?.page ?? null };
  say('creator.final', res.final);
  if (page1.rev !== host1.rev || page1.sha256 !== host1.sha256) fails.push('final-creator-vs-host');
  if (memberResult.final?.page?.rev !== host1.rev || memberResult.final?.page?.sha256 !== host1.sha256) fails.push('final-member-vs-host');

  // ---------- 收尾:删掉这个共享项目
  if (!argv.includes('--keep')) {
    const del = await P(A, async (pw) => {
      const S = await import('/src/editor/sync/syncManager.ts');
      const r = await S.adminOp('delete', { password: pw });
      return r.ok ? { ok: true } : r;
    }, creatorPw);
    res.deleted = del.ok === true;
    say('creator.delete', del);
    if (!del.ok) fails.push('delete');
  }
  await A.close();
}

async function runMember(res, fails) {
  const coordUrl = arg('--coord', null);
  if (!coordUrl) throw new Error('member 要 --coord <url>');
  res.coord = coordUrl;
  const coord = coordClient(coordUrl);
  const timeoutMs = Number(arg('--timeout', '900')) * 1000;
  let result = null;
  try {
    if (arg('--spawn-editor', null)) await spawnEditor(Number(arg('--spawn-editor')), { lan: false });
    res.origin = origin;
    const B = await openEditor();
    res.device = await P(B, () => window.__pcSyncTest.view().device);
    say('member.editor', { origin, device: res.device });

    const join = await coord.take('u2-join', Date.now() + timeoutMs);
    if (!join) throw new Error('等创建者的进入信息超时');
    say('member.join', { ...join, projectPassword: '(有)' });
    res.mode = join.mode;
    res.name = join.name;
    // 查找时页面会同时查托管端:局域网模式缺省给一个连不上的回环地址,不碰真正的托管端
    const hostedUrl = argv.includes('--hosted') ? hosted : join.mode === 'hosted' ? join.hosted : 'http://127.0.0.1:9';
    res.hosted = hostedUrl;
    await P(B, (u) => localStorage.setItem('pc.shared.hostedUrl', u), hostedUrl);

    // ---------- D11 界面「打开共享项目」:查找 →(并列时挑对应模式)→ 验证 → 进入
    await openSharedMenu(B, '打开共享项目');
    await B.type('#pc-os-name', join.name);
    await clickText(B, '查找', '[data-pc=open-shared-dialog] .pc-dialog-foot');
    const found = await waitFor(() => P(B, () => {
      if (document.querySelector('#pc-os-user')) return 'verify';
      if (document.querySelector('[data-pc=shared-candidates]')) return 'choose';
      const line = document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText;
      return line && !line.includes('正在') ? `msg:${line}` : null;
    }), 20_000, '查找结果');
    say('member.found', { found });
    if (found.startsWith('msg:')) throw new Error(`查找失败:${found.slice(4)}`);
    if (found === 'choose') {
      const want = join.mode === 'lan' ? '[局域网模式]' : '[互联网模式]';
      await clickText(B, want, '[data-pc=shared-candidates]');
      await waitFor(() => P(B, () => !!document.querySelector('#pc-os-user')), 5000, '验证步');
    }
    const label = await P(B, () => document.querySelector('[data-pc=open-shared-dialog] .pc-dialog-body')?.innerText.split('\n')[0] ?? null);
    await typeInto(B, '#pc-os-pw', join.projectPassword);
    await typeInto(B, '#pc-os-user', join.username);
    const tEnter = Date.now();
    await clickText(B, '进入', '[data-pc=open-shared-dialog] .pc-dialog-foot');
    await waitFor(() => P(B, () => window.__pcSyncTest.view().kind === 'shared'), 20_000, '进入共享项目').catch(async (e) => {
      throw new Error(`${e.message}:${await P(B, () => document.querySelector('[data-pc=open-shared-dialog] .pc-sync-status-line')?.innerText ?? '')}`);
    });
    res.enterMs = Date.now() - tEnter;
    await settle(B);
    const shared = await P(B, () => window.__pcSyncTest.view().shared);
    res.projectId = shared.projectId;
    res.where = shared.where;
    res.base = shared.base;
    res.candidate = label;
    const cred = { as: 'member', username: join.username, password: join.projectPassword };
    const page0 = await pageDigest(B);
    const host0 = await hostRead(shared.base, shared.projectId, cred, `member-${join.runId}`);
    res.rev = page0.rev;
    res.entered = { page: page0, host: host0, creatorRev: join.rev, creatorSha256: join.sha256 };
    say('member.entered', { shared, ...res.entered, enterMs: res.enterMs });
    const revOk = page0.rev === host0.rev && page0.sha256 === host0.sha256 && host0.rev === join.rev && host0.sha256 === join.sha256;
    if (!revOk) fails.push('projectRev-mismatch');
    if (shared.where !== join.mode) fails.push(`entered-${shared.where}-not-${join.mode}`);
    res.shots.push(await shot(B, 'member-1-entered'));
    await coord.put('u2-entered', { ok: revOk && shared.where === join.mode, rev: page0.rev, sha256: page0.sha256, hostRev: host0.rev, where: shared.where, base: shared.base, candidate: label, enterMs: res.enterMs });

    // ---------- 改一处:第一个片段的 text 参数;文档服务确认后报「已提交」
    const go = await coord.take('u2-go', Date.now() + 120_000);
    if (!go) throw new Error('等创建者的「改」信号超时');
    const seenCreator = watchFor(B, go.creatorToken, 180_000, 'member-2-saw-creator-edit');
    const [clipId] = await clipIds(B);
    const commitMs = await editAndSave(B, clipId, { text: go.memberToken });
    await coord.put('u2-member-edit', { clipId, key: 'text', value: go.memberToken, commitMs });
    res.memberEdit = { clipId, value: go.memberToken, commitMs };
    say('member.edit-committed', res.memberEdit);

    // ---------- 等创建者那一处在本页出现
    const report = await coord.take('u2-creator-edit', Date.now() + 120_000);
    const tReport = Date.now();
    if (!report) throw new Error('等创建者「已提交」超时');
    const seen = await seenCreator;
    res.creatorEditSeenMs = Math.max(0, seen.at - tReport);
    res.creatorEdit = { clipId: report.clipId, value: report.value, creatorCommitMs: report.commitMs, seenClipId: seen.clipId, flash: seen.flash };
    res.shots.push(seen.shot);
    say('member.saw-creator-edit', { creatorEditSeenMs: res.creatorEditSeenMs, ...res.creatorEdit });
    // creatorEditSeenMs 同上，只记录不判（耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审改）
    if (seen.clipId !== report.clipId) fails.push('creator-edit-wrong-clip');

    await settle(B);
    const page1 = await pageDigest(B);
    const host1 = await hostRead(shared.base, shared.projectId, cred, `member-${join.runId}`);
    res.final = { page: page1, host: host1 };
    if (page1.rev !== host1.rev || page1.sha256 !== host1.sha256) fails.push('final-page-vs-host');
    result = { ok: fails.length === 0, fails: [...fails], rev: res.rev, creatorEditSeenMs: res.creatorEditSeenMs, memberEdit: res.memberEdit, final: res.final };
    await B.close();
  } finally {
    // 失败也告诉创建者,免得它干等
    try { await coord.put('u2-member-result', result ?? { ok: false, fails: [...fails, 'member-error'] }); } catch { /* 协调口已关 */ }
  }
}

async function runCross() {
  const res = { ok: false, role: ROLE, mode: null, runId: randomBytes(4).toString('hex'), origin: null, coord: null, name: null, projectId: null, rev: null, shots: [] };
  const fails = [];
  try {
    if (ROLE === 'creator') await runCreator(res, fails);
    else if (ROLE === 'member') await runMember(res, fails);
    else throw new Error('--role 要 creator 或 member');
  } catch (e) {
    const lines = String(e?.stack ?? e).split(/\r?\n/);
    fails.push(`error:${lines[0].slice(0, 300)}`);
    say('error', { at: lines.filter((l) => l.includes('c65-editor-probe')).map((l) => l.trim()).slice(0, 4) });
  } finally {
    await browser.close().catch(() => {});
    await stopEditor().catch(() => {});
    if (res._coordServer) { await res._coordServer.close(); delete res._coordServer; }
  }
  for (const s of shotsNotReady) fails.push(`shot-not-ready:${s.name}`);
  if (shotsNotReady.length) res.shotsNotReady = shotsNotReady;
  res.fails = fails;
  res.ok = fails.length === 0;
  console.log(JSON.stringify(res));
  process.exitCode = res.ok ? 0 : 1;
}

if (ROLE) await runCross();
else {
  try {
    if (phases.includes('local')) await phaseLocal();
    if (phases.includes('shared')) await phaseShared();
    if (phases.includes('lan')) await phaseLan();
  } catch (e) {
    const stack = String(e?.stack ?? e);
    const lines = stack.split(/\r?\n/);
    check('probe-error', false, { message: lines[0].slice(0, 300), at: lines.filter((l) => l.includes('c65-editor-probe')).map((l) => l.trim()).slice(0, 4) });
  } finally {
    await browser.close();
  }
  check('shots-editor-ready', shotsNotReady.length === 0, shotsNotReady.length ? { notReady: shotsNotReady } : {});
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { total: results.length, passed: results.length - failed.length, failed: failed.map((f) => f.check) } }));
  process.exitCode = failed.length ? 1 : 0;
}
