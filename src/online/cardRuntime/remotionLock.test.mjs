/**
 * Wiring for "locking top level as read-only" when loading user cards (`remotionLock.mjs`), and
 * the online page loading path.
 * Run: node scripts/test-suite.mjs src/online/cardRuntime/remotionLock.test.mjs
 *
 *   RL-01  Which cards should be locked: declared as remotion-style and importing the framework;
 *     occurrences in comments or strings do not count; type-only imports do not count as loading
 *   RL-02  Do not touch any old cards: none of the existing card and part files in the repository
 *     attach this snippet, and transpiled text is verbatim identical to before
 *   RL-03  Online page: sample cards written with the framework can be transpiled, loaded, and
 *     rendered; rendering frame N first then frame M produces the same result as sequential
 *     rendering
 *   RL-04  Online page: writing to top-level objects after loading (via an indirection variable
 *     undetectable by source inspection) throws immediately; page's own modules are not frozen;
 *     cards not importing the framework (old cards) written the same way still run as usual
 *   RL-05  Unlockable values placed at top level: throws immediately upon loading, this card does
 *     not take effect, and identifies which one
 *   RL-06  The appended snippet is also valid source code on desktop path (passes TypeScript
 *     transpilation); not a single character in the preceding part of source code is modified
 *   RL-08  Cards with only a bare import (not using framework utilities): recognized as
 *     referencing framework and locked upon loading all the same; audio-only cards are also locked
 *     when loaded in sound thread
 *
 * The desktop path (dev server transform hook) is verified in real Chrome by the probe
 * `scripts/probes/remotion-style-probe.mjs`.
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
/**
 * Page built-in modules: packages use real React; built-in modules provide several files for
 * framework and kernel (the real ones)
 */
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

test("RL-01 Which cards should be locked: declared as remotion style and referencing the framework", () => {
  assert.deepEqual(K.remotionLockPlan(MARKED), { names: ["TABLE", "C", "card"], specifiers: ["../../kernel/remotionStyle"] });
  // Do not lock if either condition is missing
  assert.equal(K.remotionLockPlan(MARKED.replace('"direct"', '"stateful"')), null, "motion-style card");
  assert.equal(K.remotionLockPlan(MARKED.replace('import { tween } from "../../kernel/remotionStyle";', "const tween = (..._a: unknown[]) => 1;")), null, "card that does not reference the framework (every card built before the framework existed looks like this)");
  // Occurrences in comments or strings do not count
  const commented = `// frameMode: "direct", import { x } from "../../kernel/remotionStyle"\nconst note = 'frameMode: "direct" from "../../kernel/remotionStyle"';\n${MARKED.replace('"direct"', '"stateful"')}`;
  assert.equal(K.remotionLockPlan(commented), null);
  const commentedImport = `/* import { tween } from "../../kernel/remotionStyle"; */\n${MARKED.replace('import { tween } from "../../kernel/remotionStyle";', "const tween = (..._a: unknown[]) => 1;")}`;
  assert.equal(K.remotionLockPlan(commentedImport), null);
  // Recognizes all syntax forms of the framework
  for (const spec of ["../../kernel/remotionStyle", "../../kernel/remotionStyle/index", "../../kernel/remotionStyle/index.ts", "../../../kernel/remotionStyle"]) assert.equal(K.isFrameworkSpecifier(spec), true, spec);
  for (const spec of ["../../kernel/remotionStyle/lock", "../../kernel/remotionStyleX", "remotionStyle", "../../kernel/types"]) assert.equal(K.isFrameworkSpecifier(spec), false, spec);

  // Collect all names with top-level values: destructured, long names (truncated in token table,
  // retrieved from source by position), non-English names, exported; types and those inside
  // functions are not collected
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
      // Type-only imports (both syntax forms) are not loaded; style and data files are not treated as
      // modules; side-effect-only imports still count
      specifiers: ["react", "../../kernel/remotionStyle", "../native/hud", "./side-effect"],
    });
  }
  // The appended snippet: relative paths are resolved relative to the file directory; do not append
  // if not under src/
  const suffix = K.remotionLockSuffix(`${U}m.tsx`, MARKED);
  assert.match(suffix, /^\n\/\* [^\n]*\*\/\nimport \{ lockTopLevel as __pcLockTopLevel \} from "\.\.\/\.\.\/kernel\/remotionStyle\/lock";\n/);
  assert.match(suffix, /__pcLockTopLevel\("src\/cards\/user\/m\.tsx", \[\["TABLE", \(\) => TABLE\], \["C", \(\) => C\], \["card", \(\) => card\]\], \[__pcForeign0\]\);\n$/);
  assert.match(K.remotionLockSuffix(`${U}deep/m.tsx`, MARKED), /from "\.\.\/\.\.\/\.\.\/kernel\/remotionStyle\/lock"/);
  assert.equal(K.remotionLockSuffix("elsewhere/m.tsx", MARKED), "");
  assert.equal(K.remotionLockSuffix(`${U}m.tsx`, MARKED.replace('"direct"', '"stateful"')), "");
  // Malformed source code or non-string: do not lock, and do not throw
  assert.equal(K.remotionLockPlan(`${MARKED}\nconst broken = {`), null);
  assert.equal(K.remotionLockPlan(undefined), null);
});

