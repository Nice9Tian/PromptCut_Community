/**
 * Page startup sequence (C10a contract, sections 2 and 4). `main.tsx` imports it second (right after
 * the render clock): ES modules evaluate in import order, so guards are installed before top-level
 * code in other modules runs (some modules fetch `/api/*` upon loading).
 *
 * -- Why these tasks were not left in `boot.ts` (restored 2026-10-28) --
 *
 * The baseline `src/online/boot.ts` acted as both a startup hook and a do-it-all module. When Task E
 * rewrote it into a "seam registry", this entire startup sequence **was deleted without any
 * replacement**: the number one issue caught independently by two reviewers. The consequences were
 * real: invite links were no longer captured (and because that line in the baseline **did not include
 * the `ONLINE` condition**, it **broke both the desktop app and LAN edition together**, which is the
 * entire point of retaining the LAN layer), hardening and self-checks for the cross-origin stage were
 * not installed, the online page flag was never set (read by over thirty modules), and the dual stage
 * runtime config was never fetched (the stage iframe in the online preview area would never render).
 * Yet that line `import "./online/boot"` in `main.tsx` was untouched, with the comment beside it still
 * reading "must precede evaluation of other modules".
 *
 * The root cause was not an accidental slip: `src/online/online-seam.test.mjs` statically imports
 * `boot.ts`, whereas gatekeeper test C10A-MODE-01 forbids modules loaded by unit tests from
 * statically importing `mode.ts`: to make the new test pass, `import { ONLINE }` in `boot.ts` was
 * stripped out, and the startup sequence was dragged away with it. So the fix is **splitting the
 * file**, not adding `ONLINE` back to `boot.ts`: this file imports `mode.ts` (no Node unit test
 * imports it), while `boot.ts` remains a pure registry free of mode dependencies.
 *
 * -- Why the cloud table is **statically** imported here --
 *
 * Real implementations of guards and code versions reside on the closed-source side and must be
 * registered into the registry of `boot.ts` before they can be used. Statically importing ensures
 * that the cloud table finishes evaluation before this file's function body (ES modules are
 * depth-first), so: guards are still installed before other modules (contract requirement), and the
 * live binding `CODE_VERSION` already has a value before `Shell.tsx` reads it at top level (otherwise
 * iPad identity pre-determination always resolves to `"dev"`). In the community edition, this alias
 * resolves to an empty stub, registering nothing, and each item below safely downgrades on its own.
 */
import { ONLINE } from "./mode";
// The cloud table calls `registerOnlineExtensions` at its module top level; the community edition
// is an empty stub, exporting nothing and registering nothing
import "#promptcut-cloud-online";
import { bootApiGuard, CODE_VERSION } from "./boot";
// Cloud AI provider: must be registered before React renders. Replacing it midway changes the
// number of hooks in the same component, causing React to throw immediately (this was how the LAN
// probe crashed on 2026-10-28; see the file header of extensionsBrowser.ts for details)
import { registerAiCloudProviderFromTable } from "../ai/extensionsBrowser";
import { captureInviteFromLocation } from "./invite";
import { markOnlinePage } from "./pageFlag";
import { loadStageConfig } from "./stageOrigins";
import { bootStageGuard } from "./isolation/stageGuard";
import { bootStageGate, forcedTierOf } from "./stageGate";
import { ensureDecodeLimit } from "./mediaGate";

// Cross-origin stage (`stage.html` from online build): hardening and self-checks are scheduled
// before other modules evaluate and before any card code (contract `online-card-exec-contract.md`,
// section 3). Does nothing in desktop runtime environments, editor pages, or same-origin single stages
bootStageGuard({ online: ONLINE, base: import.meta.env.BASE_URL });
// Set runtime flag first: modules loaded by Node unit tests that cannot statically import mode.ts
// read it to disable /api calls (pageFlag.ts)
if (ONLINE) markOnlinePage();
// The `online` criterion cannot be omitted: if this guard is installed in desktop builds, the
// desktop editor's own /api/* calls will be rejected
bootApiGuard(ONLINE, { base: import.meta.env.BASE_URL });
registerAiCloudProviderFromTable();
// This line **does not include ONLINE**: joining via phone QR code scan in desktop app and LAN
// editions also relies on it to read `#invite=` and clear the passphrase from the address bar
captureInviteFromLocation();
const editorPage = ONLINE && typeof location !== "undefined" && !new URLSearchParams(location.search).has("stage");
if (editorPage) void loadStageConfig({ base: import.meta.env.BASE_URL });
// Stage gate (`stageGate.ts`): reads crash records, decides which level to attempt this time, and
// passes the result to `onlineTier.ts`; `?tier=` is only for development and acceptance checks.
// The asset gate decoder limit is measured once upon opening (remains unchanged during this session);
// if loading original-size assets previously caused crashes, it steps down several levels (recorded
// in crash records)
if (editorPage) {
  void bootStageGate({ version: CODE_VERSION ?? "dev", env: { forced: forcedTierOf(location.search) } })
    .then((g) => ensureDecodeLimit({ lowered: g.mediaLowered() }));
}
