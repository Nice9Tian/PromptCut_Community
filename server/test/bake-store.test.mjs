/**
 * `bake_card` 的卡片快照(预渲染的产物)经素材服务存取(`server/bake-store.mjs`;报告 `docs/reports/AGENT-bake-asset.md`;
 * 语义 `docs/semantics/product/asset-service.md`「预渲染的产物」「职责」、`product/agent.md`「素材与产物」)。
 *
 * 用例(BKA = bake asset,卡片快照经素材服务):
 *   BKA-1  写入与读回:PNG 经素材服务写进 `px`,地址 `/api/asset/px/<sha256>`,经 HTTP 取回的字节相同;同一个键再查命中;
 *          素材目录里不出现它直接写的文件(没有 `bake-*.png`),索引目录里只有 `<键>.json`;
 *   BKA-2  命中要问素材服务:索引里有、素材服务上没有这一块 → 当没渲过,索引条目删掉;
 *   BKA-3  老地址:素材目录里以前落下的 `bake-<clip>-<键>.png` 经素材服务的老读路由照常能取;读时迁移把它推进 `px`
 *          (字节相同)、记进索引,旧文件不动;不是 PNG 的不迁;
 *   BKA-4  素材服务不可达 / 拒绝:取不到地址、连不上、HTTP 401 都抛 BakeStoreError,消息写明素材服务地址与原因;
 *   BKA-5  盘点与淘汰:盘点只报收全的;淘汰只删索引里对得上的键(路径样的键碰不到别的文件),字节留在素材服务里;
 *   BKA-6  共享项目:登记了远程素材服务时写入后再推一份过去,索引记 `pushed`;推失败的下次命中时补推;
 *   BKA-7  源码守门:bake.ts / bake-cache.ts 不再引素材目录(`mediaDir`)、不再直接读写文件系统(`node:fs/promises`)。
 *
 * 跑:node --test server/test/bake-store.test.mjs(起的是真 HTTP 的素材服务,fs 实现落在临时目录;不要 Chrome、不要 ffmpeg)
 */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';
import { BakeStoreError, bakeUrlOf, createBakeStore, setBakeRemote, bakeRemote } from '../bake-store.mjs';
import { createAssetClient } from '../asset-store/client.mjs';
import { refusingPort } from './fake-ws-kit.mjs';

const harness = createAssetHarness();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-bake-store-test-'));
after(async () => {
  setBakeRemote(null);
  await harness.cleanup();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const indexDir = () => path.join(TMP, `index-${++seq}`);
/** 一张像样的 PNG:8 字节签名 + 随机尾巴(素材服务不解码,只看字节) */
const png = (n = 2048) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(n)]);
const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); });
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(25);
  }
}
/** 目录里递归列出的文件名 */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

