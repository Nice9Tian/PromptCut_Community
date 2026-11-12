// The "Paste authorization code" input box in the login dialog. Run manually against your own dev
// server:
//   BASE=http://127.0.0.1:<port> node server/test/cli-paste-code-ui.mjs
// All /api/ai/* are intercepted in the browser without installing anything, logging into any
// account, or touching real login commands.
// Screenshots are saved under out/ in the repo. Does not run without BASE: never connects to the
// user's resident editor by default (5190-5192).
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
// The string below is an arbitrary placeholder value, not any real authorization code.
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
      // Same as the real server: codes containing whitespace have an invalid shape and are rejected
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
  // Lands on the start page first; only enters the editor after clicking "Start creating"
  // (AI settings button is in the editor)
  await page.waitForFunction(() => !!document.querySelector('[data-pc="editor"]') || [...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && e.textContent.trim() === 'Start creating'), { timeout: 60000 });
  await page.evaluate(() => {
    if (document.querySelector('[data-pc="editor"]')) return;
    let n = [...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'Start creating');
    for (let i = 0; i < 4 && n; i++) { if (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button' || n.onclick) break; n = n.parentElement; }
    n?.click();
  });
  await page.waitForFunction(() => !!document.querySelector('[data-pc="editor"]') || !!document.querySelector('[data-pc="new-project-local-confirm"]'), { timeout: 60000 });
  await page.evaluate(() => {
    document.querySelector('[data-pc="new-project-local-confirm"]')?.click();
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

  // The server reports standard input is connected for this login task and also provides a login link
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

  // Bad code with spaces: the server rejects it, the UI shows an error, and input box content
  // is not cleared (convenient for editing)
  await page.type('.ais-code-paste input', 'bad code with spaces');
  await page.click('.ais-code-paste button');
  await page.waitForFunction(() => document.querySelector('.ais-code-paste')?.textContent.includes('Authorization code format is invalid'));
  assert.notEqual(await page.$eval('.ais-code-paste input', e => e.value), '', 'The input keeps its content after a rejection');
  assert.equal(await page.$eval('.ais-code-paste button', e => e.disabled), false, 'After a rejection it can be edited and resubmitted');
  await shot('cli-paste-code-3-rejected.png');

  // Valid code: press Enter to submit, sent out, input box is cleared, and displays submitted
  await page.focus('.ais-code-paste input');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.type('.ais-code-paste input', GOOD_CODE);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.ais-code-paste')?.textContent.includes('Submitted'));
  assert.equal(await page.$eval('.ais-code-paste input', e => e.value), '', 'The input is cleared after submitting');
  assert.deepEqual(submitted.at(-1), { provider: 'claude', code: GOOD_CODE });
  await shot('cli-paste-code-4-submitted.png');

  // Task finished: paste box disappears
  jobs[0].acceptsCode = false; jobs[0].state = 'succeeded'; jobs[0].message = 'Login successful.';
  providers[0].auth.loggedIn = true;
  await page.waitForFunction(() => !document.querySelector('.ais-code-paste'));
  // The diagnostic report does not contain the code (nor is it retained in UI state)
  assert.ok(!(await page.content()).includes(GOOD_CODE), 'No authorization code is left on the page');
  console.log('PASS: paste-code input: not shown normally, shown collapsed while a task waits for input, a bad code is rejected with the reason shown, a good code clears after submitting, gone when the task ends');
} finally { await browser.close(); }
