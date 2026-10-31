/**
 * 在线运行时与同步管理器云端扩展接缝单测（`src/online/online-seam.test.mjs`）。
 *
 * 验证：
 *   1. 社区版缺省行为（无 `cloud/online/` 或未加载云端清单时）：
 *      - `getBuildInfo()` / `CODE_VERSION` 为 `null`；
 *      - `bootApiGuard()` / `installApiGuard()` 安全返回 `null`；
 *      - `startUpdateCheck()` 返回 `hasUpdate: false` 的静默控制器；
 *      - `getSyncCloudBackend()` 提供安全的公开侧兜底实现。
 *   2. `PROMPTCUT_CLOUD_DIR` 指向不存在目录（或 `cloud/` 目录被移走）时，`loadOnlineExtensions` 静默回 `false`。
 *   3. 当 `cloud/online/manifest.ts` 存在时，能够动态加载并装配云端扩展实现。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODE_VERSION,
  bootApiGuard,
  registerApiGuard,
  getBuildInfo,
  getSyncCloudBackend,
  installApiGuard,
  loadOnlineExtensions,
  registerOnlineExtensions,
  resetOnlineExtensionsForTest,
  startUpdateCheck,
} from "./boot.ts";

test("社区版缺省：buildInfo / apiGuard / updateCheck 安全降级", () => {
  resetOnlineExtensionsForTest();
  assert.deepEqual(getBuildInfo(), { codeVersion: null });
  assert.equal(CODE_VERSION, null);
  // 入参形状照 `cloud/online/apiGuard.ts` 的真实签名：`{ href, base }`，不是原来写的 `{ online }`
  assert.equal(bootApiGuard(false), null);
  assert.equal(bootApiGuard(true), null, "没登记云端守卫时，在线模式也只能回 null");
  assert.equal(installApiGuard(true, { base: "/editor/" }), null);

  // 控制器形状照 `cloud/online/updateCheck.ts` 的真实签名：getState() / subscribe() / stop()，
  // 状态是 { hasUpdate, currentVersion, latestVersion }。2026-10-27 之前这里断言的是
  // state / reason / notifyProjectMinVersion 那一套，而那套 API 在真实现里根本不存在
  // （boot.ts 里那段说明记了为什么能一直对不上）。
  const ctrl = startUpdateCheck({ codeVersion: "v1" });
  assert.deepEqual(ctrl.getState(), { hasUpdate: false, currentVersion: null, latestVersion: null });
  const unsub = ctrl.subscribe(() => {});
  assert.equal(typeof unsub, "function");
  unsub();
  assert.equal(ctrl.getState().hasUpdate, false);
  ctrl.stop();
});

test("社区版缺省 SyncCloudBackend：墓碑查询、账号异常与协调器均可安全调用", async () => {
  resetOnlineExtensionsForTest();
  const sync = getSyncCloudBackend();

  const gone = await sync.queryGone({ version: 1, where: "lan", roomId: "r1" });
  assert.deepEqual(gone, { gone: false });

  const err = sync.createAccountFailure(401, "login-required");
  assert.equal(sync.isAccountFailure(err), true);
  assert.equal(err.status, 401);
  assert.equal(err.code, "login-required");

  const delErr = sync.createCloudDelegationError("service-disabled");
  assert.equal(delErr.code, "service-disabled");

  assert.equal(sync.projectLink("https://pc.example.com/", "prj_1", "tok_2"), "https://pc.example.com/s/prj_1/tok_2");
  assert.equal(sync.projectLink("https://pc.example.com/", "prj_1"), "https://pc.example.com/p/prj_1");

  const coord = sync.createRecoveryCoordinator({
    state() {},
    async gone() { return { gone: false }; },
    async identity() { return {}; },
    async host() { return null; },
    async discover() { return null; },
    async enter() { return { ok: true }; },
  });
  const gen0 = coord.generation;
  coord.start({ version: 1 });
  assert.equal(coord.generation, gen0 + 1);
  coord.cancel();
  assert.equal(coord.generation, gen0 + 2);
});

test("loadOnlineExtensions：当指向不存在的 cloud 目录时静默返回 false 并保持公开侧缺省", async () => {
  resetOnlineExtensionsForTest();
  const loaded = await loadOnlineExtensions({
    cloudDir: path.join(process.cwd(), "__nonexistent_cloud_dir__"),
    forceReload: true,
  });
  assert.equal(loaded, false);
  assert.equal(CODE_VERSION, null);
});

test("registerOnlineExtensions 与 cloud/online/manifest.ts（若存在）装配验证", async () => {
  resetOnlineExtensionsForTest();
  registerOnlineExtensions({
    buildInfo: { codeVersion: "test-ver-123" },
  });
  assert.equal(getBuildInfo().codeVersion, "test-ver-123");
  assert.equal(CODE_VERSION, "test-ver-123");

  resetOnlineExtensionsForTest();
  const cloudBase = process.env.PROMPTCUT_CLOUD_DIR || path.join(process.cwd(), "cloud");
  const manifestPath = path.join(cloudBase, "online", "manifest.ts");
  if (fs.existsSync(manifestPath)) {
    // 不传 cloudDir 的那一支走 Vite 别名（`#promptcut-cloud-online`，见
    // `server/vite-plugin-cloud-seams.ts`）。node --test 里没有别名表，所以必然是 false ——
    // 那正是「没装云端扩展」，公开侧缺省继续生效。
    assert.equal(await loadOnlineExtensions({ forceReload: true }), false);
    assert.equal(getBuildInfo().codeVersion, null, "别名解析不到时不许把缺省改掉");

    // 要验「装上之后」就显式给目录 —— 这是不变量 2 里「Node 侧从调用方拿」的那种形式
    const loaded = await loadOnlineExtensions({ cloudDir: cloudBase, forceReload: true });
    assert.equal(loaded, true);
  }
});

test("loadOnlineExtensions 要等清单的 ready：返回了就是能用了", async () => {
  // 2026-10-31：恢复协调器是清单里异步注册的，原来这里不等，`ensureOnlineExtensionsLoaded().then(start)`
  // 打在公开侧的空实现上，真实现注册之后没人再叫一次，页面永远停在「正在恢复原协作房间」。
  resetOnlineExtensionsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "online-ready-"));
  try {
    fs.mkdirSync(path.join(dir, "online"));
    fs.writeFileSync(path.join(dir, "online", "manifest.ts"),
      "export const manifest = { ready: new Promise((r) => setTimeout(() => { globalThis.__onlineReady = true; r(); }, 30)) };\n");
    assert.equal(await loadOnlineExtensions({ cloudDir: dir, forceReload: true }), true);
    assert.equal(globalThis.__onlineReady, true);
  } finally {
    delete globalThis.__onlineReady;
    fs.rmSync(dir, { recursive: true, force: true });
    resetOnlineExtensionsForTest();
  }
});

test("登记了云端守卫之后：桌面模式不许装，在线模式才装", () => {
  // 这一格原来是空的 —— 第十一节只验了把 `cloud/` **挪走之后**，没人在 `cloud/` 在位时
  // 按桌面模式走一遍。2026-10-28 两位审查者查出的后果：云端表注册的是无条件的
  // `installApiGuard`，而公开侧接缝又把 `online` 判据整个丢了，于是私有仓库的桌面构建
  // 与 dev server 里也会装上在线守卫，桌面编辑器自己的 /api/* 被拒、全废。
  resetOnlineExtensionsForTest();
  const calls = [];
  registerApiGuard((online, opts) => {
    calls.push({ online, base: opts?.base ?? null });
    return ["/api/account/"];
  });

  assert.equal(bootApiGuard(false, { base: "/" }), null, "桌面模式一律不装");
  assert.deepEqual(calls, [], "桌面模式连闭源那个安装函数都不该被调到");

  assert.deepEqual(bootApiGuard(true, { base: "/editor/" }), ["/api/account/"], "在线模式要装上");
  assert.deepEqual(calls, [{ online: true, base: "/editor/" }], "online 与 base 都要如实传下去");

  resetOnlineExtensionsForTest();
});
