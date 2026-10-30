/**
 * 素材服务的三个命名空间 `media` / `snap` / `px`（契约 `docs/plan/artifact-transfer-contract.md` 第 1 节，
 * 第 7 节用例 S1～S4）。
 * 跑：node --test server/test/asset-namespaces.test.mjs
 *
 * 只照契约写，不看实现。`asset-service.ts` 照 C5 的办法转译后 import（`fake-asset-service.mjs`），
 * 三个命名空间都注入 memory 实现（`assetServiceMiddleware(root, { stores: { media, snap, px } })`），
 * 分片调小到 1 KiB，免得每条用例都传几十 MB。
 *
 * S3（`media` 的全部行为不变）的主体由 `npm test` 覆盖：`asset-service.test.mjs`、`asset-store-http.test.mjs`
 * 两个文件本分支不改、照旧全过。这里另补契约第 1 节末条：旧写法 `opts.store` 仍然认，当作 `stores.media`。
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createAssetHarness } from './fake-asset-service.mjs';
import { isAssetServicePath } from '../http-guard.mjs';

const harness = createAssetHarness();
after(() => harness.cleanup());

const NS = ['media', 'snap', 'px'];
const CHUNK = 1024;
// M6a：非本机来源读写都凭素材票据（auth-contract 第 8 节）。原来这里是集群令牌，只管写；
// 现在 TOKEN 是一张 rw 素材票据，剧本里的读也带上它，另加一步「读不带票据 401」
const { assetTicketKit } = await import('./fake-shared-env.mjs');
const KIT = await assetTicketKit();
const TOKEN = KIT.issue('rw');
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const LAN = 'http://192.168.1.50:8080';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}
const sliceOf = (buf, n) => buf.subarray(n * CHUNK, Math.min(buf.length, (n + 1) * CHUNK));

const put = (base, ns, hash, n, body, headers = {}) => fetch(`${base}/${ns}/${hash}/${n}`, {
  method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', ...headers },
});
const complete = (base, ns, hash, headers = {}) => fetch(`${base}/${ns}/${hash}/complete`, { method: 'POST', headers });
const chunks = async (base, ns, hash) => (await fetch(`${base}/${ns}/${hash}/chunks`)).json();

/** 一次回包的快照：状态码、一组响应头、回包体（JSON 解析；二进制取 sha256 和长度） */
const HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control',
  'access-control-allow-origin', 'access-control-expose-headers', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-allow-private-network', 'access-control-max-age',
];
async function snap(resPromise) {
  const r = await resPromise;
  const headers = {};
  for (const k of HEADERS) headers[k] = r.headers.get(k);
  headers['last-modified?'] = r.headers.get('last-modified') !== null;
  const buf = Buffer.from(await r.arrayBuffer());
  let body;
  if (String(r.headers.get('content-type') || '').startsWith('application/json')) {
    try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8'); }
  } else {
    body = { bytes: buf.length, sha256: buf.length ? sha256(buf) : null };
  }
  return { status: r.status, headers, body };
}

/**
 * S2 的剧本：分片、对账、收尾、Range、HEAD、CORS、401。对一个命名空间跑一遍，
 * 返回 [步骤名, 快照] 列表。服务配了票据核对器、`isTrusted` 恒假：读写都要带票据（M6a；原来只有写要令牌）。
 */
