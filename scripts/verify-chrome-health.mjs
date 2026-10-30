/** Installed-runtime health-recovery regression. It only reads chrome.exe.
 * node scripts/verify-chrome-health.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'node:url';
import { launchHealthyChrome } from '../server/bakery/chrome-health.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.argv[2] || path.join(process.env.LOCALAPPDATA, 'PromptCut', 'runtime', 'chrome');
const found = [];
async function walk(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) await walk(file);
    else if (item.name.toLowerCase() === 'chrome-headless-shell.exe') found.push(file);
  }
}
await walk(runtime);
assert.ok(found.length, 'Installed chrome-headless-shell.exe was not found');
const executablePath = found[0];
const namespaced = '\\\\?\\' + executablePath;
const args = ['--window-position=-32000,-32000', '--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing', '--enable-unsafe-swiftshader'];
const exited = [];
const launchAt = async executable => {
  const browser = await puppeteer.launch({ executablePath: executable, headless: 'shell', protocolTimeout: 60000, args });
  const process = browser.process();
  if (process) process.once('exit', (code, signal) => exited.push({ pid: process.pid, code, signal }));
  return browser;
};

const calls = [];
let browser;
try {
  browser = await launchHealthyChrome({ launch: async attempt => {
    calls.push(attempt);
    return launchAt(attempt === 1 ? namespaced : executablePath);
  }, retryDelayMs: 500, jitterMs: 0 });
  assert.deepEqual(calls, [1, 2]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(exited.length >= 1, 'unhealthy first browser did not close');
  console.log('PASS namespaced-first recovery', JSON.stringify({ calls, exited }));
} finally {
  await browser?.close().catch(() => {});
}

const failedCalls = [];
await assert.rejects(() => launchHealthyChrome({ launch: async attempt => {
  failedCalls.push(attempt);
  return launchAt(namespaced);
}, retryDelayMs: 500, jitterMs: 0 }), /WebGL2 health check failed after 2 launch attempts/);
assert.deepEqual(failedCalls, [1, 2]);
await new Promise(resolve => setTimeout(resolve, 100));
assert.equal(exited.length, 4, `expected all four owned browsers to close, got ${JSON.stringify(exited)}`);
console.log('PASS two unhealthy namespace launches close owned browsers', JSON.stringify({ failedCalls, exited }));
