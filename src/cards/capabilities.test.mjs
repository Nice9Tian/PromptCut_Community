/**
 * 守门测试:卡片分类登记表(`src/cards/capabilities.json`,说明在 `capabilities.md`)。
 * 跑:node --test src/cards/capabilities.test.mjs
 *
 *   CT-01 全部内置卡(`src/cards/index.ts` 注册的四组)在表里三样登记全:哪种写法、画在什么上、依不依赖下层
 *   CT-02 写法以卡的声明为准:表里登记的值和声明对不上算错
 *   CT-03 画在什么上和卡的声明不打架(画布契约、有没有画面);是不是画布卡由 `surface` 推出,表里不写 `canvasHeavy`
 *   CT-04 表里没有多余的键(含 `frameMode`:写法只取声明,登记用 `writing`)、没有对不上任何卡的条目
 *   CT-05 两处读表的地方(`src/kernel/frameMode.mjs`、`server/vision-project.mjs`)读到同一份,都带得出新字段
 *   CT-06 新字段不进卡片身份的摘要:`cardCapabilities` 的返回仍只有原来五项,取值和登记的一致
 *   CT-07 `src/cards/index.ts` 注册的还是这四组(多了一组,本测试枚举不到,要跟着改)
 *   CT-08～CT-11 故意弄错的夹具:新增内置卡没登记、表和声明对不上、三样缺一样、不该写的值,检查都会报
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuiltinCards, BUILTIN_CARD_GROUPS } from "../testing/loadBuiltinCards.mjs";
import { reviewedCard, reviewedCanvas, cardCapabilities, cardFrameMode, normalizeFrameMode, DERIVED_FROM_PARTS } from "../kernel/frameMode.mjs";
import { reviewedCapabilities, reviewedClassification, CARD_WRITINGS, CARD_SURFACES, CANVAS_SURFACES, REVIEWED_COMPOSITING, CARD_COMPOSITINGS } from "../../server/vision-project.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TABLE = JSON.parse(fs.readFileSync(path.join(ROOT, "src/cards/capabilities.json"), "utf8"));

/** 表里每条允许出现的字段。是不是画布卡由 `surface` 推出(`frameMode.mjs` 的 `reviewedCanvas`),旧字段 `canvasHeavy` 不许再写 */
const ENTRY_KEYS = ["writing", "surface", "compositing"];
/** 登记成「故意不审」的卡:探针要它们的轴三保持未知。别的卡不许写 `unknown` */
const DELIBERATELY_UNKNOWN = ["r6-unknown", "probe-css", "probe-motion-js"];
/** 表里有、却不在内置四组里的键:随仓库带的那张 `src/cards/user/` 下的卡。新增这样的键要在这里写明 */
const KEYS_OUTSIDE_BUILTIN = ["mu-animated-shiny-text"];

/** 查表:先精确 id,再取最长的 `前缀-*`(和两处读表的地方同一口径;这里对传进来的表查,好喂夹具) */
function lookup(table, id) {
  const exact = table[id];
  if (exact && typeof exact === "object") return { key: id, entry: exact };
  let best = null;
  for (const key of Object.keys(table)) {
    if (!key.endsWith("-*")) continue;
    const prefix = key.slice(0, -1);
    if (id.startsWith(prefix) && (!best || prefix.length > best.key.length - 1)) best = { key, entry: table[key] };
  }
  return best && typeof best.entry === "object" ? best : null;
}

const hasPicture = (def) => typeof def.Component === "function" || typeof def.card === "function";

/**
 * 核对整张表,返回问题清单(空 = 没问题)。每条问题是 `{ code, id, message }`:
 *   unregistered  内置卡不在表里
 *   incomplete    三样缺一样,或取值不认识
 *   writing       表里的写法和卡的声明对不上
 *   surface       画在什么上和卡的声明打架
 *   compositing   写了这张卡不该写的记号(`unknown` / `fromParts`)
 *   extra-field   条目里有不认识的字段(含 `frameMode`:写法只取卡的声明;含旧字段 `canvasHeavy`:由 `surface` 推出)
 *   dead-key      表里的键对不上任何内置卡,也不在已知的例外里
 */