async function script(base, ns) {
  const out = [];
  const step = async (name, p) => { out.push([name, await snap(p)]); };

  const size = CHUNK * 2 + 321; // 3 片
  const buf = bytesOf(size, 11);
  const hash = sha256(buf);
  const h = { 'X-Media-Size': String(size), 'X-Media-Ext': 'bin', ...AUTH };

  await step('预检（局域网来源）', fetch(`${base}/${ns}/${hash}/0`, {
    method: 'OPTIONS',
    headers: { Origin: LAN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-media-size, authorization', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('预检（公网来源）', fetch(`${base}/${ns}/${hash}/chunks`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
  }));
  await step('对账不带票据 401', fetch(`${base}/${ns}/${hash}/chunks`, { headers: { Origin: LAN } }));
  await step('对账：没见过', fetch(`${base}/${ns}/${hash}/chunks`, { headers: { Origin: LAN, ...AUTH } }));
  await step('PUT 不带令牌 401', put(base, ns, hash, 0, sliceOf(buf, 0), { 'X-Media-Size': String(size), Origin: LAN }));
  await step('PUT 令牌错 401', put(base, ns, hash, 0, sliceOf(buf, 0), { 'X-Media-Size': String(size), Authorization: `Bearer ${TOKEN}x` }));
  await step('对账：被拒的不算', fetch(`${base}/${ns}/${hash}/chunks`, { headers: AUTH }));
  await step('PUT 第 0 片', put(base, ns, hash, 0, sliceOf(buf, 0), { ...h, Origin: LAN }));
  await step('PUT 第 2 片', put(base, ns, hash, 2, sliceOf(buf, 2), h));
  await step('对账：收了 0、2', fetch(`${base}/${ns}/${hash}/chunks`, { headers: AUTH }));
  await step('收尾：缺片', complete(base, ns, hash, { ...AUTH, Origin: LAN }));
  await step('补传第 1 片', put(base, ns, hash, 1, sliceOf(buf, 1), h));
  await step('收尾不带令牌 401', complete(base, ns, hash));
  await step('收尾：到齐', complete(base, ns, hash, { ...AUTH, Origin: LAN }));
  await step('对账：已入库', fetch(`${base}/${ns}/${hash}/chunks`, { headers: AUTH }));
  await step('入库后重传', put(base, ns, hash, 0, sliceOf(buf, 0), h));
  await step('入库后再收尾', complete(base, ns, hash, AUTH));

  await step('GET 不带票据 401', fetch(`${base}/${ns}/${hash}`, { headers: { Origin: LAN } }));
  await step('GET 全件', fetch(`${base}/${ns}/${hash}`, { headers: { Origin: LAN, ...AUTH } }));
  await step('GET 大写哈希', fetch(`${base}/${ns}/${hash.toUpperCase()}`, { headers: AUTH }));
  await step('Range 100-199', fetch(`${base}/${ns}/${hash}`, { headers: { Range: 'bytes=100-199', Origin: LAN, ...AUTH } }));
  await step('Range 跨片', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${CHUNK - 10}-${CHUNK + 9}`, ...AUTH } }));
  await step('Range 尾 10', fetch(`${base}/${ns}/${hash}`, { headers: { Range: 'bytes=-10', ...AUTH } }));
  await step('Range 开口', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${size - 5}-`, ...AUTH } }));
  await step('Range 越界 416', fetch(`${base}/${ns}/${hash}`, { headers: { Range: `bytes=${size + 10}-${size + 20}`, ...AUTH } }));
  await step('HEAD', fetch(`${base}/${ns}/${hash}`, { method: 'HEAD', headers: AUTH }));
  await step('HEAD 带 Range', fetch(`${base}/${ns}/${hash}`, { method: 'HEAD', headers: { Range: 'bytes=0-9', ...AUTH } }));
  await step('GET 查询串只读票据', fetch(`${base}/${ns}/${hash}?t=${encodeURIComponent(KIT.issue('r'))}`));
  await step('PUT 只读票据 403', put(base, ns, hash, 0, sliceOf(buf, 0), { ...h, Authorization: `Bearer ${KIT.issue('r')}` }));

  // 409：全件哈希不符
  const small = bytesOf(300, 12);
  const claimed = sha256(Buffer.from('not the same bytes'));
  await step('PUT（哈希不符的内容）', put(base, ns, claimed, 0, small, { 'X-Media-Size': '300', ...AUTH }));
  await step('收尾：hash-mismatch', complete(base, ns, claimed, AUTH));
  await step('对账：丢弃后', fetch(`${base}/${ns}/${claimed}/chunks`, { headers: AUTH }));
  await step('收尾：丢弃后是没见过的', complete(base, ns, claimed, AUTH));
  await step('GET 没入库', fetch(`${base}/${ns}/${claimed}`, { headers: AUTH }));

  // 分片校验
  const s2 = CHUNK + 10;
  const b2 = bytesOf(s2, 13);
  const h2 = sha256(b2);
  const hh = { 'X-Media-Size': String(s2), ...AUTH };
  await step('越界 416', put(base, ns, h2, 2, Buffer.alloc(10), hh));
  await step('长度不对 400', put(base, ns, h2, 1, Buffer.alloc(11), hh));
  await step('缺 size 400', put(base, ns, h2, 1, Buffer.alloc(10), AUTH));
  await step('分片号前导零 400', put(base, ns, h2, '01', Buffer.alloc(10), hh));
  await step('PUT 第 1 片', put(base, ns, h2, 1, sliceOf(b2, 1), hh));
  await step('size 不一致 409', put(base, ns, h2, 0, sliceOf(b2, 0), { 'X-Media-Size': String(s2 + 1), ...AUTH }));
  await step('对账：校验之后', fetch(`${base}/${ns}/${h2}/chunks`, { headers: AUTH }));
  await step('坏哈希 400', fetch(`${base}/${ns}/xyz/chunks`));
  await step('方法不对 405（chunks）', fetch(`${base}/${ns}/${h2}/chunks`, { method: 'POST' }));
  await step('方法不对 405（complete）', fetch(`${base}/${ns}/${h2}/complete`));
  await step('方法不对 405（全件）', fetch(`${base}/${ns}/${h2}`, { method: 'DELETE' }));
  return { out, hash, size };
}

