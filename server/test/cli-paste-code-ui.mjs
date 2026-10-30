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
  console.error('用法: BASE=http://127.0.0.1:<自己起的 dev server 端口> node server/test/cli-paste-code-ui.mjs\n不给地址不跑：不缺省连用户常驻的编辑器。');
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
        return request.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '授权码格式不对：应是登录网页上显示的那一整串，不含空格和换行。' }) });
      }
    } else if (url.pathname === '/api/ai/setup') data.jobs = jobs;
    else if (url.pathname === '/api/ai/config') data.config = { version: 1, defaultProvider: null, toolProtocol: false, api: { vendor: 'anthropic', baseUrl: '', model: '', maxTokens: 4096, apiKey: { set: false, last4: '' } } };
    else if (url.pathname === '/api/ai/agy-permissions') data = { ok: true, path: 'test', total: 0, missing: [], granted: [] };
    else if (url.pathname === '/api/ai/login') {
      const job = { id: 'job-1', provider: body.provider, kind: 'login', state: 'running', message: '请在浏览器中完成登录；若没有自动打开，可点击下方登录链接。', logs: [] };
      jobs = [job]; data.job = job;
    }
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });

  await page.goto(BASE + '/?nosetup=1', { waitUntil: 'networkidle2' });
  // 先落在开始页，点「开始创作」才进编辑器（AI 设置按钮在编辑器里）
  await page.waitForFunction(() => !!document.querySelector('[data-pc="editor"]') || [...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && e.textContent.trim() === '开始创作'), { timeout: 60000 });
  await page.evaluate(() => {
    if (document.querySelector('[data-pc="editor"]')) return;
    let n = [...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && e.textContent.trim() === '开始创作');
    for (let i = 0; i < 4 && n; i++) { if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button' || n.onclick) break; n = n.parentElement; }
    n?.click();
  });
  await page.waitForSelector('button[aria-label="AI 设置"]', { timeout: 60000 });
  await page.click('button[aria-label="AI 设置"]');
  await page.waitForSelector('.ais-dialog [data-entry="claude"]');
  await page.click('.ais-dialog [data-entry="claude"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-dialog button')].some(b => b.textContent.trim() === '登录'));

  const shot = async name => (await page.$('.ais-dialog')).screenshot({ path: fileURLToPath(new URL(name, shotDir)) });
  const clickButton = label => page.evaluate(label => [...document.querySelectorAll('.ais-dialog button')].find(b => b.textContent.trim() === label).click(), label);

  assert.equal(await page.$('.ais-code-paste'), null, '没有登录任务时不出现粘贴框');
  await clickButton('登录');
  await page.waitForFunction(() => document.body.textContent.includes('等待登录'));
  assert.equal(await page.$('.ais-code-paste'), null, '任务没有接标准输入时不出现粘贴框');

  // 服务端说这条登录任务的标准输入接着、还给了登录链接
  while (!jobs.length) await new Promise(r => setTimeout(r, 50));
  jobs[0].url = 'https://claude.com/cai/oauth/authorize?code=true';
  jobs[0].acceptsCode = true;
  await page.waitForSelector('.ais-code-paste');
  assert.equal(await page.$eval('.ais-code-paste', e => e.open), false, '平时收着');
  await shot('cli-paste-code-1-collapsed.png');

  await page.click('.ais-code-paste > summary');
  await page.waitForSelector('.ais-code-paste input');
  assert.equal(await page.$eval('.ais-code-paste input', e => e.type), 'password', '码按密码框遮住');
  assert.equal(await page.$eval('.ais-code-paste button', e => e.disabled), true, '空码不能提交');
  await shot('cli-paste-code-2-open-empty.png');

  // 带空格的坏码：服务端拒绝，界面显示错误，输入框里的内容不清掉（方便改）
  await page.type('.ais-code-paste input', 'bad code with spaces');
  await page.click('.ais-code-paste button');
  await page.waitForFunction(() => document.querySelector('.ais-code-paste')?.textContent.includes('授权码格式不对'));
  assert.notEqual(await page.$eval('.ais-code-paste input', e => e.value), '', '被拒后输入框保留内容');
  assert.equal(await page.$eval('.ais-code-paste button', e => e.disabled), false, '被拒后可以改了再交');
  await shot('cli-paste-code-3-rejected.png');

  // 好码：回车提交，送出去，输入框清空，显示已提交
  await page.focus('.ais-code-paste input');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.type('.ais-code-paste input', GOOD_CODE);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.ais-code-paste')?.textContent.includes('已提交'));
  assert.equal(await page.$eval('.ais-code-paste input', e => e.value), '', '提交后输入框清空');
  assert.deepEqual(submitted.at(-1), { provider: 'claude', code: GOOD_CODE });
  await shot('cli-paste-code-4-submitted.png');

  // 任务结束：粘贴框消失
  jobs[0].acceptsCode = false; jobs[0].state = 'succeeded'; jobs[0].message = '登录成功。';
  providers[0].auth.loggedIn = true;
  await page.waitForFunction(() => !document.querySelector('.ais-code-paste'));
  // 诊断报告里不含码（界面状态里也不留）
  assert.ok(!(await page.content()).includes(GOOD_CODE), '页面上不留授权码');
  console.log('PASS: 粘贴授权码输入框：平时不出现、任务在等输入时收着出现、坏码被拒显示原因、好码提交后清空、任务结束消失');
} finally { await browser.close(); }
