/**
 * Unit tests for website account and member seams (`src/editor/sync/accountExtensions.ts` +
 * `lanMemberSource.ts` + `cloud/account/manifest.ts`).
 *
 * Covers:
 * 1. Replaceable "member source" (`MemberSource`): public-side LAN default implementation
 *    (`createLanMemberSource`) can list online/offline members, kick members via `adminOp("kick")`,
 *    and issue LAN invite codes via `createInvite`;
 * 2. Replaceable "join source" (`JoinSource`): public-side LAN default implementation
 *    (`createLanJoinSource`) can parse `#invite=<43 chars>&doc=<path>` links, redeem with invite
 *    code and username, and join via handshake;
 * 3. Pass-through seams (`formatUploadRejectionReason`, `projectLink`, `createAccountClient`):
 *    uses default fallback when `cloud/` is not installed, and uses cloud implementation after
 *    `cloud/account/manifest.ts` is installed;
 * 4. Optional loader (`loadAccountExtensions`): quietly returns `false` without throwing unhandled
 *    exceptions when `manifestUrl` points to a nonexistent module.
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
        { username: "Xiao Wang", role: "member", online: false },
        { username: "Xiao Wang", role: "member", online: true },
        { username: "Lao Zhang", role: "creator", online: true },
        { username: "Xiao Li", role: "member", online: false },
      ],
      "Me",
      false,
    );
    assert.deepEqual(
      online.map((m) => m.username),
      ["Lao Zhang", "Me", "Xiao Wang"],
    );
    assert.deepEqual(
      offline.map((m) => m.username),
      ["Xiao Li"],
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
          name: "LAN test video",
          mode: "free",
          as: "creator",
          username: "Room owner",
        },
        members: [
          { username: "Room owner", creator: true, online: true, deviceId: "dev_host", deviceName: "HostPC" },
          { username: "Member A", creator: false, online: true, deviceId: "dev_a", deviceName: "AlicePC" },
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
    assert.equal(snap.creatorAccountId, "Room owner");
    assert.equal(snap.members.length, 2);
    assert.equal(snap.devices.length, 2);

    const kickRes = await getMemberSource().kickLanMember(
      { username: "Member A", deviceId: "dev_a" },
      { password: "pw_creator_secret" },
    );
    assert.deepEqual(kickRes, { ok: true, key: "k_delegated" });
    assert.equal(adminCalls.length, 1);
    assert.equal(adminCalls[0].op, "kick");
    assert.deepEqual(adminCalls[0].fields, { username: "Member A", deviceId: "dev_a" });

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
        return { projectId: "p_lan2", name: "Weekend rough cut", mode: "free" };
      },
      redeemInvite: async ({ username, deviceId }) => {
        assert.equal(username, "Xiao Chen");
        assert.equal(deviceId, "dev_chen");
        return { projectId: "p_lan2", name: "Weekend rough cut", mode: "free", key: "k_member_ticket" };
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
        username: "Xiao Chen",
      });
      assert.deepEqual(joined, { ok: true, projectId: "p_lan2" });
      assert.equal(enteredCandidate.projectId, "p_lan2");
      assert.equal(enteredCred.key, "k_member_ticket");
    }
    assert.equal(lanUsernameOk("Xiao Chen"), true);
    assert.equal(lanUsernameOk(" bad "), false);
  });

  it("pass-through seams work both before and after cloud/account/manifest.ts registration", async () => {
    // Community edition default fallback (when cloud extensions are not registered)
    assert.equal(
      formatUploadRejectionReason("guest-video-limit"),
      "Guests can upload at most 3 videos. To upload more, please sign up for an account.",
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

    // Load cloud manifest via optional loader (returns true and registers cloud implementation when
    // cloud/ is present; quietly returns false and keeps public-side default fallback when absent)
    const cloudManifest = new URL("../../../cloud/account/manifest.ts", import.meta.url);
    const hasCloudManifest = fs.existsSync(cloudManifest);
    // The branch without manifestUrl uses the Vite alias (`#promptcut-cloud-account`, see
    // `server/vite-plugin-cloud-seams.ts`). node --test has no alias table, so it is always false:
    // that is precisely "cloud extensions not installed", and the LAN default implementation
    // remains in effect.
    assert.equal(await loadAccountExtensions({ includeUi: false }), false);
    assert.equal(getMemberSource(), getDefaultLanMemberSource(), "when the alias cannot be resolved, the member source is still the LAN one");
    // To test "after installation", explicitly provide the path: this is the "obtained from caller"
    // form in invariant 2
    assert.equal(
      await loadAccountExtensions({ manifestUrl: cloudManifest.href, includeUi: false }),
      hasCloudManifest,
    );
    assert.equal(
      formatUploadRejectionReason("guest-file-too-large"),
      // When cloud extension is installed, copy is provided by the cloud version (still Chinese);
      // when not installed, it defaults to built-in English on the public side
      hasCloudManifest ? "Each source file uploaded by a guest cannot exceed 100 MB." : "Each source file uploaded by a guest cannot exceed 100 MB.",
    );
    assert.equal(
      projectLink("https://accounts.example/editor", "prj_0123456789abcdef01234567", "tok_abc"),
      "https://accounts.example/editor/s/prj_0123456789abcdef01234567/tok_abc",
    );

    // Optional loader returns false for missing paths
    resetAccountExtensions();
    const missingLoaded = await loadAccountExtensions({
      manifestUrl: new URL("./non-existent-cloud-manifest.ts", import.meta.url).href,
    });
    assert.equal(missingLoaded, false);
  });
});
