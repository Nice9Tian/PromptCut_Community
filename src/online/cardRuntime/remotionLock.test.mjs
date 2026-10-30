/**
 * 载入用户卡时「把顶层锁成只读」的接法（`remotionLock.mjs`），以及在线页面这条载入路径。
 * 跑：node scripts/test-suite.mjs src/online/cardRuntime/remotionLock.test.mjs
 *
 *   RL-01  哪些卡该锁：声明成 remotion 式并且引用了框架；注释、字符串里的字样不算；只带类型的导入不算载入
 *   RL-02  老卡一张都不碰：仓库里现有的每一个卡片与部件文件都不接这一段，转译出来的文本与原来一字不差
 *   RL-03  在线页面：用框架写的示例卡转得出、载得进、渲得出来；先渲第 N 帧再渲第 M 帧与顺着渲相同
 *   RL-04  在线页面：载入之后往顶层的对象里写（绕一道变量，源码检查看不出）当场报错；页面自己的模块没被冻住；
 *          没引用框架的卡（老卡）同样的写法照旧能跑
 *   RL-05  锁不住的东西放在顶层：载入时当场报错，这张卡不生效，说得出是哪一个
 *   RL-06  接上去的这一段在桌面那条路上也是合法的源码（TypeScript 转得过）；源码前面的部分一个字符都不动
 *   RL-08  只有一行裸导入的卡（用不到框架的工具）：认成引用了框架、载入时照样锁；只有声音的卡在声音线程里载入时同样接锁
 *
 * 桌面那条路（开发服务器的转换钩子）在真 Chrome 里由探针 `scripts/probes/remotion-style-probe.mjs` 验。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { transform } from "sucrase";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const require = createRequire(import.meta.url);
const FIX = path.join(ROOT, "server", "test", "fixtures", "remotion-style");
const fixture = (name) => fs.readFileSync(path.join(FIX, name), "utf8").replace(/\r\n/g, "\n");

const K = await import(srcUrl("online/cardRuntime/remotionLock.mjs"));
const T = await import(srcUrl("online/cardRuntime/transpile.ts"));
const L = await import(srcUrl("online/cardRuntime/loader.ts"));
const V = await import(srcUrl("online/cardRuntime/version.ts"));
const FRAMEWORK = await import(srcUrl("kernel/remotionStyle/index.ts"));

const U = "src/cards/user/";
const RUNTIME = V.CARD_RUNTIME_VERSION;
const hashOf = (body) => createHash("sha256").update(body, "utf8").digest("hex");
const lib = (files) => {
  const m = new Map(Object.entries(files).map(([k, body]) => [k, { body, hash: hashOf(body) }]));
  return { read: (k) => m.get(k) ?? null };
};
/** 页面自带的模块：包用真的 React；内置模块里给框架与内核的几个文件（真的那一份） */
const builtinOk = (p) => /^src\/kernel\/[\w/]+\.ts$/.test(p) && fs.existsSync(path.join(ROOT, p));
const host = () => ({
  packages: { react: () => require("react"), "react/jsx-runtime": () => require("react/jsx-runtime") },
  builtin: (p) => (builtinOk(p) ? () => import(srcUrl(p.slice("src/".length))) : null),
});
const bundle = (files, entry) => T.bundleCard({ runtime: RUNTIME, entry, read: lib(files).read, hasBuiltin: builtinOk });
const load = async (files, entry) => {
  const out = await bundle(files, entry);
  assert.equal(out.ok, true, JSON.stringify(out.state));
  const loader = L.createCardLoader({ runtime: RUNTIME, host: host() });
  const [res] = await loader.setBundles([out.bundle]);
  return { out, loader, res };
};

const MARKED = `import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";
const TABLE = { a: 1 };
function C({ t = 0 }: CardProps<{}>) { return <div style={{ opacity: tween(t, { duration: 1 }) }}>{TABLE.a}</div>; }
export const card: CardDef<{}> = { id: "m", name: "m", description: "d", source: "user", frameMode: "direct", defaults: {}, controls: [], Component: C };
`;

