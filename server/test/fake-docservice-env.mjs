/**
 * For testing only; production code must not import this.
 *
 * Shared utilities for C6.3 document service core tests (contract
 * `docs/plan/docservice-contract.md` Section 7):
 *
 *   loadStore() / loadProject() / loadContent()   dynamically imports modules under test; when
 *                                                 missing, each test case fails individually with a
 *                                                 clear reason
 *   tempDir(t)                                    creates a temp directory, deleted when test ends
 *   authByQuery                                   determines principal by URL query string
 *                                                 `?user=<id>`; `user=deny` rejects (401)
 *   startStandalone({ modules, ... })             starts service in standalone mode (port 0,
 *                                                 autoTick: false); connected clients closed on
 *                                                 cleanup
 *   replyTo(c, reqId, ms?)                        waits for a response with this reqId
 *   untilType(c, types, ms?)                      waits for the next message whose type is in types
 *
 * Only imports Node built-in modules and `fake-ws-kit.mjs` in the same directory.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocService } from '../docservice/service.mjs';
import { wsClient } from './fake-ws-kit.mjs';

export async function loadStore() {
  const mod = await import('../docservice/store/index.mjs');
  assert.equal(typeof mod.createFileStore, 'function', `store/index.mjs must export createFileStore; exports: ${Object.keys(mod).join(', ')}`);
  assert.equal(typeof mod.createMemoryStore, 'function', `store/index.mjs must export createMemoryStore; exports: ${Object.keys(mod).join(', ')}`);
  return mod;
}

const isModule = (v) => v && typeof v === 'object' && Array.isArray(v.types) && typeof v.handle === 'function';

export async function loadProject() {
  const mod = await import('../docservice/modules/project.mjs');
  assert.equal(typeof mod.projectModule, 'function', `modules/project.mjs must export projectModule; exports: ${Object.keys(mod).join(', ')}`);
  return (options) => {
    const m = mod.projectModule(options);
    assert.ok(isModule(m), 'projectModule must return a module object');
    assert.deepEqual(m.types, ['project.'], 'types is [\'project.\'] (contract section 1)');
    assert.deepEqual(m.channels, ['project'], 'channels is [\'project\'] (contract section 1)');
    return m;
  };
}

export async function loadContent() {
  const mod = await import('../docservice/modules/content.mjs');
  assert.equal(typeof mod.contentModule, 'function', `modules/content.mjs must export contentModule; exports: ${Object.keys(mod).join(', ')}`);
  return (options) => {
    const m = mod.contentModule(options);
    assert.ok(isModule(m), 'contentModule must return a module object');
    assert.deepEqual(m.types, ['content.'], 'types is [\'content.\'] (contract section 2)');
    assert.deepEqual(m.channels, ['content'], 'channels is [\'content\'] (contract section 2)');
    return m;
  };
}

/** Create temporary directory and delete it when the test case finishes */
export function tempDir(t, prefix = 'pc-c63-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Determines principal by URL query string: `?user=alice` → { userId: 'alice', tenantId: 't-test' }; `?user=deny` → 401; defaults to 'u-default' */
export function authByQuery(req) {
  const user = new URL(req.url ?? '/', 'http://localhost').searchParams.get('user') ?? 'u-default';
  if (user === 'deny') return null;
  return { userId: user, tenantId: 't-test' };
}

/**
 * Starts service in standalone mode. `url(user?)` provides ws address; `connect(user?)` connects
 * and waits for open. Logs are collected into `logs`. `cleanup()` closes clients and service, and
 * can be called repeatedly.
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
      throw new Error(`${err.message}: ${url(user)}${why}`);
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

/** Waits for the response with this reqId */
export const replyTo = (c, reqId, ms = 2000) => c.next((m) => m?.reqId === reqId, ms);

/** Waits for the next message whose type is in types */
export const untilType = (c, types, ms = 2000) => c.next((m) => [].concat(types).includes(m?.type), ms);

let reqSeq = 0;
/** Sends a message with a new reqId and waits for its response */
export async function ask(c, message, ms = 2000) {
  const reqId = `r-${++reqSeq}`;
  c.send({ ...message, reqId });
  const reply = await replyTo(c, reqId, ms);
  return reply;
}