/* ------------------------------------------------------------------ S1 */

test('S1 同一份字节分别传进 media、snap、px：三个命名空间互不可见，一个里有、另一个里 404', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  const buf = bytesOf(CHUNK + 77, 1);
  const hash = sha256(buf);
  const upload = async (ns) => {
    for (let n = 0; n < 2; n++) {
      const r = await put(base, ns, hash, n, sliceOf(buf, n), { 'X-Media-Size': String(buf.length) });
      assert.equal(r.status, 200, `${ns} 第 ${n} 片`);
      await r.arrayBuffer();
    }
    const c = await complete(base, ns, hash);
    assert.equal(c.status, 200, `${ns} 收尾`);
    await c.arrayBuffer();
  };
  const visible = async (ns) => {
    const r = await fetch(`${base}/${ns}/${hash}`);
    const body = Buffer.from(await r.arrayBuffer());
    const st = await chunks(base, ns, hash);
    const head = await fetch(`${base}/${ns}/${hash}`, { method: 'HEAD' });
    return { status: r.status, same: r.status === 200 && body.equals(buf), complete: st.complete, received: st.received, head: head.status };
  };
  const expectState = async (have) => {
    for (const ns of NS) {
      const v = await visible(ns);
      if (have.includes(ns)) {
        assert.deepEqual(v, { status: 200, same: true, complete: true, received: [0, 1], head: 200 }, `${ns} 里应当有`);
        assert.notEqual(await stores[ns].stat(hash), null, `${ns} 的数据层里应当有`);
      } else {
        assert.deepEqual(v, { status: 404, same: false, complete: false, received: [], head: 404 }, `${ns} 里应当没有`);
        assert.equal(await stores[ns].stat(hash), null, `${ns} 的数据层里应当没有`);
      }
    }
  };

  await expectState([]);
  await upload('media');
  await expectState(['media']);
  await upload('snap');
  await expectState(['media', 'snap']);
  await upload('px');
  await expectState(['media', 'snap', 'px']);

  // 分片状态同样互不可见：只在 px 收了一片的另一份字节，media、snap 的对账是「没见过」
  const other = bytesOf(CHUNK + 5, 2);
  const oh = sha256(other);
  assert.equal((await put(base, 'px', oh, 0, sliceOf(other, 0), { 'X-Media-Size': String(other.length) })).status, 200);
  assert.deepEqual(await chunks(base, 'px', oh), { size: other.length, chunkSize: CHUNK, received: [0], complete: false });
  for (const ns of ['media', 'snap']) assert.deepEqual(await chunks(base, ns, oh), { size: null, chunkSize: CHUNK, received: [], complete: false }, ns);
  // 另一个命名空间登记了别的 size 也不冲突（各自一份登记）
  const r = await put(base, 'snap', oh, 0, Buffer.alloc(10), { 'X-Media-Size': '10' });
  assert.equal(r.status, 200, 'snap 里同一个哈希按自己的 size 登记，不和 px 冲突');
  await r.arrayBuffer();
});

