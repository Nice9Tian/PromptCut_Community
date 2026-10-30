import type { PartDef, PartProps } from "../../kernel/partTypes";
import { ParticlesView } from "../../cards/native/particles";
import { assetOptions } from "../../cards/catalogAssets";

/**
 * 粒子背景。
 * 从 particles 卡片拆出的媒体部件，铺满整个画面。
 * 进场: 随机生成，实时漂浮。
 */
interface Params {
  config: string;
  color: string;
  quantity: number;
  speed: number;
  size: number;
  links: string;
  seed: number;
}

function simpleOptions(params: Params): Record<string, any> {
  return {
    fpsLimit: 60,
    particles: {
      number: { value: Math.max(0, params.quantity | 0), density: { enable: false } },
      color: { value: params.color },
      opacity: { value: 0.8 },
      size: { value: Math.max(0.5, params.size) },
      move: { enable: true, speed: Math.max(0, params.speed), outModes: { default: "out" } },
      links: { enable: params.links === "yes", color: params.color, distance: 160, opacity: 0.45, width: 1.5 },
    },
  };
}

async function resolveOptions(params: Params): Promise<Record<string, any>> {
  const c = params.config.trim();
  if (!c) return simpleOptions(params);
  if (c.startsWith("{")) return JSON.parse(c);
  const r = await fetch(c);
  if (!r.ok) throw new Error(`拉取粒子配置失败 ${r.status}: ${c}`);
  return r.json();
}

function MediaParticlesPart({ params, width, height, t }: PartProps<Params>) {
  const depsKey = [params.config, params.color, params.quantity, params.speed, params.size, params.links].join("\u0000");

  return (
    <div style={{ position: "absolute", inset: 0, width, height }}>
      <ParticlesView resolve={() => resolveOptions(params)} seed={params.seed} depsKey={depsKey} t={t} />
    </div>
  );
}

export const mediaParticles: PartDef<Params> = {
  id: "media-particles",
  name: "粒子背景",
  description: "漂浮的粒子,可带连线,铺满整个画面",
  useWhen: "整段画面需要一层动态的科技感 / 星空感底纹时用,通常放最底层;不填 config 用简单参数,要雪花 / 星空 / 气泡这类现成效果就在 config 填 /catalog/particles/ 下的 URL(此时简单参数不起作用);粒子排布由 seed 决定,同一个 seed 每次导出都一样;它是背景不是主角,要强调数字或文字用别的部件叠在上面。",
  tags: ["粒子", "背景", "科技", "星空", "雪花", "canvas"],
  role: "media",
  from: "particles",
  defaults: {
    config: "",
    color: "#8ab4ff",
    quantity: 80,
    speed: 1.2,
    size: 3,
    links: "yes",
    seed: 1,
  },
  controls: [
    { key: "config", label: "现成配置", type: "asset", kind: "particles", options: assetOptions("particles"), hint: "从素材目录里挑一个(options 里的 URL),或填别的 URL / 内联 JSON;填了就用它,下面的颜色/数量/速度不起作用" },
    { key: "color", label: "颜色", type: "color" },
    { key: "quantity", label: "数量", type: "number", min: 0, max: 400, step: 10 },
    { key: "speed", label: "速度", type: "number", min: 0, max: 10, step: 0.2 },
    { key: "size", label: "大小(px)", type: "number", min: 0.5, max: 20, step: 0.5 },
    { key: "links", label: "连线", type: "select", options: [{ value: "yes", label: "有" }, { value: "no", label: "无" }] },
    { key: "seed", label: "随机种子", type: "number", min: 1, max: 99999, step: 1, hint: "换一个数就换一种排布" },
  ],
  defaultFrame: { x: 960, y: 540, w: 1920, h: 1080, anchor: [0.5, 0.5] },
  settleMs: () => 0,
  after: "evolve",
  Component: MediaParticlesPart,
};
