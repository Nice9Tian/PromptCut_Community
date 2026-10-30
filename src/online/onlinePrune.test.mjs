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

test("PRUNE-01 每一处就地的 ONLINE_BUILD 都与标准写法逐字相同", () => {
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
  assert.ok(sites.length >= 10, `就地常量应在十几个模块里,实际 ${sites.length}:${sites.join(", ")}`);
  assert.deepEqual(bad, [], `写法与标准不同:\n${bad.join("\n")}`);
});

test("PRUNE-02 Node 里这行求值为 false,不抛错", () => {
  // 与源码同一个表达式;Node 的 ESM 里 import.meta 在、import.meta.env 不在
  const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
  assert.equal(ONLINE_BUILD, false);
});

test("PRUNE-03 在线页面云端项目不提示未保存改动(issue #16)", () => {
  const topBar = fs.readFileSync(path.join(ROOT, "src/editor/TopBar.tsx"), "utf8");
  const statusBar = fs.readFileSync(path.join(ROOT, "src/editor/StatusBar.tsx"), "utf8");
  assert.match(topBar, /useStore\(\(s\)\s*=>\s*!ONLINE_BUILD\s*&&\s*s\.dirty\)/, "TopBar 在在线构建下不应把云端项目标成有未保存改动");
  assert.doesNotMatch(topBar, /切到氛围式会丢掉它们。继续？/, "TopBar 切回氛围式不应弹网页版未保存确认框");
  assert.match(statusBar, /useStore\(\(s\)\s*=>\s*!ONLINE_BUILD\s*&&\s*s\.dirty\)/, "StatusBar 在在线构建下不应订阅本机草稿脏标记");
});

test("PRUNE-04 在线页面离开编辑界面:只在改动只在本页时才问(游客那条路)", () => {
  const topBar = fs.readFileSync(path.join(ROOT, "src/editor/TopBar.tsx"), "utf8");
  assert.match(topBar, /unsentAtRisk\(v\.status,\s*v\.unconfirmed,\s*v\.offlineStore\)/,
    "顶栏要用和浏览器离开确认同一个判断(unsentAtRisk),不要自己另写一套");
  assert.match(topBar, /const okToLeaveOnline = \(\) =>\s*!ONLINE_BUILD \|\| !unsentRisk \|\| confirm\(UNSENT_LEAVE_TEXT\)/,
    "在线页面才问,且用 onlineStatus.ts 里那一句原文");
  // 顶栏「氛围式」和「回首页」两条路都要过这道问话
  const goVibe = topBar.slice(topBar.indexOf("const goVibe = () =>"));
  assert.match(goVibe, /if \(ONLINE_BUILD\) \{ if \(okToLeaveOnline\(\)\) go\(\); return; \}/, "切氛围式要先问");
  const goHome = topBar.slice(topBar.indexOf("const goHome = () =>"), topBar.indexOf("const goVibe = () =>"));
  assert.match(goHome, /if \(!okToLeaveOnline\(\)\) return;/, "回首页要先问");
});

test("PRUNE-05 手机版:系统后退要拦住,用手机版自己的确认框问", () => {
  const mob = fs.readFileSync(path.join(ROOT, "src/mobile/MobileEditor.tsx"), "utf8");
  assert.match(mob, /unsentAtRisk\(v\.status,\s*v\.unconfirmed,\s*v\.offlineStore\)/,
    "手机版要用和顶栏、浏览器离开确认同一个判断");
  // popstate 是后退发生之后才到的:要留住人就得把那一层压回去,再问
  assert.match(mob, /if \(riskRef\.current && !leaving\.current\) \{[\s\S]*?history\.pushState\(\{ pcm: 1, lvl: 1 \}[\s\S]*?askLeave\.current\(\);/,
    "手机版收到 popstate 要先把这一层压回去再问,不能直接走");
  assert.match(mob, /confirm\(\{ text: UNSENT_LEAVE_BODY, ok: "离开", danger: true, run: leaveNow \}\)/,
    "用手机版自己的确认框(window.confirm 在手机上体验差、还可能被屏蔽)");
  assert.doesNotMatch(mob, /window\.confirm|confirm\(["「]/, "手机版不许直接用浏览器的 confirm");
});
