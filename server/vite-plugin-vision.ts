import type { Plugin, ViteDevServer } from "vite";
import { isPrerender } from "./render-role.mjs";
import { onCardSourceChange } from "./card-overrides.mjs";
import { invalidateWorkers, killWorker, renderWorkers } from "./vision/worker-pool";
import { registerEditorSide, registerPrerenderSide } from "./vision/routes";

export { bakeTarget } from "./vision/bake";

/**
 * Give the model eyes: render "what the timeline looks like at second t" into an image and return it.
 *
 * Why not capture in the browser: editor preview is an iframe (?stage=1), and page scripts have no
 * way to read the iframe frame into a bitmap. Therefore, it can only be rendered on the server.
 *
 * Why directly reuse server/bakery/ instead of starting another puppeteer instance:
 * the virtual clock, animation pinning, and asset preheating practices in that script form the
 * **entire** basis for export determinism (see explanation in its file header). Starting a separate
 * system would cause "what the model sees" and "what the user exports" to quietly diverge:
 * that is worse than having no vision, as the model would make changes based on a non-existent
 * image. The cost is launching a Chrome instance each time (a few seconds), which is acceptable for
 * viewing images a few times per call.
 */

/*
 * Images for the model: scaled down to max edge 768, transparent areas overlaid with a mid-tone
 * checkerboard. Implementation and rationale were moved to server/png-post.mjs:
 * that is pixel-by-pixel synchronous work handled by render workers in their own processes, no longer
 * occupying this process's event loop.
 *
 * Why a checkerboard instead of a solid color background (original explanation, preserved here):
 * previously backed by a near-black solid color, **dark cards placed on top effectively vanished**,
 * "nothing there" and "there is a dark card" looked identical. Real case (diagnostic report
 * chat-diagnostic-20260909-045354): for a 3D logo card with dark metal, the model inspected
 * see_frames 20 times in a row, thought the card was not rendered, and repeated the same 5 calls
 * verbatim for three rounds. Switched to a checkerboard, so transparent areas reveal the grid pattern.
 */
export function visionPlugin(): Plugin {
  return {
    name: "promptcut-vision",
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      // When card source changes, render workers on both sides must discard spare pages
      onCardSourceChange(() => invalidateWorkers());
      /*
       * When the service shuts down (including config dependency changes, vite restarting in the same
       * process), kill all render workers spawned by this process. Restarting reloads this module,
       * leaving workers held by the old module unmanaged: resident ones (hot standby, foreground) never
       * exit on idle, leaking two Chrome instances on every restart.
       */
      server.httpServer?.on("close", () => {
        for (const w of [...renderWorkers]) killWorker(w, new Error("Service shut down"));
      });

      if (!isPrerender) {
        registerEditorSide(server, root);
        return;
      }
      registerPrerenderSide(server, root);
    },
  };
}

export default visionPlugin;
