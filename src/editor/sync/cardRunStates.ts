/**
 * 编辑页面这一侧合出每张同步卡的运行状态(`docs/plan/online-card-exec-contract.md` 第 8 节;原来的第十种运行状态随旧档位撤销,
 * 2026-10-07 用户定在线浏览器不分身份执行用户卡与素材效果卡)。纯函数。
 *
 * 先后(前面的条件成立就不看后面的):
 *   1. 本页不能执行(站点总开关关了、没有隔离环境)→ `not-isolated`;
 *   2. 这张卡的入口转译不成 → 转译给的状态(`unsupported-syntax` / `missing-module` / `load-error`);
 *   3. 舞台报了这张卡的状态 → 用舞台的(`ready`、`load-error`、`gpu`、`media`、`runtime-error`……);
 *      两个舞台都报了且不一样时取不是 `ready` 的那个(一台运行不了就按运行不了处理,两台画面才一致);
 *   4. 转译成了、舞台还没报 → `loading`;
 *   5. 还没轮到转译(源码刚取到)→ `loading`。
 * 结果写进 `registry.setCardRunStates`;参数面板、时间轴徽标、轻重判定读那里。
 */
import type { CardRunState, SyncedUserCard } from "../../kernel/registry.ts";
import type { BundleResult } from "../../online/cardRuntime/protocol.ts";
import { cyrb53 } from "../../render/cyrb53.mjs";

export interface EditorRunStateInput {
  /** 同步表(静态解析出来的卡;`source` 是入口文件的键) */
  cards: Iterable<SyncedUserCard>;
  /** 本页能不能执行(`gate.ts` 的 `cardExecAvailable()`) */
  available: boolean;
  /** 不能执行时的说明(站点关了那一句);没有就不写 */
  blockedDetail?: string | null;
  /** 转译的结果(每个入口一条) */
  bundles: readonly BundleResult[];
  /** 各舞台报来的状态(卡片 id → 状态);没报过的舞台不在里面 */
  stages?: Iterable<ReadonlyMap<string, CardRunState> | null | undefined>;
  /** 要几台舞台都报了这张卡才下结论(双舞台给 2:两台画面要一致,只有一台载入好时还算 `loading`;单舞台给 1);缺省 1 */
  stageCount?: number;
}

export function editorRunStates(input: EditorRunStateInput): Map<string, CardRunState> {
  const out = new Map<string, CardRunState>();
  const byEntry = new Map(input.bundles.map((b) => [b.entry, b]));
  const stages = [...(input.stages ?? [])].filter((m): m is ReadonlyMap<string, CardRunState> => !!m);
  for (const card of input.cards) {
    if (!card || typeof card.id !== "string" || out.has(card.id)) continue;
    if (!input.available) { out.set(card.id, { state: "not-isolated", ...(input.blockedDetail ? { detail: input.blockedDetail } : {}) }); continue; }
    const bundle = card.source ? byEntry.get(card.source) : undefined;
    if (bundle && !bundle.ok) { out.set(card.id, bundle.state); continue; }
    if (!bundle) { out.set(card.id, { state: "loading" }); continue; }
    const reported = stages.map((m) => m.get(card.id)).filter((s): s is CardRunState => !!s);
    const bad = reported.find((s) => s.state !== "ready");
    // 有一台说运行不了就按运行不了(不用等另一台);都说行的要等够台数
    if (!bad && reported.length < Math.max(1, input.stageCount ?? 1)) { out.set(card.id, { state: "loading" }); continue; }
    // 能运行的带上这一代的短签名:成本身份里的源码版本用它(源码或转译器换了,身份跟着换)
    out.set(card.id, bad ?? { state: "ready", version: String(cyrb53(String(bundle.bundle?.generation ?? ""))) });
  }
  return out;
}

/** 参数面板的说明(契约第 8 节的表);`ready`、`loading` 不出说明 */
export function runStateMessage(s: CardRunState | undefined): string | null {
  if (!s) return null;
  const d = s.detail ? s.detail : "";
  const where = s.file ? `,${s.file.replace(/^src\/cards\/user\//, "")}` : "";
  switch (s.state) {
    case "ready": case "loading": return null;
    case "unsupported-syntax": return `在线浏览器不能运行这张卡:用了在线页面不支持的写法${d ? `(${d}${where})` : ""}。画面由渲染节点提供。`;
    case "missing-module": return `在线浏览器不能运行这张卡:引用了在线页面里没有的模块${d ? ` ${d}` : ""}。画面由渲染节点提供。`;
    case "load-error": return `在线浏览器不能运行这张卡:载入时出错${d ? `(${d})` : ""}。`;
    case "gpu": return "这台设备的图形能力不够,素材效果卡的画面由渲染节点提供。";
    case "media": return "这台设备解不了这段素材,素材效果卡的画面由渲染节点提供。";
    case "runtime-error": return "这张卡在在线浏览器里运行出错,本次改由渲染节点提供画面。";
    case "not-isolated": return d ? `${d},用户卡与素材效果卡的画面由渲染节点提供。` : "这个页面没有隔离的运行环境,用户卡与素材效果卡的画面由渲染节点提供。";
    default: return null;
  }
}