test("RL-01 哪些卡该锁：声明成 remotion 式并且引用了框架", () => {
  assert.deepEqual(K.remotionLockPlan(MARKED), { names: ["TABLE", "C", "card"], specifiers: ["../../kernel/remotionStyle"] });
  // 两个条件缺一个都不锁
  assert.equal(K.remotionLockPlan(MARKED.replace('"direct"', '"stateful"')), null, "motion 式的卡");
  assert.equal(K.remotionLockPlan(MARKED.replace('import { tween } from "../../kernel/remotionStyle";', "const tween = (..._a: unknown[]) => 1;")), null, "没引用框架的卡（框架出现之前建的卡都是这样）");
  // 注释、字符串里的字样不算
  const commented = `// frameMode: "direct"，import { x } from "../../kernel/remotionStyle"\nconst note = 'frameMode: "direct" from "../../kernel/remotionStyle"';\n${MARKED.replace('"direct"', '"stateful"')}`;
  assert.equal(K.remotionLockPlan(commented), null);
  const commentedImport = `/* import { tween } from "../../kernel/remotionStyle"; */\n${MARKED.replace('import { tween } from "../../kernel/remotionStyle";', "const tween = (..._a: unknown[]) => 1;")}`;
  assert.equal(K.remotionLockPlan(commentedImport), null);
  // 框架的几种写法都认
  for (const spec of ["../../kernel/remotionStyle", "../../kernel/remotionStyle/index", "../../kernel/remotionStyle/index.ts", "../../../kernel/remotionStyle"]) assert.equal(K.isFrameworkSpecifier(spec), true, spec);
  for (const spec of ["../../kernel/remotionStyle/lock", "../../kernel/remotionStyleX", "remotionStyle", "../../kernel/types"]) assert.equal(K.isFrameworkSpecifier(spec), false, spec);

  // 顶层有值的名字都收：解构出来的、长名字（词法表里会截短，按位置回源码取）、非英文的名字、导出的；类型与函数里面的不收
  const names = `import React, { useMemo } from "react";
import type { CardDef } from "../../kernel/types";
import { CardProps } from "../../kernel/types";
import { interpolate, Easing } from "../../kernel/remotionStyle";
import { hudDefaults } from "../native/hud";
import "./side-effect";
import raw from "./data.json";
import css from "./look.css";
const 调色板 = ["#f00"]; const { a, b: [c] } = { a: 1, b: [2] };
const EASE = Easing.bezier(0.16, 1, 0.3, 1);
interface Params { text: string }
type Local = number;
function aVeryLongComponentNameThatTheTokenTableTruncates({ params, t = 0 }: CardProps<Params>) { const inner = 1; return <React.Fragment>{useMemo(() => inner, [])}{interpolate(t, [0, 1], [0, 1])}</React.Fragment>; }
export const card: CardDef<Params> = { id: "n", frameMode: "direct", defaults: { ...hudDefaults }, Component: aVeryLongComponentNameThatTheTokenTableTruncates, raw, css };
`;
  for (const source of [names, names.replace(/\n/g, "\r\n")]) {
    assert.deepEqual(K.remotionLockPlan(source), {
      names: ["调色板", "a", "c", "EASE", "aVeryLongComponentNameThatTheTokenTableTruncates", "card"],
      // 只带类型的导入（两种写法）不载入；样式与数据文件不当模块；只为副作用的导入照样算
      specifiers: ["react", "../../kernel/remotionStyle", "../native/hud", "./side-effect"],
    });
  }
  // 接上去的那一段：相对路径按文件所在的目录算；不在 src/ 下的不接
  const suffix = K.remotionLockSuffix(`${U}m.tsx`, MARKED);
  assert.match(suffix, /^\n\/\* [^\n]*\*\/\nimport \{ lockTopLevel as __pcLockTopLevel \} from "\.\.\/\.\.\/kernel\/remotionStyle\/lock";\n/);
  assert.match(suffix, /__pcLockTopLevel\("src\/cards\/user\/m\.tsx", \[\["TABLE", \(\) => TABLE\], \["C", \(\) => C\], \["card", \(\) => card\]\], \[__pcForeign0\]\);\n$/);
  assert.match(K.remotionLockSuffix(`${U}deep/m.tsx`, MARKED), /from "\.\.\/\.\.\/\.\.\/kernel\/remotionStyle\/lock"/);
  assert.equal(K.remotionLockSuffix("elsewhere/m.tsx", MARKED), "");
  assert.equal(K.remotionLockSuffix(`${U}m.tsx`, MARKED.replace('"direct"', '"stateful"')), "");
  // 写坏的源码、不是字符串：不锁，也不抛
  assert.equal(K.remotionLockPlan(`${MARKED}\nconst broken = {`), null);
  assert.equal(K.remotionLockPlan(undefined), null);
});

