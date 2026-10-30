/** 外链资源回归：内置卡在线与桌面允许同样URL，不因出口政策删除资源。
 * 已知NASA URL仍引用远端，不随构建分发徽标；新增外链不因本测试被禁止。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 已知的外链(文件 → 出现几处、怎么处理的) */
const KNOWN = {
  "server/catalog/particles/nasa.json": { count: 1, handled: "在线与桌面使用相同外链，徽标不随构建自带" },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
/** 去掉注释(来源说明里的网址不算资源);字符串里的 `//` 不动 */
function stripComments(src) {
  let out = "", i = 0, quote = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (quote) { out += c; if (c === "\\") { out += d ?? ""; i += 2; continue; } if (c === quote) quote = null; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i = src.indexOf("*/", i + 2); i = i < 0 ? src.length : i + 2; continue; }
    out += c; i++;
  }
  return out;
}
const EXTERNAL = /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'`)]*/gi;
/** 不是要加载的资源:XML 命名空间 */
const HARMLESS = /^https?:\/\/www\.w3\.org\//i;

function externalsIn(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  let text = fs.readFileSync(file, "utf8");
  if (/\.(tsx?|mjs|js|css)$/.test(file)) text = stripComments(text);
  if (/\/index\.json$/.test(rel)) { try { const j = JSON.parse(text); delete j.source; text = JSON.stringify(j); } catch { /* 原样 */ } }
  return (text.match(EXTERNAL) ?? []).filter((u) => !HARMLESS.test(u)).map((u) => ({ rel, url: u }));
}

test("EXT-01 已知外链来源仍登记且不随构建替换，新增外链不被禁止", () => {
  const files = [
    ...walk(path.join(ROOT, "src", "cards")).filter((f) => !f.split(path.sep).join("/").includes("/cards/user/")),
    ...walk(path.join(ROOT, "src", "parts")),
    ...walk(path.join(ROOT, "server", "catalog")),
  ].filter((f) => /\.(tsx?|mjs|css|json)$/.test(f) && !/\.test\./.test(f) && !/\.md$/.test(f));
  assert.ok(files.length > 100, `扫到的文件太少(${files.length}),路径可能变了`);
  const found = new Map();
  for (const f of files) for (const hit of externalsIn(f)) found.set(hit.rel, [...(found.get(hit.rel) ?? []), hit.url]);
  for (const [rel, urls] of found) {
    if (!KNOWN[rel]) continue; // 其它外链允许，不设置新增外链禁令。
    assert.equal(urls.length, KNOWN[rel].count, `${rel} 的外链数变了:${urls.join(" ")}`);
  }
  for (const rel of Object.keys(KNOWN)) assert.ok(found.has(rel), `${rel} 已经没有外链了,把它从 KNOWN 里去掉`);
});

test("EXT-02 预设nasa的外链背景图在线与桌面相同，不删除或打包徽标", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "cards", "native", "particles.tsx"), "utf8");
  assert.match(src, /background: \{ \.\.\.\(opts\.background \|\| \{\}\), color: "transparent" \}/);
  assert.doesNotMatch(src, /onlineSafeBackground|__pcOnlinePage|delete bg\.image/);
  const nasa = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "catalog", "particles", "nasa.json"), "utf8"));
  const re = /url\(\s*['"]?\s*(?:https?:)?\/\//i;
  assert.ok(re.test(nasa.background.image), "nasa 预设的背景图应当还是外链(桌面照旧);要是改成自带了,连同 KNOWN 一起改");
});
