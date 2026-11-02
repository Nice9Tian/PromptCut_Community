/**
 * 产品声明（`product.config.json`、`server/auth/product.mjs`）：公开版没有托管端，也不连任何我们的服务器。
 *
 * 2026-10-30 实测过反面：社区版什么都不设，按名字找项目时把项目名发到了缺省托管地址，协作面板还有「云端」按钮。
 * 私有仓库里 `cloud/` 在，所以这里用子进程把 `PROMPTCUT_CLOUD_DIR` 指到空目录，两边跑到的都是公开版的行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const auth = (name) => new URL(`../auth/${name}`, import.meta.url).href;

/** 在公开版的声明下跑一段模块代码，取它打印的 JSON */
function asCommunity(code) {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-no-cloud-'));
  try {
    const env = { ...process.env, PROMPTCUT_CLOUD_DIR: empty };
    delete env.PROMPTCUT_HOSTED_URL;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true });
    return JSON.parse(out);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

test('PD-1 community edition declaration: LAN only, no hosted side, no account cloud', () => {
  const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'product.config.json'), 'utf8'));
  assert.deepEqual(declared, { collab: { targets: ['lan'] }, hosted: null, accountCloudOrigin: null });
  const r = asCommunity(`
    const { PRODUCT } = await import(${JSON.stringify(auth('product.mjs'))});
    const h = await import(${JSON.stringify(auth('hosted-default.mjs'))});
    console.log(JSON.stringify({ PRODUCT, url: h.DEFAULT_HOSTED_URL, choice: h.hostedUrlChoice({ env: {} }), retired: h.RETIRED_HOSTED_HOSTS }));
  `);
  assert.deepEqual(r.PRODUCT, declared);
  assert.equal(r.url, '');
  assert.deepEqual(r.choice, { url: '', from: 'default' });
  assert.deepEqual(r.retired, []);
});

test('PD-2 community edition finds projects by name: sends no outgoing requests and reports no hosted-side errors', () => {
  const r = asCommunity(`
    const { findSharedProject } = await import(${JSON.stringify(auth('route.mjs'))});
    const seen = [];
    const fetch = async (url) => { seen.push(String(url)); return new Response('{}', { status: 404 }); };
    const found = await findSharedProject({ name: 'my-secret-project', lan: { discover: async () => [] }, fetch });
    console.log(JSON.stringify({ seen, candidates: found.candidates, hostedErrors: found.errors.filter((e) => e.where === 'hosted') }));
  `);
  assert.deepEqual(r, { seen: [], candidates: [], hostedErrors: [] });
});

test('PD-3 community edition refuses to create cloud projects outright; addresses the user supplies still work as before', () => {
  const r = asCommunity(`
    const { createSharedProject, findSharedProject } = await import(${JSON.stringify(auth('route.mjs'))});
    const refused = await createSharedProject({ where: 'hosted', name: 'x' }).then(() => null, (e) => e.message);
    const seen = [];
    const fetch = async (url) => { seen.push(String(url)); return new Response('{}', { status: 404 }); };
    await findSharedProject({ name: 'x', hostedUrl: 'https://my-own-node.example/hosted', fetch });
    console.log(JSON.stringify({ refused, seen }));
  `);
  assert.match(r.refused, /no hosted side/);
  assert.equal(r.seen.length, 1);
  assert.equal(new URL(r.seen[0]).host, 'my-own-node.example');
});

test('PD-4 the community edition editor process allows no account cloud (except those a probe explicitly allows)', () => {
  const r = asCommunity(`
    const { accountDocUrlAllowed, ACCOUNT_CLOUD_ORIGIN } = await import(${JSON.stringify(new URL('../account-card-link.mjs', import.meta.url).href)});
    console.log(JSON.stringify({
      origin: ACCOUNT_CLOUD_ORIGIN,
      plain: accountDocUrlAllowed('wss://accounts.example/hosted/', {}),
      opened: accountDocUrlAllowed('wss://accounts.example/hosted/', { PROMPTCUT_ACCOUNT_CLOUD_ORIGIN: 'https://accounts.example' }),
    }));
  `);
  assert.deepEqual(r, { origin: null, plain: false, opened: true });
});

test('PD-5 all "Cloud" entries in the collaboration panel are tied to the declaration', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const panel = read('src/editor/sync/CollabSection.tsx');
  assert.match(panel, /\{hostedTarget \? \(\s*<div className="pc-collab-row">/, 'the "Stored on" row');
  assert.match(panel, /!ONLINE && hostedTarget \? <button[^>]*data-pc="collab-move-hosted"/, '"Move to the cloud"');
  const join = read('src/editor/sync/JoinForm.tsx');
  assert.match(join, /!ONLINE && !viaInvite && hostedTarget \? \(\s*<button[^>]*pc-sync-link-btn/, '"Server address"');
  assert.match(join, /showServer && !ONLINE && !viaInvite && hostedTarget \?/, 'hosted address input');
});
