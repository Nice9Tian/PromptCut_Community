import type { Control } from "../../kernel/types";

export interface HudParams {
  position: "center" | "bottom" | "left" | "right";
  accent: string;
}

export const hudControls: Control[] = [
  {
    key: "position",
    label: "Position",
    type: "select",
    options: [
      { value: "center", label: "Center" },
      { value: "bottom", label: "Bottom" },
      { value: "left", label: "Align left" },
      { value: "right", label: "Align right" },
    ],
  },
  { key: "accent", label: "Main color (leave empty to use theme color)", type: "color" },
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
  { key: "offsetX", label: "X offset", type: "number" },
  { key: "offsetY", label: "Y offset", type: "number" },
];
export const hudOffsetDefaults: HudOffsetParams = {
  offsetX: 0,
  offsetY: 0,
};
export function getOffsetStyle(params: HudOffsetParams) {
  return { transform: `translate(${params.offsetX || 0}px, ${params.offsetY || 0}px)` };
}
