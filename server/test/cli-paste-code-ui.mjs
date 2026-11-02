// 登录对话框的「粘贴授权码」输入框。手动跑，对着自己起的 dev server：
//   BASE=http://127.0.0.1:<端口> node server/test/cli-paste-code-ui.mjs
// 所有 /api/ai/* 都在浏览器里拦截，不装任何东西、不登录任何账号、不碰真实的登录命令。
// 截图存到仓库 out/ 下。不给 BASE 不跑：永不缺省连用户常驻的编辑器（5190～5192）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('Usage: BASE=http://127.0.0.1:<port of your own dev server> node server/test/cli-paste-code-ui.mjs\nWithout an address it does not run: it never falls back to the user\'s always-running editor.');
  process.exit(2);
}

const shotDir = new URL('../../out/', import.meta.url);
fs.mkdirSync(shotDir, { recursive: true });
// 下面这串是随手编的占位值，不是任何真实授权码。
const GOOD_CODE = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo-_.~#c3RhdGU9';

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const providers = ['claude', 'codex', 'agy'].map(id => ({ id, label: id, available: true, version: '9.9.9', auth: { loggedIn: false } }));
  let jobs = [];
  const submitted = [];
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/ai/')) return request.continue();
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    let data = { ok: true };
    if (url.pathname === '/api/ai/providers') data.providers = providers;
    else if (url.pathname === '/api/ai/setup' && request.method() === 'POST') {
      submitted.push(body);
      // 和真服务端一样：带空白的码形状不对，拒绝
      if (/\s/.test(body.code || '')) {
        return request.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Invalid authorization code format: it should be the whole string shown on the login page, with no spaces or line breaks.' }) });
      }
    } else if (url.pathname === '/api/ai/setup') data.jobs = jobs;
    else if (url.pathname === '/api/ai/config') data.config = { version: 1, defaultProvider: null, toolProtocol: false, api: { vendor: 'anthropic', baseUrl: '', model: '', maxTokens: 4096, apiKey: { set: false, last4: '' } } };
    else if (url.pathname === '/api/ai/agy-permissions') data = { ok: true, path: 'test', total: 0, missing: [], granted: [] };
    else if (url.pathname === '/api/ai/login') {
      const job = { id: 'job-1', provider: body.provider, kind: 'login', state: 'running', message: 'Complete the login in your browser; if it does not open automatically, click the login link below.', logs: [] };
      jobs = [job]; data.job = job;
    }
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });

  await page.goto(BASE + '/?nosetup=1', { waitUntil: 'networkidle2' });
  // 先落在开始页，点「开始创作」才进编辑器（AI 设置按钮在编辑器里）
  await page.waitForFunction(() => !!document.querySelector('[data-pc="editor"]') || [...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && e.textContent.trim() === 'Start creating'), { timeout: 60000 });
  await page.evaluate(() => {
    if (document.querySelector('[data-pc="editor"]')) return;
    let n = [...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'Start creating');
    for (let i = 0; i < 4 && n; i++) { if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button' || n.onclick) break; n = n.parentElement; }
    n?.click();
  });
  await page.waitForSelector('button[aria-label="AI settings"]', { timeout: 60000 });
  await page.click('button[aria-label="AI settings"]');
  await page.waitForSelector('.ais-dialog [data-entry="claude"]');
  await page.click('.ais-dialog [data-entry="claude"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-dialog button')].some(b => b.textContent.trim() === 'Log in'));

  const shot = async name => (await page.$('.ais-dialog')).screenshot({ path: fileURLToPath(new URL(name, shotDir)) });
  const clickButton = label => page.evaluate(label => [...document.querySelectorAll('.ais-dialog button')].find(b => b.textContent.trim() === label).click(), label);

  assert.equal(await page.$('.ais-code-paste'), null, 'The paste box does not appear when there is no login task');
  await clickButton('Log in');
  await page.waitForFunction(() => document.body.textContent.includes('Waiting for login'));
  assert.equal(await page.$('.ais-code-paste'), null, 'The paste box does not appear when the task is not attached to standard input');

  // 服务端说这条登录任务的标准输入接着、还给了登录链接
  while (!jobs.length) await new Promise(r => setTimeout(r, 50));
  jobs[0].url = 'https://claude.com/cai/oauth/authorize?code=true';
  jobs[0].acceptsCode = true;
  await page.waitForSelector('.ais-code-paste');
  assert.equal(await page.$eval('.ais-code-paste', e => e.open), false, 'Collapsed by default');
  await shot('cli-paste-code-1-collapsed.png');

  await page.click('.ais-code-paste > summary');
  await page.waitForSelector('.ais-code-paste input');
  assert.equal(await page.$eval('.ais-code-paste input', e => e.type), 'password', 'The code is masked like a password field');
  assert.equal(await page.$eval('.ais-code-paste button', e => e.disabled), true, 'An empty code cannot be submitted');
  await shot('cli-paste-code-2-open-empty.png');

  // 带空格的坏码：服务端拒绝，界面显示错误，输入框里的内容不清掉（方便改）
  await page.type('.ais-code-paste input', 'bad code with spaces');
  await page.click('.ais-code-paste button');
  await page.waitForFunction(() => document.querySelector('.ais-code-paste')?.textContent.includes('Authorization code format is invalid'));
  assert.notEqual(await page.$eval('.ais-code-paste input', e => e.value), '', 'The input keeps its content after a rejection');
  assert.equal(await page.$eval('.ais-code-paste button', e => e.disabled), false, 'After a rejection it can be edited and resubmitted');
  await shot('cli-paste-code-3-rejected.png');

  // 好码：回车提交，送出去，输入框清空，显示已提交
  await page.focus('.ais-code-paste input');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.type('.ais-code-paste input', GOOD_CODE);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.ais-code-paste')?.textContent.includes('Submitted'));
  assert.equal(await page.$eval('.ais-code-paste input', e => e.value), '', 'The input is cleared after submitting');
  assert.deepEqual(submitted.at(-1), { provider: 'claude', code: GOOD_CODE });
  await shot('cli-paste-code-4-submitted.png');

  // 任务结束：粘贴框消失
  jobs[0].acceptsCode = false; jobs[0].state = 'succeeded'; jobs[0].message = 'Login successful.';
  providers[0].auth.loggedIn = true;
  await page.waitForFunction(() => !document.querySelector('.ais-code-paste'));
  // 诊断报告里不含码（界面状态里也不留）
  assert.ok(!(await page.content()).includes(GOOD_CODE), 'No authorization code is left on the page');
  console.log('PASS: paste-code input: not shown normally, shown collapsed while a task waits for input, a bad code is rejected with the reason shown, a good code clears after submitting, gone when the task ends');
} finally { await browser.close(); }
