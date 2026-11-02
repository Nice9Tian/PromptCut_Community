/**
 * The sound half in the background stage (`docs/plan/online-card-exec-contract.md` 3.5): sound host
 * plus "entry → card" distribution, giving the stage RPC a ready-made shape.
 * **Created only in background stages**, with prerequisites identical to the visual half
 * (`stageRuntime.ts`).
 *
 *   const sound = createStageSound({ spawn, onState: (state) => report to editor page });
 *   await sound.setBundles(bundles sent by editor page);            // receives the same set of bundles as the visual half
 *   const samples = await sound.render({ projectKey, project?, nodeId, start, count, sampleRate });
 *   sound.dispose();
 *
 * The state reported to the editor page (`StageSoundState`) speaks in terms of **card id**: which
 * cards' audio can be synthesized online, signature of this generation, and reasons synthesis
 * failed. The editor page side uses `src/editor/io/isolatedSound.ts` to wire it as the isolated
 * host for `cardAudio.ts`.
 *
 * Project: sent only once per version by editor page (with `project`), afterwards sending only
 * `projectKey`; the most recent versions are retained here.
 */
import { syncedUserCards } from "../../kernel/registry.ts";
import type { CardBundle } from "./protocol.ts";
import { createSoundHost, type SoundHostOptions } from "./soundHost.ts";
import { tr } from "../../i18n/index.ts";

export interface StageSoundState {
  /** Card id whose audio can be synthesized online → signature of this generation's audio code (changes on generation switch) */
  ready: Record<string, string>;
  /** Card id that cannot be synthesized → reason (for panel) */
  blocked: Record<string, string>;
}

export interface StageSoundRequest {
  projectKey: string;
  /** This version of the project; may be omitted if the same `projectKey` was already sent */
  project?: unknown;
  nodeId: string;
  start: number;
  count: number;
  sampleRate: number;
}

export interface StageSound {
  setBundles(bundles: readonly CardBundle[]): Promise<StageSoundState>;
  render(request: StageSoundRequest, signal?: AbortSignal): Promise<Float32Array>;
  state(): StageSoundState;
  dispose(): void;
}

export interface StageSoundOptions extends SoundHostOptions {
  onState?: (state: StageSoundState) => void;
  /** Entry key → card ids whose source matches this entry in the sync table; by default queries stage's own registry (the copy sent by the editor page via `setSyncedUserCards`) */
  entryCards?: (entry: string) => readonly string[];
}

export const STAGE_SOUND_PROJECTS_KEPT = 4;
export const STAGE_SOUND_NO_PROJECT = "The sound thread does not have this project revision";

/** Short signature for a generation (only to determine if changed, collision resistance not required) */
function shortSig(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export function createStageSound(opts: StageSoundOptions): StageSound {
  const host = createSoundHost(opts);
  const entryCards = opts.entryCards ?? ((entry: string) => [...syncedUserCards().values()].filter((c) => c.source === entry).map((c) => c.id));
  const projects = new Map<string, unknown>();
  let current: StageSoundState = { ready: {}, blocked: {} };
  return {
    async setBundles(bundles) {
      const outcome = await host.setBundles(bundles);
      const generationOf = new Map(bundles.map((b) => [b.entry, b.generation]));
      const ready: Record<string, string> = {}, blocked: Record<string, string> = {};
      const audio = new Set(outcome.audioCards);
      for (const r of outcome.results) {
        if (r.ok) {
          for (const id of r.cardIds) if (audio.has(id)) ready[id] = shortSig(generationOf.get(r.entry) ?? r.generation);
          continue;
        }
        const reason = outcome.blocked[r.entry] ?? tr("Error while loading");
        for (const id of entryCards(r.entry)) if (!(id in ready)) blocked[id] = reason;
      }
      current = { ready, blocked };
      opts.onState?.(current);
      return current;
    },
    render(request, signal) {
      if (request.project !== undefined) {
        projects.delete(request.projectKey);
        projects.set(request.projectKey, request.project);
        while (projects.size > STAGE_SOUND_PROJECTS_KEPT) projects.delete(projects.keys().next().value as string);
      }
      if (!projects.has(request.projectKey)) return Promise.reject(new Error(STAGE_SOUND_NO_PROJECT));
      return host.render({ projectKey: request.projectKey, project: projects.get(request.projectKey), nodeId: request.nodeId, start: request.start, count: request.count, sampleRate: request.sampleRate }, signal);
    },
    state: () => current,
    dispose() {
      projects.clear();
      current = { ready: {}, blocked: {} };
      host.dispose();
    },
  };
}