function checkCardTable(table, cards, { keysOutsideBuiltin = KEYS_OUTSIDE_BUILTIN } = {}) {
  const problems = [], used = new Set();
  const report = (code, id, message) => problems.push({ code, id, message });
  for (const [key, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { report("incomplete", key, "条目不是对象"); continue; }
    for (const field of Object.keys(entry)) if (!ENTRY_KEYS.includes(field)) {
      report("extra-field", key, field === "frameMode"
        ? "表里不许写 frameMode:写法只取卡的声明,表里写了也没人读;写法登记在 writing"
        : field === "canvasHeavy" ? "表里不许再写 canvasHeavy:是不是画布卡由 surface 推出(canvas2d / webgl)"
        : `不认识的字段 ${field}`);
    }
    if (!Object.hasOwn(CARD_WRITINGS, entry.writing)) report("incomplete", key, `writing 缺了或不认识:${JSON.stringify(entry.writing)}`);
    if (!CARD_SURFACES.includes(entry.surface)) report("incomplete", key, `surface 缺了或不认识:${JSON.stringify(entry.surface)}`);
    if (!CARD_COMPOSITINGS.includes(entry.compositing)) report("incomplete", key, `compositing 缺了或不认识:${JSON.stringify(entry.compositing)}`);
  }
  for (const def of cards) {
    const id = def.id, hit = lookup(table, id);
    if (!hit) { report("unregistered", id, "内置卡没有登记进 src/cards/capabilities.json(同时改 capabilities.md)"); continue; }
    used.add(hit.key);
    const entry = hit.entry;
    // 写法:以声明为准。内置卡必须显式声明 direct / stateful,登记的值取自它
    const declared = normalizeFrameMode(def.frameMode);
    if (def.frameMode !== "direct" && def.frameMode !== "stateful") report("writing", id, `内置卡要显式声明 frameMode 为 direct 或 stateful,现在是 ${JSON.stringify(def.frameMode)}`);
    else if (cardFrameMode(def, def.defaults) !== declared) report("writing", id, `声明 ${declared},实际按 ${cardFrameMode(def, def.defaults)} 处理(need_prerendering 与声明冲突)`);
    else if (CARD_WRITINGS[entry.writing] !== declared) report("writing", id, `表里登记 ${entry.writing}(${CARD_WRITINGS[entry.writing]}),卡的声明是 ${declared};以声明为准,改表`);
    // 画在什么上:以表为准,但不许和卡自己的声明打架
    if (CARD_SURFACES.includes(entry.surface)) {
      if (!hasPicture(def) !== (entry.surface === "none")) report("surface", id, hasPicture(def) ? "这张卡有画面,surface 不能是 none" : "这张卡没有画面(只有声音),surface 要写 none");
      if (def.canvas && !CANVAS_SURFACES.includes(entry.surface)) report("surface", id, `卡声明了画布契约 canvas.kind=${def.canvas.kind},表里却登记 ${entry.surface}`);
      if (def.canvas && (def.canvas.kind === "dom2d") !== (entry.surface === "canvas2d")) report("surface", id, `画布契约 canvas.kind=${def.canvas.kind} 和登记的 ${entry.surface} 对不上(dom2d ↔ canvas2d,其余 ↔ webgl)`);
      if (def.canvasHeavy === true && !CANVAS_SURFACES.includes(entry.surface)) report("surface", id, "卡的源码写了 canvasHeavy,表里却不是画布卡");
    }
    // 依不依赖下层:两个记号只给点了名的卡用
    if (entry.compositing === "fromParts" && !DERIVED_FROM_PARTS.includes(id)) report("compositing", id, "fromParts 只给组合卡用");
    if (DERIVED_FROM_PARTS.includes(id) && entry.compositing !== "fromParts") report("compositing", id, "组合卡的 compositing 由部件推导,表里写 fromParts");
    if (entry.compositing === "unknown" && !DELIBERATELY_UNKNOWN.includes(id)) report("compositing", id, "unknown 只给故意不审的探针卡用;内置卡要有审阅结论");
  }
  for (const key of Object.keys(table)) if (!used.has(key) && !keysOutsideBuiltin.includes(key)) report("dead-key", key, "表里的键对不上任何内置卡");
  return problems;
}

const describe = (problems) => problems.map((p) => `[${p.code}] ${p.id}: ${p.message}`).join("\n");

let kit;
before(async () => { kit = await loadBuiltinCards(ROOT); });
after(async () => { await kit?.close(); });

test("CT-01～CT-04 全部内置卡在表里三样登记全,写法取自声明,表里没有多余的东西", () => {
  assert.ok(kit.cards.length >= 100, `内置卡应有一百来张,读到 ${kit.cards.length} 张`);
  assert.equal(new Set(kit.cards.map((c) => c.id)).size, kit.cards.length, "内置卡 id 不重复");
  const problems = checkCardTable(TABLE, kit.cards);
  assert.equal(problems.length, 0, `登记表有 ${problems.length} 处问题:\n${describe(problems)}`);
});

test("CT-02 补充:声明成 remotion 式的内置卡,表里一张不落", () => {
  const declared = kit.cards.filter((c) => c.frameMode === "direct").map((c) => c.id).sort();
  const registered = kit.cards.filter((c) => lookup(TABLE, c.id)?.entry.writing === "remotion").map((c) => c.id).sort();
  assert.deepEqual(registered, declared);
});

test("CT-05 两处读表的地方读到同一份,都带得出新字段;通配照旧", () => {
  const ids = [...kit.cards.map((c) => c.id), ...Object.keys(TABLE), "no-such-card", "particles", "particles-", "particlesX"];
  for (const id of ids) assert.deepEqual(reviewedCapabilities(id), reviewedCard(id), `${id}:Node 侧和 frameMode.mjs 查到的条目不同`);
  // frameMode.mjs:条目原样带出,新字段读得到
  assert.deepEqual(reviewedCard("scene-3d"), { writing: "motion", surface: "webgl", compositing: "independent" });
  // 是不是画布卡:由 surface 推出;表里没有的卡给 undefined
  assert.deepEqual(["scene-3d", "particles", "particles-snow", "r6-canvas", "odometer", "sound-keyboard", "no-such-card"].map(reviewedCanvas), [true, true, true, true, false, false, undefined]);
  for (const id of ids) assert.equal(reviewedCanvas(id), reviewedClassification(id)?.canvas, `${id}:两处判画布卡不一致`);
  assert.equal(reviewedCard("caption-track").writing, "remotion");
  assert.equal(reviewedCard("sound-keyboard").surface, "none");
  // 通配:`particles-*` 配 `particles-xxx`,不配 `particles`(它单列),也不配别的前缀
  assert.deepEqual(reviewedCard("particles-snow"), TABLE["particles-*"]);
  assert.deepEqual(reviewedCard("particles"), TABLE.particles);
  assert.equal(reviewedCard("particlesX"), undefined);
  assert.equal(reviewedCard("no-such-card"), undefined);
  // vision-project.mjs:整理过的三样
  assert.deepEqual(reviewedClassification("particles-snow"), { writing: "motion", frameMode: "stateful", surface: "canvas2d", canvas: true, compositing: "independent", reviewed: true });
  assert.deepEqual(reviewedClassification("caption-track"), { writing: "remotion", frameMode: "direct", surface: "dom", canvas: false, compositing: "independent", reviewed: true });
  assert.deepEqual(reviewedClassification("blur-text"), { writing: "motion", frameMode: "stateful", surface: "dom", canvas: false, compositing: "belowDependent", reviewed: true });
  assert.deepEqual(reviewedClassification("composite"), { writing: "motion", frameMode: "stateful", surface: "dom", canvas: false, compositing: "unknown", reviewed: false });
  assert.deepEqual(reviewedClassification("r6-unknown"), { writing: "motion", frameMode: "stateful", surface: "dom", canvas: false, compositing: "unknown", reviewed: false });
  assert.equal(reviewedClassification("no-such-card"), undefined);
  for (const def of kit.cards) {
    const c = reviewedClassification(def.id);
    assert.equal(c.frameMode, def.frameMode, `${def.id}:Node 侧读到的写法和声明不同`);
    assert.ok(c.writing && c.surface, `${def.id}:Node 侧读不全`);
  }
});

test("CT-06 新字段不进卡片身份的摘要:cardCapabilities 仍只有原来五项,取值和登记的一致", () => {
  for (const def of kit.cards) {
    const caps = cardCapabilities(def), entry = lookup(TABLE, def.id).entry;
    assert.deepEqual(Object.keys(caps).sort(), ["canvasHeavy", "compositing", "frameMode", "independentCache", "need_prerendering"], `${def.id}:能力表多了或少了字段(它整个进摘要)`);
    assert.equal(caps.frameMode, CARD_WRITINGS[entry.writing], `${def.id}:写法`);
    assert.equal(caps.need_prerendering, caps.frameMode === "stateful", `${def.id}:need_prerendering`);
    assert.equal(caps.canvasHeavy, CANVAS_SURFACES.includes(entry.surface), `${def.id}:画布卡`);
    // 没有部件的组合卡推导出 independent;故意不审的三张是 unknown;其余等于审阅结论
    const expected = REVIEWED_COMPOSITING.includes(entry.compositing) ? entry.compositing : entry.compositing === "fromParts" ? "independent" : "unknown";
    assert.equal(caps.compositing, expected, `${def.id}:依不依赖下层`);
    assert.equal(caps.independentCache, expected === "independent", `${def.id}:independentCache`);
  }
  // 组合卡带了解析不出来的部件时照旧是 unknown(登记进表没有改变它的推导)
  const composite = kit.cards.find((c) => c.id === "composite");
  assert.equal(cardCapabilities(composite, composite.defaults, [{ partId: "x" }]).compositing, "unknown");
  assert.equal(cardCapabilities(composite, composite.defaults, ["blur-text", "odometer"]).compositing, "belowDependent");
});

test("CT-07 src/cards/index.ts 注册的还是这四组", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/cards/index.ts"), "utf8");
  const call = /registerCards\(\[([^\]]*)\]\)/.exec(source);
  assert.ok(call, "找不到 registerCards([...]) 那一行");
  const names = call[1].split(",").map((s) => s.trim().replace(/^\.\.\./, "")).filter(Boolean).sort();
  assert.deepEqual(names, Object.keys(BUILTIN_CARD_GROUPS).sort(), "内置卡的分组变了:loadBuiltinCards.mjs 的 BUILTIN_CARD_GROUPS 要跟着改,否则守门测试枚举不全");
});