test("RL-02 老卡一张都不碰：仓库里现有的每个卡片与部件文件都不接这一段，转译结果一字不差", () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = [...walk(path.join(ROOT, "src", "cards")), ...walk(path.join(ROOT, "src", "parts"))].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.(test|d)\./.test(f));
  assert.ok(files.length > 60, `卡片与部件文件 ${files.length} 个`);
  let direct = 0;
  for (const file of files) {
    const key = path.relative(ROOT, file).replace(/\\/g, "/");
    const source = fs.readFileSync(file, "utf8");
    if (/frameMode:\s*"direct"/.test(source)) direct++;
    assert.equal(K.remotionLockPlan(source), null, key);
    assert.equal(K.remotionLockSuffix(key, source), "", key);
    const got = T.transpileCardFile(key, source);
    if (!got.ok) continue; // 在线页面本来就不支持的写法（与这里无关），原样
    const plain = transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true, preserveDynamicImport: true, filePath: key }).code;
    assert.equal(got.js, plain, `${key} 转出来的文本变了`);
  }
  // 声明成 remotion 式的内置卡确实在这批文件里（它们不是用框架写的，所以同样不锁）
  assert.ok(direct >= 4, `声明成 remotion 式的内置文件 ${direct} 个`);
  // 违规样例与对照卡里，没引用框架的那几张同样不锁
  for (const name of ["rs-stateful-control.tsx", "violations/framework.tsx"]) assert.equal(K.remotionLockSuffix(`${U}x.tsx`, fixture(name)), "", name);
});

test("RL-03 在线页面：用框架写的示例卡转得出、载得进、渲得出来；先渲第 N 帧再渲第 M 帧与顺着渲相同", async () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  for (const name of ["rs-title-reveal.tsx", "rs-bar-race.tsx", "rs-orbit-canvas.tsx"]) {
    const entry = `${U}${name}`;
    const { out, loader, res } = await load({ [entry]: fixture(name) }, entry);
    assert.equal(res.ok, true, JSON.stringify(res.state));
    // 包里记着运行时那一半：舞台按它去取页面自带的模块
    assert.deepEqual(out.bundle.modules[0].imports["../../kernel/remotionStyle/lock"], { kind: "builtin", path: "src/kernel/remotionStyle/lock.ts" });
    assert.deepEqual(out.bundle.modules[0].imports["../../kernel/remotionStyle"], { kind: "builtin", path: "src/kernel/remotionStyle/index.ts" });
    assert.match(out.bundle.modules[0].js, /^"use strict";/, "转出来的是严格模式：往冻住的对象里写会抛错，不是悄悄不生效");
    const [def] = loader.cards();
    assert.ok(Object.isFrozen(def) && Object.isFrozen(def.defaults) && Object.isFrozen(def.controls) && Object.isFrozen(def.Component), `${name} 的卡片定义锁住了`);
    const frame = (n) => renderToStaticMarkup(React.createElement(def.Component, { params: { ...def.defaults }, playToken: 0, t: n / 30, duration: 5 }));
    const forward = [];
    for (let n = 0; n <= 60; n++) forward.push(frame(n));
    // 画布卡的像素是在浏览器里画的，这里只有一个空的 <canvas>（像素由真 Chrome 里的探针比）；另两张的标记确实随时间变
    if (name !== "rs-orbit-canvas.tsx") assert.notEqual(forward[3], forward[40], "画面确实随时间变");
    for (const n of [60, 0, 37, 12, 59, 1]) assert.equal(frame(n), forward[n], `${name} 第 ${n} 帧`);
    for (let n = 60; n >= 0; n--) assert.equal(frame(n), forward[n], `${name} 倒着渲到第 ${n} 帧`);
  }
});

