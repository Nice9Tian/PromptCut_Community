/**
 * 局域网缺省实现的**入口注册**（用户 2026-10-28 的要求：走入口注册，别放在模块顶层顺带注册）。
 *
 * 这几条钉住的是**规矩本身**：注册点在哪、不在哪。缺省成员源/加入源自己的行为由
 * `accountExtensions.test.mjs` 覆盖（它按注入依赖直接构造，不载真的 syncManager）。
 *
 * **为什么是静态核对而不是真载进来跑**：`lanBoot.ts` 往下牵
 * `collab.ts` → `./syncManager`（不带扩展名）→ …，整个 `src/editor/sync/` 子树的相对 import 都
 * 不带后缀，只经 Vite 解析。raw Node 载不进来（试过，ERR_MODULE_NOT_FOUND）。
 * 为这一条去给整棵子树补后缀不值得，所以这里核对形状 —— 要盯的「注册点挪没挪」恰好是静态可见的。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("LANBOOT-1 those two panels must no longer contain a top-level registration", () => {
  // 原来的写法是文件顶层 `if (!ONLINE) { setDefaultLanMemberSource(...) }`，谁 import 到就注册。
  // 它靠巧合生效：2026-10-28 的审查算过 import 闭包 —— 从 `src/mobile/MobileApp.tsx` 出发这两个
  // 面板**都不在闭包里**，而 `src/mobile/useMembers.ts` 就在调 `getMemberSource()`。
  // 今天不坏只因为 `src/Shell.tsx` 静态引了 `Editor` / `StartPage`，而 `MobileApp` 自己是 lazy()。
  // 将来谁把 `Editor` 改成 lazy，手机端成员列表就静默变空。所以这条盯的是「顶层调用」这个形状。
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
  // Lite 版（只有本地、没有局域网）要从社区版裁出来、不另开仓库，所以方向规则是 core 不许 import lan。
  // **这一轮不立闸门**（用户说 Lite 构建与检查等拆完两仓之后再加），但入口那一条边是故意留的、
  // 也是 Lite 要剪的那一刀，所以至少钉住「它确实只在入口」。
  const lanBootImporters = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/[.](ts|tsx|mjs)$/.test(e.name) && !/[.]test[.]mjs$/.test(e.name)) {
        // 按行看「这一行既是 import、又提到 lanBoot」——只是在注释里指路不算一条边
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

