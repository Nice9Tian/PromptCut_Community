/**
 * 仅供测试，生产代码不得引用。
 *
 * C6.3 文档服务本体测试（契约 `docs/plan/docservice-contract.md` 第 7 节）共用的小工具：
 *
 *   loadStore() / loadProject() / loadContent()   动态 import 被测模块，缺失时各条用例各自失败、原因写清楚
 *   tempDir(t)                                     建临时目录，用例结束时删掉
 *   authByQuery                                    按 URL 查询串 `?user=<id>` 定 principal；`user=deny` 拒绝（401）
 *   startStandalone({ modules, ... })              独立模式起服务（端口 0、autoTick: false），连上的客户端在 cleanup 时关掉
 *   replyTo(c, reqId, ms?)                         等带这个 reqId 的回包
 *   untilType(c, types, ms?)                       等下一条类型在 types 里的消息
 *
 * 只引 Node 内置模块与同目录的 `fake-ws-kit.mjs`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocService } from '../docservice/service.mjs';
import { wsClient } from './fake-ws-kit.mjs';

export async function loadStore() {
  const mod = await import('../docservice/store/index.mjs');
  assert.equal(typeof mod.createFileStore, 'function', `store/index.mjs 要导出 createFileStore；导出：${Object.keys(mod).join(', ')}`);
  assert.equal(typeof mod.createMemoryStore, 'function', `store/index.mjs 要导出 createMemoryStore；导出：${Object.keys(mod).join(', ')}`);
  return mod;
}

const isModule = (v) => v && typeof v === 'object' && Array.isArray(v.types) && typeof v.handle === 'function';

export async function loadProject() {
  const mod = await import('../docservice/modules/project.mjs');
  assert.equal(typeof mod.projectModule, 'function', `modules/project.mjs 要导出 projectModule；导出：${Object.keys(mod).join(', ')}`);
  return (options) => {
    const m = mod.projectModule(options);
    assert.ok(isModule(m), 'projectModule 要返回模块对象');
    assert.deepEqual(m.types, ['project.'], 'types 是 [\'project.\']（契约第 1 节）');
    assert.deepEqual(m.channels, ['project'], 'channels 是 [\'project\']（契约第 1 节）');
    return m;
  };
}

export async function loadContent() {
  const mod = await import('../docservice/modules/content.mjs');
  assert.equal(typeof mod.contentModule, 'function', `modules/content.mjs 要导出 contentModule；导出：${Object.keys(mod).join(', ')}`);
  return (options) => {
    const m = mod.contentModule(options);
    assert.ok(isModule(m), 'contentModule 要返回模块对象');
    assert.deepEqual(m.types, ['content.'], 'types 是 [\'content.\']（契约第 2 节）');
    assert.deepEqual(m.channels, ['content'], 'channels 是 [\'content\']（契约第 2 节）');
    return m;
  };
}

/** 建临时目录，用例结束时删掉 */
export function tempDir(t, prefix = 'pc-c63-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 按 URL 查询串定 principal：`?user=alice` → { userId: 'alice', tenantId: 't-test' }；`?user=deny` → 401；缺省 'u-default' */
export function authByQuery(req) {
  const user = new URL(req.url ?? '/', 'http://localhost').searchParams.get('user') ?? 'u-default';
  if (user === 'deny') return null;
  return { userId: user, tenantId: 't-test' };
}

/**
 * 独立模式起服务。`url(user?)` 给出 ws 地址；`connect(user?)` 连上并等 open。
 * 日志收进 `logs`。`cleanup()` 关掉客户端与服务，可重复调用。
 */
export async function startStandalone({ modules, path = '/', authenticate = authByQuery, now = Date.now, ...rest } = {}) {
  const logs = [];
  const service = createDocService({
    log: (event, fields) => logs.push({ event, ...fields }),
    autoTick: false,
    authenticate,
    now,
    path,
    modules,
    ...rest,
  });
  const { port } = await service.listen(0, '127.0.0.1');
  const clients = [];
  const url = (user) => `ws://127.0.0.1:${port}${path}${user ? `?user=${encodeURIComponent(user)}` : ''}`;
  const connect = async (user) => {
    const c = wsClient(url(user));
    clients.push(c);
    let why = '';
    c.ws.addEventListener('error', (e) => { why += ` error=${e?.message ?? e?.error?.message ?? ''} cause=${e?.error?.cause?.code ?? e?.error?.cause?.message ?? ''}`; });
    c.ws.addEventListener('close', (e) => { why += ` close=${e.code}/${e.reason}`; });
    try {
      await c.opened;
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error(`${err.message}：${url(user)}${why}`);
    }
    return c;
  };
  const health = async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    for (const c of clients) c.close();
    await service.close();
  };
  return { service, port, url, connect, health, cleanup, logs };
}

/** 等带这个 reqId 的回包 */
export const replyTo = (c, reqId, ms = 2000) => c.next((m) => m?.reqId === reqId, ms);

/** 等下一条类型在 types 里的消息 */
export const untilType = (c, types, ms = 2000) => c.next((m) => [].concat(types).includes(m?.type), ms);

let reqSeq = 0;
/** 发一条带新 reqId 的消息，等它的回包 */
export async function ask(c, message, ms = 2000) {
  const reqId = `r-${++reqSeq}`;
  c.send({ ...message, reqId });
  const reply = await replyTo(c, reqId, ms);
  return reply;
}
