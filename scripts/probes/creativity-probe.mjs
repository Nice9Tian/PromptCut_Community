/**
 * 创造力等级界面探针(计划 agent-workflow-plan.md A1):
 *
 *   node scripts/probes/creativity-probe.mjs [--origin http://127.0.0.1:5760] [--shots <目录>]
 *
 * 真的打开编辑台(?editor),依次:
 *   P1 项目设置里有「创造力等级」,新项目缺省「高」;切到「低」→ 确定 → 项目文档里 creativity = 'low';
 *   P2 服务端按项目等级拦:不带对话 ID 的调用(= 桌面 APP 会话,跟项目)create_card 被拒,报错写明「低」「高」;
 *   P3 set_project_meta 写 creativity 被拒,项目等级不变;
 *   P4 AI 栏「⋯」运行选项里有「创造力」,缺省「跟项目(低)」;改成「中」→ 本机页签里存下 'medium';
 *   P5 发消息时请求体带上 creativity: 'medium' 与 projectCreativity: 'low'(拦下 fetch,不真的起模型);
 *   P6 对话覆盖优先:按这个对话 ID 登记「中」之后,项目仍是「低」,edit_card 过闸(卡不存在才报错)、create_card 仍被拒且写「中」。
 *
 * P6 的登记走真的 /api/ai/chat,provider 故意给一个不存在的名字:登记在起模型之前,起模型那一步直接报错,不花额度。
 * 截图(--shots 给了才存):settings-low.png(项目设置)、ai-creativity-follow.png / ai-creativity.png(运行选项弹层改前 / 改后)、ai-panel-full.png。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin, flagArg } from './probe-connect.mjs';

const origin = devOrigin();
const shots = flagArg('shots', null);
if (shots) fs.mkdirSync(shots, { recursive: true });
const fails = [];
const passes = [];
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mcpCall = async (tool, args, agent) => {
  const res = await fetch(`${origin}/api/mcp/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args, ...(agent ? { agent } : {}) }),
  });
  return res.json();
};

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('[data-pc="ai-run-options"]', { timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 60000, polling: 500 });
  // 从出厂状态开始:新项目
  await page.evaluate(async () => { const m = await import('/src/store/project.ts'); m.actions.newProject?.(); });
  await sleep(500);
  // 开场的卡片成本测量会盖一层遮罩(probe-gate),点击会落在它上面:等它撤掉
  await page.waitForFunction(() => !document.querySelector('[data-pc="probe-gate"]'), { timeout: 120000, polling: 500 }).catch(() => {});

  /* P1 项目设置 */
  await page.evaluate(() => window.dispatchEvent(new Event('pc-open-project-settings')));
  await page.waitForSelector('#pc-proj-creativity', { timeout: 10000 });
  const initial = await page.$eval('#pc-proj-creativity', (el) => el.value);
  check(initial === 'high', 'P1 the creativity level of a new project defaults to "High"', initial);
  const optionTexts = await page.$$eval('#pc-proj-creativity option', (os) => os.map((o) => o.textContent));
  check(optionTexts.length === 3 && optionTexts[0].startsWith('Low') && optionTexts[1].startsWith('Medium') && optionTexts[2].startsWith('High'), 'P1 three options Low / Medium / High', optionTexts);
  await page.select('#pc-proj-creativity', 'low');
  if (shots) await page.screenshot({ path: path.join(shots, 'settings-low.png') });
  await page.evaluate(() => { const b = [...document.querySelectorAll('.pc-dialog-foot .pc-btn--primary')].find((x) => x.textContent.includes('OK')); b?.click(); });
  await page.waitForFunction(() => !document.querySelector('#pc-proj-creativity'), { timeout: 10000 });
  const stored = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().project.creativity);
  check(stored === 'low', 'P1 after OK, creativity = low in the project document', stored);

  /* P2 服务端按项目等级拦(不带对话 ID = 桌面 APP 会话,跟项目);项目经页面镜像到服务端,等它一会儿 */
  let denied = null;
  for (let i = 0; i < 40; i += 1) {
    const r = await mcpCall('create_card', { id: 'cr-probe-new-card', source: '// probe' });
    const payload = r.result ?? r;
    if (payload?.creativity) { denied = payload; break; }
    await sleep(500);
  }
  check(!!denied && denied.creativity.current === 'low' && denied.creativity.required === 'high', 'P2 when the project is "Low", create_card is rejected (requires "High")', denied?.creativity);
  check(!!denied && /currently "Low"/.test(denied.error) && /requires "High"/.test(denied.error) && /project settings/.test(denied.error), 'P2 the error states the current level, the required level, and how to adjust it', denied?.error);

  /* P3 set_project_meta 写不进等级 */
  const meta = await mcpCall('set_project_meta', { creativity: 'high' });
  const metaPayload = meta.result ?? meta;
  check(metaPayload?.ok === false && /Unrecognized fields: creativity/.test(metaPayload.error ?? ''), 'P3 set_project_meta with creativity is rejected', metaPayload);
  const after = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().project.creativity);
  check(after === 'low', 'P3 the project level is still "Low"', after);

  /* P4 AI 栏运行选项 */
  await page.click('[data-pc="ai-run-options"]');
  await page.waitForSelector('[data-pc="ai-creativity"]', { visible: true, timeout: 5000 });
  const followText = await page.$eval('[data-pc="ai-creativity"]', (el) => el.options[el.selectedIndex].textContent);
  check(followText === 'Follow project (Low)', 'P4 the chat defaults to "Follow project (Low)"', followText);
  const popShot = async (name) => {
    const box = await page.$eval('.ai-pop.ai-modelbar', (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.screenshot({ path: path.join(shots, name), clip: { x: Math.max(0, box.x - 260), y: Math.max(0, box.y - 40), width: Math.min(1600, box.w + 420), height: Math.min(1000, box.h + 160) }, captureBeyondViewport: false });
  };
  if (shots) await popShot('ai-creativity-follow.png');
  await page.select('[data-pc="ai-creativity"]', 'medium');
  await sleep(200);
  // 选完弹层若收起就再点开,好截到改过的样子
  if (!(await page.$eval('.ai-pop.ai-modelbar', (el) => el.style.display !== 'none'))) {
    await page.click('[data-pc="ai-run-options"]');
    await page.waitForSelector('[data-pc="ai-creativity"]', { visible: true, timeout: 5000 });
  }
  if (shots) {
    await popShot('ai-creativity.png');
    await page.screenshot({ path: path.join(shots, 'ai-panel-full.png'), captureBeyondViewport: false });
  }
  // 分页清单按项目分开(2026-10-22):新项目还没有会话时当前页是开始页占位页,等级记在它身上(内存),点发送变成第一个会话时才写存储
  const saved = await page.evaluate(async () => { const m = await import('/src/ai/agentTabs.ts'); return m.getTabCreativity(m.getActiveTabId()); });
  check(saved === 'medium', 'P4 medium is recorded in the local tab', saved);
  const projectStill = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().project.creativity);
  check(projectStill === 'low', 'P4 the chat override does not change the project default', projectStill);

  /* P5 请求体带上等级(拦 fetch) */
  await page.evaluate(() => {
    window.__crBodies = [];
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/ai/chat')) {
        window.__crBodies.push(JSON.parse(init.body));
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n')); c.close(); } });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return orig(input, init);
    };
  });
  await page.keyboard.press('Escape');
  const ta = await page.$('.ai-panel textarea');
  await ta.click();
  await ta.type('Probe: test the creativity level');
  await page.evaluate(() => document.querySelector('[data-pc="ai-send"]')?.click());
  await page.waitForFunction(() => window.__crBodies.length > 0, { timeout: 10000 }).catch(() => {});
  const body = await page.evaluate(() => window.__crBodies[0] ?? null);
  // 点发送把开始页占位页变成第一个会话:等级随它写进这个项目的清单
  const storedAfterSend = await page.evaluate(async () => { const m = await import('/src/ai/agentTabs.ts'); const raw = localStorage.getItem(`pc.agentTabs:${m.getAgentProjectId()}`); return JSON.parse(raw || 'null')?.tabs?.[0]?.creativity ?? null; });
  check(storedAfterSend === 'medium', 'P4 after the first message is sent, medium is stored in this project\'s tab manifest', storedAfterSend);
  check(body?.creativity === 'medium' && body?.projectCreativity === 'low', 'P5 the chat request carries creativity=medium, projectCreativity=low', body && { creativity: body.creativity, projectCreativity: body.projectCreativity, conversationId: body.conversationId });

  /* P6 对话覆盖优先(真的登记一次) */
  const conv = `crprobe${Date.now().toString(36)}`;
  await fetch(`${origin}/api/ai/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'probe-none', prompt: 'x', conversationId: conv, creativity: 'medium', projectCreativity: 'low' }),
  }).then((r) => r.text()).catch(() => '');
  const edit = await mcpCall('edit_card', { cardId: 'cr-probe-missing-card', find: 'a', replace: 'b' }, conv);
  const editPayload = edit.result ?? edit;
  check(!editPayload?.creativity, 'P6 when the chat is "Medium", edit_card passes the gate (a later error because the card does not exist is an implementation matter)', editPayload);
  const create = await mcpCall('create_card', { id: 'cr-probe-new-card', source: '// probe' }, conv);
  const createPayload = create.result ?? create;
  check(createPayload?.creativity?.current === 'medium' && createPayload.creativity.required === 'high' && /set separately for this chat/.test(createPayload.error), 'P6 when the chat is "Medium", create_card is still rejected, and the error names "Medium" and the source', createPayload?.creativity);
  const sameProject = await mcpCall('edit_card', { cardId: 'cr-probe-missing-card', find: 'a', replace: 'b' });
  check(!!(sameProject.result ?? sameProject)?.creativity, 'P6 control: without a chat ID (following the project "Low"), edit_card is rejected', (sameProject.result ?? sameProject)?.creativity);

  // 收尾:项目设置改回「高」,不把低档留在这台 dev server 的项目里
  await page.evaluate(async () => { const m = await import('/src/store/project.ts'); m.actions.setProjectMeta({ creativity: undefined }); });
  await page.evaluate(async () => { const m = await import('/src/ai/agentTabs.ts'); m.setTabCreativity(m.getActiveTabId(), null); });
  check(errors.length === 0, 'Page has no uncaught exceptions', errors.slice(0, 5));
} finally {
  await browser.close();
}
for (const p of passes) console.log('PASS', p);
for (const f of fails) console.log('FAIL', f);
console.log(fails.length ? `Probe failed: ${fails.length} failed, ${passes.length} passed` : `Probe passed: ${passes.length} checks`);
process.exit(fails.length ? 1 : 0);
