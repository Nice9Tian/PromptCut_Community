/**
 * Online runtime and sync manager cloud extension seam unit tests (`src/online/online-seam.test.mjs`).
 *
 * Verify:
 *   1. Community edition default behavior (without `cloud/online/` or when cloud manifest not loaded):
 *      - `getBuildInfo()` / `CODE_VERSION` is `null`;
 *      - `bootApiGuard()` / `installApiGuard()` safely returns `null`;
 *      - `startUpdateCheck()` returns a silent controller with `hasUpdate: false`;
 *      - `getSyncCloudBackend()` provides a safe fallback implementation on the open side.
 *   2. When `PROMPTCUT_CLOUD_DIR` points to a non-existent directory (or `cloud/` directory is
 *      moved away), `loadOnlineExtensions` silently returns `false`.
 *   3. When `cloud/online/manifest.ts` exists, able to dynamically load and mount cloud extension
 *      implementations.
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

test("community edition defaults: buildInfo / apiGuard / updateCheck downgrade safely", () => {
  resetOnlineExtensionsForTest();
  assert.deepEqual(getBuildInfo(), { codeVersion: null });
  assert.equal(CODE_VERSION, null);
  // Input shape matches real signature in `cloud/online/apiGuard.ts`: `{ href, base }`,
  // not `{ online }` as originally written
  assert.equal(bootApiGuard(false), null);
  assert.equal(bootApiGuard(true), null, "with no cloud guard registered, online mode can only return null too");
  assert.equal(installApiGuard(true, { base: "/editor/" }), null);

  // Controller shape matches real signature in `cloud/online/updateCheck.ts`: getState() / subscribe() / stop(),
  // status is { hasUpdate, currentVersion, latestVersion }. Before 2026-10-27, assertions here were for
  // the state / reason / notifyProjectMinVersion set, but that API does not exist in the real implementation
  // (the explanation in boot.ts recorded why they could remain mismatched for so long).
  const ctrl = startUpdateCheck({ codeVersion: "v1" });
  assert.deepEqual(ctrl.getState(), { hasUpdate: false, currentVersion: null, latestVersion: null });
  const unsub = ctrl.subscribe(() => {});
  assert.equal(typeof unsub, "function");
  unsub();
  assert.equal(ctrl.getState().hasUpdate, false);
  ctrl.stop();
});

test("community edition default SyncCloudBackend: tombstone queries, account errors and the coordinator can all be called safely", async () => {
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

test("loadOnlineExtensions: when pointed at a nonexistent cloud directory, silently returns false and keeps the public-side defaults", async () => {
  resetOnlineExtensionsForTest();
  const loaded = await loadOnlineExtensions({
    cloudDir: path.join(process.cwd(), "__nonexistent_cloud_dir__"),
    forceReload: true,
  });
  assert.equal(loaded, false);
  assert.equal(CODE_VERSION, null);
});

test("registerOnlineExtensions and cloud/online/manifest.ts (if present) assembly check", async () => {
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
    // The branch not passing cloudDir uses Vite alias (`#promptcut-cloud-online`, see
    // `server/vite-plugin-cloud-seams.ts`). node --test has no alias table, so it is bound to be false:
    // that is precisely "cloud extension not installed", and open side default remains in effect.
    assert.equal(await loadOnlineExtensions({ forceReload: true }), false);
    assert.equal(getBuildInfo().codeVersion, null, "the defaults must not be overwritten when the alias cannot be resolved");

    // To verify "after installation", explicitly provide directory: this is invariant 2's
    // "Node side receives from caller" form
    const loaded = await loadOnlineExtensions({ cloudDir: cloudBase, forceReload: true });
    assert.equal(loaded, true);
  }
});

test("loadOnlineExtensions must wait for the manifest's ready: once it returns, it is usable", async () => {
  // 2026-10-31: Restore coordinator is asynchronously registered in manifest; originally this did
  // not wait, and `ensureOnlineExtensionsLoaded().then(start)` hit the empty implementation on the
  // open side; after real implementation registered, nobody called it again, leaving page forever
  // stuck on "Restoring original collaboration room".
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

test("after the cloud guard is registered: not installed in desktop mode, installed only in online mode", () => {
  // This slot was originally empty: section 11 only tested **after moving** `cloud/` away; nobody tested
  // desktop mode while `cloud/` was in place. Consequences found by two reviewers on 2026-10-28: the cloud
  // table registers unconditional `installApiGuard`, while the open-side seam completely dropped `online`
  // criterion, so desktop builds and dev server in private repo also installed online guard; desktop
  // editor's own /api/* was rejected and broke completely.
  resetOnlineExtensionsForTest();
  const calls = [];
  registerApiGuard((online, opts) => {
    calls.push({ online, base: opts?.base ?? null });
    return ["/api/account/"];
  });

  assert.equal(bootApiGuard(false, { base: "/" }), null, "never installed in desktop mode");
  assert.deepEqual(calls, [], "in desktop mode the closed-source install function must not even be called");

  assert.deepEqual(bootApiGuard(true, { base: "/editor/" }), ["/api/account/"], "must be installed in online mode");
  assert.deepEqual(calls, [{ online: true, base: "/editor/" }], "both online and base must be passed through as-is");

  resetOnlineExtensionsForTest();
});
