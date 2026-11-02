/**
 * Message handling for the sound thread (`docs/plan/online-card-exec-contract.md` 3.5). Pure logic:
 * module table and messaging methods are both supplied by the creator, so the thread entry
 * (`soundWorker.ts`) and unit tests share the same implementation.
 *
 * The thread contains a loader (the same `createCardLoader` as the stage, with the module table
 * replaced by the one containing placeholders) and an evaluation engine (`soundEngine.ts`).
 * The stage (`soundHost.ts`) sends three kinds of messages:
 *
 *   { t: "load", seq, bundles }                                → { t: "loaded", seq, results, audioCards, blocked }
 *   { t: "project", key, project }                             (no response; a given key is sent only once)
 *   { t: "render", id, key, nodeId, start, count, sampleRate } → { t: "block", id, samples }(buffer transfer) or { t: "error", id, message }
 *
 * `audioCards`: card ids loaded successfully with `audio()` defined: only their audio can be
 * synthesized online. `blocked`: entry key → reason, for failed loads (touched placeholder module
 * at top level, referenced module absent from thread, threw error). The stage reports both to the
 * editor page, which determines dispatch and panel descriptions from them.
 * The thread itself sets no timeout: timeouts are handled by stage `terminate()` (an infinite loop
 * can only be interrupted this way).
 */
import type { CardDef } from "../../kernel/types.ts";
import { createCardLoader, type CardLoaderOptions, type HostModules } from "./loader.ts";
import type { CardBundle, LoadResult } from "./protocol.ts";
import { createSoundEngine, type SoundEngine } from "./soundEngine.ts";
import { isSoundStubError } from "./soundStub.ts";

export type SoundThreadIn =
  | { t: "load"; seq: number; bundles: CardBundle[] }
  | { t: "project"; key: string; project: unknown }
  | { t: "render"; id: number; key: string; nodeId: string; start: number; count: number; sampleRate: number };

export type SoundThreadOut =
  | { t: "loaded"; seq: number; results: LoadResult[]; audioCards: string[]; blocked: Record<string, string> }
  | { t: "block"; id: number; samples: Float32Array }
  | { t: "error"; id: number; message: string };

export interface SoundThreadOptions {
  runtime: string;
  host: HostModules;
  compile?: CardLoaderOptions["compile"];
  post: (message: SoundThreadOut, transfer?: Transferable[]) => void;
  /** Swap out engine for tests */
  engine?: (getCard: (id: string) => CardDef<any> | undefined) => SoundEngine;
}

/** How many project copies to retain (evaluating many blocks in a row for the same audio sends the project only once; projects change frequently during editing, so keep the most recent copies) */
export const SOUND_PROJECTS_KEPT = 4;

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split("\n")[0].slice(0, 240);

export function createSoundThread(opts: SoundThreadOptions): { handle(message: SoundThreadIn): Promise<void>; cards(): string[] } {
  let cards = new Map<string, CardDef<any>>();
  const getCard = (id: string) => cards.get(id);
  const engine = (opts.engine ?? createSoundEngine)(getCard);
  const loader = createCardLoader({
    runtime: opts.runtime, host: opts.host, compile: opts.compile,
    onCards: (defs) => { cards = new Map(defs.map((d) => [d.id, d])); engine.reset(); },
  });
  const projects = new Map<string, unknown>();

  return {
    cards: () => [...cards.keys()],
    async handle(message) {
      if (!message || typeof message !== "object") return;
      if (message.t === "load") {
        let results: LoadResult[] = [];
        try { results = await loader.setBundles(Array.isArray(message.bundles) ? message.bundles : []); } catch { results = []; }
        const blocked: Record<string, string> = {};
        for (const r of results) {
          if (r.ok) continue;
          const detail = r.state.detail ?? r.state.state;
          blocked[r.entry] = r.state.state === "missing-module" ? `The sound thread has no module ${detail}` : isSoundStubError(detail) ? detail : `Error while loading (${detail})`;
        }
        const audioCards = [...cards.values()].filter((d) => typeof d.audio === "function").map((d) => d.id).sort();
        opts.post({ t: "loaded", seq: message.seq, results, audioCards, blocked });
        return;
      }
      if (message.t === "project") {
        if (typeof message.key !== "string" || !message.key) return;
        projects.delete(message.key);
        projects.set(message.key, message.project);
        while (projects.size > SOUND_PROJECTS_KEPT) projects.delete(projects.keys().next().value as string);
        return;
      }
      if (message.t === "render") {
        const { id } = message;
        try {
          if (!projects.has(message.key)) throw new Error("The sound thread does not have this project revision");
          const samples = await engine.render({ project: projects.get(message.key), nodeId: message.nodeId, start: message.start, count: message.count, sampleRate: message.sampleRate });
          // Copy before transferring: card code might return a view of a buffer it retains
          const out = new Float32Array(samples);
          opts.post({ t: "block", id, samples: out }, [out.buffer]);
        } catch (err) {
          opts.post({ t: "error", id, message: firstLine(err) });
        }
      }
    },
  };
}
