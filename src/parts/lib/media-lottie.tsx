import type { PartDef, PartProps } from "../../kernel/partTypes";
import { LottieView } from "../../cards/native/lottie";
import { assetOptions } from "../../cards/catalogAssets";

/**
 * Lottie 动画。
 * 从 lottie 卡片拆出的媒体部件，按时间轴逐帧定位。
 * 进场: 跟着时间轴走，挂载即显，不靠自己的时钟。
 */
interface Params {
  json: string;
  src: string;
  speed: number;
  loop: string;
  fit: string;
}

function MediaLottiePart({ params, t, width, height }: PartProps<Params>) {
  return (
    <div style={{ position: "absolute", inset: 0, width, height }}>
      <LottieView
        json={params.json}
        src={params.src}
        speed={params.speed}
        loop={params.loop}
        fit={params.fit}
        t={t}
      />
    </div>
  );
}

export const mediaLottie: PartDef<Params> = {
  id: "media-lottie",
  name: "Lottie 动画",
  description: "播放一段 Lottie 动画,跟着时间轴逐帧走",
  useWhen: "放一段现成的 Lottie(AE 导出的 JSON)动画;软件自带 5 段素材列在 src 的 hint 里,也可以贴 JSON 文本进 json 或填别的 URL;它不会自己「播」,是按时间逐帧定位,speed 调快慢、loop 决定到头循环还是停在最后一帧;素材许可证要自己核对;不适合从零画动效。",
  tags: ["lottie", "动画文件", "AE", "素材"],
  role: "media",
  from: "lottie",
  defaults: {
    json: "",
    src: "/catalog/lottie/bodymovin.json",
    speed: 1,
    loop: "no",
    fit: "contain",
  },
  controls: [
    { key: "json", label: "Lottie JSON 文本(优先)", type: "text", hint: "整个 .json 文件的内容;留空则用 src" },
    { key: "src", label: "素材 / URL", type: "asset", kind: "lottie", options: assetOptions("lottie"), hint: "从素材目录里挑一个(options 里的 URL),或填别的 JSON URL;json 留空时才用它" },
    { key: "speed", label: "速度倍率", type: "number", min: 0.1, max: 8, step: 0.1 },
    { key: "loop", label: "到头后", type: "select", options: [{ value: "no", label: "停在最后一帧" }, { value: "yes", label: "循环" }] },
    { key: "fit", label: "适配", type: "select", options: [{ value: "contain", label: "完整显示" }, { value: "cover", label: "铺满裁切" }] },
  ],
  defaultFrame: { x: 960, y: 540, w: 600, h: 600, anchor: [0.5, 0.5] },
  settleMs: () => 0,
  after: "evolve",
  Component: MediaLottiePart,
};