/* ------------------------------------------------------------------ S2 */

test('S2 snap、px 的分片、对账、收尾、Range、HEAD、CORS、401 规则与 media 相同，字段逐个比较', async () => {
  const runs = {};
  for (const ns of NS) {
    // 每个命名空间一台新服务，剧本从同一个空状态起跑
    const srv = await harness.serve({ chunkSize: CHUNK, tickets: KIT.tickets, isTrusted: () => false });
    runs[ns] = await script(srv.base, ns);
    await srv.close();
  }
  const ref = runs.media.out;
  // media 自己先按 C5 契约核几处，免得三家一起错
  const get = (name) => ref.find(([n]) => n === name)[1];
  assert.deepEqual(get('对账：没见过').body, { size: null, chunkSize: CHUNK, received: [], complete: false });
  assert.deepEqual([get('PUT 不带令牌 401').status, get('PUT 不带令牌 401').body], [401, { ok: false, error: 'unauthorized' }]);
  assert.deepEqual([get('对账不带票据 401').status, get('对账不带票据 401').body], [401, { ok: false, error: 'unauthorized' }]);
  assert.equal(get('GET 不带票据 401').status, 401);
  assert.equal(get('GET 查询串只读票据').status, 200);
  assert.equal(get('GET 查询串只读票据').headers['cache-control'], 'no-store');
  assert.deepEqual([get('PUT 只读票据 403').status, get('PUT 只读票据 403').body], [403, { ok: false, error: 'forbidden' }]);
  assert.deepEqual(get('对账：收了 0、2').body.received, [0, 2]);
  assert.deepEqual([get('收尾：缺片').status, get('收尾：缺片').body.missing], [400, [1]]);
  assert.equal(get('收尾：到齐').status, 200);
  assert.equal(get('GET 全件').status, 200);
  assert.equal(get('GET 全件').headers['access-control-allow-origin'], '*');
  assert.equal(get('Range 100-199').status, 206);
  assert.equal(get('Range 越界 416').status, 416);
  assert.equal(get('预检（局域网来源）').status, 204);
  assert.equal(get('预检（局域网来源）').headers['access-control-allow-private-network'], 'true');
  assert.equal(get('预检（公网来源）').headers['access-control-allow-private-network'], null);
  assert.deepEqual([get('收尾：hash-mismatch').status, get('收尾：hash-mismatch').body.error], [409, 'hash-mismatch']);

  for (const ns of ['snap', 'px']) {
    const got = runs[ns].out;
    assert.equal(got.length, ref.length);
    for (let i = 0; i < ref.length; i++) {
      const [name, a] = ref[i];
      const [name2, b] = got[i];
      assert.equal(name2, name);
      assert.equal(b.status, a.status, `${ns}「${name}」状态码`);
      // 带 url 的回包长度随 url 变，content-length 不比
      const hasUrl = a.body && typeof a.body === 'object' && 'url' in a.body;
      for (const k of Object.keys(a.headers)) {
        if (hasUrl && k === 'content-length') continue;
        assert.equal(b.headers[k], a.headers[k], `${ns}「${name}」响应头 ${k}`);
      }
      // 收尾回包里的 `url` 是取回地址，按命名空间不同，单独核（见下）；其余字段逐个比较
      const strip = (body) => (body && typeof body === 'object' && 'url' in body ? { ...body, url: typeof body.url } : body);
      assert.deepEqual(strip(b.body), strip(a.body), `${ns}「${name}」回包`);
    }
    // 契约第 10 节第 2 条：snap / px 的 url 是 `/api/asset/<ns>/<hash>`；media 照旧 `/@media/<hash>`
    const fin = got.find(([n]) => n === '收尾：到齐')[1].body;
    assert.equal(fin.url, `/api/asset/${ns}/${runs[ns].hash}`, `${ns} 收尾回包的 url`);
    const again = got.find(([n]) => n === '入库后再收尾')[1].body;
    assert.equal(again.url, `/api/asset/${ns}/${runs[ns].hash}`, `${ns} 入库后再收尾的 url`);
  }
  assert.equal(get('收尾：到齐').body.url, `/@media/${runs.media.hash}`, 'media 的 url 照旧');
});

