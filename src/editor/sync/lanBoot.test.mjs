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

test("LANBOOT-1 那两个面板里不许再有顶层注册", () => {
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
      rel + " 里又出现了 " + fn + "(…)。局域网缺省实现要在入口注册" +
        "（src/editor/sync/lanBoot.ts），不许放在模块顶层顺带注册。",
    );
  }
});

test("LANBOOT-2 入口里确实注册了，而且带在线判据", () => {
  const main = read("src/main.tsx");
  assert.ok(main.includes("registerLanDefaults"), "src/main.tsx 里没有调 registerLanDefaults()");
  assert.ok(
    main.includes("if (!ONLINE) registerLanDefaults()"),
    "入口那一行要带 ONLINE 判据：在线浏览器模式里没有局域网，" +
      "成员与加入由云端那张表注册的真实现负责",
  );
});

test("LANBOOT-3 lanBoot 自己：两个源都注册、而且幂等", () => {
  const src = read("src/editor/sync/lanBoot.ts");
  for (const fn of ["setDefaultLanMemberSource", "setDefaultLanJoinSource"]) {
    assert.ok(src.includes(fn + "("), "lanBoot.ts 没有注册 " + fn + " —— 少一个，那一侧就退回不可用的缺省");
  }
  assert.ok(
    src.includes("if (registered) return;"),
    "lanBoot.ts 少了幂等守卫：入口之外要是有人再调一次，会把已经注册好的实现换成新构造的一份",
  );
});

test("LANBOOT-4 core → lan 只许有入口那一条边", () => {
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
    "lanBoot 只该被入口 src/main.tsx 引（它自己不算）。多出来的那些是新的 core → lan 边，" +
      "Lite 要剪的刀会变多 —— 要用局域网的东西，从这里注册进去的接缝拿。",
  );
});

