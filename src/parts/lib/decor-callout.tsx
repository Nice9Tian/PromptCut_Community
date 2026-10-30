import { motion } from "motion/react";
import type { PartDef, PartProps } from "../../kernel/partTypes";
import { easeExpoOut, accentOf } from "../../cards/native/hud";
import { fitOr } from "../fit";

/**
 * 界面标注。
 * 从 ui-callout 拆出的装饰部件。包含一个发光的圈和引出来的标签。
 * 进场: 圈子放大出现，接着引线划出，最后标签滑入。
 */
interface Params {
  label: string;
  side: string;
  accent: string;
  size: number;
}

function DecorCalloutPart({ params, width, height }: PartProps<Params>) {
  const accent = accentOf(params);
  const isLeft = params.side === "left";

  const ringW = width;
  const ringH = height;
  const lineLength = 200;
  const lineDrop = 80;

  // Polyline points
  const startX = isLeft ? 0 : ringW;
  const startY = ringH / 2;
  const midX = isLeft ? -lineLength / 2 : ringW + lineLength / 2;
  const endX = isLeft ? -lineLength : ringW + lineLength;
  const endY = startY + lineDrop;

  const points = `${startX},${startY} ${midX},${startY} ${endX},${endY}`;
  const pathLen = lineLength + Math.abs(lineDrop);

  const size = fitOr(params.size, { width: Math.max(200, width), height: Math.max(48, height * 0.4), text: params.label, lines: 1, max: 80 });

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "visible" }}>
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0, scale: 1.3 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: easeExpoOut }}
      >
        {/* Ring */}
        <div
          className="absolute inset-0 rounded-2xl"
          style={{ border: `3px solid ${accent}`, boxShadow: `0 0 20px ${accent}40` }}
        />

        {/* Leader Line */}
        <svg className="absolute inset-0 overflow-visible" style={{ width: "100%", height: "100%" }}>
          <motion.polyline
            points={points}
            fill="none"
            stroke={accent}
            strokeWidth="4"
            strokeLinejoin="round"
            strokeDasharray={pathLen}
            initial={{ strokeDashoffset: pathLen }}
            animate={{ strokeDashoffset: 0 }}
            transition={{ duration: 0.5, delay: 0.4, ease: "linear" }}
          />
        </svg>

        {/* Label */}
        <motion.div
          className="absolute px-8 py-3 bg-black text-white rounded-full font-bold whitespace-nowrap"
          style={{
            left: isLeft ? -lineLength - 10 : ringW + lineLength + 10,
            top: endY,
            fontSize: size,
          }}
          initial={{ opacity: 0, x: isLeft ? "-100%" : 0, y: "-50%" }}
          animate={{ opacity: 1, x: isLeft ? "-100%" : 0, y: "-50%" }}
          transition={{ duration: 0.4, delay: 0.9, ease: easeExpoOut }}
        >
          {params.label}
        </motion.div>
      </motion.div>
    </div>
  );
}

export const decorCallout: PartDef<Params> = {
  id: "decor-callout",
  name: "界面标注",
  description: "圈出屏幕区域并引出标签",
  useWhen: "底层是录屏画面、要圈出界面上某块区域并引出标签时用;圈的范围就是这个部件自己的框,直接把框拖到要圈的位置和大小即可,再用 side 选引线朝左还是朝右。",
  tags: ["界面","标注","圈选","教程"],
  role: "decor",
  from: "ui-callout",
  defaults: {
    label: "核心功能入口",
    side: "right",
    accent: "",
    size: 0,
  },
  controls: [
    { key: "label", label: "标签文字", type: "text" },
    {
      key: "side",
      label: "引线方向",
      type: "select",
      options: [
        { value: "left", label: "向左" },
        { value: "right", label: "向右" },
      ],
    },
    { key: "accent", label: "主题色", type: "color" },
    { key: "size", label: "字号(0 = 按框自适应)", type: "number", min: 0, max: 120, step: 2, hint: "0 表示按部件的框自动算;想固定就填具体像素" },
  ],
  defaultFrame: { x: 960, y: 540, w: 240, h: 120, anchor: [0.5, 0.5] },
  settleMs: () => 1300,
  after: "hold",
  Component: DecorCalloutPart,
};
