/**
 * 声音线程的消息处理(`docs/plan/online-card-exec-contract.md` 3.5)。纯逻辑:模块表、怎么发消息都由创建者给,
 * 所以线程入口(`soundWorker.ts`)与单测用同一份。
 *
 * 线程里有一个加载器(与舞台同一个 `createCardLoader`,模块表换成带占位的那一张)和一个求值引擎(`soundEngine.ts`)。
 * 舞台(`soundHost.ts`)发来三种消息:
 *
 *   { t: "load", seq, bundles }                                → { t: "loaded", seq, results, audioCards, blocked }
 *   { t: "project", key, project }                             (不回;同一个 key 只发一次)
 *   { t: "render", id, key, nodeId, start, count, sampleRate } → { t: "block", id, samples }(缓冲区转移)或 { t: "error", id, message }
 *
 * `audioCards`:载入成功、写了 `audio()` 的卡片 id —— 只有它们的声音能在线合成。`blocked`:入口键 → 原因,
 * 载入不成的(顶层碰了占位模块、引用了线程里没有的模块、抛错)。舞台把这两样报给编辑页面,分派与面板说明据此判。
 * 线程自己不设时限:超时由舞台 `terminate()`(死循环只有这样掐得断)。
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
  /** 测试换掉引擎 */
  engine?: (getCard: (id: string) => CardDef<any> | undefined) => SoundEngine;
}

/** 手里留几份项目(同一段声音连着求很多块,项目只传一次;编辑中项目常换,留最近的几份) */
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
          blocked[r.entry] = r.state.state === "missing-module" ? `声音线程里没有模块 ${detail}` : isSoundStubError(detail) ? detail : `载入时出错(${detail})`;
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
          if (!projects.has(message.key)) throw new Error("声音线程里没有这一版项目");
          const samples = await engine.render({ project: projects.get(message.key), nodeId: message.nodeId, start: message.start, count: message.count, sampleRate: message.sampleRate });
          // 复制一份再转移:卡片代码可能回的是它自己留着的缓冲区的视图
          const out = new Float32Array(samples);
          opts.post({ t: "block", id, samples: out }, [out.buffer]);
        } catch (err) {
          opts.post({ t: "error", id, message: firstLine(err) });
        }
      }
    },
  };
}