// ── 故意弄错的夹具:证明上面的检查真的会报 ──

const copy = (value) => structuredClone(value);
const codesFor = (problems, id) => problems.filter((p) => p.id === id).map((p) => p.code);

test("CT-08 夹具:新增一张内置卡没登记 → 报 unregistered", () => {
  const added = { id: "brand-new-card", frameMode: "stateful", defaults: {}, Component: () => null };
  const problems = checkCardTable(TABLE, [...kit.cards, added]);
  assert.deepEqual(problems.map((p) => [p.code, p.id]), [["unregistered", "brand-new-card"]]);
  // 登记上就不报了
  assert.deepEqual(checkCardTable({ ...TABLE, "brand-new-card": { writing: "motion", surface: "dom", compositing: "independent" } }, [...kit.cards, added]), []);
  // 从表里删掉一张现有的卡,同样报
  const table = copy(TABLE); delete table.odometer;
  assert.deepEqual(checkCardTable(table, kit.cards).map((p) => [p.code, p.id]), [["unregistered", "odometer"]]);
  // 通配盖不到的前缀不算登记
  const stray = { id: "particlesnew", frameMode: "stateful", defaults: {}, Component: () => null };
  assert.deepEqual(codesFor(checkCardTable(TABLE, [...kit.cards, stray]), "particlesnew"), ["unregistered"]);
});

