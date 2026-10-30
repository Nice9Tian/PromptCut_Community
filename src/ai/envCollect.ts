import { buildEnvReport, type EnvInput } from "./envReport";
import { getSkillSnapshot } from "../skill/skillMode";
import { getRealTabs } from "./agentTabs";
import { getState } from "../store/project";

/**
 * 把散在各个 store 里的「当时的现场」凑齐,再问服务端要它那一半。
 *
 * 拼装逻辑在 envReport.ts(纯函数,能单测);这里只负责取值和那一次网络请求 ——
 * 取值本身没什么可测的,而它们各自的 store 在测试环境里都要 mock 一遍才跑得起来。
 *
 * **任何一步失败都不许挡住报告**。诊断报告是用户已经遇到问题之后才点的,
 * 这时候本地服务很可能正是坏掉的那个;为了多一段现场把整份报告导不出来,
 * 是把唯一的线索也一起弄丢。所以每一段都各自 try,失败就在原地留一句话。
 */

/** 问服务端要环境信息的超时。它已经在本机了,五秒还不回就是它自己出事了 */
const SERVER_TIMEOUT_MS = 5000;

function clientInput(): EnvInput {
  const st = getState();
  const p = st.project;
  return {
    skill: (() => { try { return getSkillSnapshot().state; } catch { return null; } })(),
    agentTabs: (() => { try { return getRealTabs().length; } catch { return 1; } })(),
    project: {
      name: p.name,
      filePath: st.filePath,
      dirty: st.dirty,
      duration: p.duration,
      width: p.width,
      height: p.height,
      fps: p.fps,
      media: p.media.map((m) => ({
        id: m.id, name: m.name, kind: m.kind,
        duration: m.duration, width: m.width, height: m.height,
        path: m.path, hasTranscript: !!m.transcript,
      })),
      tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, clips: t.clips })),
    },
    storage: (() => { try { return localStorage; } catch { return null; } })(),
    agent: typeof navigator === "undefined" ? null
      : { userAgent: navigator.userAgent, language: navigator.language, platform: (navigator as any).platform },
    viewport: typeof window === "undefined" ? null
      : { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
  };
}

/** 服务端那一半:Node 进程状态、会话文件柜、装了哪些驱动 */
async function serverPart(): Promise<unknown> {
  try {
    // refresh=0:不要为了这份快照去给三个 CLI 各起一个子进程探活(单个超时 15 秒)。
    // 那会让最有价值的 sessions 段被探活拖到超时丢掉 —— 而这个按钮正是机器出问题时才点的。
    const res = await fetch("/api/ai/diagnostics?refresh=0", { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) });
    const data = await res.json();
    if (!res.ok || !data?.ok) return { error: data?.error || `HTTP ${res.status}` };
    return data;
  } catch (e) {
    // 服务没起来本身就是一条线索,别把它咽掉
    return { error: e instanceof Error ? e.message : String(e), 说明: "取不到服务端信息 —— 本地服务可能没在跑,这本身可能就是问题所在" };
  }
}

export async function collectEnvironment(visibleMessages: number): Promise<Record<string, unknown>> {
  let client: Record<string, unknown>;
  try {
    client = buildEnvReport({ ...clientInput(), visibleMessages });
  } catch (e) {
    client = { error: e instanceof Error ? e.message : String(e), 说明: "界面这边的现场没采集成功" };
  }
  return { ...client, server: await serverPart() };
}
