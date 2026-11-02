/**
 * Placeholder modules in sound thread (`docs/plan/online-card-exec-contract.md` 3.5). Pure logic,
 * loaded directly by unit tests.
 *
 * The sound thread is a dedicated background thread without DOM. Packages requiring DOM immediately
 * upon load (`lottie-web`, `@tsparticles/*`, `react-dom`) and visual built-in modules (component
 * files under `src/cards/`, `src/parts/`) are given placeholders: **importing or accessing properties
 * on them never throws** (for cards with both visuals and `audio()` in the same file, the file top can
 * still write `import lottie from "lottie-web"` or `const Box = motion.div`), **and only actually
 * calling or `new`-ing them throws** "cannot use <name> in sound code". If the top level of a card
 * file calls a placeholder, the card fails to load in the sound thread, its audio cannot be
 * synthesized online, and it falls back to existing artifacts.
 */

/** Error thrown when a placeholder is invoked; sound thread uses it to report failure reason */
export const SOUND_STUB_PREFIX = "Sound code cannot use ";

export function soundStubMessage(name: string): string {
  return `${SOUND_STUB_PREFIX}${name}`;
}

/** Placeholder for a module: any property is the same placeholder (can chain property access), throws only on call or `new` */
export function createSoundStub(name: string): unknown {
  const fail = (): never => { throw new Error(soundStubMessage(name)); };
  // Target is a function: the placeholder can be referenced as a component or read for `.name` as a function, just cannot be invoked
  const target = function soundStub() { /* Placeholder */ };
  const stub: unknown = new Proxy(target, {
    get(_t, key) {
      if (key === "__esModule") return true;
      // Should not throw when `await`ed, interpolated into template strings, or JSON-serialized, nor be treated as a thenable
      if (key === "then" || key === Symbol.toPrimitive || key === Symbol.iterator || key === Symbol.asyncIterator || key === "toJSON") return undefined;
      if (key === Symbol.toStringTag) return "SoundStub";
      if (key === "toString") return () => `[placeholder ${name}]`;
      if (key === "$$typeof" || key === "prototype") return undefined;
      return stub;
    },
    has: () => true,
    apply: fail,
    construct: fail,
    set: () => true,
  });
  return stub;
}

/** Whether the error was thrown by a placeholder (sound thread classifies it as "this card's audio cannot be synthesized online") */
export function isSoundStubError(err: unknown): boolean {
  return String((err as Error)?.message ?? err).includes(SOUND_STUB_PREFIX);
}

/** Try the real module first; provide a placeholder if loading fails (module top level touched `document` / `window`) */
export function realOrStub(name: string, load: () => Promise<unknown>): () => Promise<unknown> {
  return async () => {
    try { return await load(); } catch { return createSoundStub(name); }
  };
}
