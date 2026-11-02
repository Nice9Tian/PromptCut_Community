/*
 * **Entry registration** of the default LAN implementation (belongs to the `lan` class, see `server/test/community-ownership.mjs`).
 *
 * ── Why this file exists ──
 *
 * On the public side (community edition), the "member source" and the "join source" are default implementations of
 * **replaceable seams**: LAN shared projects have a complete set of credential, member and invite code mechanisms,
 * so the default is not a stub that throws, but a LAN implementation that really runs (`lanMemberSource.ts`). On the
 * cloud side, `cloud/account/ui-manifest.tsx` registers the real implementation that overrides it.
 *
 * These two registrations used to be written at **module top level**, so whoever imported that panel registered them
 * as a side effect:
 *   `src/editor/sync/MembersPanel.tsx`  top level `if (!ONLINE) setDefaultLanMemberSource(...)`
 *   `src/start/JoinPanel.tsx`           top level `if (!ONLINE) setDefaultLanJoinSource(...)`
 *
 * This had two problems, and the user asked on 2026-10-28 to remove it:
 *
 * 1. **It worked by coincidence.** The review on 2026-10-28 worked out the import closure: starting from
 *    `src/mobile/MobileApp.tsx`, **neither panel is in the closure**, yet `src/mobile/useMembers.ts` calls
 *    `getMemberSource()`. It does not break today only because `src/Shell.tsx` statically imports `Editor` /
 *    `StartPage` (whose closures contain these two panels), while `MobileApp` itself is `lazy()`. **If someone later
 *    makes `Editor` lazy to slim the bundle, the member list on mobile silently becomes empty**: the default member
 *    source returns `null`, and `memberAdmin` throws "Member management for website accounts is not enabled for
 *    the current project".
 * 2. **The Lite edition cannot be trimmed cleanly.** Lite (local only, no LAN) has to be cut out of the community
 *    edition, but the registration points are scattered across the top levels of two panels, which amounts to
 *    "whoever imports it gets LAN". With registration centralized after the entry point, Lite only needs to skip this
 *    one line.
 *
 * ── This is the only core → lan edge ──
 *
 * `src/main.tsx` (core) calls `registerLanDefaults()`, which is the **only place** in the shared tree where core code
 * points at LAN code. The direction rule is normally "core must not import lan"; this one is left deliberately, and is
 * also the cut Lite has to make (the way to cut is ready-made: the load-swaps-in-an-empty-stub approach of
 * `server/vite-plugin-online-prune.ts`). **Do not add a second one elsewhere**: to use LAN things, go through the seam
 * registered from here.
 *
 * Relative imports always carry the `.ts` suffix: this file is loaded directly by a Node unit test
 * (`lanBoot.test.mjs`), and raw Node cannot resolve imports without the suffix (that is how `recoveryAssociation.ts`
 * crashed that time).
 */
import { setDefaultLanJoinSource, setDefaultLanMemberSource } from "./accountExtensions.ts";
import { createLanJoinSource, createLanMemberSource } from "./lanMemberSource.ts";
import { createInvite, localCollab } from "./collab.ts";
import { client as sharedClient, errorStatus } from "./sharedApi.ts";
import { adminOp, ensureDevice, enterShared, getSyncView } from "./syncManager.ts";

let registered = false;

/**
 * Register the LAN default member source and join source. Idempotent: one call from the entry point is enough.
 *
 * The caller decides whether it is online (`main.tsx` uses `ONLINE`): in online browser mode there is no LAN, and
 * both members and joining are handled by the real implementation registered from the cloud-side table.
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

/** For unit tests only: lets the next `registerLanDefaults()` register again */
export function resetLanDefaultsForTest(): void {
  registered = false;
}
