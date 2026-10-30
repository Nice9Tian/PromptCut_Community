import { useMemo } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { HudParams, hudControls, hudDefaults, getPositionClass, accentOf } from "./hud";
import "./hud.css";
import { compileCaptionFrames, captionFrameAt } from "../../render/captionFrame.mjs";

interface Params extends HudParams {
  lines: string;
  showEn: string;
  strokeOn: string;
  strokeW: number;
  strokeColor: string;
}

function genTextShadow(w: number, color: string) {
  let shadow = [];
  const steps = 12;
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * w * 10) / 10;
    const y = Math.round(Math.sin(angle) * w * 10) / 10;
    shadow.push(`${x}px ${y}px 0 ${color}`);
  }
  return shadow.join(", ");
}

function CaptionTrackCard({ params, t = 0 }: CardProps<Params>) {
  const compiled = useMemo(() => compileCaptionFrames(params.lines), [params.lines]);
  const frame = captionFrameAt(compiled, t);
  const curLine = frame?.line;

  if (!curLine) {
    return <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ alignItems: "flex-end", paddingBottom: "120px" }} />;
  }

  const zhParts = curLine.zh.split("*");
  const strokeStyle = params.strokeOn === "true" ? { textShadow: genTextShadow(params.strokeW, params.strokeColor) } : {};

  return (
    <div className={`hud-wrapper ${getPositionClass(params.position)}`} style={{ alignItems: "flex-end", paddingBottom: "120px" }}>
        <div
          key={frame!.index}
          style={{ opacity: frame!.opacity, transform: frame!.y === 0 ? "none" : `translateY(${frame!.y}px)` }}
          className="flex flex-col items-center"
        >
          <div className="text-[56px] text-white text-center font-bold tracking-wide" style={strokeStyle}>
            {zhParts.map((part, i) => {
              if (i % 2 === 1) {
                return (
                  <span key={i} style={{ color: accentOf(params) }}>
                    {part}
                  </span>
                );
              }
              return <span key={i}>{part}</span>;
            })}
          </div>
          {params.showEn === "true" && curLine.en && (
            <div className="text-[32px] text-[#a0aab4] text-center mt-4">
              {curLine.en}
            </div>
          )}
        </div>
    </div>
  );
}

export const captionTrack: CardDef<Params> = {
  id: "caption-track",
  name: "常驻双语字幕",
  description: "根据时间显示双语字幕",
  source: "native",
  useWhen: "给一整段口播铺常驻字幕。一张卡覆盖整段时间即可,不要每句话建一张;lines 必填,通常用 fill_captions 从文字稿直接灌进来。",
  tags: ["字幕", "caption", "subtitle", "转写", "双语"],
  defaults: {
    ...hudDefaults,
    position: "bottom",
    // 默认留空:字幕内容只能来自文字稿,给不出有意义的默认值。
    // 以前这里放三行演示文案,缺 lines 时会照播,看上去像"字幕加好了",
    // 实际显示的是跟视频无关的样例 —— 失败被默认值盖住了。现在缺了就是空的,
    // 并且 lines 标了 required,建卡时就会被拦下来。
    lines: "",
    showEn: "true",
    strokeOn: "true",
    strokeW: 4,
    strokeColor: "#000000",
  },
  controls: [
    // 组件内联写死了 alignItems: flex-end 和 paddingBottom,字幕永远贴底 ——
    // 通用的 hudControls 里那个「位置」有「居中」选项,但在这张卡上垂直方向根本不生效,
    // 只有水平方向(靠左/靠右)会变。所以这里换掉标签和选项,只给真能生效的三种,
    // 免得用户选了「居中」以为字幕会挪到画面中间、AI 也照着填。
    {
      key: "position", label: "水平位置", type: "select",
      options: [
        { value: "bottom", label: "底部居中" },
        { value: "left", label: "底部靠左" },
        { value: "right", label: "底部靠右" },
      ],
    },
    ...hudControls.filter((c) => c.key !== "position"),
    {
      key: "lines", label: "字幕(起|止|中|英)", type: "text", required: true,
      hint: "一行一条字幕,格式 `起|止|中文|英文`(英文可留空),秒数相对本 clip 起点。中文里用 *星号* 包住的词会用主色高亮。可以用 fill_captions 从素材文字稿自动灌入。",
    },
    { key: "showEn", label: "显示英文", type: "select", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] },
    { key: "strokeOn", label: "开启描边", type: "select", options: [{ value: "true", label: "是" }, { value: "false", label: "否" }] },
    { key: "strokeW", label: "描边宽度", type: "number" },
    { key: "strokeColor", label: "描边颜色", type: "color" },
  ],
  parts: [
    { id: "lines", label: "字幕行", role: "list", params: ["lines", "showEn", "strokeOn", "strokeW", "strokeColor"] },
  ],
  lifecycle: { after: "evolve", exit: ["fade"] },
  frameMode: "direct",
  Component: CaptionTrackCard,
};
