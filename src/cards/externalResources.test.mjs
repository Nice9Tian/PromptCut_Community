/** External resource regression: built-in cards allow the same URLs online and on desktop,
 * not deleting resources due to export policies. Known NASA URLs still reference remote endpoints,
 * without distributing logos with the build; new external links are not banned by this test. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Known external links (file → occurrence count, how handled) */
const KNOWN = {
  "server/catalog/particles/nasa.json": { count: 1, handled: "Online and desktop use the same external link, and the logo is not bundled with the build" },
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
/**
 * Strip comments (URLs in source attributions do not count as resources); leave `//` inside
 * strings untouched
 */
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
/** Not a resource to load: XML namespace */
const HARMLESS = /^https?:\/\/www\.w3\.org\//i;

function externalsIn(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  let text = fs.readFileSync(file, "utf8");
  if (/\.(tsx?|mjs|js|css)$/.test(file)) text = stripComments(text);
  if (/\/index\.json$/.test(rel)) { try { const j = JSON.parse(text); delete j.source; text = JSON.stringify(j); } catch { /* As is */ } }
  return (text.match(EXTERNAL) ?? []).filter((u) => !HARMLESS.test(u)).map((u) => ({ rel, url: u }));
}

test("EXT-01 Known external link sources are still registered and not replaced by the build, and new external links are not forbidden", () => {
  const files = [
    ...walk(path.join(ROOT, "src", "cards")).filter((f) => !f.split(path.sep).join("/").includes("/cards/user/")),
    ...walk(path.join(ROOT, "src", "parts")),
    ...walk(path.join(ROOT, "server", "catalog")),
  ].filter((f) => /\.(tsx?|mjs|css|json)$/.test(f) && !/\.test\./.test(f) && !/\.md$/.test(f));
  assert.ok(files.length > 100, `Too few files scanned (${files.length}), the path may have changed`);
  const found = new Map();
  for (const f of files) for (const hit of externalsIn(f)) found.set(hit.rel, [...(found.get(hit.rel) ?? []), hit.url]);
  for (const [rel, urls] of found) {
    if (!KNOWN[rel]) continue; // Other external links are allowed; no ban is imposed on newly added external links.
    assert.equal(urls.length, KNOWN[rel].count, `The number of external links in ${rel} changed: ${urls.join(" ")}`);
  }
  for (const rel of Object.keys(KNOWN)) assert.ok(found.has(rel), `${rel} no longer has any external links, remove it from KNOWN`);
});

test("EXT-02 The external background image of the nasa preset is the same online and on desktop, and the logo is neither removed nor bundled", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "cards", "native", "particles.tsx"), "utf8");
  assert.match(src, /background: \{ \.\.\.\(opts\.background \|\| \{\}\), color: "transparent" \}/);
  assert.doesNotMatch(src, /onlineSafeBackground|__pcOnlinePage|delete bg\.image/);
  const nasa = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "catalog", "particles", "nasa.json"), "utf8"));
  const re = /url\(\s*['"]?\s*(?:https?:)?\/\//i;
  assert.ok(re.test(nasa.background.image), "The nasa preset's background image should still be an external link (unchanged on desktop); if it is changed to a bundled one, update KNOWN along with it");
});