test('BKA-1 写入与读回:PNG 经素材服务进 px,地址按内容哈希,取回字节相同;素材目录里没有它直接写的文件', async () => {
  const srv = await harness.serve({ stores: 'default' }); // fs 实现:media → <root>/out/media,px → <root>/out/asset-store/px
  const dir = indexDir();
  const store = createBakeStore({ indexDir: dir, origin: () => srv.origin, remote: () => null });
  const key = 'a1b2c3d4e5f6';
  assert.equal(await store.lookup(key), null, '没渲过');
  const bytes = png();
  const e = await store.put(key, bytes, { width: 512, height: 512, clipId: 'c1', name: `bake-c1-${key}.png` });
  assert.equal(e.hash, sha256(bytes));
  assert.equal(e.url, bakeUrlOf(e.hash));
  assert.match(e.url, /^\/api\/asset\/px\/[0-9a-f]{64}$/);
  assert.equal(e.bytes, bytes.length);

  const res = await fetch(`${srv.origin}${e.url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, '经素材服务取回的字节相同');

  const hit = await store.lookup(key);
  assert.equal(hit?.hash, e.hash, '再查命中');
  assert.equal(hit.url, e.url);

  const mediaFiles = walk(path.join(srv.root, 'out', 'media')).map((f) => path.basename(f));
  assert.deepEqual(mediaFiles.filter((n) => /^bake-/.test(n)), [], '素材目录里没有 bake-*.png');
  assert.ok(!mediaFiles.some((n) => n.startsWith(e.hash)), '也不在素材(media)命名空间里');
  assert.deepEqual(fs.readdirSync(dir), [`${key}.json`], '索引目录里只有 <键>.json');
  const idx = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'));
  assert.equal(idx.hash, e.hash);
  assert.equal(idx.clipId, 'c1');
  // 素材服务那一侧确实收全了(对账是唯一事实来源)
  const st = await (await fetch(`${srv.base}/px/${e.hash}/chunks`)).json();
  assert.equal(st.complete, true);
  await srv.close();
});

test('BKA-2 命中要问素材服务:索引里有、素材服务上没有 → 当没渲过,索引条目删掉', async () => {
  const srv = await harness.serve(); // memory 实现
  const dir = indexDir();
  const store = createBakeStore({ indexDir: dir, origin: () => srv.origin, remote: () => null });
  fs.mkdirSync(dir, { recursive: true });
  const key = 'bbbbbbbbbbbb';
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({ key, hash: 'cd'.repeat(32), bytes: 10 }));
  assert.equal(await store.lookup(key), null);
  assert.ok(!fs.existsSync(path.join(dir, `${key}.json`)), '过期的索引条目删掉');
  // 坏条目(不是 JSON / 键对不上)当没有
  fs.writeFileSync(path.join(dir, `${key}.json`), '{oops');
  assert.equal(await store.lookup(key), null);
  assert.equal(await store.lookup('../../etc/x'), null, '不合格的键不碰文件系统');
  await srv.close();
});

test('BKA-3 老地址照常能取;读时迁移经素材服务把旧文件推进 px,旧文件不动;不是 PNG 的不迁', async () => {
  const srv = await harness.serve({ stores: 'default' });
  const media = path.join(srv.root, 'out', 'media');
  const key = 'c0ffee123456';
  const name = `bake-clip_1-${key}.png`;
  const old = png(4096);
  fs.writeFileSync(path.join(media, name), old); // 以前的 bake_card 落下的文件(测试布置现场,不是被测代码写的)

  // 老项目参数里存着的 /@media/bake-….png:素材服务的老读路由照常答
  const legacy = await fetch(`${srv.origin}/@media/${encodeURIComponent(name)}`);
  assert.equal(legacy.status, 200);
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), old);

  const seen = [];
  const counting = (url, init) => { seen.push(String(url)); return fetch(url, init); };
  const store = createBakeStore({ indexDir: indexDir(), origin: () => srv.origin, fetchImpl: counting, remote: () => null });
  assert.equal(await store.lookup(key), null, '索引里还没有');
  const moved = await store.migrateLegacy(key, name, { width: 800, height: 450, clipId: 'clip_1' });
  assert.ok(moved?.migrated, '迁移了');
  assert.equal(moved.hash, sha256(old));
  assert.ok(seen.some((u) => u.endsWith(`/@media/${encodeURIComponent(name)}`)), '旧文件经素材服务的老读路由取');
  const back = await fetch(`${srv.origin}${moved.url}`);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), old, 'px 里的字节与旧文件相同');
  assert.ok(fs.existsSync(path.join(media, name)), '旧文件不删');
  assert.equal((await store.lookup(key))?.hash, moved.hash, '之后直接命中');
  const again = await fetch(`${srv.origin}/@media/${encodeURIComponent(name)}`);
  assert.equal(again.status, 200, '老地址迁移之后照样能取');

  // 没有旧文件:回 null;不是 PNG 的:不迁
  assert.equal(await store.migrateLegacy('dddddddddddd', 'bake-x-dddddddddddd.png'), null);
  fs.writeFileSync(path.join(media, 'bake-x-eeeeeeeeeeee.png'), 'not a png');
  assert.equal(await store.migrateLegacy('eeeeeeeeeeee', 'bake-x-eeeeeeeeeeee.png'), null);
  // 名字不像老格式的不去取(不拿它当任意文件的读口)
  assert.equal(await store.migrateLegacy('ffffffffffff', '../secret.png'), null);
  assert.equal(await store.migrateLegacy('ffffffffffff', 'foo.mp4'), null);
  await srv.close();
});

test('BKA-4 素材服务不可达 / 拒绝:回清楚的错(写明地址与原因)', async () => {
  const none = createBakeStore({ indexDir: indexDir(), origin: () => null, remote: () => null });
  await assert.rejects(none.put('aaaaaaaaaaaa', png()), (e) => e instanceof BakeStoreError && e.kind === 'asset-service' && /素材服务不可达.*取不到素材服务的地址/.test(e.message));

  const s = await refusingPort();
  after(() => s.close());
  const closed = `http://127.0.0.1:${s.port}`;
  const down = createBakeStore({ indexDir: indexDir(), origin: () => closed, remote: () => null, retries: 0, timeoutMs: 3000 });
  await assert.rejects(down.put('aaaaaaaaaaaa', png()), (e) => e instanceof BakeStoreError && e.message.includes(`素材服务不可达(${closed}/api/asset)`) && /写入/.test(e.message));
  await assert.rejects(down.migrateLegacy('aaaaaaaaaaaa', 'bake-a-aaaaaaaaaaaa.png'), (e) => e instanceof BakeStoreError && e.message.includes(closed));
  // 索引里有的键,问对账时连不上:也是清楚的错,不当成「没渲过」
  const dir = indexDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'aaaaaaaaaaaa.json'), JSON.stringify({ key: 'aaaaaaaaaaaa', hash: 'ab'.repeat(32), bytes: 5 }));
  const down2 = createBakeStore({ indexDir: dir, origin: () => closed, remote: () => null, retries: 0, timeoutMs: 3000 });
  await assert.rejects(down2.lookup('aaaaaaaaaaaa'), (e) => e instanceof BakeStoreError && /素材服务不可达/.test(e.message));
  assert.ok(fs.existsSync(path.join(dir, 'aaaaaaaaaaaa.json')), '连不上时不删索引');

  // 拒绝(非本机、没票据 → 401)
  const srv = await harness.serve({ isTrusted: () => false, tickets: null });
  const denied = createBakeStore({ indexDir: indexDir(), origin: () => srv.origin, remote: () => null, retries: 0 });
  await assert.rejects(denied.put('aaaaaaaaaaaa', png()), (e) => e instanceof BakeStoreError && e.status === 401 && e.message.includes(`素材服务拒绝了写入(${srv.base},HTTP 401)`));
  await srv.close();
});