test('S2b snap / px 专用的 MIME 表认 text/html → html、video/iso.segment → m4s，media 的表不变；X-Media-Ext 优先', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  let seed = 100;
  const one = async (ns, headers) => {
    const buf = bytesOf(200, ++seed);
    const hash = sha256(buf);
    assert.equal((await put(base, ns, hash, 0, buf, { 'X-Media-Size': '200', ...headers })).status, 200);
    assert.equal((await complete(base, ns, hash)).status, 200);
    return (await stores[ns].stat(hash))?.ext;
  };
  for (const ns of ['snap', 'px']) {
    assert.equal(await one(ns, { 'X-Media-Type': 'text/html' }), 'html', `${ns} text/html`);
    assert.equal(await one(ns, { 'X-Media-Type': 'text/html; charset=utf-8' }), 'html', `${ns} text/html; charset`);
    assert.equal(await one(ns, { 'X-Media-Type': 'video/iso.segment' }), 'm4s', `${ns} video/iso.segment`);
    assert.equal(await one(ns, { 'X-Media-Type': 'video/mp4' }), 'mp4', `${ns} video/mp4`);
  }
  for (const ns of NS) {
    assert.equal(await one(ns, { 'X-Media-Ext': 'mp4', 'X-Media-Type': 'video/iso.segment' }), 'mp4', `${ns} 扩展名优先`);
    assert.equal(await one(ns, { 'X-Media-Ext': 'm4s' }), 'm4s', `${ns} 直接给扩展名`);
    assert.equal(await one(ns, {}), '', `${ns} 都没给`);
  }
  // 契约第 10 节第 8、10 条：snap / px 只存候选扩展名（html、mp4、m4s、专用 MIME 表里的全部扩展名、htm、m4v、jpeg），
  // 不在表里的一律存成不带扩展名；media 不受影响
  for (const ns of ['snap', 'px']) {
    assert.equal(await one(ns, { 'X-Media-Ext': 'bin' }), '', `${ns} bin 不在候选表里`);
    assert.equal(await one(ns, { 'X-Media-Ext': 'xyz' }), '', `${ns} xyz 不在候选表里`);
    assert.equal(await one(ns, { 'X-Media-Ext': 'html' }), 'html', `${ns} html 在候选表里`);
    for (const ext of ['htm', 'm4v', 'jpeg']) assert.equal(await one(ns, { 'X-Media-Ext': ext }), ext, `${ns} ${ext} 在候选表里`);
    // png 在专用 MIME 表里：存成 <hash>.png，按候选找得回来
    const png = bytesOf(200, ++seed);
    const ph = sha256(png);
    assert.equal((await put(base, ns, ph, 0, png, { 'X-Media-Size': '200', 'X-Media-Ext': 'png' })).status, 200);
    assert.equal((await complete(base, ns, ph)).status, 200);
    assert.equal((await stores[ns].stat(ph))?.ext, 'png', `${ns} png 存成 <hash>.png`);
    assert.equal((await chunks(base, ns, ph)).complete, true, `${ns} png 按候选算已入库`);
    const back = await fetch(`${base}/${ns}/${ph}`);
    assert.equal(back.status, 200, `${ns} png 取得回来`);
    assert.ok(Buffer.from(await back.arrayBuffer()).equals(png), `${ns} png 字节一致`);
    assert.equal(await one(ns, { 'X-Media-Type': 'image/png' }), 'png', `${ns} image/png 反查出 png，在候选表里`);
  }
  assert.equal(await one('media', { 'X-Media-Ext': 'png' }), 'png', 'media 照旧存 png');
  assert.equal(await one('media', { 'X-Media-Ext': 'bin' }), 'bin', 'media 照旧存 bin');
  // 契约第 10 节第 1 条：不改共享的 MIME_TO_EXT，media 落盘的文件名不变
  assert.equal(await one('media', { 'X-Media-Type': 'text/html' }), '', 'media 不认 text/html');
  assert.equal(await one('media', { 'X-Media-Type': 'video/iso.segment' }), '', 'media 不认 video/iso.segment');
  assert.equal(await one('media', { 'X-Media-Type': 'video/mp4' }), 'mp4', 'media 原有的表照旧');
});

