/**
 * Supporting fixture for overreach probe card: disk read attempts during Node-side script
 * processing (test fixture, defensive test, not attack code; defined in
 * `docs/plan/sound-online-render-task.md` section "Overreach probe card").
 *
 * Scripts are transpiled and imports resolved on the Node side by Vite in worker process. This file
 * includes one of each pattern that "causes Node side to read or list files outside working
 * directory", pointing to test files where probe placed fake credentials (`PROBE-FAKE-…`)
 * (`__OUTSIDE__` is replaced by probe with absolute path to that file, `__OUTSIDE_REL__` with
 * relative path from user card directory to it). Read-only: none will write, delete, or execute
 * other programs. It is also referenced as a build plugin by style fixture (`@plugin`), so top
 * level leaves a marker filename indicating "executed in Node": `process` only exists when loaded
 * as a plugin; probe verifies this marker does **not** appear.
 * Expected: host render service's synchronous file precheck rejects entire file (not installed, not
 * handed to Vite).
 */
import outsideRaw from "__OUTSIDE_REL__?raw";
import outsideUrl from "/@fs/__OUTSIDE__?url";

export const outsideGlob = import.meta.glob("__OUTSIDE_DIR_REL__/**/*", { query: "?raw", eager: true });
export const outsideNames = import.meta.glob("/../../**/*.json");
export const outsideAsset = new URL("__OUTSIDE_REL__", import.meta.url).href;
export const outsideDynamic = (name: string) => import(`__OUTSIDE_DIR_REL__/${name}.json`);
export const outside = { outsideRaw, outsideUrl };

// Only holds when loaded in Node as a build plugin (no process in browser): only reports "executed",
// reads and writes nothing else
const g = globalThis as any;
if (typeof g.process?.versions?.node === "string") console.log("OVERREACH-NODE-SIDE-EXECUTED PROBE-FAKE-NODE-EXEC-MARK");

export default function overreachNodeSidePlugin() { return { handler() {} }; }