test('BKA-5 盘点只报收全的;淘汰只删索引里对得上的键,字节留在素材服务里', async () => {
  const srv = await harness.serve();
  const dir = indexDir();
  const store = createBakeStore({ indexDir: dir, origin: () => srv.origin, remote: () => null });
  const a = await store.put('111111111111', png(100));
  const b = await store.put('222222222222', png(200));
  fs.writeFileSync(path.join(dir, '333333333333.json'), JSON.stringify({ key: '333333333333', hash: 'ef'.repeat(32), bytes: 7 }));
  const st = await store.status(['111111111111', '222222222222', '333333333333', '444444444444', 'nope']);
  assert.deepEqual([...st.keys()].sort(), ['111111111111', '222222222222']);
  assert.equal(st.get('111111111111').url, a.url);
  assert.ok(!fs.existsSync(path.join(dir, '333333333333.json')), '素材服务里没有的,索引条目当场删掉');

  const list = await store.list();
  assert.equal(list.length, 2);
  fs.writeFileSync(path.join(TMP, 'victim.txt'), 'keep me');
  const ev = await store.evict(['111111111111', '../victim', '/etc/passwd', 42, 'zzzzzzzzzzzz']);
  assert.deepEqual(ev.deleted, ['111111111111']);
  assert.equal(ev.freedBytes, a.bytes);
  assert.ok(fs.existsSync(path.join(TMP, 'victim.txt')), '路径样的键碰不到别的文件');
  assert.equal(await store.lookup('111111111111'), null, '淘汰后不再命中');
  assert.equal((await store.lookup('222222222222'))?.hash, b.hash);
  const still = await fetch(`${srv.origin}${a.url}`);
  assert.equal(still.status, 200, '字节留在素材服务里(没有删除接口)');
  // 同一张图再写一次:只是一次对账,不重传
  const client = createAssetClient({ base: srv.base });
  assert.equal((await client.put('px', await (await fetch(`${srv.origin}${a.url}`)).arrayBuffer().then((x) => Buffer.from(x)))).uploaded, false);
  await srv.close();
});

