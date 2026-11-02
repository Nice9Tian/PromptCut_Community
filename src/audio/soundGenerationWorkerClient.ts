import { renderSoundEffectWav } from "./soundGeneration";

/** Browser jobs always leave synthesis off the UI thread; cancellation terminates dense blocks too. */
export const renderSoundEffectWavInWorker: typeof renderSoundEffectWav = (recipe, options = {}) => {
  // The non-browser deterministic test/export runner uses the same pure block implementation.
  if (typeof Worker === "undefined") return renderSoundEffectWav(recipe, options);
  return new Promise<Uint8Array>((resolve, reject) => {
    options.signal?.throwIfAborted();
    const worker = new Worker(new URL("./soundGenerationWorker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { worker.terminate(); options.signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => {
      if (typeof event.data?.progress === "number") options.progress?.(event.data.progress);
      else if (event.data?.wav instanceof ArrayBuffer) { cleanup(); resolve(new Uint8Array(event.data.wav)); }
      else if (event.data?.error) { cleanup(); reject(new Error(event.data.error)); }
    };
    worker.onerror = event => { cleanup(); reject(new Error(event.message || "Sound effect synthesis process failed to start")); };
    worker.postMessage(recipe);
  });
};
