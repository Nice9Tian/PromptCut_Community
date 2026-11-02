/**
 * Registration of cloud AI providers **must be synchronous, and at the entry point**.
 *
 * Why this deserves a dedicated gatekeeper: the hooks in `src/ai/extensions.ts` forward to
 * `currentProvider`; the community edition default barely calls hooks, while the cloud
 * implementation calls a whole chain. **Once the provider is swapped between two renders, the
 * number of hooks for the same component changes**, and React throws on the spot:
 *
 *     React has detected a change in the order of Hooks called by AiPanel
 *     TypeError: Cannot read properties of null (reading 'getSnapshot')
 *
 * That is how the LAN end-to-end probe crashed on 2026-10-28: `AiPanel` threw and took down half the
 * tree; the collaboration settings section was not rendered at all, and the probe never got the
 * invite link (even though invite-create on the server had actually succeeded). At the time,
 * `extensionsBrowser.ts` was written as "void an async import as soon as the module is referenced",
 * which was precisely causing mid-flight replacement.
 *
 * tsc, five gates, over eight thousand unit tests, two builds **were all green**: this pitfall is
 * only visible when the UI is actually rendered. So the shape is pinned down here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("AIEXT-1 The cloud AI table is a static import and must not be swapped in asynchronously", () => {
  const src = read("src/ai/extensionsBrowser.ts");
  assert.ok(
    src.includes('import * as cloudAi from "#promptcut-cloud-ai"'),
    "Use a static import to get the cloud AI table: only a static import finishes evaluating before this module's function bodies run, so there is no \"swapped in later\"",
  );
  assert.ok(
    !src.includes("await import(") && !src.includes("void ensure") && !src.includes("Promise"),
    "No async loading is allowed in this file: async = provider swapped in after render = the same component's hook count changes = React throws",
  );
});

test("AIEXT-2 Registration happens at the entry point, not on a component", () => {
  const boot = read("src/online/pageBoot.ts");
  assert.ok(
    boot.includes("registerAiCloudProviderFromTable()"),
    "registerAiCloudProviderFromTable() must be called once in the page boot sequence",
  );

  // Components are not allowed to handle registration themselves: CloudAiPanel is deep in the tree
  // and may be lazy-loaded; if attached to it, registration could still happen later than AiPanel's
  // first render
  const panel = read("src/editor/right/CloudAiPanel.tsx");
  assert.ok(
    !panel.includes("extensionsBrowser"),
    "CloudAiPanel must not import extensionsBrowser: registration belongs at the entry point, not \"whoever imports it registers\"",
  );
});

test("AIEXT-3 Registration is ordered before rendering", () => {
  // pageBoot is imported on line 2 of main.tsx (right after the render clock), while createRoot is at
  // the end of main.tsx; so as long as registration is in pageBoot, it is guaranteed to precede
  // rendering. This keeps watch that the order in main.tsx is not messed up.
  const main = read("src/main.tsx");
  const bootAt = main.indexOf("./online/pageBoot");
  const renderAt = main.indexOf("createRoot(");
  assert.ok(bootAt >= 0, "Does main.tsx no longer import ./online/pageBoot? The whole boot sequence is gone");
  assert.ok(renderAt >= 0, "createRoot( not found in main.tsx");
  assert.ok(
    bootAt < renderAt,
    "pageBoot must come before createRoot: the provider must be settled before React renders anything",
  );
});

