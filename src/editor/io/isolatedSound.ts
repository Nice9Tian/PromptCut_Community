/**
 * Editor page side: connects the sound half of the background stage (`stageSound.ts` on the stage RPC
 * end) as the isolated host of `cardAudio.ts` (`docs/plan/online-card-exec-contract.md` 3.5, section 6).
 * Only converts shapes; never executes any card code.
 *
 *   const link = createIsolatedSoundLink({ render: (request) => background stage RPC.synthCardAudio(request) });
 *   link.setState(state reported by the stage);     // call again whenever the load result changes; null = this thread is gone (stage replaced, page cannot execute)
 *   link.dispose();
 *
 * Once connected, the sound of user cards and media effect cards arriving synchronously follows rule B:
 * those judged light are synthesized on the sound thread through here, those judged heavy use existing output.
 *
 * Treat what the stage reports as untrusted input: the state is validated by shape and truncated;
 * the shape of sample chunks is checked once more in `cardAudio.ts`.
 * The project is sent with a request only once per version (a structured clone), after that only the key;
 * if the stage says it does not have this version (it restarted), resend once with the project.
 */
import { setIsolatedCardAudioHost, type CardAudioRequest, type IsolatedCardAudioHost } from "../../audio/cardAudio";

/** Sound state reported by the stage (same shape as `StageSoundState` in `src/online/cardRuntime/stageSound.ts`) */
export interface IsolatedSoundState {
  ready: Record<string, string>;
  blocked: Record<string, string>;
}

export interface IsolatedSoundRpcRequest {
  projectKey: string;
  project?: unknown;
  nodeId: string;
  start: number;
  count: number;
  sampleRate: number;
}

export interface IsolatedSoundLink {
  setState(state: unknown): void;
  host(): IsolatedCardAudioHost;
  dispose(): void;
}

const NO_PROJECT = /No such project version/;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** State reported by the stage → a clean copy (keys are card ids, values are short strings); returns null if the shape is wrong */
export function sanitizeSoundState(state: unknown): IsolatedSoundState | null {
  if (!isRecord(state)) return null;
  const pick = (v: unknown, max: number) => {
    const out: Record<string, string> = {};
    if (!isRecord(v)) return out;
    for (const [id, text] of Object.entries(v).slice(0, 500)) if (id && id.length <= 200 && typeof text === "string" && text) out[id] = text.slice(0, max);
    return out;
  };
  return { ready: pick(state.ready, 64), blocked: pick(state.blocked, 240) };
}

export function createIsolatedSoundLink(opts: { render: (request: IsolatedSoundRpcRequest, signal?: AbortSignal) => Promise<Float32Array> }): IsolatedSoundLink {
  let state: IsolatedSoundState | null = null;
  /** Project object → key (projects on the editor page are updated immutably, so one object is one version) */
  const keys = new WeakMap<object, string>();
  const sent = new Set<string>();
  let seq = 0;
  const keyOf = (project: unknown): string => {
    const owner = project as object;
    let key = keys.get(owner);
    if (!key) { key = `p${++seq}`; keys.set(owner, key); }
    return key;
  };
  const host: IsolatedCardAudioHost = {
    runnable: (cardId) => !!state && Object.hasOwn(state.ready, cardId),
    blocker: (cardId) => (state && Object.hasOwn(state.blocked, cardId) ? state.blocked[cardId] : null),
    versionOf: (cardId) => (state && Object.hasOwn(state.ready, cardId) ? state.ready[cardId] : ""),
    async render(request: CardAudioRequest, signal) {
      const projectKey = keyOf(request.project);
      const base = { projectKey, nodeId: request.nodeId, start: request.start, count: request.count, sampleRate: request.sampleRate };
      const first = !sent.has(projectKey);
      sent.add(projectKey);
      if (sent.size > 64) { sent.clear(); sent.add(projectKey); }
      try {
        return await opts.render(first ? { ...base, project: request.project } : base, signal);
      } catch (err) {
        // The stage restarted and no longer has this version: resend once with the project
        if (first || !NO_PROJECT.test(String((err as Error)?.message ?? err))) throw err;
        return opts.render({ ...base, project: request.project }, signal);
      }
    },
  };
  return {
    setState(next) {
      const clean = next === null ? null : sanitizeSoundState(next);
      // Unchanged: do not disturb the sound side (switching host makes every sound in use fetch again; the
      // stage reports its state every time it loads a bundle)
      const same = (clean === null && state === null) || (!!clean && !!state && JSON.stringify(clean) === JSON.stringify(state));
      state = clean;
      // The stage replaced its batch of cards (or the thread is gone): it may no longer hold the projects
      // sent earlier, so send the project with the next request
      sent.clear();
      if (!same) setIsolatedCardAudioHost(clean ? host : null);
    },
    host: () => host,
    dispose() {
      state = null;
      sent.clear();
      setIsolatedCardAudioHost(null);
    },
  };
}
