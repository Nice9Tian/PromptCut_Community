/**
 * 云端 Agent 发布预渲染之前的轻重判定(语义 `product/agent.md`「发出任务后可以离开」:托管方的渲染节点生成的是**被改动的重卡**
 * 给成员预览用的轨道流;`product/rendering.md`「轻卡、重卡」:轻重靠实测)。
 *
 * Agent 服务自己不测卡(没有舞台;`mechanism/rendering.md`「多项目模式的做法」:轻重只在用户设备的编辑页面里测),
 * 它能拿到的实测是文档服务里的**共享成本记录**(`mechanism/document-service.md`「成本记录」,页面测完写进去的那一份)。
 * 判定照在线页面的同一套走,不另设数字:
 *
 * - 片段 → 成本身份:`costIdentity.ts` 的 `clipIdentityOf`(页面的探针与分派表同一份;剪辑段里的卡按摊平视图的虚拟片段给身份);
 * - 每张卡的耗时:同一身份的各条记录(来自不同环境)取中位数(`boundarySearch.mjs` 的 `representativeCosts`,界限搜索的代表耗时);
 * - 分派:`pipelinePlan.mjs` 的 `planPipelines`(预算 B、成本倍率、按位置贪心、推帧卡、3D 视图都在里面),每张重卡每拍的固定成本
 *   取在线双舞台的换帧成本(`swapCost.ts` 的 `layerSwapMs`,与 `Preview` 交给 `planDispatch` 的同一个);
 * - 这个身份没有记录、但**同一张卡**(同一个卡片 id、同一份源码版本,参数、长度、帧率随意)别的身份有记录时,按那些记录
 *   估:把它们当成这个身份的记录,照上一条取中位数(`mechanism/agent.md`「只发重卡」的〔裁〕)。Agent 改一次参数就换一个身份,
 *   在线成员的页面来不及测完时,用改之前那份(或项目里同一张卡别的片段)的实测,不按「没有记录」一律判重。
 *   「同一张卡」的身份来自此刻的项目,加上调用方记下的、这个对话之前见过的项目状态(`opts.sameCard`,`cardIdentityGroups` 算的);
 * - 同一张卡也一条记录都没有,才按 `clipWeight` 的兜底:声明了 `direct` 的判轻,其余判重(页面测完之前的同一条);
 *   服务端注册表里没有定义的卡(项目自带的用户卡还没登记进来、未知卡片)没有身份、没有声明,一律判重,照原来发。
 *
 * 结果是 `prerenderSet`(任一位置判重的卡)与候选片段的交集。本文件在 Agent 服务里经 ssr-host 的载入缝载入
 * (`server/agent/service/render-clips.mjs` 的 `HEAVY_JUDGE_MODULE`),页面不用它。
 */
import type { Project } from "../kernel/project";
import { flatPlanProject } from "../kernel/cutFlatten.mjs";
import { representativeCosts } from "../render/boundarySearch.mjs";
import type { CardCostRecord } from "../render/cardCostKey.mjs";
import { planPipelines } from "../render/pipelinePlan.mjs";
import { resolveTuning } from "../render/pipelineTuning.mjs";
import { clipIdentityOf, sourceVersionsOf } from "./costIdentity";
import { layerSwapMs } from "./swapCost";

/** 文档服务 `cost.list` 回的一条(只用到这两项) */
export interface SharedCostLike {
  identityKey: string;
  stepMs: number;
}

/** 「同一张卡」的键:卡片 id + 源码版本(参数、长度、帧率不进键);注册表里没有的卡没有键 */
function cardGroupOf(cardId: unknown, versions: Record<string, string>): string | null {
  if (typeof cardId !== "string" || !cardId) return null;
  const v = versions[cardId];
  return typeof v === "string" ? `${cardId}\u0000${v}` : null;
}

/** 摊平视图里每个有成本身份的片段 → 它的「同一张卡」键 */
function clipGroups(project: Project, identityKeys: Record<string, string>): Map<string, string> {
  const versions = sourceVersionsOf();
  const out = new Map<string, string>();
  for (const tr of flatPlanProject(project).tracks) for (const c of tr.clips) {
    if (!identityKeys[c.id]) continue;
    const g = cardGroupOf((c as { cardId?: unknown }).cardId, versions);
    if (g) out.set(c.id, g);
  }
  return out;
}

