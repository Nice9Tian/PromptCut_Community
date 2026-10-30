/*
 * 局域网默认实现的**入口注册**（归 `lan` 类，见 `server/test/community-ownership.mjs`）。
 *
 * ── 为什么要有这个文件 ──
 *
 * 公开侧（社区版）的「成员源」和「加入源」是**替换型接缝**的缺省实现：局域网共享项目有一整套
 * 完整的凭证、成员与邀请码机制，所以缺省不是抛异常的桩，而是能真跑的局域网实现
 * （`lanMemberSource.ts`）。云端那一侧由 `cloud/account/ui-manifest.tsx` 注册真实现覆盖它。
 *
 * 原来这两处注册写在**模块顶层**，谁 import 到那个面板就顺带注册了：
 *   `src/editor/sync/MembersPanel.tsx`  顶层 `if (!ONLINE) setDefaultLanMemberSource(...)`
 *   `src/start/JoinPanel.tsx`           顶层 `if (!ONLINE) setDefaultLanJoinSource(...)`
 *
 * 这么写有两个问题，用户 2026-10-28 要求改掉：
 *
 * 1. **它靠巧合生效。** 2026-10-28 的审查算过 import 闭包：从 `src/mobile/MobileApp.tsx` 出发
 *    这两个面板**都不在闭包里**，而 `src/mobile/useMembers.ts` 就在调 `getMemberSource()`。
 *    今天不坏，只因为 `src/Shell.tsx` 静态 import 了 `Editor` / `StartPage`（它们的闭包里有这两个
 *    面板），而 `MobileApp` 自己是 `lazy()`。**将来谁为了瘦身把 `Editor` 改成 lazy，手机端的成员
 *    列表就静默变空** —— 缺省成员源回 `null`、`memberAdmin` 抛「当前项目未开启网站账号成员管理」。
 * 2. **Lite 版裁不干净。** Lite（只有本地、没有局域网）要从社区版裁出来，而注册点散在两个面板的
 *    顶层，就等于「谁 import 到就有局域网」。注册集中在入口之后，Lite 只要不走这一行即可。
 *
 * ── 这是 core → lan 唯一的一条边 ──
 *
 * `src/main.tsx`（core）调 `registerLanDefaults()`，这是共享树里核心代码指向局域网代码的
 * **唯一一处**。方向规则本来是「core 不许 import lan」，这一条是故意留的、也是 Lite 要剪的那一刀
 * （剪法现成：`server/vite-plugin-online-prune.ts` 那套 load 换空桩）。
 * **别在别处再加第二条** —— 要用局域网的东西，让它从这里注册进去的接缝拿。
 *
 * 相对 import 一律带 `.ts` 后缀：本文件会被 Node 单测直接载入（`lanBoot.test.mjs`），
 * 不带后缀 raw Node 解析不了（`recoveryAssociation.ts` 那次就是这么崩的）。
 */
import { setDefaultLanJoinSource, setDefaultLanMemberSource } from "./accountExtensions.ts";
import { createLanJoinSource, createLanMemberSource } from "./lanMemberSource.ts";
import { createInvite, localCollab } from "./collab.ts";
import { client as sharedClient, errorStatus } from "./sharedApi.ts";
import { adminOp, ensureDevice, enterShared, getSyncView } from "./syncManager.ts";

let registered = false;

/**
 * 把局域网的缺省成员源与加入源登记上。幂等，入口调一次就够。
 *
 * 调用方自己判在线与否（`main.tsx` 用 `ONLINE`）：在线浏览器模式里没有局域网，
 * 成员与加入都由云端那张表注册的真实现负责。
 */
export function registerLanDefaults(): void {
  if (registered) return;
  registered = true;

  setDefaultLanMemberSource(createLanMemberSource({ getSyncView, adminOp, localCollab, createInvite }));
  setDefaultLanJoinSource(
    createLanJoinSource({
      resolveInvite: (o) => sharedClient.resolveInvite(o),
      redeemInvite: (o) => sharedClient.redeemInvite(o),
      ensureDevice,
      enterShared,
      errorStatus,
    }),
  );
}

/** 只给单测用：让下一次 `registerLanDefaults()` 重新注册 */
export function resetLanDefaultsForTest(): void {
  registered = false;
}
