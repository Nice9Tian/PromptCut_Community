import { createElement } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { lottieAssets, particleAssets, type CatalogAsset } from "../catalogAssets";
import { LottieView } from "../native/lottie";
import { ParticlesView } from "../native/particles";
import { translateParticlesConfig } from "./particlesKnobs";

/**
 * 素材封装卡:动效素材 → 函数翻译 → 约定封装。
 *
 * 素材目录(server/catalog)里的每个 Lottie 动画、每份粒子配置在这里各自变成一张 CardDef:
 *   - 原始文件留在目录里,卡片只记 URL;组件复用 LottieView / ParticlesView 这两个「函数」;
 *   - 对外只有翻译出来的旋钮(Lottie:速度 / 到头后 / 适配;粒子:配置里真有的数量 / 速度 /
 *     大小 / 颜色 / 不透明度 / 连线),parts 和 lifecycle 一并声明;
 *   - Agent 和左栏看到的就是这些卡:add_clip({ cardId: "lottie-adrock" }) 即可,不用知道 URL,
 *     更不用读素材文件。
 *
 * 构建时生成(catalog 的 index.json 和粒子配置都是 import 进来的),打进包里的和开发机上的一样。
 * id 前缀 lottie- / particles- 是保留命名空间,create_card 不许占。
 */

const particleConfigs = import.meta.glob<Record<string, any>>("../../../server/catalog/particles/*.json", { eager: true, import: "default" });

function configOf(name: string): Record<string, any> | null {
  for (const [file, cfg] of Object.entries(particleConfigs)) {
    if (file.endsWith(`/${name}.json`)) return cfg;
  }
  return null;
}

const describe = (a: CatalogAsset) => a.note || a.description;
const whenToUse = (a: CatalogAsset) => a.use || "";

function lottieCardOf(a: CatalogAsset): CardDef<any> {
  const settleMs = a.seconds ? Math.round(a.seconds * 1000) : undefined;
  const Component = ({ params, t = 0 }: CardProps<any>) =>
    createElement(LottieView, { json: "", src: a.url, speed: Number(params.speed) || 1, loop: String(params.loop), fit: String(params.fit), t });
  return {
    id: `lottie-${a.name}`,
    name: `Lottie · ${a.name}`,
    description: describe(a),
    useWhen: `${whenToUse(a)}动画本身 ${a.seconds ?? "?"}s(${a.w}×${a.h});clip 给到这个时长就完整播一遍,更长就停在最后一帧或循环。`,
    tags: ["lottie", "素材", ...a.tags],
    source: "asset",
    // 帧模式:remotion 式(渲染重构「癸」)。LottieView 不让播放器自己走,每一帧把 t 换算成帧号直接跳过去;
    // 随机数和属性值留旧数那几处在 loadLottie 里固定住了(见 native/lottie.tsx 文件头),任何参数下都是 direct。
    // 本文件里素材封装卡的源码版本只取声明里的几项:这一行改掉的那一次,5 张 Lottie 封装卡的键才变。
    frameMode: "direct",
    defaults: { speed: 1, loop: "no", fit: "contain" },
    controls: [
      { key: "speed", label: "速度倍率", type: "number", min: 0.1, max: 8, step: 0.1 },
      { key: "loop", label: "到头后", type: "select", options: [{ value: "no", label: "停在最后一帧" }, { value: "yes", label: "循环" }] },
      { key: "fit", label: "适配", type: "select", options: [{ value: "contain", label: "完整显示" }, { value: "cover", label: "铺满裁切" }] },
    ],
    parts: [{ id: "animation", label: a.name, role: "media", params: ["speed", "loop", "fit"], enterMs: 0, ...(settleMs ? { settleMs } : {}) }],
    lifecycle: { ...(settleMs ? { settleMs } : {}), after: "hold", exit: ["fade"] },
    // 动画本身多长是定的,但 speed 拉快就早落定;loop 打开就不是「停住」而是「循环」
    timing: (p) => {
      const speed = Number(p.speed) > 0 ? Number(p.speed) : 1;
      const settle = settleMs ? settleMs / speed : undefined;
      return { ...(settle ? { settleMs: settle, parts: { animation: { settleMs: settle } } } : {}), after: String(p.loop) === "yes" ? "loop" : "hold" };
    },
    Component,
  };
}

function particlesCardOf(a: CatalogAsset): CardDef<any> | null {
  const config = configOf(a.name);
  if (!config) return null;
  const knobs = translateParticlesConfig(config);
  const Component = ({ params, t = 0 }: CardProps<any>) => {
    const depsKey = JSON.stringify(knobs.controls.map((c) => params[c.key]));
    return createElement(ParticlesView, {
      resolve: async () => knobs.apply(config, params),
      seed: Number(params.seed) || 1,
      depsKey,
      t,
    });
  };
  return {
    id: `particles-${a.name}`,
    name: `粒子 · ${a.name}`,
    description: describe(a),
    useWhen: `${whenToUse(a)}它是背景,通常放最底层、盖住整段时长;粒子位置由 seed 决定,同一个 seed 每次导出都一样。`,
    tags: ["粒子", "背景", "素材", ...a.tags],
    source: "asset",
    // 帧模式:审计固化(A0.1)。tsParticles 逐帧积分位置,任何参数下都是 stateful。
    frameMode: "stateful",
    defaults: { ...knobs.defaults, seed: 1 },
    controls: [
      ...knobs.controls,
      { key: "seed", label: "随机种子", type: "number", min: 1, max: 99999, step: 1, hint: "换一个数就换一种排布;同一个数每次导出都一样" },
    ],
    parts: [{ id: "particles", label: a.name, role: "media", params: [...knobs.controls.map((c) => c.key), "seed"] }],
    lifecycle: { after: "evolve", exit: ["fade"] },
    Component,
  };
}

export const assetCards: CardDef<any>[] = [
  ...lottieAssets.map(lottieCardOf),
  ...particleAssets.map(particlesCardOf).filter((c): c is CardDef<any> => !!c),
];

/** 左栏分组用:素材卡按种类分开 */
export function assetCardKind(card: CardDef<any>): "lottie" | "particles" | null {
  if (card.source !== "asset") return null;
  return card.id.startsWith("lottie-") ? "lottie" : "particles";
}

/** 粒子素材里目录标了 featured 的那些:左栏默认只显示这些,免得 50 多张把列表挤满 */
export const featuredParticleIds = new Set(particleAssets.filter((a) => a.featured).map((a) => `particles-${a.name}`));