test("CT-09 夹具:表里的写法和卡的声明对不上 → 报 writing", () => {
  // 表写错:remotion 式的卡登记成 motion,motion 式的卡登记成 remotion
  for (const [id, wrong] of [["caption-track", "motion"], ["odometer", "remotion"], ["particles-*", "remotion"]]) {
    const table = copy(TABLE); table[id].writing = wrong;
    const problems = checkCardTable(table, kit.cards);
    assert.ok(problems.length > 0 && problems.every((p) => p.code === "writing"), `${id} 改成 ${wrong} 应只报 writing:\n${describe(problems)}`);
    if (!id.endsWith("*")) assert.deepEqual(problems.map((p) => p.id), [id]);
    else assert.ok(problems.length > 50 && problems.every((p) => p.id.startsWith("particles-")), "通配条目写错,它盖住的每张卡都报");
  }
  // 卡改了声明、表没跟:同样报(以声明为准)
  const cards = kit.cards.map((c) => (c.id === "odometer" ? { ...c, frameMode: "direct" } : c));
  assert.deepEqual(checkCardTable(TABLE, cards).map((p) => [p.code, p.id]), [["writing", "odometer"]]);
  // 内置卡不写声明、或写了旧值:报
  const undeclared = kit.cards.map((c) => (c.id === "odometer" ? { ...c, frameMode: undefined } : c));
  assert.deepEqual(checkCardTable(TABLE, undeclared).map((p) => [p.code, p.id]), [["writing", "odometer"]]);
});

