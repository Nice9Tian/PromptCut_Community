/**
 * Formulas for stage ports, **computed once and used in four places** (J4: "the number of stage
 * ports is taken from a constant `STAGE_PORTS = 2`").
 *
 * Where it is used: starting reverse proxies in the editor process (`vite-plugin-stage-ports.ts`),
 * constructing `PROMPTCUT_CORS_ORIGINS` (`vite-plugin-prerender.ts`), writing port.json
 * (`vite-plugin-ai.ts`), and assembling iframe URLs from injected ports in the page
 * (`src/editor/previewMode.ts`). In the future, when a third iframe (the prerenderer in online
 * browser mode, L1) occupies a third port, only this single constant needs to change.
 *
 * Why "editor port +1, +2" instead of picking any two free ports: both the desktop shell and probes
 * need to know these two addresses **outside the page** (port.json, `--origin` inference); a fixed
 * offset is simpler than passing port numbers around; if port collisions occur, the proxy is not
 * started and the page itself falls back to same-origin single stage (see description in the plugin).
 */

/** Number of stage iframes = number of stage ports */
export const STAGE_PORTS = 2;

/** Editor port → two stage ports */
export function stagePortsOf(editorPort) {
  return Array.from({ length: STAGE_PORTS }, (_, i) => Number(editorPort) + 1 + i);
}

/**
 * All origin representations for the two stage ports. `PROMPTCUT_CORS_ORIGINS` must permit
 * according to this list: when pages in stage iframes call the prerender process (snapshot bytes in
 * J3, SSE in C3), the Origin they carry is their own origin, not the editor's origin.
 */
export function stageOriginsOf(editorPort, hosts = ["127.0.0.1", "localhost", "[::1]"]) {
  return stagePortsOf(editorPort).flatMap((p) => hosts.map((h) => `http://${h}:${p}`));
}
