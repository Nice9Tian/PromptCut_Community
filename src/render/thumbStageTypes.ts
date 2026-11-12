import type { Box } from "./contentBox";

export interface ThumbStageRequest {
  kind: "card" | "part";
  id: string;
  width: number;
  height: number;
  themeId?: string;
  fps?: number;
}

export interface ThumbStageResult {
  ok: boolean;
  unsupported?: boolean;
  t: number;
  phase: number;
  score: number;
  box: Box | null;
  mode: "dom" | "img";
  html?: string;
  dataUrl?: string;
  imgWidth?: number;
  imgHeight?: number;
}

export interface ThumbStageApi {
  sample(req: ThumbStageRequest): Promise<ThumbStageResult>;
  cardsStamp(): number;
}