test('S2c 缺省的 snap、px 是 fs 实现，目录固定在 <root>/out/asset-store/<ns>、不看 PROMPTCUT_EXPORT_DIR，不写媒体索引；按候选文件名找已有文件', async () => {
  const fsp = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const exportDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-c62-export-'));
  const before = process.env.PROMPTCUT_EXPORT_DIR;
  process.env.PROMPTCUT_EXPORT_DIR = exportDir;
  try {
    const srv = await harness.serve({ stores: 'default', isTrusted: () => true, token: null });
    const { base, root } = srv;
    const html = Buffer.from('<div data-pc-scene="">snapshot</div>', 'utf8');
    const seg = bytesOf(900, 41);
    const hh = sha256(html), hs = sha256(seg);
    assert.equal((await put(base, 'snap', hh, 0, html, { 'X-Media-Size': String(html.length), 'X-Media-Type': 'text/html' })).status, 200);
    assert.equal((await complete(base, 'snap', hh)).status, 200);
    assert.equal((await put(base, 'px', hs, 0, seg, { 'X-Media-Size': String(seg.length), 'X-Media-Ext': 'm4s' })).status, 200);
    assert.equal((await complete(base, 'px', hs)).status, 200);

    const snapDir = path.join(root, 'out', 'asset-store', 'snap');
    const pxDir = path.join(root, 'out', 'asset-store', 'px');
    assert.ok((await fsp.readFile(path.join(snapDir, `${hh}.html`))).equals(html), 'snap 落在 <root>/out/asset-store/snap/<hash>.html');
    assert.ok((await fsp.readFile(path.join(pxDir, `${hs}.m4s`))).equals(seg), 'px 落在 <root>/out/asset-store/px/<hash>.m4s');
    const walk = async (dir) => {
      const out = [];
      let items = [];
      try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
      for (const item of items) {
        const p = path.join(dir, item.name);
        if (item.isDirectory()) out.push(...await walk(p)); else out.push(p);
      }
      return out;
    };
    for (const file of await walk(exportDir)) {
      assert.ok(!file.includes(hh) && !file.includes(hs), `PROMPTCUT_EXPORT_DIR 下不该有 snap / px 的文件：${file}`);
      if (file.endsWith('.json')) {
        const text = await fsp.readFile(file, 'utf8');
        assert.ok(!text.includes(hh) && !text.includes(hs), `媒体索引不该记 snap / px 的块：${file}`);
      }
    }
    assert.equal((await fetch(`${base}/media/${hh}`)).status, 404, 'media 里没有 snap 的块');

    // 取回（Content-Type 契约没定，不比）
    const g = await fetch(`${base}/snap/${hh}`);
    assert.equal(g.status, 200);
    assert.ok(Buffer.from(await g.arrayBuffer()).equals(html));

    // 候选文件名：直接放进目录的 <hash>.mp4、无扩展名的 <hash> 都找得到，算已入库
    const init = bytesOf(333, 42);
    const hi = sha256(init);
    await fsp.writeFile(path.join(pxDir, `${hi}.mp4`), init);
    const bare = bytesOf(222, 43);
    const hb = sha256(bare);
    await fsp.writeFile(path.join(snapDir, hb), bare);
    assert.equal((await chunks(base, 'px', hi)).complete, true, 'px/<hash>.mp4 算已入库');
    const gi = await fetch(`${base}/px/${hi}`);
    assert.equal(gi.status, 200);
    assert.ok(Buffer.from(await gi.arrayBuffer()).equals(init));
    assert.equal((await chunks(base, 'snap', hb)).complete, true, '无扩展名的 <hash> 也算已入库');
    assert.equal((await fetch(`${base}/snap/${hb}`)).status, 200);

    // 第 8 条：不在候选表里的扩展名存成不带扩展名的 <hash>，之后照样找得到
    const odd = bytesOf(444, 44);
    const ho = sha256(odd);
    assert.equal((await put(base, 'px', ho, 0, odd, { 'X-Media-Size': String(odd.length), 'X-Media-Ext': 'bin' })).status, 200);
    assert.equal((await complete(base, 'px', ho)).status, 200);
    assert.ok((await fsp.readFile(path.join(pxDir, ho))).equals(odd), 'bin 存成 <root>/out/asset-store/px/<hash>');
    await assert.rejects(fsp.stat(path.join(pxDir, `${ho}.bin`)), '不存 <hash>.bin');
    assert.equal((await chunks(base, 'px', ho)).complete, true);
    const go = await fetch(`${base}/px/${ho}`);
    assert.equal(go.status, 200);
    assert.equal(go.headers.get('content-type'), 'application/octet-stream');
    assert.ok(Buffer.from(await go.arrayBuffer()).equals(odd));

    // 第 10 条：png 在候选表里，存成 <hash>.png，按候选文件名找得回来
    const pic = bytesOf(555, 45);
    const hp = sha256(pic);
    assert.equal((await put(base, 'snap', hp, 0, pic, { 'X-Media-Size': String(pic.length), 'X-Media-Ext': 'png' })).status, 200);
    assert.equal((await complete(base, 'snap', hp)).status, 200);
    assert.ok((await fsp.readFile(path.join(snapDir, `${hp}.png`))).equals(pic), 'png 存成 <root>/out/asset-store/snap/<hash>.png');
    assert.equal((await chunks(base, 'snap', hp)).complete, true, '<hash>.png 按候选算已入库');
    const gp = await fetch(`${base}/snap/${hp}`);
    assert.equal(gp.status, 200);
    assert.ok(Buffer.from(await gp.arrayBuffer()).equals(pic));
  } finally {
    if (before === undefined) delete process.env.PROMPTCUT_EXPORT_DIR; else process.env.PROMPTCUT_EXPORT_DIR = before;
    await fsp.rm(exportDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ S3 */

test('S3 旧写法 opts.store 仍然认、当作 stores.media；只给 stores.media 时 media 的行为与 C5 相同', async () => {
  // 旧写法：只传 opts.store
  const legacy = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null, legacyStore: true });
  const buf = bytesOf(CHUNK + 3, 21);
  const hash = sha256(buf);
  for (let n = 0; n < 2; n++) assert.equal((await put(legacy.base, 'media', hash, n, sliceOf(buf, n), { 'X-Media-Size': String(buf.length), 'X-Media-Ext': 'png' })).status, 200);
  const fin = await complete(legacy.base, 'media', hash);
  assert.equal(fin.status, 200);
  assert.deepEqual(await fin.json(), { ok: true, hash, size: buf.length, complete: true, url: `/@media/${hash}` });
  assert.notEqual(await legacy.stores.media.stat(hash), null, 'opts.store 就是 media 的数据层');
  const got = await fetch(`${legacy.base}/media/${hash}`);
  assert.equal(got.status, 200);
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(buf));
  assert.equal(got.headers.get('content-type'), 'image/png');

  // 新写法：media 的回包与旧写法逐字段相同
  const a =await script((await harness.serve({ chunkSize: CHUNK, tickets: KIT.tickets, isTrusted: () => false, legacyStore: true })).base, 'media');
  const b = await script((await harness.serve({ chunkSize: CHUNK, tickets: KIT.tickets, isTrusted: () => false })).base, 'media');
  assert.deepEqual(b.out, a.out, 'stores.media 与 opts.store 的 media 行为相同');
});

/* ------------------------------------------------------------------ S4 */

test('S4 不认识的命名空间：素材服务不处理（交给 next，本测试的兜底回 404）、回 4xx、不落任何状态；isAssetServicePath 只认三个命名空间', async () => {
  const srv = await harness.serve({ chunkSize: CHUNK, isTrusted: () => true, token: null });
  const { base, stores } = srv;
  const buf = bytesOf(100, 31);
  const hash = sha256(buf);
  const is4xx = (s) => s >= 400 && s < 500;
  for (const ns of ['foo', 'snaps', 'pix', 'mediax', 'asset', 'png', 'x']) {
    const p = await put(base, ns, hash, 0, buf, { 'X-Media-Size': '100' });
    assert.ok(is4xx(p.status), `${ns} PUT 回 ${p.status}`);
    // 契约第 10 节第 3 条：中间件交给 next()，回包来自本测试的兜底（纯文本 no route），不是素材服务的 JSON，也不带跨源头
    assert.equal(await p.text(), 'no route', `${ns} PUT 应当落到兜底`);
    assert.equal(p.headers.get('access-control-allow-origin'), null, `${ns} 素材服务没接手，不补跨源头`);
    const c = await complete(base, ns, hash);
    assert.ok(is4xx(c.status), `${ns} complete 回 ${c.status}`);
    assert.equal(await c.text(), 'no route');
    for (const tail of ['/chunks', '']) {
      const g = await fetch(`${base}/${ns}/${hash}${tail}`);
      assert.ok(is4xx(g.status), `${ns} GET${tail} 回 ${g.status}`);
      assert.equal(await g.text(), 'no route');
    }
  }
  for (const ns of NS) {
    assert.deepEqual(await stores[ns].chunks(hash), { size: null, chunkSize: CHUNK, received: [], complete: false }, `${ns} 没落任何状态`);
    assert.equal(await stores[ns].stat(hash), null);
    assert.deepEqual((await stores[ns].usage()).blobs, 0, `${ns} 一件都没入库`);
  }

  const h = 'ab'.repeat(32);
  for (const ns of NS) {
    for (const tail of ['', '/chunks', '/complete', '/0', '/12']) {
      assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}${tail}`), true, `${ns}${tail}`);
    }
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}?x=1`), true, `${ns} 带查询串`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}/bogus`), false, `${ns}/bogus`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}`), false, `${ns} 没有哈希`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/xyz`), false, `${ns} 坏哈希`);
  }
  for (const ns of ['foo', 'snaps', 'pix', 'mediax', 'asset', 'png', 'x', '']) {
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}`), false, `不认 ${JSON.stringify(ns)}`);
    assert.equal(isAssetServicePath(`/api/asset/${ns}/${h}/0`), false, `不认 ${JSON.stringify(ns)}/0`);
  }
  assert.equal(isAssetServicePath(`/api/asset/snap/px/${h}`), false);
  assert.equal(isAssetServicePath(`/api/ai/snap/${h}`), false);
  assert.equal(isAssetServicePath(`/@media/${h}`), false);
});