/**
 * 这个项目里每张卡(卡片 id + 源码版本)出现过的成本身份。调用方(`render-clips.mjs` 的 gate)在开工时与每次写入后记一份,
 * 判定时作为 `opts.sameCard` 交回来:改参数之前的那个身份(多半已经有页面测好的记录)就这样留下来。
 */
export function cardIdentityGroups(project: Project | null): Record<string, string[]> {
  if (!project) return {};
  const { identityKeys } = clipIdentityOf(project);
  const out: Record<string, string[]> = {};
  for (const [clipId, g] of clipGroups(project, identityKeys)) {
    const list = (out[g] ??= []);
    if (!list.includes(identityKeys[clipId])) list.push(identityKeys[clipId]);
  }
  return out;
}

/**
 * @param project 写入之后的项目(激活剪辑在顶层;剪辑段里的卡按摊平视图的虚拟片段 id 判)
 * @param records 本项目的共享成本记录(`cost.list` 的 `records`)
 * @param candidates 这次要发布的候选片段 id(`render-clips.mjs` 挑出来的)
 * @param opts.sameCard 之前见过的项目状态里同一张卡的身份(`cardIdentityGroups` 的结果,键相同的合并)
 * @returns 候选里判重的(`heavy`)与判轻的(`light`),各自保持候选的顺序;不在摊平视图里的候选两边都不放。
 *   `estimated` 是候选里耗时按同一张卡别的身份估出来的(不管判轻判重),诊断用
 */
export function judgeHeavyClips(project: Project | null, records: readonly SharedCostLike[] | null | undefined, candidates: readonly string[],
  opts: { sameCard?: Record<string, readonly string[]> | null } = {}): { heavy: string[]; light: string[]; estimated: string[] } {
  if (!project || !candidates.length) return { heavy: [], light: [], estimated: [] };
  const list = records ?? [];
  // 共享记录只有单帧耗时(`clipWeight` 只认得到的几项:没有 `kind` / `seekOk` / `catchUpMs` 时按推帧卡在一拍内追得上算,权重 = stepMs)
  const exact = representativeCosts(list);
  const { identityKeys, frameModes } = clipIdentityOf(project);
  // 同一张卡的身份:此刻项目里的 + 之前见过的
  const groupOfClip = clipGroups(project, identityKeys);
  const members = new Map<string, Set<string>>();
  const add = (g: string, k: string) => { let s = members.get(g); if (!s) members.set(g, (s = new Set())); s.add(k); };
  for (const [clipId, g] of groupOfClip) add(g, identityKeys[clipId]);
  for (const [g, keys] of Object.entries(opts.sameCard ?? {})) for (const k of keys ?? []) if (typeof k === "string") add(g, k);
  // 没有记录的身份:同一张卡别的身份的记录当成它的,同一条中位数
  const estimatedKeys = new Map<string, number>();
  for (const [clipId, g] of groupOfClip) {
    const k = identityKeys[clipId];
    if (exact.has(k) || estimatedKeys.has(k)) continue;
    const peers = members.get(g)!;
    const borrowed = list.filter((r) => r && r.identityKey !== k && peers.has(r.identityKey)).map((r) => ({ identityKey: k, stepMs: r.stepMs }));
    const v = representativeCosts(borrowed).get(k);
    if (typeof v === "number") estimatedKeys.set(k, v);
  }
  const costs = [...exact, ...estimatedKeys].map(([identityKey, stepMs]) => ({ identityKey, stepMs })) as unknown as CardCostRecord[];
  const fps = Math.max(1, Number(project.fps) || 30);
  const planned = flatPlanProject(project);
  const plan = planPipelines(planned, costs, fps, {
    tuning: resolveTuning(null), identityKeys, frameModes,
    deadMs: (clipId: string) => layerSwapMs(project, clipId),
  });
  const present = new Set(planned.tracks.flatMap((tr) => tr.clips.map((c) => c.id)));
  const heavy: string[] = [];
  const light: string[] = [];
  const estimated: string[] = [];
  for (const id of candidates) {
    if (!present.has(id)) continue;
    (plan.prerenderSet.has(id) ? heavy : light).push(id);
    if (estimatedKeys.has(identityKeys[id])) estimated.push(id);
  }
  return { heavy, light, estimated };
}
