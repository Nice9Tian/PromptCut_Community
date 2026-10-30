/**
 * 后台舞台里的声音这一半(`docs/plan/online-card-exec-contract.md` 3.5):声音宿主加上「入口 → 卡片」的摊法,
 * 给舞台 RPC 一个现成的形状。**只在后台舞台里建**,前提与画面那一半(`stageRuntime.ts`)相同。
 *
 *   const sound = createStageSound({ spawn, onState: (state) => 报给编辑页面 });
 *   await sound.setBundles(编辑页面发来的包);            // 与画面那一半收的是同一组包
 *   const samples = await sound.render({ projectKey, project?, nodeId, start, count, sampleRate });
 *   sound.dispose();
 *
 * 报给编辑页面的状态(`StageSoundState`)按**卡片 id** 说话:哪些卡的声音能在线合成、这一代的签名、合成不了的原因。
 * 编辑页面那一侧用 `src/editor/io/isolatedSound.ts` 把它接成 `cardAudio.ts` 的隔离宿主。
 *
 * 项目:编辑页面每个版本只发一次(带 `project`),之后只带 `projectKey`;这里留最近几版。
 */
import { syncedUserCards } from "../../kernel/registry.ts";
import type { CardBundle } from "./protocol.ts";
import { createSoundHost, type SoundHostOptions } from "./soundHost.ts";

export interface StageSoundState {
  /** 声音能在线合成的卡片 id → 这一代声音代码的签名(换代就变) */
  ready: Record<string, string>;
  /** 合成不了的卡片 id → 原因(给面板) */
  blocked: Record<string, string>;
}

export interface StageSoundRequest {
  projectKey: string;
  /** 这一版项目;同一个 `projectKey` 发过就可以不带 */
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
  /** 入口键 → 同步表里源码是这个入口的卡片 id;缺省查舞台自己的注册表(编辑页面经 `setSyncedUserCards` 发来的那一份) */
  entryCards?: (entry: string) => readonly string[];
}

export const STAGE_SOUND_PROJECTS_KEPT = 4;
export const STAGE_SOUND_NO_PROJECT = "声音线程里没有这一版项目";

/** 一代的短签名(只为判「换没换」,不必抗碰撞) */
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
        const reason = outcome.blocked[r.entry] ?? "载入时出错";
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
