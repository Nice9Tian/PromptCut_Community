/** Async control initialization belongs to the frame being rendered. DOM
 * quietness alone cannot detect a pending loader/worker. Components dispose
 * their ticket on unmount so an old card cannot block a new request.
 */
const work = new Map<symbol, { label: string; done: Promise<void>; error?: Error }>();
export function beginFrameWork(label: string) {
  const id = Symbol(label);
  let resolve!: () => void;
  const item = { label, done: new Promise<void>(r => { resolve = r; }), error: undefined as Error | undefined };
  work.set(id, item);
  return {
    ready() { work.delete(id); resolve(); },
    fail(error: unknown) { if (work.has(id)) item.error = error instanceof Error ? error : new Error(String(error)); resolve(); },
    dispose() { work.delete(id); resolve(); },
  };
}
export function frameWorkStatus() { return [...work.values()].map(w => ({ label: w.label, error: w.error?.message })); }
export async function waitForFrameWork() {
  while (work.size) {
    for (const w of work.values()) if (w.error) throw new Error(`控件尚未就绪 (${w.label}): ${w.error.message}`);
    await Promise.all([...work.values()].map(w => w.done));
  }
}
