// Run against a local dev server. All setup endpoints are intercepted: no real
// installers, account logins, or permission changes are triggered by this test.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

// The address must be provided explicitly (environment variable BASE), exiting with usage if
// omitted: never connects to the user's resident editor by default (5190-5192).
const BASE = (process.env.BASE || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('Usage: BASE=http://127.0.0.1:<port of your own dev server> node server/test/cli-setup-ui.mjs\nWithout an address it does not run: it never falls back to the user\'s always-running editor.');
  process.exit(2);
}

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const providers = ['claude', 'codex', 'agy'].map(id => ({ id, label: id, available: false, auth: { loggedIn: false } }));
  let jobs = [];
  let serial = 0;
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/ai/')) return request.continue();
    const body = JSON.parse(request.postData() || '{}');
    let data = { ok: true };
    if (url.pathname === '/api/ai/providers') data.providers = providers;
    else if (url.pathname === '/api/ai/setup') data.jobs = jobs;
    else if (url.pathname === '/api/ai/config') data.config = { version: 1, defaultProvider: null, toolProtocol: false, api: { vendor: 'anthropic', baseUrl: '', model: '', maxTokens: 4096, apiKey: { set: false, last4: '' } } };
    else if (url.pathname === '/api/ai/agy-permissions') data = { ok: true, path: 'test', total: 0, missing: [], granted: [] };
    else if (url.pathname === '/api/ai/install' || url.pathname === '/api/ai/login') {
      if (body.dryRun) data.command = 'Download and install from the official source';
      else {
        const job = { id: String(++serial), provider: body.provider, kind: url.pathname.endsWith('install') ? 'install' : 'login', state: 'running', message: 'Processing', logs: [] };
        jobs = [...jobs.filter(j => j.provider !== body.provider), job]; data.job = job;
      }
    }
    await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(BASE + '/?nosetup=1', { waitUntil: 'networkidle2' });
  const button = await page.$eval('.ai-gear-btn', e => ({ text: e.textContent, height: e.getBoundingClientRect().height }));
  assert.ok(button.text.includes('AI settings')); assert.ok(button.height >= 32);
  await page.click('.ai-gear-btn');
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-row')].filter(e => ['claude', 'codex', 'agy'].includes(e.querySelector('.ais-row-name')?.textContent)).every(e => [...e.querySelectorAll('button')].some(b => b.textContent === 'Install')));
  const clickRowButton = async (id, label) => page.evaluate(({ id, label }) => {
    const row = [...document.querySelectorAll('.ais-row')].find(e => e.querySelector('.ais-row-name').textContent === id);
    [...row.querySelectorAll('button')].find(e => e.textContent.trim() === label).click();
  }, { id, label });
  await clickRowButton('claude', 'Install'); await clickRowButton('codex', 'Install');
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-row')].filter(e => e.textContent.includes('Installing')).length === 2);
  jobs.find(j => j.provider === 'claude').state = 'failed';
  jobs.find(j => j.provider === 'claude').message = 'Download failed, please check the network';
  await page.waitForFunction(() => document.body.textContent.includes('Download failed, please check the network'));
  assert.ok(await page.$eval('.ais-dialog', e => e.textContent.includes('Retry install')));
  await page.keyboard.press('Escape'); await page.click('.ai-gear-btn');
  await page.waitForFunction(() => document.querySelector('.ais-dialog').textContent.includes('Download failed, please check the network'));
  providers.find(p => p.id === 'codex').available = true;
  jobs.find(j => j.provider === 'codex').state = 'succeeded';
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-row')].find(e => e.querySelector('.ais-row-name').textContent === 'codex').textContent.includes('Not logged in'));
  await clickRowButton('codex', 'Log in');
  await page.waitForFunction(() => document.body.textContent.includes('Waiting for login'));
  jobs.find(j => j.provider === 'codex').url = 'https://auth.openai.com/example';
  await page.waitForSelector('a[href="https://auth.openai.com/example"]');
  jobs.find(j => j.provider === 'codex').state = 'succeeded';
  providers.find(p => p.id === 'codex').auth.loggedIn = true;
  await page.waitForFunction(() => [...document.querySelectorAll('.ais-row')].find(e => e.querySelector('.ais-row-name').textContent === 'codex').textContent.includes('Logged in'));
  console.log('PASS: settings entry, concurrent installs, failure/retry, dialog recovery, browser login link, verified login refresh');
} finally { await browser.close(); }
