/**
 * Gatekeeper: in-place constants for online build pruning (M8 legacy L24, see "Online build pruning"
 * in `src/online/pageFlag.ts`).
 * Run: node --test src/online/onlinePrune.test.mjs
 *
 * rolldown tree shaking only recognizes constants with statically known values in the current module,
 * so modules to be pruned write an in-place `ONLINE_BUILD` line. If this line is mistyped (e.g. written
 * to read `mode.ts`, missing `typeof` guard), online build cannot prune it, or loading in Node unit
 * tests throws immediately. Verify here:
 *   PRUNE-01 Every occurrence of `const ONLINE_BUILD =` under `src/` matches the standard form verbatim;
 *   PRUNE-02 In Node (without `import.meta.env`), this line evaluates to false without throwing.
 * Whether it was pruned is checked by C10A-API-03 in `server/test/c10a-online-build.test.mjs`
 * (`/api` ratchet manifest matches artifacts item by item).
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
  // After A3, the closed-source parts live under cloud/ (this directory does not exist in the public
  // repository); this check originally guarded them, and must continue guarding them after the move
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
  // Same expression as source code; in Node ESM import.meta exists, import.meta.env does not
  const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";
  assert.equal(ONLINE_BUILD, false);
});

test("PRUNE-03 online page cloud projects do not prompt about unsaved changes (issue #16)", () => {
  const topBar = fs.readFileSync(path.join(ROOT, "src/editor/TopBar.tsx"), "utf8");
  const statusBar = fs.readFileSync(path.join(ROOT, "src/editor/StatusBar.tsx"), "utf8");
  assert.match(topBar, /useStore\(\(s\)\s*=>\s*!ONLINE_BUILD\s*&&\s*s\.dirty\)/, "TopBar should not mark a cloud project as having unsaved changes in the online build");
  assert.doesNotMatch(topBar, /The current project has unsaved changes, and switching to Vibe mode will discard them\. Continue\?/, "TopBar switching back to Vibe mode should not show the web version's unsaved-changes confirmation");
  assert.match(statusBar, /useStore\(\(s\)\s*=>\s*!ONLINE_BUILD\s*&&\s*s\.dirty\)/, "StatusBar should not subscribe to the local draft dirty flag in the online build");
});

test("PRUNE-04 online page leaving the editor: ask only when the changes exist only on this page (the guest path)", () => {
  const topBar = fs.readFileSync(path.join(ROOT, "src/editor/TopBar.tsx"), "utf8");
  assert.match(topBar, /unsentAtRisk\(v\.status,\s*v\.unconfirmed,\s*v\.offlineStore\)/,
    "the top bar must use the same check as the browser leave confirmation (unsentAtRisk), not write its own");
  assert.match(topBar, /const okToLeaveOnline = \(\) =>\s*!ONLINE_BUILD \|\| !unsentRisk \|\| confirm\(UNSENT_LEAVE_TEXT\)/,
    "ask only on the online page, and use the exact sentence from onlineStatus.ts");
  // Both top bar paths, "Vibe mode" and "Back to home", must pass through this confirmation prompt
  const goVibe = topBar.slice(topBar.indexOf("const goVibe = () =>"));
  assert.match(goVibe, /if \(ONLINE_BUILD\) \{ if \(okToLeaveOnline\(\)\) go\(\); return; \}/, "switching to Vibe mode must ask first");
  const goHome = topBar.slice(topBar.indexOf("const goHome = () =>"), topBar.indexOf("const goVibe = () =>"));
  assert.match(goHome, /if \(!okToLeaveOnline\(\)\) return;/, "going to the home page must ask first");
});

test("PRUNE-05 mobile app: system back must be intercepted and ask with the mobile app's own confirmation dialog", () => {
  const mob = fs.readFileSync(path.join(ROOT, "src/mobile/MobileEditor.tsx"), "utf8");
  assert.match(mob, /unsentAtRisk\(v\.status,\s*v\.unconfirmed,\s*v\.offlineStore\)/,
    "the mobile app must use the same check as the top bar and the browser leave confirmation");
  // popstate arrives only after back navigation occurred: to keep user, push state back before prompting
  assert.match(mob, /if \(riskRef\.current && !leaving\.current\) \{[\s\S]*?history\.pushState\(\{ pcm: 1, lvl: 1 \}[\s\S]*?askLeave\.current\(\);/,
    "on popstate the mobile app must first push this layer back and then ask, not leave directly");
  assert.match(mob, /confirm\(\{ text: UNSENT_LEAVE_BODY, ok: trText\("Leave"\), danger: true, run: leaveNow \}\)/,
    "use the mobile app's own confirmation dialog (window.confirm is a poor experience on phones and may be blocked)");
  assert.doesNotMatch(mob, /window\.confirm|confirm\(["']/, "the mobile app must not use the browser's confirm directly");
});
