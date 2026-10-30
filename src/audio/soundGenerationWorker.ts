/** Dedicated CPU worker; never creates an AudioContext or another playback engine. */
import { renderSoundEffectWav } from "./soundGeneration";
import type { SoundEffectRecipe } from "../kernel/soundEffects";
self.addEventListener("message", async (event: MessageEvent<SoundEffectRecipe>) => {
  try {
    const wav = await renderSoundEffectWav(event.data, {
      progress: progress => self.postMessage({ progress }),
      yield: () => Promise.resolve(),
    });
    (self as unknown as Worker).postMessage({ wav: wav.buffer }, [wav.buffer]);
  } catch (error) { self.postMessage({ error: String((error as Error)?.message ?? error) }); }
});