test("RL-04 在线页面：载入之后往顶层的对象里写当场报错；页面自己的模块没被冻住；老卡照旧能跑", async () => {
  const React = require("react");
  const entry = `${U}rs-alias-write.tsx`;
  const source = fixture("rs-alias-write.tsx");
  const { loader, res } = await load({ [entry]: source }, entry);
  assert.equal(res.ok, true, JSON.stringify(res.state));
  const [def] = loader.cards();
  // 不写的时候照常渲
  const quiet = def.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 });
  assert.equal(quiet.type, "div");
  // 一写就抛：对象的属性、数组的 push
  for (const text of ["write-object", "write-array"]) {
    assert.throws(() => def.Component({ params: { text }, playToken: 0, t: 0.2 }), (err) => err instanceof TypeError, text);
  }
  // 写没写进去：再渲一次，计数还是 0、数组还是一个元素
  assert.deepEqual(def.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 }).props.children, ["read-only", 0, 1]);
  // 页面自己的模块（React、框架）不是这张卡的，没被冻住
  assert.equal(Object.isFrozen(React), false);
  assert.equal(Object.isFrozen(require("react/jsx-runtime")), false);
  assert.equal(Object.isFrozen(FRAMEWORK.tween), false, "框架的函数是页面那一份，卡片锁只读时不碰它");
  assert.equal(Object.isFrozen(FRAMEWORK.Easing), true, "这张表是框架自己冻的");

  // 同样的写法、没引用框架的卡（框架出现之前建的卡都是这样）：不锁，照旧能跑、照旧写得进去
  const old = source.replace('import { tween } from "../../kernel/remotionStyle";\n', "const tween = (t: number, _o: unknown) => Math.min(1, t);\n");
  const oldEntry = `${U}old-alias-write.tsx`;
  const loaded = await load({ [oldEntry]: old.replace('"rs-alias-write"', '"old-alias-write"') }, oldEntry);
  assert.equal(loaded.res.ok, true, JSON.stringify(loaded.res.state));
  const [oldDef] = loaded.loader.cards();
  assert.equal(Object.isFrozen(oldDef), false);
  oldDef.Component({ params: { text: "write-object" }, playToken: 0, t: 0.2 });
  oldDef.Component({ params: { text: "write-array" }, playToken: 0, t: 0.2 });
  assert.deepEqual(oldDef.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 }).props.children, ["read-only", 1, 2], "老卡的行为没变");
});

test("RL-05 锁不住的东西放在顶层：载入时当场报错，这张卡不生效", async () => {
  const entry = `${U}buffer.tsx`;
  // 建卡检查不许顶层 new；这里绕过它（经函数返回），由载入时的这一道拦住
  const source = MARKED.replace("const TABLE = { a: 1 };", "function make() { return new Float32Array(4); }\nconst TABLE = { a: 1, buf: make() };").replace('id: "m"', 'id: "buffer"');
  const { loader, res } = await load({ [entry]: source }, entry);
  assert.equal(res.ok, false);
  assert.equal(res.state.state, "load-error");
  assert.match(res.state.detail, /buffer\.tsx.*TABLE\.buf.*Float32Array.*锁不成只读/s);
  assert.deepEqual(loader.cards(), []);
});

