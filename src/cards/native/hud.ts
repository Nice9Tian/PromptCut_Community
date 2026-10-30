import type { Control } from "../../kernel/types";

export interface HudParams {
  position: "center" | "bottom" | "left" | "right";
  accent: string;
}

export const hudControls: Control[] = [
  {
    key: "position",
    label: "位置",
    type: "select",
    options: [
      { value: "center", label: "居中" },
      { value: "bottom", label: "底部" },
      { value: "left", label: "靠左" },
      { value: "right", label: "靠右" },
    ],
  },
  { key: "accent", label: "主色(留空用主题色)", type: "color" },
];

export const hudDefaults: HudParams = {
  position: "center",
  accent: "",
};

export const easeExpoOut: [number, number, number, number] = [0.16, 1, 0.3, 1];

export function getPositionClass(position: string) {
  switch (position) {
    case "bottom":
      return "hud-pos-bottom";
    case "left":
      return "hud-pos-left";
    case "right":
      return "hud-pos-right";
    case "center":
    default:
      return "hud-pos-center";
  }
}

export function accentOf(params: { accent?: string }): string {
  return params.accent && params.accent.trim() ? params.accent : "var(--pc-accent, #4f8cff)";
}

export interface HudOffsetParams {
  offsetX: number;
  offsetY: number;
}
export const hudOffsetControls: Control[] = [
  { key: "offsetX", label: "X 偏移", type: "number" },
  { key: "offsetY", label: "Y 偏移", type: "number" },
];
export const hudOffsetDefaults: HudOffsetParams = {
  offsetX: 0,
  offsetY: 0,
};
export function getOffsetStyle(params: HudOffsetParams) {
  return { transform: `translate(${params.offsetX || 0}px, ${params.offsetY || 0}px)` };
}
