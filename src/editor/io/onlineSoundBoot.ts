/**
 * Connects the online sound judgment (`onlineSoundJudge.ts`) to the cost table of the in-page snapshot
 * store L2.
 * A separate file: L2 is not wired in Node unit tests, and the judgment itself must be runnable in unit tests.
 * Imported by the preview's sound layer (`src/editor/preview/MediaLayers.tsx`), so it is wired as soon as the
 * editor page opens.
 */
import { createMemorySoundCostStore, type SoundCostStore } from "../../audio/soundCost";
import { pageL2 } from "../../online/l2";
import { configureOnlineSoundJudge } from "./onlineSoundJudge";

const fallback = createMemorySoundCostStore();
configureOnlineSoundJudge({
  // If L2 cannot be opened (no IndexedDB, rejected by the browser), record only in page memory
  store: () => pageL2().then((store) => store as SoundCostStore, () => fallback),
});