test("RL-06 接上去的这一段在桌面那条路上也是合法的源码；源码前面的部分一个字符都不动", () => {
  const ts = require("typescript");
  for (const name of ["rs-title-reveal.tsx", "rs-bar-race.tsx", "rs-orbit-canvas.tsx", "rs-alias-write.tsx"]) {
    const source = fixture(name);
    const key = `${U}${name}`;
    const suffix = K.remotionLockSuffix(key, source);
    assert.ok(suffix.startsWith("\n") && suffix.includes("__pcLockTopLevel("), name);
    const full = source + suffix;
    assert.equal(full.slice(0, source.length), source);
    // 桌面：开发服务器把 TSX 当 ES 模块转
    const out = ts.transpileModule(full, { reportDiagnostics: true, fileName: key, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, isolatedModules: true } });
    assert.deepEqual((out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")), [], name);
    assert.match(out.outputText, /import \{ lockTopLevel as __pcLockTopLevel \} from "\.\.\/\.\.\/kernel\/remotionStyle\/lock";/);
    assert.match(out.outputText, /import \* as __pcForeign0 from /);
    // 在线：转成 CommonJS 之后每个 require 都认得
    const got = T.transpileCardFile(key, source);
    assert.equal(got.ok, true);
    assert.ok(got.specifiers.includes("../../kernel/remotionStyle/lock"), name);
  }
});

test("RL-07 转译缓存：该锁的卡另用一个键，别的卡的键不变；运行时版本不动", async () => {
  // 运行时版本进纯浏览器节点的环境指纹：动了它，在线浏览器里所有卡的键都跟着变。所以不动它，只给该锁的卡换缓存键
  assert.equal(V.CARD_RUNTIME_ABI, "ocr2");
  const plain = MARKED.replace('import { tween } from "../../kernel/remotionStyle";', "const tween = (..._a: unknown[]) => 1;").replace('id: "m"', 'id: "p"');
  const files = { [`${U}m.tsx`]: MARKED, [`${U}p.tsx`]: plain };
  const seen = [];
  const store = new Map();
  const cache = { get: (key, hash) => { seen.push(["get", key, hash]); return store.get(`${key}|${hash}`); }, set: (key, hash, value) => { seen.push(["set", key, hash]); store.set(`${key}|${hash}`, value); } };
  const run = (entry) => T.bundleCard({ runtime: RUNTIME, entry, read: lib(files).read, hasBuiltin: builtinOk, cache });
  const marked = await run(`${U}m.tsx`), unmarked = await run(`${U}p.tsx`);
  assert.equal(marked.ok && unmarked.ok, true);
  assert.deepEqual(seen, [
    ["get", `${U}m.tsx`, `${hashOf(MARKED)}${K.REMOTION_LOCK_CACHE_TAG}`], ["set", `${U}m.tsx`, `${hashOf(MARKED)}${K.REMOTION_LOCK_CACHE_TAG}`],
    ["get", `${U}p.tsx`, hashOf(plain)], ["set", `${U}p.tsx`, hashOf(plain)],
  ]);
  // 「没接这一段」时存下的旧结果（键是光秃秃的内容哈希）不会被该锁的卡拿去用
  store.set(`${U}m.tsx|${hashOf(MARKED)}`, { ok: true, js: "exports.stale = true;", specifiers: [] });
  const again = await run(`${U}m.tsx`);
  assert.match(again.bundle.modules[0].js, /lockTopLevel/);
  // 这一代的签名里还是内容哈希本身：同一份源码在哪儿算都是同一代
  assert.equal(marked.bundle.generation, T.generationOf(RUNTIME, [[`${U}m.tsx`, hashOf(MARKED)]]));
});

test("RL-08 只有一行裸导入的卡：认成引用了框架，载入时照样锁；只有声音的卡在声音线程里载入时同样接锁", async () => {
  // 裸导入：该锁；它是「只为副作用的导入」，算真的会载入的模块
  const source = fixture("rs-bare-import.tsx");
  assert.deepEqual(K.remotionLockPlan(source), { names: ["COUNTER", "C", "card"], specifiers: ["../../kernel/remotionStyle"] });
  assert.notEqual(K.remotionLockSuffix(`${U}rs-bare-import.tsx`, source), "");
  // 去掉那一行就不锁（没引用框架的违规样例同理）
  assert.equal(K.remotionLockPlan(source.replace('import "../../kernel/remotionStyle";\n', "")), null);
  assert.equal(K.remotionLockPlan(fixture("violations/framework.tsx")), null);

  // 在线页面：载得进，顶层锁住，绕一道变量往里写当场报错
  const entry = `${U}rs-bare-import.tsx`;
  const { out, loader, res } = await load({ [entry]: source }, entry);
  assert.equal(res.ok, true, JSON.stringify(res.state));
  assert.deepEqual(out.bundle.modules[0].imports["../../kernel/remotionStyle"], { kind: "builtin", path: "src/kernel/remotionStyle/index.ts" });
  assert.deepEqual(out.bundle.modules[0].imports["../../kernel/remotionStyle/lock"], { kind: "builtin", path: "src/kernel/remotionStyle/lock.ts" });
  const [def] = loader.cards();
  assert.ok(Object.isFrozen(def) && Object.isFrozen(def.defaults), "卡片定义锁住了");
  assert.equal(def.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 }).type, "div");
  assert.throws(() => def.Component({ params: { text: "write-object" }, playToken: 0, t: 0.2 }), (err) => err instanceof TypeError);
  assert.deepEqual(def.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 }).props.children, ["read-only", 0]);

  // 只有 audio() 的卡：声音线程用的是同一个打包函数和同一个加载器（`soundThread.ts`），模块表里 `src/kernel/` 是真的
  // （`soundModules.ts`）。这里用同样形状的模块表载一遍：接了锁，顶层的对象写不进去
  const sound = `import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { createNotificationRecipe, renderSoundEffectBlock } from "../../kernel/soundEffects";
const CACHE = { calls: 0 };
export const card: CardDef<{}> = {
  id: "rs-sound-only", name: "只有声音", description: "d", source: "user", kind: "animation", inputs: {}, frameMode: "direct", defaults: {}, controls: [],
  audio: (_sources, range) => {
    const cache = CACHE;
    cache.calls += 1;
    return renderSoundEffectBlock(createNotificationRecipe({ frequency: 660, gain: 0.5, duration: 0.2 }), { start: range.start, count: range.count });
  },
};
`;
  assert.deepEqual(K.remotionLockPlan(sound), { names: ["CACHE", "card"], specifiers: ["../../kernel/remotionStyle", "../../kernel/soundEffects"] });
  const TH = await import(srcUrl("online/cardRuntime/soundThread.ts"));
  const soundEntry = `${U}rs-sound-only.tsx`;
  const bundled = await bundle({ [soundEntry]: sound }, soundEntry);
  assert.equal(bundled.ok, true, JSON.stringify(bundled.state));
  assert.deepEqual(bundled.bundle.modules[0].imports["../../kernel/remotionStyle/lock"], { kind: "builtin", path: "src/kernel/remotionStyle/lock.ts" });
  const posted = [];
  const thread = TH.createSoundThread({ runtime: RUNTIME, host: host(), post: (m) => posted.push(m) });
  await thread.handle({ t: "load", seq: 1, bundles: [bundled.bundle] });
  const loaded = posted.find((m) => m.t === "loaded");
  assert.deepEqual([loaded.audioCards, loaded.blocked], [["rs-sound-only"], {}], JSON.stringify(loaded));
  const project = { version: 1, id: "p", name: "p", width: 640, height: 360, fps: 30, duration: 2, media: [], tracks: [{ id: "t", name: "t", clips: [{ id: "c1", cardId: "rs-sound-only", start: 0, end: 0.5, params: {} }] }] };
  await thread.handle({ t: "project", key: "k1", project });
  await thread.handle({ t: "render", id: 1, key: "k1", nodeId: "@clip/c1", start: 0, count: 64, sampleRate: 48000 });
  const answer = posted.find((m) => m.id === 1);
  assert.equal(answer.t, "error", `往锁住的顶层对象里写：这一块合成不了，报错而不是悄悄带着状态。实际：${JSON.stringify(answer?.t)}`);
});
