// 带 .ts 后缀:tsconfig 开了 allowImportingTsExtensions,而单测是用 node --test 直接跑
// .ts 的,无后缀的传递 import 它解析不了(projectAi.test.mjs 当初就栽在这上面)。
import { AI_SESSION_PREFIX } from "./aiSessionKeys.ts";

/**
 * 诊断报告里的「当时这台机器是什么状态」。
 *
 * # 为什么要有它
 *
 * 原来那份对话诊断只有对话本身:模型说了什么、调了哪些工具。用户报
 * 「Agent 看得见别的项目的素材」时,报告里看得到它张口说出一个不存在的文件名,
 * 却看不到**当时素材库到底有没有东西**、项目存在哪、界面处在哪个模式。
 * 于是「产品的 bug」和「这台机器的环境问题」一条都排除不掉,只能来回问用户。
 *
 * 这里补的就是那些现场:模式、项目和素材、可见对话条数、以及后端会话 id。
 * 服务端那半(Node 进程状态、会话文件柜)在 server/harness/env-snapshot.mjs。
 *
 * # 为什么是个纯函数
 *
 * 它读的东西散在四五个 store 里,取值本身不难,难的是「漏了哪一项」——
 * 而漏一项的代价就是又一轮来回问。所以取值和拼装分开:拼装在这里,能单测。
 */

export interface EnvMediaItem {
  id: string;
  name: string;
  kind: string;
  duration?: number;
  width?: number;
  height?: number;
  path?: string;
  hasTranscript?: boolean;
}

export interface EnvInput {
  /** 旧字段:原来记布局(传统式 / 对话式);对话式布局已去掉,不再传,旧报告里可能还有 */
  layout?: string;
  /** SKILL 模式;没开就传 null 或 { active:false } */
  skill?: { active: boolean; since?: string | null } | null;
  /** AI 栏开着几个 Agent 页签(多 Agent;含 spawn_agent 拉起的子 Agent) */
  agentTabs?: number;
  /** 当前项目;没有就传 null */
  project?: {
    name?: string;
    filePath?: string | null;
    dirty?: boolean;
    duration?: number;
    width?: number;
    height?: number;
    fps?: number;
    media?: EnvMediaItem[];
    tracks?: Array<{ id: string; name?: string; clips?: unknown[] }>;
  } | null;
  /** 界面上看得见的对话条数 */
  visibleMessages?: number;
  /** localStorage;传 undefined 表示读不到 */
  storage?: Pick<Storage, 'length' | 'key' | 'getItem'> | null;
  /** 浏览器/WebView 信息 */
  agent?: { userAgent?: string; language?: string; platform?: string } | null;
  /** 视口,排查布局类问题用 */
  viewport?: { width: number; height: number; dpr?: number } | null;
}

/** 值太长就截断:localStorage 里存过整段草稿,一条能把报告顶上撑爆 */
const VALUE_LIMIT = 200;

/**
 * 能把**原值**带进报告的键。是白名单,不是前缀通配。
 *
 * 原来写的是「`ai` 或 `pc.` 开头就收」,于是 `pc.ai.script`(用户手写的剧本正文,
 * 见 ai/script.ts)静默进了报告 —— 而这份报告是**要上传的**(ai/reportSubmit.ts)。
 * 更糟的是通配意味着将来任何新加的 `ai*` / `pc.*` 键都会自动跟着外发,
 * 加键的人不会想到这一层。
 *
 * 所以反过来:只有明确列进来的纯设置项才带值,别的只报「有这么个键、多长」。
 * 排查时「哪些设置存在、各多长」本身就够用,原文并不需要。
 */
const VALUE_SAFE = new Set([
  "aiProvider", "aiShowThinking", "aiViewMode", "aiSetupFace", "aiSetupDone",
  "pc.volume", "pc.muted", "pc.deps.sttDismissed", "pc.agentTabs.active",
]);
/**
 * 这些前缀下存的都是枚举 / 开关 / 数字(驱动名、模型名、思考档、布局标签页、面板宽度),
 * 带值安全,而且正是排查时要看的东西。
 *
 * 「pc.ai.」整个前缀**不能**放行 —— 用户手写的剧本就在 pc.ai.script 底下。
 * 所以逐个列出 pc.ai. 下面那几种设置。宁可少列几个:少列只是少一行信息,
 * 多列就是把用户的原创内容发出去。
 */
const VALUE_SAFE_PREFIX = [
  "pc.ai.model.", "pc.ai.effort.", "pc.ai.fast.", "pc.ai.deepAuto.",
  "pc.ai.deepAutoRounds.", "pc.ai.schemaCompat.", "pc.ai.toolProtocol.",
  "pc.left.", "pc.right.", "pc.timeline.",
];

function safeToShow(key: string): boolean {
  return VALUE_SAFE.has(key) || VALUE_SAFE_PREFIX.some((p) => key.startsWith(p));
}

/** 一句人话说清「现在是哪个模式」,省得从三个布尔值里推 */
export function describeMode(input: EnvInput): string {
  // 两种工作方式(user-workflow.md「工作方式」):传统式 / SKILL(桌面 APP 的 Agent 经 MCP 接入同一个项目,AI 栏照常可用)
  const bits = [input.skill?.active ? 'SKILL 模式(桌面 APP 的 Agent 经 MCP 改这个项目,AI 栏照常可用)' : '传统式'];
  if ((input.agentTabs ?? 1) > 1) bits.push(`多 Agent(${input.agentTabs} 个页签)`);
  return bits.join(' + ');
}