test("RL-02 old cards are left untouched: no existing card or part file in the repo gets this appended segment, and the transpiled output is identical character for character", () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = [...walk(path.join(ROOT, "src", "cards")), ...walk(path.join(ROOT, "src", "parts"))].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.(test|d)\./.test(f));
  assert.ok(files.length > 60, `${files.length} card and part files`);
  let direct = 0;
  for (const file of files) {
    const key = path.relative(ROOT, file).replace(/\\/g, "/");
    const source = fs.readFileSync(file, "utf8");
    if (/frameMode:\s*"direct"/.test(source)) direct++;
    assert.equal(K.remotionLockPlan(source), null, key);
    assert.equal(K.remotionLockSuffix(key, source), "", key);
    const got = T.transpileCardFile(key, source);
    if (!got.ok) continue; // Syntax unsupported by online page in the first place (unrelated here): left as is
    const plain = transform(source, { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic", production: true, preserveDynamicImport: true, filePath: key }).code;
    assert.equal(got.js, plain, `The transpiled text of ${key} changed`);
  }
  // Built-in cards declared as remotion-style are indeed among these files (they are not written
  // with the framework, so they are not locked either)
  assert.ok(direct >= 4, `${direct} built-in files declared as remotion-style`);
  // Among violation samples and control cards, those not importing the framework are not locked either
  for (const name of ["rs-stateful-control.tsx", "violations/framework.tsx"]) assert.equal(K.remotionLockSuffix(`${U}x.tsx`, fixture(name)), "", name);
});

test("RL-03 online page: the sample card written with the framework can be transpiled, loaded and rendered; rendering frame N then frame M gives the same result as rendering sequentially", async () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  for (const name of ["rs-title-reveal.tsx", "rs-bar-race.tsx", "rs-orbit-canvas.tsx"]) {
    const entry = `${U}${name}`;
    const { out, loader, res } = await load({ [entry]: fixture(name) }, entry);
    assert.equal(res.ok, true, JSON.stringify(res.state));
    // Package records the runtime half: stage fetches page built-in modules according to it
    assert.deepEqual(out.bundle.modules[0].imports["../../kernel/remotionStyle/lock"], { kind: "builtin", path: "src/kernel/remotionStyle/lock.ts" });
    assert.deepEqual(out.bundle.modules[0].imports["../../kernel/remotionStyle"], { kind: "builtin", path: "src/kernel/remotionStyle/index.ts" });
    assert.match(out.bundle.modules[0].js, /^"use strict";/, "The transpiled output is in strict mode: writing to a frozen object throws instead of silently having no effect");
    const [def] = loader.cards();
    assert.ok(Object.isFrozen(def) && Object.isFrozen(def.defaults) && Object.isFrozen(def.controls) && Object.isFrozen(def.Component), `The card definition of ${name} is locked`);
    const frame = (n) => renderToStaticMarkup(React.createElement(def.Component, { params: { ...def.defaults }, playToken: 0, t: n / 30, duration: 5 }));
    const forward = [];
    for (let n = 0; n <= 60; n++) forward.push(frame(n));
    // Pixels of canvas cards are drawn in browser, here there is only an empty <canvas> (pixels are
    // compared by probes in real Chrome); tokens of the other two cards indeed change over time
    if (name !== "rs-orbit-canvas.tsx") assert.notEqual(forward[3], forward[40], "The picture really changes over time");
    for (const n of [60, 0, 37, 12, 59, 1]) assert.equal(frame(n), forward[n], `${name} frame ${n}`);
    for (let n = 60; n >= 0; n--) assert.equal(frame(n), forward[n], `${name} rendered backwards to frame ${n}`);
  }
});

