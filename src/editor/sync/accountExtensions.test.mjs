/**
 * 网站账号与成员接缝（`src/editor/sync/accountExtensions.ts` + `lanMemberSource.ts` + `cloud/account/manifest.ts`）单测。
 *
 * 覆盖：
 * 1. 替换型「成员源」（`MemberSource`）：公开侧局域网默认实现（`createLanMemberSource`）能列出在线/离线成员、通过 `adminOp("kick")` 踢人、通过 `createInvite` 签发局域网邀请码；
 * 2. 替换型「加入源」（`JoinSource`）：公开侧局域网默认实现（`createLanJoinSource`）能解析 `#invite=<43位>&doc=<路径>` 链接、凭邀请码与用户名兑换并握手加入；
 * 3. 贯穿型接缝（`formatUploadRejectionReason`、`projectLink`、`createAccountClient`）：未装 `cloud/` 时走默认兜底，安装 `cloud/account/manifest.ts` 后走云端实现；
 * 4. 可选加载器（`loadAccountExtensions`）：`manifestUrl` 指向不存在模块时安静返回 `false`，不抛未捕获异常。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it, beforeEach } from "node:test";
import {
  createAccountClient,
  formatUploadRejectionReason,
  getDefaultLanJoinSource,
  getDefaultLanMemberSource,
  getJoinSource,
  getMemberSource,
  loadAccountExtensions,
  projectLink,
  registerAccountExtensions,
  registerJoinSource,
  registerMemberSource,
  resetAccountExtensions,
  setDefaultLanJoinSource,
  setDefaultLanMemberSource,
} from "./accountExtensions.ts";
import {
  createLanJoinSource,
  createLanMemberSource,
  lanUsernameOk,
  splitLanMembers,
} from "./lanMemberSource.ts";

describe("accountExtensions & lanMemberSource seam", () => {
  beforeEach(() => {
    resetAccountExtensions();
  });

  it("splitLanMembers merges duplicate connections, ensures self is online, and sorts creator first", () => {
    const { online, offline } = splitLanMembers(
      [
        { username: "小王", role: "member", online: false },
        { username: "小王", role: "member", online: true },
        { username: "老张", role: "creator", online: true },
        { username: "小李", role: "member", online: false },
      ],
      "我",
      false,
    );
    assert.deepEqual(
      online.map((m) => m.username),
      ["老张", "我", "小王"],
    );
    assert.deepEqual(
      offline.map((m) => m.username),
      ["小李"],
    );
  });

  it("createLanMemberSource lists LAN members, kicks via adminOp, and creates LAN invite links", async () => {
    const adminCalls = [];
    const lanSource = createLanMemberSource({
      getSyncView: () => ({
        shared: {
          where: "lan",
          base: "http://192.168.1.10:5180/doc/p_lan1",
          projectId: "p_lan1",
          name: "局域网测试片",
          mode: "free",
          as: "creator",
          username: "房主",
        },
        members: [
          { username: "房主", creator: true, online: true, deviceId: "dev_host", deviceName: "HostPC" },
          { username: "成员甲", creator: false, online: true, deviceId: "dev_a", deviceName: "AlicePC" },
        ],
      }),
      adminOp: async (op, auth, fields) => {
        adminCalls.push({ op, auth, fields });
        return { ok: true, reply: {}, key: "k_delegated" };
      },
      localCollab: () => ({ creatorPassword: "pw_creator_secret" }),
      createInvite: async (pw) => ({
        ok: true,
        invite: {
          link: `http://192.168.1.10:5180/#invite=${"A".repeat(43)}&doc=%2Fdoc%2Fp_lan1`,
          expiresAt: 1900000000000,
          maxUses: 10,
        },
      }),
    });

    setDefaultLanMemberSource(lanSource);
    assert.equal(getMemberSource().kind, "lan");

    const snap = await getMemberSource().fetchMembers();
    assert.ok(snap);
    assert.equal(snap.projectId, "p_lan1");
    assert.equal(snap.creatorAccountId, "房主");
    assert.equal(snap.members.length, 2);
    assert.equal(snap.devices.length, 2);

    const kickRes = await getMemberSource().kickLanMember(
      { username: "成员甲", deviceId: "dev_a" },
      { password: "pw_creator_secret" },
    );
    assert.deepEqual(kickRes, { ok: true, key: "k_delegated" });
    assert.equal(adminCalls.length, 1);
    assert.equal(adminCalls[0].op, "kick");
    assert.deepEqual(adminCalls[0].fields, { username: "成员甲", deviceId: "dev_a" });

    const inviteRes = await getMemberSource().createInvite("pw_creator_secret");
    assert.equal(inviteRes.ok, true);
    assert.ok(inviteRes.link.includes("#invite="));
  });

  it("createLanJoinSource resolves and redeems LAN invite links without website accounts", async () => {
    const code = "B".repeat(43);
    const link = `http://192.168.1.20:5180/#invite=${code}&doc=%2Fdoc%2Fp_lan2`;
    let enteredCandidate = null;
    let enteredCred = null;

    const joinSource = createLanJoinSource({
      resolveInvite: async ({ base, code: c }) => {
        assert.equal(base, "http://192.168.1.20:5180/doc/p_lan2");
        assert.equal(c, code);
        return { projectId: "p_lan2", name: "周末粗剪", mode: "free" };
      },
      redeemInvite: async ({ username, deviceId }) => {
        assert.equal(username, "小陈");
        assert.equal(deviceId, "dev_chen");
        return { projectId: "p_lan2", name: "周末粗剪", mode: "free", key: "k_member_ticket" };
      },
      ensureDevice: async () => ({ deviceId: "dev_chen", deviceName: "ChenPhone" }),
      enterShared: async (candidate, cred) => {
        enteredCandidate = candidate;
        enteredCred = cred;
        return { ok: true };
      },
    });

    setDefaultLanJoinSource(joinSource);
    const resolved = await getJoinSource().resolveLanInvite(link);
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.projectId, "p_lan2");
      const joined = await getJoinSource().joinLanByInvite({
        base: resolved.base,
        code: resolved.code,
        username: "小陈",
      });
      assert.deepEqual(joined, { ok: true, projectId: "p_lan2" });
      assert.equal(enteredCandidate.projectId, "p_lan2");
      assert.equal(enteredCred.key, "k_member_ticket");
    }
    assert.equal(lanUsernameOk("小陈"), true);
    assert.equal(lanUsernameOk(" bad "), false);
  });

  it("pass-through seams work both before and after cloud/account/manifest.ts registration", async () => {
    // 社区版默认兜底（未注册云端扩展时）
    assert.equal(
      formatUploadRejectionReason("guest-video-limit"),
      "游客最多上传 3 条视频。要传更多，请注册一个账号。",
    );
    assert.equal(
      projectLink("https://accounts.example/editor", "prj_0123456789abcdef01234567"),
      "https://accounts.example/editor/p/prj_0123456789abcdef01234567",
    );
    const fallbackClient = createAccountClient({
      online: true,
      origin: "https://accounts.example",
      device: { deviceId: "d1", deviceName: "Dev1" },
    });
    assert.deepEqual(await fallbackClient.thirdPartyProviders(), []);

    // 经可选加载器加载云端 manifest（cloud/ 在位时返回 true 并注册云端实现，不在时安静返回 false 并保持公开侧默认兜底）
    const cloudManifest = new URL("../../../cloud/account/manifest.ts", import.meta.url);
    const hasCloudManifest = fs.existsSync(cloudManifest);
    // 不给 manifestUrl 的那一支走 Vite 别名（`#promptcut-cloud-account`，见
    // `server/vite-plugin-cloud-seams.ts`）。node --test 里没有别名表，所以必然是 false ——
    // 那正是「没装云端扩展」，局域网默认实现继续生效。
    assert.equal(await loadAccountExtensions({ includeUi: false }), false);
    assert.equal(getMemberSource(), getDefaultLanMemberSource(), "别名解析不到时成员源还是局域网那个");
    // 要验「装上之后」就显式给路径 —— 这是不变量 2 里「从调用方拿」的那种形式
    assert.equal(
      await loadAccountExtensions({ manifestUrl: cloudManifest.href, includeUi: false }),
      hasCloudManifest,
    );
    assert.equal(
      formatUploadRejectionReason("guest-file-too-large"),
      "游客上传的每一条源文件不能超过 100 MB。",
    );
    assert.equal(
      projectLink("https://accounts.example/editor", "prj_0123456789abcdef01234567", "tok_abc"),
      "https://accounts.example/editor/s/prj_0123456789abcdef01234567/tok_abc",
    );

    // 可选加载器对缺失路径返回 false
    resetAccountExtensions();
    const missingLoaded = await loadAccountExtensions({
      manifestUrl: new URL("./non-existent-cloud-manifest.ts", import.meta.url).href,
    });
    assert.equal(missingLoaded, false);
  });
});