/**
 * 素材都在哪些目录下。
 *
 * 单列这一项是因为「新建项目落在临时目录」这类问题只在目录上看得出来:
 * 素材名字看着正常,路径却在 %TEMP% 下、或者压根还指着上一个项目的文件夹。
 */
export function mediaDirs(media: EnvMediaItem[]): string[] {
  const seen = new Set<string>();
  for (const m of media) {
    if (!m.path) continue;
    const cut = Math.max(m.path.lastIndexOf('\\'), m.path.lastIndexOf('/'));
    // cut === 0 是 posix 根下的文件(/a.mp4),目录就是根,不是「没有目录」
    seen.add(cut > 0 ? m.path.slice(0, cut) : cut === 0 ? '/' : '(没有目录)');
  }
  return [...seen];
}

/** localStorage 里和 AI / 编辑器有关的那些键。密钥不存这儿(在服务端 ai.json) */
function localKeys(storage: EnvInput['storage']): { sessionIds: Record<string, string>; settings: Record<string, string>; note?: string } {
  if (!storage) return { sessionIds: {}, settings: {}, note: '读不到 localStorage' };
  const sessionIds: Record<string, string> = {};
  const settings: Record<string, string> = {};
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k) continue;
      const v = storage.getItem(k);
      if (v === null) continue;
      const short = v.length > VALUE_LIMIT ? `${v.slice(0, VALUE_LIMIT)}…(共 ${v.length} 字)` : v;
      if (k.startsWith(AI_SESSION_PREFIX)) sessionIds[k] = short;
      else if (!/^(ai|pc\.)/.test(k)) continue;
      // 白名单外的只报「有这么个键、多长」:排查要的是「哪些设置存在」,不是原文 —— 见 VALUE_SAFE
      else settings[k] = safeToShow(k) ? short : `(有值,共 ${v.length} 字;不在白名单,不带原文)`;
    }
  } catch {
    return { sessionIds, settings, note: '读 localStorage 时出错,下面这些可能不全' };
  }
  return { sessionIds, settings };
}

export function buildEnvReport(input: EnvInput): Record<string, unknown> {
  const media = input.project?.media || [];
  const tracks = input.project?.tracks || [];
  const clips = tracks.reduce((n, t) => n + (t.clips?.length || 0), 0);
  const keys = localKeys(input.storage);
  const sessionCount = Object.keys(keys.sessionIds).length;

  return {
    说明: '出问题那一刻这台机器的现场。用来分清「产品的 bug」和「这台机器的环境问题」——只有对话本身的话,两者一条都排除不掉。',
    mode: {
      mode: input.skill?.active ? 'skill' : 'classic',
      skillActive: !!input.skill?.active,
      skill: input.skill?.active ? input.skill : null,
      agentTabs: input.agentTabs ?? 1,
      说明: describeMode(input),
    },
    project: input.project
      ? {
          name: input.project.name,
          // null 就是「还没存过盘」。新建项目一直没保存时素材落在临时目录,
          // 用户看到的一堆怪事都是从这儿来的,所以这一项要显式说出来
          filePath: input.project.filePath ?? null,
          saved: !!input.project.filePath,
          savedNote: input.project.filePath ? undefined : '这个项目还没保存过,素材和工作目录都在临时目录下',
          unsavedChanges: !!input.project.dirty,
          canvas: { width: input.project.width, height: input.project.height, fps: input.project.fps, duration: input.project.duration },
          tracks: tracks.map((t) => ({ id: t.id, name: t.name, clips: t.clips?.length || 0 })),
          clipCount: clips,
        }
      : null,
    media: {
      count: media.length,
      // 用户说「素材库里什么也没有」而模型偏偏说得出文件名 —— 这一行就是对质用的
      说明: media.length === 0 ? '素材库是空的:模型如果说得出任何素材名字,那不是从这个项目里读到的' : `素材库有 ${media.length} 个文件`,
      dirs: mediaDirs(media),
      items: media.map((m) => ({
        id: m.id, name: m.name, kind: m.kind,
        duration: m.duration, width: m.width, height: m.height,
        path: m.path ?? '(没有磁盘路径,可能是还没上传的 blob)',
        hasTranscript: !!m.hasTranscript,
      })),
    },
    chat: {
      visibleMessages: input.visibleMessages ?? null,
      backendSessionIds: keys.sessionIds,
      /*
       * 界面上是空的、后端却接着上一段历史,这种脱节没有任何界面症状。
       * 把两个数摆在一起,报告一眼就能看出来:可见 0 条 + 会话 id 还在
       * = 服务端会去 harness-sessions 里把旧历史整段读回来(见 aiSessionKeys.ts)。
       */
      说明: sessionCount === 0
        ? '没有残留的后端会话 id:这一轮是从零开始的'
        : `还留着 ${sessionCount} 把后端会话 id —— 对上服务端 sessions 那一段,看它们各自背着多少条历史`,
    },
    localSettings: keys.settings,
    localNote: keys.note,
    agent: input.agent || null,
    viewport: input.viewport || null,
  };
}