test("RL-04 online page: writing to a top-level object after load throws immediately; the page's own modules are not frozen; old cards still run as before", async () => {
  const React = require("react");
  const entry = `${U}rs-alias-write.tsx`;
  const source = fixture("rs-alias-write.tsx");
  const { loader, res } = await load({ [entry]: source }, entry);
  assert.equal(res.ok, true, JSON.stringify(res.state));
  const [def] = loader.cards();
  // Renders as usual when not writing
  const quiet = def.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 });
  assert.equal(quiet.type, "div");
  // Throws on write: object properties, array push
  for (const text of ["write-object", "write-array"]) {
    assert.throws(() => def.Component({ params: { text }, playToken: 0, t: 0.2 }), (err) => err instanceof TypeError, text);
  }
  // Whether write took effect: render again, count is still 0, array still has one element
  assert.deepEqual(def.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 }).props.children, ["read-only", 0, 1]);
  // Page's own modules (React, framework) do not belong to this card, not frozen
  assert.equal(Object.isFrozen(React), false);
  assert.equal(Object.isFrozen(require("react/jsx-runtime")), false);
  assert.equal(Object.isFrozen(FRAMEWORK.tween), false, "The framework's functions are the page's own copy; the card lock does not touch them when making things read-only");
  assert.equal(Object.isFrozen(FRAMEWORK.Easing), true, "This table is frozen by the framework itself");

  // Same syntax for cards not importing the framework (all cards created before the framework are
  // like this): do not lock, run as usual, writes still succeed
  const old = source.replace('import { tween } from "../../kernel/remotionStyle";\n', "const tween = (t: number, _o: unknown) => Math.min(1, t);\n");
  const oldEntry = `${U}old-alias-write.tsx`;
  const loaded = await load({ [oldEntry]: old.replace('"rs-alias-write"', '"old-alias-write"') }, oldEntry);
  assert.equal(loaded.res.ok, true, JSON.stringify(loaded.res.state));
  const [oldDef] = loaded.loader.cards();
  assert.equal(Object.isFrozen(oldDef), false);
  oldDef.Component({ params: { text: "write-object" }, playToken: 0, t: 0.2 });
  oldDef.Component({ params: { text: "write-array" }, playToken: 0, t: 0.2 });
  assert.deepEqual(oldDef.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 }).props.children, ["read-only", 1, 2], "Old card behavior is unchanged");
});

test("RL-05 something that cannot be locked is placed at top level: it throws immediately on load and this card does not take effect", async () => {
  const entry = `${U}buffer.tsx`;
  // Card creation check forbids top-level new; bypassed here (returned via a function), and blocked
  // by this check during loading
  const source = MARKED.replace("const TABLE = { a: 1 };", "function make() { return new Float32Array(4); }\nconst TABLE = { a: 1, buf: make() };").replace('id: "m"', 'id: "buffer"');
  const { loader, res } = await load({ [entry]: source }, entry);
  assert.equal(res.ok, false);
  assert.equal(res.state.state, "load-error");
  assert.match(res.state.detail, /buffer\.tsx.*TABLE\.buf.*Float32Array.*cannot be locked read-only/s);
  assert.deepEqual(loader.cards(), []);
});

