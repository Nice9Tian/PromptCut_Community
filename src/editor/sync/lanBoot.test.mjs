/**
 * **Entry registration** for default LAN implementation (user requirement, 2026-10-28:
 * use entry registration, do not register along the way at module top level).
 *
 * These pin down **the rule itself**: where the registration point is and where it is not.
 * The behavior of default member source / join source itself is covered by
 * `accountExtensions.test.mjs` (it constructs directly via injected dependencies without
 * loading real syncManager).
 *
 * **Why static verification instead of actually loading and running**: `lanBoot.ts` pulls in
 * `collab.ts` → `./syncManager` (without extension) → ..., and relative imports across the
 * entire `src/editor/sync/` subtree have no extensions, resolved only by Vite. raw Node cannot
 * load them (tried, ERR_MODULE_NOT_FOUND). Adding extensions to the entire subtree for this
 * single check is not worth it, so shape is verified here: the target to watch, "whether the
 * registration point moved", happens to be statically visible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("LANBOOT-1 those two panels must no longer contain a top-level registration", () => {
  // The original code was file top-level `if (!ONLINE) { setDefaultLanMemberSource(...) }`,
  // registering whenever imported.
  // It worked by coincidence: the review on 2026-10-28 calculated the import closure: starting
  // from `src/mobile/MobileApp.tsx`, neither of these two panels is **in the closure**, while
  // `src/mobile/useMembers.ts` was calling `getMemberSource()`.
  // Today it does not break only because `src/Shell.tsx` statically imports `Editor` / `StartPage`,
  // while `MobileApp` itself is lazy().
  // If someone turns `Editor` into lazy in the future, the mobile app member list silently becomes
  // empty. Therefore this check watches the shape of "top-level call".
  for (const [rel, fn] of [
    ["src/editor/sync/MembersPanel.tsx", "setDefaultLanMemberSource"],
    ["src/start/JoinPanel.tsx", "setDefaultLanJoinSource"],
  ]) {
    const src = read(rel);
    assert.ok(
      !src.includes(fn + "("),
      rel + " again contains " + fn + "(…). The LAN default implementation must be registered at the entry point" +
        " (src/editor/sync/lanBoot.ts), never at module top level as a side effect.",
    );
  }
});

test("LANBOOT-2 the entry point does register it, and with the online condition", () => {
  const main = read("src/main.tsx");
  assert.ok(main.includes("registerLanDefaults"), "registerLanDefaults() is not called in src/main.tsx");
  assert.ok(
    main.includes("if (!ONLINE) registerLanDefaults()"),
    "The entry line must carry the ONLINE condition: there is no LAN in online browser mode, " +
      "members and joining are handled by the real implementation registered by the cloud table",
  );
});

test("LANBOOT-3 lanBoot itself: both sources are registered, and idempotently", () => {
  const src = read("src/editor/sync/lanBoot.ts");
  for (const fn of ["setDefaultLanMemberSource", "setDefaultLanJoinSource"]) {
    assert.ok(src.includes(fn + "("), "lanBoot.ts does not register " + fn + ": if one is missing, that side falls back to the unusable default");
  }
  assert.ok(
    src.includes("if (registered) return;"),
    "lanBoot.ts is missing the idempotency guard: if anyone calls it again outside the entry point, it would replace the already registered implementations with a newly constructed one",
  );
});

test("LANBOOT-4 core → lan may have only the one edge from the entry point", () => {
  // The Lite edition (local only, no LAN) is to be cut out from community edition without
  // opening a separate repository, so the architectural rule is that core must not import lan.
  // **No gate is set up in this round** (the user stated that Lite build and checks will be added
  // after splitting the two repos), but that single edge at the entry was left intentionally and is
  // the cut Lite needs to make, so at least pin down that "it is indeed only at the entry".
  const lanBootImporters = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/[.](ts|tsx|mjs)$/.test(e.name) && !/[.]test[.]mjs$/.test(e.name)) {
        // Check line by line whether "this line is both an import and mentions lanBoot": merely pointing
        // the way in a comment does not count as an edge
        const lines = fs.readFileSync(full, "utf8").split(String.fromCharCode(10));
        const imports = lines.some((l) => l.includes("lanBoot") && l.trimStart().startsWith("import"));
        const self = path.relative(ROOT, full).split(path.sep).join("/") === "src/editor/sync/lanBoot.ts";
        if (imports || self) {
          lanBootImporters.push(path.relative(ROOT, full).split(path.sep).join("/"));
        }
      }
    }
  };
  walk(path.join(ROOT, "src"));
  assert.deepEqual(
    lanBootImporters.sort(),
    ["src/editor/sync/lanBoot.ts", "src/main.tsx"],
    "lanBoot should be imported only by the entry point src/main.tsx (itself excluded). The extra ones are new core → lan edges, " +
      "and Lite would have more cuts to make: to use LAN features, go through the seam registered from here.",
  );
});