test('BKA-6 共享项目:登记了远程素材服务时写入后再推一份过去;推失败的下次命中时补推', async () => {
  const local = await harness.serve();
  const remote = await harness.serve();
  const dir = indexDir();
  const events = [];
  let remoteClient = createAssetClient({ base: remote.base });
  setBakeRemote(() => remoteClient);
  assert.equal(bakeRemote(), remoteClient);
  const store = createBakeStore({ indexDir: dir, origin: () => local.origin, log: (ev, f) => events.push({ ev, ...f }) });
  const bytes = png(300);
  const e = await store.put('555555555555', bytes);
  const pushed = await until(async () => (await fetch(`${remote.base}/px/${e.hash}/chunks`).then((r) => r.json())).complete === true);
  assert.ok(pushed, '远程素材服务收全了');
  const got = await fetch(`${remote.origin}${e.url}`);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes, '远程取回的字节相同');
  assert.ok(await until(() => JSON.parse(fs.readFileSync(path.join(dir, '555555555555.json'), 'utf8')).pushed === remote.base), '索引记下推到哪一台');

  // 推失败(远程连不上):写入照常成功;换回能连的远程后,下次命中时补推
  const s = await refusingPort();
  after(() => s.close());
  const closed = `http://127.0.0.1:${s.port}`;
  remoteClient = createAssetClient({ base: `${closed}/api/asset`, retries: 0, timeoutMs: 2000 });
  const f = await store.put('666666666666', png(400));
  assert.ok(await until(() => events.some((x) => x.ev === 'bake.push-failed' && x.key === '666666666666')), '推失败记日志,不抛');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '666666666666.json'), 'utf8')).pushed, undefined);
  remoteClient = createAssetClient({ base: remote.base });
  assert.equal((await store.lookup('666666666666'))?.hash, f.hash);
  assert.ok(await until(async () => (await fetch(`${remote.base}/px/${f.hash}/chunks`).then((r) => r.json())).complete === true), '命中时补推上去了');
  setBakeRemote(null);
  assert.equal(bakeRemote(), null);
  await local.close();
  await remote.close();
});