test("CT-10 夹具:三样缺一样、或取值不认识 → 报 incomplete", () => {
  for (const field of ["writing", "surface", "compositing"]) {
    const table = copy(TABLE); delete table.odometer[field];
    const problems = checkCardTable(table, kit.cards);
    assert.ok(problems.some((p) => p.code === "incomplete" && p.id === "odometer" && p.message.includes(field)), `缺 ${field} 应报:\n${describe(problems)}`);
    const bad = copy(TABLE); bad.odometer[field] = "whatever";
    assert.ok(checkCardTable(bad, kit.cards).some((p) => p.code === "incomplete" && p.id === "odometer"), `${field} 写了不认识的值应报`);
  }
  // 只有旧的两样(改之前的样子)不算登记全
  const old = copy(TABLE); old.odometer = { compositing: "belowDependent" };
  assert.deepEqual(codesFor(checkCardTable(old, kit.cards), "odometer").filter((c) => c === "incomplete").length, 2);
});

test("CT-11 夹具:不该写的值 → 各自报出来", () => {
  const run = (edit) => { const table = copy(TABLE); edit(table); return checkCardTable(table, kit.cards); };
  // 表里写 frameMode(没人读,写法只取声明)、不认识的字段
  assert.deepEqual(run((t) => { t.odometer.frameMode = "stateful"; }).map((p) => [p.code, p.id]), [["extra-field", "odometer"]]);
  assert.deepEqual(run((t) => { t.odometer.note = "x"; }).map((p) => [p.code, p.id]), [["extra-field", "odometer"]]);
  // 旧字段 canvasHeavy 不许再写(写 true、写 false 都报):是不是画布卡由 surface 推出
  assert.deepEqual(run((t) => { t["scene-3d"].canvasHeavy = true; }).map((p) => [p.code, p.id]), [["extra-field", "scene-3d"]]);
  assert.deepEqual(run((t) => { t.odometer.canvasHeavy = true; }).map((p) => [p.code, p.id]), [["extra-field", "odometer"]]);
  assert.deepEqual(run((t) => { t.odometer.canvasHeavy = false; }).map((p) => [p.code, p.id]), [["extra-field", "odometer"]]);
  // 和卡自己的声明打架:three 契约的卡登记成 2D 画布、粒子卡登记成 WebGL、有画面的卡登记成没有画面、只有声音的卡登记成 DOM
  assert.deepEqual(codesFor(run((t) => { t["scene-3d"].surface = "canvas2d"; }), "scene-3d"), ["surface"]);
  assert.deepEqual(codesFor(run((t) => { t.particles.surface = "webgl"; }), "particles"), ["surface"]);
  assert.deepEqual(codesFor(run((t) => { t.odometer.surface = "none"; }), "odometer"), ["surface"]);
  assert.deepEqual(codesFor(run((t) => { t["sound-keyboard"].surface = "dom"; }), "sound-keyboard"), ["surface"]);
  // 两个记号只给点了名的卡
  assert.deepEqual(run((t) => { t.odometer.compositing = "unknown"; }).map((p) => [p.code, p.id]), [["compositing", "odometer"]]);
  assert.deepEqual(run((t) => { t.odometer.compositing = "fromParts"; }).map((p) => [p.code, p.id]), [["compositing", "odometer"]]);
  assert.deepEqual(run((t) => { t.composite.compositing = "independent"; }).map((p) => [p.code, p.id]), [["compositing", "composite"]]);
  // 对不上任何卡的键
  assert.deepEqual(run((t) => { t["gone-card"] = { writing: "motion", surface: "dom", compositing: "independent" }; }).map((p) => [p.code, p.id]), [["dead-key", "gone-card"]]);
});