test("RL-06 the appended segment is also valid source on the desktop path; not a single character of the source before it is changed", () => {
  const ts = require("typescript");
  for (const name of ["rs-title-reveal.tsx", "rs-bar-race.tsx", "rs-orbit-canvas.tsx", "rs-alias-write.tsx"]) {
    const source = fixture(name);
    const key = `${U}${name}`;
    const suffix = K.remotionLockSuffix(key, source);
    assert.ok(suffix.startsWith("\n") && suffix.includes("__pcLockTopLevel("), name);
    const full = source + suffix;
    assert.equal(full.slice(0, source.length), source);
    // Desktop: dev server transforms TSX as ES modules
    const out = ts.transpileModule(full, { reportDiagnostics: true, fileName: key, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, isolatedModules: true } });
    assert.deepEqual((out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")), [], name);
    assert.match(out.outputText, /import \{ lockTopLevel as __pcLockTopLevel \} from "\.\.\/\.\.\/kernel\/remotionStyle\/lock";/);
    assert.match(out.outputText, /import \* as __pcForeign0 from /);
    // Online: after transpiling to CommonJS, every require is recognized
    const got = T.transpileCardFile(key, source);
    assert.equal(got.ok, true);
    assert.ok(got.specifiers.includes("../../kernel/remotionStyle/lock"), name);
  }
});

test("RL-07 transpile cache: a card that must be locked uses a separate key, keys of other cards are unchanged; runtime version is unchanged", async () => {
  // Runtime version enters environment fingerprint of pure browser nodes: modifying it causes
  // keys of all cards in online browser to change. So leave it untouched, only change cache keys for
  // cards that should be locked
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
  // Old results stored before "attaching this snippet" (keyed by bare content hash) will not be
  // used by cards that should be locked
  store.set(`${U}m.tsx|${hashOf(MARKED)}`, { ok: true, js: "exports.stale = true;", specifiers: [] });
  const again = await run(`${U}m.tsx`);
  assert.match(again.bundle.modules[0].js, /lockTopLevel/);
  // Signature of this generation is still content hash itself: same source code is considered the
  // same generation wherever computed
  assert.equal(marked.bundle.generation, T.generationOf(RUNTIME, [[`${U}m.tsx`, hashOf(MARKED)]]));
});

test("RL-08 a card with only a bare import line: recognized as referencing the framework and still locked on load; a card with only sound is also locked when loaded in the sound thread", async () => {
  // Bare imports: should lock; they are "side-effect-only imports" and count as genuinely loaded
  // modules
  const source = fixture("rs-bare-import.tsx");
  assert.deepEqual(K.remotionLockPlan(source), { names: ["COUNTER", "C", "card"], specifiers: ["../../kernel/remotionStyle"] });
  assert.notEqual(K.remotionLockSuffix(`${U}rs-bare-import.tsx`, source), "");
  // Removing that line skips locking (the same applies to violation samples not importing the
  // framework)
  assert.equal(K.remotionLockPlan(source.replace('import "../../kernel/remotionStyle";\n', "")), null);
  assert.equal(K.remotionLockPlan(fixture("violations/framework.tsx")), null);

  // Online page: loads, top level locked; writing into it via an intermediate variable throws immediately
  const entry = `${U}rs-bare-import.tsx`;
  const { out, loader, res } = await load({ [entry]: source }, entry);
  assert.equal(res.ok, true, JSON.stringify(res.state));
  assert.deepEqual(out.bundle.modules[0].imports["../../kernel/remotionStyle"], { kind: "builtin", path: "src/kernel/remotionStyle/index.ts" });
  assert.deepEqual(out.bundle.modules[0].imports["../../kernel/remotionStyle/lock"], { kind: "builtin", path: "src/kernel/remotionStyle/lock.ts" });
  const [def] = loader.cards();
  assert.ok(Object.isFrozen(def) && Object.isFrozen(def.defaults), "The card definition is locked");
  assert.equal(def.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 }).type, "div");
  assert.throws(() => def.Component({ params: { text: "write-object" }, playToken: 0, t: 0.2 }), (err) => err instanceof TypeError);
  assert.deepEqual(def.Component({ params: { text: "read-only" }, playToken: 0, t: 0.2 }).props.children, ["read-only", 0]);

  // Cards with only audio(): the sound thread uses the same bundle function and same loader
  // (`soundThread.ts`), and `src/kernel/` in the module table is real (`soundModules.ts`). Load once
  // here with a module table of the same shape: lock attached, top-level objects cannot be written to
  const sound = `import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { createNotificationRecipe, renderSoundEffectBlock } from "../../kernel/soundEffects";
const CACHE = { calls: 0 };
export const card: CardDef<{}> = {
  id: "rs-sound-only", name: "Sound only", description: "d", source: "user", kind: "animation", inputs: {}, frameMode: "direct", defaults: {}, controls: [],
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
  assert.equal(answer.t, "error", `Writing to a locked top-level object: this block cannot be composed and reports an error instead of silently carrying state. Actual: ${JSON.stringify(answer?.t)}`);
});