test('BKA-7 源码守门:bake.ts / bake-cache.ts 不再引素材目录、不再直接读写文件系统', () => {
  for (const f of ['server/vision/bake.ts', 'server/vision/bake-cache.ts']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\bmediaDir\b/, `${f} 不引 mediaDir`);
    assert.doesNotMatch(src, /from "node:fs(\/promises)?"/, `${f} 不直接读写文件系统`);
    assert.doesNotMatch(src, /vite-plugin-media/, `${f} 不引媒体插件`);
  }
  const bake = fs.readFileSync(path.join(ROOT, 'server/vision/bake.ts'), 'utf8');
  assert.match(bake, /store\.put\(key, r\.buf/, '渲好的字节经 bake-store 入库');
  assert.match(bake, /store\.lookup\(key\)/, '命中经 bake-store 问');
  assert.match(bake, /store\.migrateLegacy\(key, name/, '单张那条路做读时迁移');
  assert.match(bake, /store\.migrateLegacy\(tg\.key, tg\.name/, '批量那条路做读时迁移');
});

test('BKA-8 共享项目的另一个成员:本机素材服务没有这块 px 时向当前连接的远程素材服务取一次、校验入库再答', async () => {
  const pull = await import('../media-pull.mjs');
  const a = await harness.asset();
  const remote = await harness.serve();
  const bytes = png(1500);
  const { hash } = await createAssetClient({ base: remote.base }).put('px', bytes, { ext: 'png' });

  /** 本机素材服务:memory 数据层,pullArtifact 走缺省(media-pull 的当前远程) */
  const stores = { media: await harness.memoryStore(), snap: await harness.memoryStore(), px: await harness.memoryStore() };
  const serveWith = async (opts) => {
    const mw = a.assetServiceMiddleware(path.join(TMP, `local-${++seq}`), { stores, ...opts });
    const s = await listen((req, res) => { void mw(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
    return s;
  };
  const local = await serveWith({});
  try {
    pull.resetPullStateForTest();
    // 没连远程:照旧 404
    assert.equal((await fetch(`${local.origin}/api/asset/px/${hash}`)).status, 404);

    pull.setRemoteAssetService({ base: remote.base });
    const res = await fetch(`${local.origin}/api/asset/px/${hash}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, '取回的字节相同');
    assert.equal((await stores.px.chunks(hash)).complete, true, '入了本机素材服务');
    const pulls = () => pull.pullLog().filter((e) => e.event === 'artifact.pull' && e.hash === hash).length;
    assert.equal(pulls(), 1);
    assert.equal((await fetch(`${local.origin}/api/asset/px/${hash}`)).status, 200);
    assert.equal(pulls(), 1, '第二次是本机命中,不再问远程');
    // 远程也没有的:404(远程那台的 media-pull 也指着它自己 —— 按需拉取带的头让它不再往下拉,不成环、不等超时)
    assert.equal((await fetch(`${local.origin}/api/asset/px/${'ab'.repeat(32)}`)).status, 404);
  } finally {
    pull.resetPullStateForTest();
    await closeServer(local.server);
  }

  // 拉回来的字节不对(内容哈希对不上):不入库,404
  const liar = await serveWith({ pullArtifact: async () => ({ bytes: png(10), contentType: 'image/png' }) });
  const other = 'cd'.repeat(32);
  assert.equal((await fetch(`${liar.origin}/api/asset/px/${other}`)).status, 404);
  assert.equal((await stores.px.chunks(other)).complete, false);
  await closeServer(liar.server);
  // pullArtifact: null 关掉
  let asked = 0;
  const off = await serveWith({ pullArtifact: null });
  pull.setRemoteAssetService({ base: remote.base });
  const fresh = png(20);
  const fh = (await createAssetClient({ base: remote.base }).put('px', fresh)).hash;
  assert.equal((await fetch(`${off.origin}/api/asset/px/${fh}`)).status, 404);
  pull.resetPullStateForTest();
  await closeServer(off.server);
  // 非本机、没票据的读:先拒(401),不会替它去远程拉
  const guarded = await serveWith({ isTrusted: () => false, tickets: null, pullArtifact: async () => { asked++; return null; } });
  assert.equal((await fetch(`${guarded.origin}/api/asset/px/${fh}`)).status, 401);
  assert.equal(asked, 0);
  await closeServer(guarded.server);
  await remote.close();
});

test('BKA-9 登记的「远程」就是本机素材服务时不推', async () => {
  const local = await harness.serve();
  let puts = 0;
  const client = createAssetClient({ base: local.base });
  setBakeRemote(() => ({ base: `${local.base}/`, put: (...x) => { puts++; return client.put(...x); } }));
  try {
    const store = createBakeStore({ indexDir: indexDir(), origin: () => local.origin });
    const e = await store.put('777777777777', png(50));
    await sleep(100);
    assert.equal(puts, 0);
    assert.equal((await store.lookup('777777777777'))?.hash, e.hash);
    await sleep(100);
    assert.equal(puts, 0);
  } finally {
    setBakeRemote(null);
    await local.close();
  }
});

/* ------------------------------------------------------------------ px 的容量淘汰(asset-store/px-evict.mjs) */

test('BKA-10 淘汰计划:超上限按最近使用从旧到新删到上限的 90%;保护期内的不删;没超不删', async () => {
  const { planPxEviction, pxCapBytes, PX_EVICT_DEFAULTS } = await import('../asset-store/px-evict.mjs');
  const now = 10_000_000;
  const blobs = [
    { hash: 'a', size: 30, lastUsed: now - 5_000_000 },
    { hash: 'b', size: 30, lastUsed: now - 4_000_000 },
    { hash: 'c', size: 30, lastUsed: now - 3_000_000 },
    { hash: 'd', size: 30, lastUsed: now - 10 }, // 刚用过
  ];
  const p = planPxEviction(blobs, { capBytes: 100, now, protectMs: 60_000 });
  assert.equal(p.total, 120);
  assert.equal(p.target, 90);
  assert.deepEqual(p.victims.map((v) => v.hash), ['a'], '删最旧的一个就到 90 以下');
  const q = planPxEviction(blobs, { capBytes: 40, now, protectMs: 60_000 });
  assert.deepEqual(q.victims.map((v) => v.hash), ['a', 'b', 'c'], '保护期内的 d 再超也不删');
  assert.deepEqual(planPxEviction(blobs, { capBytes: 120, now }).victims, [], '没超上限不删');
  // 上限:环境变量优先;磁盘小于 500 GiB 取 2%;否则 10 GiB
  assert.equal(pxCapBytes({ env: { PROMPTCUT_PX_CAP_BYTES: '1234' } }), 1234);
  assert.equal(pxCapBytes({ env: {}, diskTotal: 100 * 1024 ** 3 }), Math.floor(100 * 1024 ** 3 * 0.02));
  assert.equal(pxCapBytes({ env: {}, diskTotal: 2048 * 1024 ** 3 }), PX_EVICT_DEFAULTS.capBytes);
  assert.equal(pxCapBytes({ env: {}, diskTotal: null }), 10 * 1024 ** 3);
});

/** 真的素材服务(fs 数据层,px 带淘汰器,不自动起)挂在 http 上 */
async function serveWithEvict(pxEvict) {
  const a = await harness.asset();
  const root = path.join(TMP, `evict-${++seq}`);
  fs.mkdirSync(path.join(root, 'out', 'media'), { recursive: true });
  const saved = process.env.PROMPTCUT_EXPORT_DIR;
  delete process.env.PROMPTCUT_EXPORT_DIR;
  // These cases drive eviction explicitly; onStored must not race the pre-eviction assertion.
  const mw = a.assetServiceMiddleware(root, { pxEvict: { start: false, ...pxEvict, options: { ...pxEvict.options, minIntervalMs: Number.MAX_SAFE_INTEGER } } });
  if (saved !== undefined) process.env.PROMPTCUT_EXPORT_DIR = saved;
  const s = await listen((req, res) => { void mw(req, res, () => { res.statusCode = 404; res.end('no route'); }); });
  const evictor = await mw.pxEvictor();
  after(async () => { await evictor?.stop(); await closeServer(s.server); });
  return { ...s, root, base: `${s.origin}/api/asset`, pxDir: path.join(root, 'out', 'asset-store', 'px'), evictor };
}

test('BKA-11 本机素材服务的 px 超上限时按最近使用删到 90%:media 一个字节不碰,最近用过的留下', async () => {
  const srv = await serveWithEvict({ capBytes: 10_000, options: { protectMs: 0 } });
  assert.ok(srv.evictor, '缺省 fs 数据层时淘汰器开着');
  const client = createAssetClient({ base: srv.base });
  // 素材原件:比上限大得多,也不许被删
  const movie = crypto.randomBytes(50_000);
  const { hash: mediaHash } = await client.put('media', movie, { ext: 'mp4' });
  const hashes = [];
  for (let i = 0; i < 5; i++) { hashes.push((await client.put('px', png(3000 - 8))).hash); await sleep(15); } // 5 × 3000 = 15000 > 10000
  await sleep(15);
  // 最早写的那块刚被取过一次:它变成最近用的
  assert.equal((await fetch(`${srv.base}/px/${hashes[0]}`)).status, 200);
  const r = await srv.evictor.evictNow();
  assert.equal(r.ran, true);
  assert.equal(r.total, 15000);
  assert.deepEqual(r.removed, [hashes[1], hashes[2]], '从最久没用的删起,删到 9000 以下为止(15000 → 9000)');
  for (const h of r.removed) assert.equal((await fetch(`${srv.base}/px/${h}/chunks`).then((x) => x.json())).complete, false);
  for (const h of [hashes[0], hashes[3], hashes[4]]) assert.equal((await fetch(`${srv.base}/px/${h}`)).status, 200, '剩下的照常取得到');
  const m = await fetch(`${srv.base}/media/${mediaHash}`);
  assert.equal(m.status, 200);
  assert.deepEqual(Buffer.from(await m.arrayBuffer()), movie, 'media 不被删');
  assert.ok(fs.existsSync(path.join(srv.pxDir, '.usage.json')), '使用时刻记在 px 目录的 .usage.json');
  assert.equal((await srv.evictor.evictNow()).removed.length, 0, '已经在上限以下,不再删');
  await srv.evictor.stop();
  await closeServer(srv.server);
});

test('BKA-12 保护期内用过的不删;同一时刻只有拿到锁的那一个做淘汰,死锁 3 分钟后接手', async () => {
  const srv = await serveWithEvict({ capBytes: 1000 }); // 缺省保护期 30 分钟
  const client = createAssetClient({ base: srv.base });
  const h = (await client.put('px', png(3000))).hash;
  let r = await srv.evictor.evictNow();
  assert.deepEqual(r.removed, [], '刚写进去(30 分钟内用过)的不删,哪怕超了上限');
  assert.equal((await fetch(`${srv.base}/px/${h}`)).status, 200);
  // 锁:别的进程正拿着 → 这一轮跳过
  const lock = path.join(srv.pxDir, '.evict-lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() }));
  r = await srv.evictor.evictNow();
  assert.equal(r.ran, false, '拿不到锁就跳过');
  assert.ok(fs.existsSync(lock), '别人的锁不动');
  // 锁超过 3 分钟没更新:算死锁,删掉接手
  const old = new Date(Date.now() - 4 * 60_000);
  fs.utimesSync(lock, old, old);
  r = await srv.evictor.evictNow();
  assert.equal(r.ran, true, '死锁接手');
  assert.ok(!fs.existsSync(lock), '做完放锁');
  await srv.evictor.stop();
  await closeServer(srv.server);
});

test('BKA-13 快照被淘汰后再要:索引问对账得到「没有」,删掉索引条目,回到重渲那条路', async () => {
  const srv = await serveWithEvict({ capBytes: 0, options: { protectMs: 0 } });
  const dir = indexDir();
  const store = createBakeStore({ indexDir: dir, origin: () => srv.origin, remote: () => null });
  const e = await store.put('888888888888', png(500));
  assert.equal((await store.lookup('888888888888'))?.hash, e.hash, '淘汰前命中');
  const r = await srv.evictor.evictNow();
  assert.deepEqual(r.removed, [e.hash]);
  assert.equal(await store.lookup('888888888888'), null, '淘汰后不再命中(bakeOne 拿到 null 就去渲)');
  assert.ok(!fs.existsSync(path.join(dir, '888888888888.json')), '索引条目删掉');
  // 重渲之后再写回:又能命中
  const again = await store.put('888888888888', png(500));
  assert.equal((await store.lookup('888888888888'))?.hash, again.hash);
  await srv.evictor.stop();
  await closeServer(srv.server);
});

test('BKA-14 注入了自己的 px 数据层、或 pxEvict: null、或 PROMPTCUT_PX_EVICT=0 时不开淘汰', async () => {
  const a = await harness.asset();
  const root = path.join(TMP, `noevict-${++seq}`);
  const own = a.assetServiceMiddleware(root, { stores: { px: await harness.memoryStore() } });
  assert.equal(await own.pxEvictor(), null);
  assert.equal(await a.assetServiceMiddleware(root, { pxEvict: null }).pxEvictor(), null);
  process.env.PROMPTCUT_PX_EVICT = '0';
  try { assert.equal(await a.assetServiceMiddleware(root, {}).pxEvictor(), null); } finally { delete process.env.PROMPTCUT_PX_EVICT; }
});
