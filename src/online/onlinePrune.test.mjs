/**
 * 守门:在线构建剪枝的就地常量(M8 遗留 L24,写法见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。
 * 跑:node --test src/online/onlinePrune.test.mjs
 *
 * rolldown 摇树只认本模块里值可知的常量,所以要剪枝的模块各自就地写一行 `ONLINE_BUILD`。这一行抄错了
 * (比如写成读 `mode.ts`、少了 `typeof` 守卫),在线构建就剪不掉、或 Node 单测载入时当场抛错。这里核对:
 *   PRUNE-01 `src/` 下每一处 `const ONLINE_BUILD =` 都与标准写法逐字相同;
 *   PRUNE-02 Node 里(没有 `import.meta.env`)这行求值为 false,不抛错。
 * 剪得掉没有,由 `server/test/c10a-online-build.test.mjs` 的 C10A-API-03(`/api` 棘轮清单与产物逐条一致)核对。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const CANON = 'const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";';

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
  return /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
});

test("PRUNE-01 every in-place ONLINE_BUILD is verbatim identical to the canonical form", () => {
  const sites = [];
  const bad = [];
  // A3 之后闭源的那几摊在 cloud/ 下（公开仓库里没有这个目录）；这道检查原来就管着它们，搬走以后也要接着管
  const dirs = [path.join(ROOT, "src"), ...[path.join(ROOT, "cloud", "src"), path.join(ROOT, "cloud", "online")].filter((d) => fs.existsSync(d))];
  for (const f of dirs.flatMap(walk)) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/^\s*(export\s+)?const ONLINE_BUILD\b/.test(line)) return;
      const where = `${path.relative(ROOT, f).split(path.sep).join("/")}:${i + 1}`;
      sites.push(where);
      if (line.trim() !== CANON) bad.push(`${where}: ${line.trim()}`);
    });
  }
  assert.ok(sites.length >= 10, `in-place constants should span a dozen or so modules, actual ${sites.length}:${sites.join(", ")}`);
  assert.deepEqual(bad, [], `form differs from canonical:\n${bad.join("\n")}`);
});

test("PRUNE-02 this line evaluates to false in Node, without throwing", () => {
  // 与源码同一个表达式;Node 的 ESM 里 import.meta 在、import.meta.env 不在
  const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
  assert.equal(ONLINE_BUILD, false);
});

test("PRUNE-03 online page cloud projects do not prompt about unsaved changes (issue #16)", () => {
  const topBar = fs.readFileSync(path.join(ROOT, "src/editor/TopBar.tsx"), "utf8");
  const statusBar = fs.readFileSync(path.join(ROOT, "src/editor/StatusBar.tsx"), "utf8");
  assert.match(topBar, /useStore\(\(s\)\s*=>\s*!ONLINE_BUILD\s*&&\s*s\.dirty\)/, "TopBar should not mark a cloud project as having unsaved changes in the online build");
  assert.doesNotMatch(topBar, /Switching to Vibe mode will discard them\. Continue\?/, "TopBar switching back to Vibe mode should not show the web version's unsaved-changes confirmation");
  assert.match(statusBar, /useStore\(\(s\)\s*=>\s*!ONLINE_BUILD\s*&&\s*s\.dirty\)/, "StatusBar should not subscribe to the local draft dirty flag in the online build");
});

test("PRUNE-04 online page leaving the editor: ask only when the changes exist only on this page (the guest path)", () => {
  const topBar = fs.readFileSync(path.join(ROOT, "src/editor/TopBar.tsx"), "utf8");
  assert.match(topBar, /unsentAtRisk\(v\.status,\s*v\.unconfirmed,\s*v\.offlineStore\)/,
    "the top bar must use the same check as the browser leave confirmation (unsentAtRisk), not write its own");
  assert.match(topBar, /const okToLeaveOnline = \(\) =>\s*!ONLINE_BUILD \|\| !unsentRisk \|\| confirm\(UNSENT_LEAVE_TEXT\)/,
    "ask only on the online page, and use the exact sentence from onlineStatus.ts");
  // 顶栏「氛围式」和「回首页」两条路都要过这道问话
  const goVibe = topBar.slice(topBar.indexOf("const goVibe = () =>"));
  assert.match(goVibe, /if \(ONLINE_BUILD\) \{ if \(okToLeaveOnline\(\)\) go\(\); return; \}/, "switching to Vibe mode must ask first");
  const goHome = topBar.slice(topBar.indexOf("const goHome = () =>"), topBar.indexOf("const goVibe = () =>"));
  assert.match(goHome, /if \(!okToLeaveOnline\(\)\) return;/, "going to the home page must ask first");
});

test("PRUNE-05 mobile app: system back must be intercepted and ask with the mobile app's own confirmation dialog", () => {
  const mob = fs.readFileSync(path.join(ROOT, "src/mobile/MobileEditor.tsx"), "utf8");
  assert.match(mob, /unsentAtRisk\(v\.status,\s*v\.unconfirmed,\s*v\.offlineStore\)/,
    "the mobile app must use the same check as the top bar and the browser leave confirmation");
  // popstate 是后退发生之后才到的:要留住人就得把那一层压回去,再问
  assert.match(mob, /if \(riskRef\.current && !leaving\.current\) \{[\s\S]*?history\.pushState\(\{ pcm: 1, lvl: 1 \}[\s\S]*?askLeave\.current\(\);/,
    "on popstate the mobile app must first push this layer back and then ask, not leave directly");
  assert.match(mob, /confirm\(\{ text: UNSENT_LEAVE_BODY, ok: "Leave", danger: true, run: leaveNow \}\)/,
    "use the mobile app's own confirmation dialog (window.confirm is a poor experience on phones and may be blocked)");
  assert.doesNotMatch(mob, /window\.confirm|confirm\(["']/, "the mobile app must not use the browser's confirm directly");
});
