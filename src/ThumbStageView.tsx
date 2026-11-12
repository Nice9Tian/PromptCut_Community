import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Stage } from "./render/Stage";
import { installStageClock } from "./render/stageClock";
import { createAnimationPinner } from "./render/pinAnimations";
import { createSnapshot } from "./render/createSnapshot";
import { createGlHost } from "./render/gl/glHost";
import { frameWorkStatus, waitForFrameWork } from "./kernel/frameReady";
import { getCard, onCardsUpdated } from "./kernel/registry";
import { getPart } from "./kernel/partRegistry";
import { clipFrameMode } from "./kernel/frameMode.mjs";
import { CARD_RUNTIME_ABI, validateCardGraph } from "./kernel/cardGraph.mjs";
import { setOnlineBrowserMode, unsupportedHere } from "./render/placeholderHost";
import { ONLINE } from "./online/mode";
import { themeStyle } from "./themes";
import { measureContentBox, unionBox, type Box } from "./render/contentBox";
import type { ThumbStageApi, ThumbStageRequest, ThumbStageResult } from "./render/thumbStageTypes";
import {
  candidateTimestamps,
  pickRepresentativeFrame,
  resolveSampleWindow,
  type FrameSample,
} from "./render/representativeFrame.mjs";
import { assetCardKind } from "./cards/assets";
import { findAssetByUrl } from "./cards/catalogAssets";
import type { CardDef, Clip, PartInstance, Timeline } from "./kernel/types";
import type { PartDef } from "./kernel/partTypes";
import "./cards";

/**
 * Dedicated offscreen stage (`?stage=1&thumb=1`) for deterministic representative-frame thumbnail
 * generation in the Classic mode Animation panel.
 *
 * Why a dedicated `?stage=1` document:
 *   - `stageClockEntry.ts` (first import in `main.tsx`) installs `stageClock` (`performance.now`,
 *     `requestAnimationFrame`, `patchAnimate`, virtual `setTimeout`/`setInterval`) and `pinEntropy`
 *     (`Math.random`, `Date.now`, `crypto.getRandomValues`) BEFORE Motion, Lottie, tsParticles, or
 *     any card module evaluates.
 *   - Consequently, every card and part advances in deterministic virtual time at microtask speed
 *     without freezing or touching the editor document's own UI animations or timeline preview stage.
 */

try {
  setOnlineBrowserMode(ONLINE || new URLSearchParams(location.search).get("platform") === "browser");
} catch { /* Non-browser environment */ }

const isThumbStageRoute = typeof window !== "undefined"
  && new URLSearchParams(location.search).has("stage")
  && new URLSearchParams(location.search).has("thumb");

const clock = isThumbStageRoute ? installStageClock() : null;
const pinner = createAnimationPinner();

const DEFAULT_FPS = 30;
const MAX_CANVAS_THUMB_SIDE = 768;
const GRID_COLS = 16;
const GRID_ROWS = 9;
const ALPHA_MIN = 8;

/** Embedded synthetic media image (colorful geometric gradient) so declarative `def.card` shaders render a vivid preview without network I/O. */
const SAMPLE_GRAPH_MEDIA_URL = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">`
  + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0ea5e9"/>`
  + `<stop offset="50%" stop-color="#8b5cf6"/><stop offset="100%" stop-color="#f97316"/></linearGradient></defs>`
  + `<rect width="640" height="360" fill="url(#g)"/>`
  + `<circle cx="200" cy="180" r="88" fill="rgba(255,255,255,0.85)"/>`
  + `<rect x="340" y="104" width="176" height="152" rx="24" fill="rgba(15,23,42,0.58)" stroke="rgba(255,255,255,0.85)" stroke-width="6"/>`
  + `</svg>`,
);

export type { ThumbStageApi, ThumbStageRequest, ThumbStageResult };

declare global {
  interface Window {
    __pcThumbStage?: ThumbStageApi;
  }
}

const realSetTimeout = (): ((cb: () => void, ms?: number) => number) =>
  (typeof window !== "undefined" && window.__pcRealSetTimeout)
    ? window.__pcRealSetTimeout
    : ((cb: () => void, ms?: number) => window.setTimeout(cb, ms));

async function waitFrameReadyBounded(timeoutMs: number): Promise<void> {
  if (frameWorkStatus().length === 0) return;
  const setTimer = realSetTimeout();
  await Promise.race([
    waitForFrameWork(),
    new Promise<void>((resolve) => {
      setTimer(resolve, timeoutMs);
    }),
  ]);
}

function inlineLottieSeconds(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as { fr?: unknown; ip?: unknown; op?: unknown };
    const fr = Number(parsed.fr);
    const ip = Number(parsed.ip ?? 0);
    const op = Number(parsed.op);
    if (Number.isFinite(fr) && fr > 0 && Number.isFinite(op) && op > ip) {
      return (op - ip) / fr;
    }
  } catch { /* Invalid JSON falls back to default window */ }
  return null;
}

function buildGraphForCard(def: CardDef<any>, params: Record<string, unknown>, width: number, height: number): Timeline["graph"] {
  if (typeof def.card !== "function") return undefined;
  const inputs: Record<string, { nodeId: string }> = {};
  for (const key of Object.keys(def.inputs ?? { source: { kind: "video" } })) {
    inputs[key] = { nodeId: "@media/thumb-sample" };
  }
  try {
    const graph = validateCardGraph({
      nodes: [
        {
          id: "@media/thumb-sample",
          adapter: "media",
          media: { id: "thumb-sample", name: "sample", url: SAMPLE_GRAPH_MEDIA_URL, type: "image", width, height },
          inputs: {},
          capabilities: { need_prerendering: false, compositing: "independent" },
        },
        {
          id: "@clip/thumb-clip/card",
          adapter: "card",
          kind: def.kind ?? "animation",
          cardId: def.id,
          params,
          inputs,
        },
      ],
      outputs: [
        {
          nodeId: "@clip/thumb-clip/card",
          clipId: "thumb-clip",
          trackId: "thumb-track",
          start: 0,
          end: 10,
        },
      ],
    });
    return { abi: CARD_RUNTIME_ABI, ...graph };
  } catch {
    return undefined;
  }
}

function prepareTarget(req: ThumbStageRequest): {
  timeline: Timeline;
  candidates: Array<{ t: number; phase: number }>;
  fastDirect: boolean;
  unsupported: boolean;
} | null {
  const width = Math.max(16, Math.round(req.width || 1920));
  const height = Math.max(16, Math.round(req.height || 1080));
  const fps = Math.max(1, Math.round(req.fps || DEFAULT_FPS));

  if (req.kind === "part") {
    const part: PartDef<any> | undefined = getPart(req.id);
    if (!part) return null;
    let settleMs: number | null = null;
    try {
      const v = part.settleMs?.(part.defaults);
      if (typeof v === "number" && Number.isFinite(v) && v > 0) settleMs = v;
    } catch { /* Ignore part timing errors */ }

    let catalogSeconds: number | null = null;
    let sampleKind: "part" | "lottie" | "particles" = "part";
    if (part.id === "media-lottie") {
      sampleKind = "lottie";
      const src = String((part.defaults as Record<string, unknown>)?.src ?? "");
      catalogSeconds = (src ? findAssetByUrl("lottie", src)?.seconds : undefined)
        ?? inlineLottieSeconds((part.defaults as Record<string, unknown>)?.json)
        ?? null;
    } else if (part.id === "media-particles") {
      sampleKind = "particles";
    }

    const win = resolveSampleWindow({ settleMs, catalogSeconds, kind: sampleKind });
    const candidates = candidateTimestamps(win.windowSec, { settleSec: win.settleSec, fps });
    const partInstance: PartInstance = {
      id: "preview",
      partId: part.id,
      params: { ...part.defaults },
      ...(part.defaultFrame ? { frame: { ...part.defaultFrame } } : {}),
    };
    const clip: Clip = {
      id: "thumb-clip",
      cardId: "composite",
      start: 0,
      end: Math.max(win.windowSec + 2, 10),
      params: {},
      parts: [partInstance],
    };
    const timeline: Timeline = {
      fps,
      width,
      height,
      duration: clip.end,
      themeId: req.themeId,
      clips: [clip],
    };
    const fastDirect = part.id === "media-lottie" || part.id === "media-particles";
    return { timeline, candidates, fastDirect, unsupported: false };
  }

  const def = getCard(req.id);
  if (!def) return null;
  if (unsupportedHere(def.id, def)) {
    const timeline: Timeline = { fps, width, height, duration: 2, themeId: req.themeId, clips: [] };
    return { timeline, candidates: [{ t: 0, phase: 0.62 }], fastDirect: true, unsupported: true };
  }

  // Library-only sample subtitle lines when caption-track's required `lines` default is empty.
  const baseDefaults = (def.defaults && typeof def.defaults === "object")
    ? { ...(def.defaults as Record<string, unknown>) }
    : {};
  if (def.id === "caption-track" && !String(baseDefaults.lines ?? "").trim()) {
    baseDefaults.lines = "0|10|Live *highlighted* caption|Bilingual subtitle preview";
  }

  let settleMs: number | null = null;
  try {
    const dyn = def.timing?.(baseDefaults)?.settleMs;
    if (typeof dyn === "number" && Number.isFinite(dyn) && dyn > 0) settleMs = dyn;
  } catch { /* Fall back to static lifecycle */ }
  if (settleMs === null) {
    const st = def.lifecycle?.settleMs;
    if (typeof st === "number" && Number.isFinite(st) && st > 0) settleMs = st;
  }

  const assetKind = assetCardKind(def);
  let sampleKind: "card" | "lottie" | "particles" | "graph" =
    assetKind === "lottie" || def.id === "lottie"
      ? "lottie"
      : assetKind === "particles" || def.id === "particles"
        ? "particles"
        : typeof def.card === "function" && !def.Component
          ? "graph"
          : "card";

  let catalogSeconds: number | null = null;
  if (sampleKind === "lottie") {
    const src = String(baseDefaults.src ?? "");
    catalogSeconds = (src ? findAssetByUrl("lottie", src)?.seconds : undefined)
      ?? inlineLottieSeconds(baseDefaults.data ?? baseDefaults.json)
      ?? null;
  }

  const rawDur = Number(baseDefaults.duration);
  const durationSec = settleMs === null && Number.isFinite(rawDur) && rawDur > 0 && rawDur <= 10 ? rawDur : null;

  const win = resolveSampleWindow({ settleMs, durationSec, catalogSeconds, kind: sampleKind });
  const candidates = candidateTimestamps(win.windowSec, { settleSec: win.settleSec, fps });

  const graph = buildGraphForCard(def, baseDefaults, width, height);
  const clip: Clip = {
    id: "thumb-clip",
    cardId: def.id,
    ...(graph ? { nodeId: "@clip/thumb-clip/card" } : {}),
    start: 0,
    end: Math.max(win.windowSec + 2, 10),
    params: baseDefaults,
  };
  const timeline: Timeline = {
    fps,
    width,
    height,
    duration: clip.end,
    themeId: req.themeId,
    clips: [clip],
    ...(graph ? { graph } : {}),
  };

  // Pure direct cards and self-stepping ParticlesView only need commits at the candidate points.
  const fastDirect = clipFrameMode(clip, def) === "direct"
    || sampleKind === "particles"
    || sampleKind === "graph";

  return { timeline, candidates, fastDirect, unsupported: false };
}

/* ── Reusable offscreen measurement & canvas buffers ────────────────────────────────────── */

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "DEFS", "CLIPPATH", "MASK", "SYMBOL",
  "LINEARGRADIENT", "RADIALGRADIENT", "STOP", "PATTERN", "FILTER",
]);

const SVG_LEAF_TAGS = new Set([
  "path", "rect", "circle", "ellipse", "line", "polygon", "polyline", "image", "use", "text",
]);

let pixelProbe: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
function getPixelProbe(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (pixelProbe) return pixelProbe;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  pixelProbe = { canvas, ctx };
  return pixelProbe;
}

const slotPool: Array<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> = [];
function getSlotCanvas(index: number, w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  while (slotPool.length <= index) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    slotPool.push({ canvas, ctx });
  }
  const slot = slotPool[index];
  if (slot.canvas.width !== w || slot.canvas.height !== h) {
    slot.canvas.width = w;
    slot.canvas.height = h;
  } else {
    slot.ctx.clearRect(0, 0, w, h);
  }
  return slot;
}

function parseBlurPx(filterStr: string): number {
  if (!filterStr || filterStr === "none") return 0;
  const m = /blur\(\s*([0-9.]+)px\s*\)/.exec(filterStr);
  return m ? Math.max(0, parseFloat(m[1]) || 0) : 0;
}

function parseRgbaLum(v: string): { lum: number; a: number } | null {
  if (!v || v === "transparent" || v === "none") return null;
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  const a = p.length >= 4 ? p[3] : 1;
  if (a <= 0.005) return null;
  const lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
  return { lum, a };
}

function markGrid(
  grid: Float32Array,
  l: number,
  t: number,
  r: number,
  b: number,
  stageW: number,
  stageH: number,
  weight: number,
): void {
  if (weight <= 0 || r <= l || b <= t || stageW <= 0 || stageH <= 0) return;
  const c0 = Math.max(0, Math.min(GRID_COLS - 1, Math.floor((l / stageW) * GRID_COLS)));
  const c1 = Math.max(0, Math.min(GRID_COLS - 1, Math.floor(((r - 1e-3) / stageW) * GRID_COLS)));
  const r0 = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor((t / stageH) * GRID_ROWS)));
  const r1 = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(((b - 1e-3) / stageH) * GRID_ROWS)));
  for (let ry = r0; ry <= r1; ry++) {
    for (let cx = c0; cx <= c1; cx++) {
      const idx = ry * GRID_COLS + cx;
      grid[idx] = Math.min(1, grid[idx] + weight);
    }
  }
}

function ownTrimmedText(el: Element): string {
  let out = "";
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? "";
  }
  return out.trim();
}

function ownTextRect(el: Element): DOMRect | null {
  const range = document.createRange();
  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const n of el.childNodes) {
    if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? "").trim()) continue;
    range.selectNodeContents(n);
    const rc = range.getBoundingClientRect();
    if (rc.width <= 0 || rc.height <= 0) continue;
    l = Math.min(l, rc.left);
    t = Math.min(t, rc.top);
    r = Math.max(r, rc.right);
    b = Math.max(b, rc.bottom);
  }
  range.detach();
  return r > l && b > t ? new DOMRect(l, t, r - l, b - t) : null;
}

interface MeasuredCandidate {
  sample: FrameSample;
  box: Box | null;
  hasCanvas: boolean;
  hasDomOrSvg: boolean;
}

function measureStageCandidate(
  sceneRoot: HTMLElement,
  tSec: number,
  phase: number,
  slotIdx: number,
): MeasuredCandidate {
  const stageEl = sceneRoot.querySelector<HTMLElement>(".pc-stage");
  const clipWrap = sceneRoot.querySelector<HTMLElement>("[data-pc-clip]");
  if (!stageEl || !clipWrap) {
    return {
      sample: { t: tSec, phase, opacityMass: 0, coverage: 0, spread: 0, detail: 0, contrast: 0, blurPx: 0 },
      box: null,
      hasCanvas: false,
      hasDomOrSvg: false,
    };
  }

  const sr = stageEl.getBoundingClientRect();
  const stageW = stageEl.offsetWidth || sr.width || 1920;
  const stageH = stageEl.offsetHeight || sr.height || 1080;
  const scale = stageW > 0 ? sr.width / stageW : 1;
  const stageArea = Math.max(1, stageW * stageH);

  const box = measureContentBox(stageEl);
  const grid = new Float32Array(GRID_COLS * GRID_ROWS);

  let opacityMass = 0;
  let detail = 0;
  let blurWeighted = 0;
  let blurWeightTotal = 0;
  let lumSum = 0;
  let lumSqSum = 0;
  let lumWeight = 0;
  let hasCanvas = false;
  let hasDomOrSvg = false;
  const canvases: Array<{ el: HTMLCanvasElement; l: number; t: number; w: number; h: number; op: number; bg: string }> = [];

  const toLocal = (rc: DOMRect) => {
    const l = Math.max(0, (rc.left - sr.left) / scale);
    const t = Math.max(0, (rc.top - sr.top) / scale);
    const r = Math.min(stageW, (rc.right - sr.left) / scale);
    const b = Math.min(stageH, (rc.bottom - sr.top) / scale);
    return { l, t, r, b, w: Math.max(0, r - l), h: Math.max(0, b - t) };
  };

  const addLum = (lum: number, w: number) => {
    if (w <= 0) return;
    lumSum += lum * w;
    lumSqSum += lum * lum * w;
    lumWeight += w;
  };

  const visit = (el: Element, parentOp: number, parentBlur: number): void => {
    const tagUpper = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tagUpper)) return;
    if (
      el.hasAttribute("data-pc-placeholder")
      || el.hasAttribute("data-pc-proxy-plane")
      || el.hasAttribute("data-pc-stream-plane")
    ) {
      return;
    }

    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    const ownOp = Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1;
    const effOp = parentOp * Math.max(0, Math.min(1, ownOp));
    if (effOp <= 0.005) return;
    const effBlur = parentBlur + parseBlurPx(cs.filter);

    if (tagUpper === "CANVAS") {
      const cv = el as HTMLCanvasElement;
      if (cv.width > 0 && cv.height > 0) {
        const loc = toLocal(cv.getBoundingClientRect());
        if (loc.w > 0 && loc.h > 0) {
          hasCanvas = true;
          const cvBg = parseRgbaLum(cs.backgroundColor) ? cs.backgroundColor : "";
          canvases.push({ el: cv, l: loc.l, t: loc.t, w: loc.w, h: loc.h, op: effOp, bg: cvBg });
          const probe = getPixelProbe();
          if (probe) {
            try {
              const pw = probe.canvas.width;
              const ph = probe.canvas.height;
              probe.ctx.clearRect(0, 0, pw, ph);
              probe.ctx.drawImage(cv, 0, 0, pw, ph);
              const d = probe.ctx.getImageData(0, 0, pw, ph).data;
              let alphaTotal = 0;
              let activePx = 0;
              let edgeSum = 0;
              const areaRatio = (loc.w * loc.h) / stageArea;
              for (let py = 0; py < ph; py++) {
                for (let px = 0; px < pw; px++) {
                  const idx = (py * pw + px) * 4;
                  const aByte = d[idx + 3];
                  if (aByte < ALPHA_MIN) continue;
                  const a = (aByte / 255) * effOp;
                  alphaTotal += a;
                  activePx++;
                  const lum = (0.2126 * d[idx] + 0.7152 * d[idx + 1] + 0.0722 * d[idx + 2]) / 255;
                  addLum(lum, a);
                  if (px > 0) {
                    const prevIdx = idx - 4;
                    edgeSum += (Math.abs(d[idx] - d[prevIdx]) + Math.abs(d[idx + 1] - d[prevIdx + 1]) + Math.abs(d[idx + 2] - d[prevIdx + 2]) + Math.abs(aByte - d[prevIdx + 3])) / 1020;
                  }
                  const gx = loc.l + (px / pw) * loc.w;
                  const gy = loc.t + (py / ph) * loc.h;
                  markGrid(grid, gx, gy, gx + loc.w / pw, gy + loc.h / ph, stageW, stageH, a * 0.25);
                }
              }
              const totalPx = pw * ph;
              if (activePx > 0) {
                const frac = alphaTotal / totalPx;
                opacityMass += frac * areaRatio;
                detail += (activePx / totalPx) * 16 + (edgeSum / totalPx) * 24;
                blurWeighted += effBlur * frac;
                blurWeightTotal += frac;
              }
            } catch { /* Tainted or unreadable canvas */ }
          }
        }
      }
      return;
    }

    const isSvg = el.namespaceURI === "http://www.w3.org/2000/svg";
    if (isSvg) {
      const tagLower = el.tagName.toLowerCase();
      if (SVG_LEAF_TAGS.has(tagLower)) {
        const loc = toLocal(el.getBoundingClientRect());
        if (loc.w > 0.5 && loc.h > 0.5) {
          const fill = cs.fill;
          const stroke = cs.stroke;
          const hasFill = !!fill && fill !== "none" && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(fill);
          const hasStroke = !!stroke && stroke !== "none" && (parseFloat(cs.strokeWidth) || 0) > 0;
          if (hasFill || hasStroke || tagLower === "image" || tagLower === "use") {
            let drawnFrac = 1;
            if (!hasFill && hasStroke) {
              const da = parseFloat(cs.strokeDasharray);
              const doff = parseFloat(cs.strokeDashoffset);
              if (Number.isFinite(da) && da > 1 && Number.isFinite(doff)) {
                drawnFrac = Math.max(0, Math.min(1, 1 - Math.abs(doff) / da));
              }
            }
            if (drawnFrac > 0.005) {
              hasDomOrSvg = true;
              const areaRatio = (loc.w * loc.h) / stageArea;
              const effWeight = effOp * drawnFrac;
              if (areaRatio >= 0.92) {
                opacityMass += 0.06 * effWeight;
              } else {
                const contrib = Math.min(0.45, areaRatio) * effWeight;
                opacityMass += contrib;
                detail += 0.85 * effWeight;
                markGrid(grid, loc.l, loc.t, loc.r, loc.b, stageW, stageH, effWeight * 0.5);
                blurWeighted += effBlur * (contrib + 0.05);
                blurWeightTotal += contrib + 0.05;
              }
              const lum = parseRgbaLum(hasFill ? fill : stroke);
              if (lum) addLum(lum.lum, effWeight * Math.min(0.25, areaRatio + 0.02));
            }
          }
        }
      }
      for (const child of el.children) visit(child, effOp, effBlur);
      return;
    }

    if (tagUpper === "IMG") {
      const img = el as HTMLImageElement;
      if (img.getAttribute("src") || img.currentSrc) {
        const loc = toLocal(el.getBoundingClientRect());
        if (loc.w > 0.5 && loc.h > 0.5) {
          hasDomOrSvg = true;
          const areaRatio = (loc.w * loc.h) / stageArea;
          opacityMass += Math.min(0.6, areaRatio) * effOp;
          detail += 1.5 * effOp;
          markGrid(grid, loc.l, loc.t, loc.r, loc.b, stageW, stageH, effOp * 0.6);
        }
      }
      return;
    }

    const txt = ownTrimmedText(el);
    if (txt.length > 0) {
      const trc = ownTextRect(el);
      if (trc) {
        const loc = toLocal(trc);
        if (loc.w > 0.5 && loc.h > 0.5) {
          hasDomOrSvg = true;
          const areaRatio = (loc.w * loc.h) / stageArea;
          const contrib = areaRatio * 0.4 * effOp;
          opacityMass += contrib;
          // Non-zero digits contribute slightly more detail than placeholder "0" so rolling counters
          // ("0" -> "75%", "0" -> "100") prefer settled readings over initial zero frames.
          const nonZeroChars = txt.replace(/0/g, "").length;
          detail += (txt.length * 0.6 + nonZeroChars * 0.45) * effOp;
          markGrid(grid, loc.l, loc.t, loc.r, loc.b, stageW, stageH, effOp * 0.75);
          blurWeighted += effBlur * (contrib + 0.1);
          blurWeightTotal += contrib + 0.1;
          const fg = parseRgbaLum(cs.color);
          if (fg) addLum(fg.lum, effOp * 0.15);
        }
      }
    }

    const bgLum = parseRgbaLum(cs.backgroundColor);
    const hasBgImg = !!cs.backgroundImage && cs.backgroundImage !== "none";
    const hasBorder = (parseFloat(cs.borderTopWidth) || 0) > 0 || (parseFloat(cs.borderLeftWidth) || 0) > 0;
    if (bgLum || hasBgImg || hasBorder) {
      const loc = toLocal(el.getBoundingClientRect());
      if (loc.w > 0.5 && loc.h > 0.5) {
        hasDomOrSvg = true;
        const areaRatio = (loc.w * loc.h) / stageArea;
        const paintAlpha = bgLum ? bgLum.a : 0.6;
        if (areaRatio >= 0.92) {
          opacityMass += 0.06 * effOp * paintAlpha;
        } else {
          const contrib = Math.min(0.45, areaRatio) * effOp * paintAlpha;
          opacityMass += contrib;
          detail += 0.45 * effOp;
          markGrid(grid, loc.l, loc.t, loc.r, loc.b, stageW, stageH, effOp * paintAlpha * 0.4);
          blurWeighted += effBlur * contrib;
          blurWeightTotal += contrib;
        }
        if (bgLum) addLum(bgLum.lum, effOp * bgLum.a * Math.min(0.25, areaRatio + 0.02));
      }
    }

    for (const child of el.children) visit(child, effOp, effBlur);
  };

  for (const child of clipWrap.children) visit(child, 1, 0);

  let occupiedCells = 0;
  let minGx = GRID_COLS;
  let maxGx = -1;
  let minGy = GRID_ROWS;
  let maxGy = -1;
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      if (grid[gy * GRID_COLS + gx] > 0.02) {
        occupiedCells++;
        if (gx < minGx) minGx = gx;
        if (gx > maxGx) maxGx = gx;
        if (gy < minGy) minGy = gy;
        if (gy > maxGy) maxGy = gy;
      }
    }
  }

  const coverage = occupiedCells / (GRID_COLS * GRID_ROWS);
  const gridSpread = maxGx >= minGx && maxGy >= minGy
    ? ((maxGx - minGx + 1) * (maxGy - minGy + 1)) / (GRID_COLS * GRID_ROWS)
    : 0;
  const boxSpread = box ? Math.min(1, ((box.r - box.l) * (box.b - box.t)) / stageArea) : gridSpread;
  const spread = Math.max(gridSpread, boxSpread);

  let contrast = 0;
  if (lumWeight > 0) {
    const mean = lumSum / lumWeight;
    const variance = Math.max(0, lumSqSum / lumWeight - mean * mean);
    // Combine internal variance with contrast against dark stage backdrop (~0.08 luminance).
    const std = Math.sqrt(variance);
    const fgContrast = Math.abs(mean - 0.08);
    contrast = Math.min(1, std * 1.8 + fgContrast * 0.7);
  }

  const blurPx = blurWeightTotal > 0 ? blurWeighted / blurWeightTotal : 0;

  // For pure-canvas animations (particles, scene-3d, shader cards), copy this candidate onto a compact
  // reusable 2D slot canvas during the forward pass so we never need a second pass to capture best.index.
  if (hasCanvas && !hasDomOrSvg) {
    const scaleDown = Math.min(1, MAX_CANVAS_THUMB_SIDE / Math.max(stageW, stageH));
    const tw = Math.max(2, Math.round(stageW * scaleDown));
    const th = Math.max(2, Math.round(stageH * scaleDown));
    const slot = getSlotCanvas(slotIdx, tw, th);
    if (slot) {
      for (const c of canvases) {
        try {
          const dx = (c.l / stageW) * tw;
          const dy = (c.t / stageH) * th;
          const dw = (c.w / stageW) * tw;
          const dh = (c.h / stageH) * th;
          slot.ctx.save();
          slot.ctx.globalAlpha = c.op;
          if (c.bg) {
            slot.ctx.fillStyle = c.bg;
            slot.ctx.fillRect(dx, dy, dw, dh);
          }
          slot.ctx.drawImage(c.el, dx, dy, dw, dh);
          slot.ctx.restore();
        } catch { /* Ignore tainted canvas */ }
      }
    }
  }

  return {
    sample: { t: tSec, phase, opacityMass, coverage, spread, detail, contrast, blurPx },
    box,
    hasCanvas,
    hasDomOrSvg,
  };
}

function releaseLiveCanvases(root: HTMLElement | null): void {
  if (!root) return;
  for (const cv of root.querySelectorAll<HTMLCanvasElement>("[data-pc-clip] canvas:not([data-pc-gl-plane])")) {
    try {
      cv.width = 0;
      cv.height = 0;
    } catch { /* Ignore */ }
  }
}

export default function ThumbStageView() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [t, setT] = useState(0);
  const [token, setToken] = useState(1);
  const stampRef = useRef(0);

  useEffect(() => {
    return onCardsUpdated(() => {
      stampRef.current++;
    });
  }, []);

  useEffect(() => {
    if (!clock) return;
    const glHost = createGlHost({ stageId: "Thumb", route: "perDocument", compact: true, mainThread: true });
    glHost.setRole("back");

    let queue = Promise.resolve();

    const glStrict = async (sec: number): Promise<void> => {
      const beat = glHost.beat({ strict: true, t: sec });
      if (beat) await beat;
    };

    const mountAtZero = async (tl: Timeline): Promise<void> => {
      window.__pcResetRandom?.(1);
      pinner.reset();
      clock.set(0);
      flushSync(() => {
        setToken((n) => n + 1);
        setTimeline(tl);
        setT(0);
      });
      clock.tick(clock.now());
      clock.tick(clock.now());
      pinner.sync(0);
      await glStrict(0);
      await waitFrameReadyBounded(4000);
      clock.tick(clock.now());
      pinner.sync(0);
    };

    const advanceToSec = async (targetSec: number, fps: number, fastDirect: boolean): Promise<void> => {
      const targetMs = targetSec * 1000;
      if (targetMs > clock.now()) {
        if (fastDirect) {
          clock.set(targetMs);
          flushSync(() => setT(targetSec));
          clock.tick(clock.now());
          pinner.sync(targetMs);
        } else {
          await clock.advanceToAsync(targetMs, {
            step: 1000 / fps,
            fps,
            maxCatchUp: Infinity,
            yieldEvery: 16,
            onFrame: (ms) => flushSync(() => setT(ms / 1000)),
            afterFrame: (ms) => {
              pinner.sync(ms);
            },
          });
        }
      }
      await glStrict(targetSec);
      await waitFrameReadyBounded(2000);
      if (pinner.endedInLastSync() > 0) {
        await Promise.resolve();
      }
    };

    const runSample = async (req: ThumbStageRequest): Promise<ThumbStageResult> => {
      const prepared = prepareTarget(req);
      if (!prepared) {
        return { ok: false, t: 0, phase: 0, score: 0, box: null, mode: "dom" };
      }
      if (prepared.unsupported) {
        return { ok: false, unsupported: true, t: 0, phase: 0.62, score: 0, box: null, mode: "dom" };
      }

      const { timeline: tl, candidates, fastDirect } = prepared;
      const sceneRoot = rootRef.current;
      if (!sceneRoot) {
        return { ok: false, t: 0, phase: 0, score: 0, box: null, mode: "dom" };
      }

      try {
        await mountAtZero(tl);

        const samples: FrameSample[] = [];
        let mergedBox: Box | null = null;
        let sawCanvas = false;
        let sawDomOrSvg = false;

        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          await advanceToSec(cand.t, tl.fps, fastDirect);
          const measured = measureStageCandidate(sceneRoot, cand.t, cand.phase, i);
          samples.push(measured.sample);
          mergedBox = unionBox(mergedBox, measured.box);
          if (measured.hasCanvas) sawCanvas = true;
          if (measured.hasDomOrSvg) sawDomOrSvg = true;
        }

        const best = pickRepresentativeFrame(samples);

        if (sawCanvas && !sawDomOrSvg) {
          const scaleDown = Math.min(1, MAX_CANVAS_THUMB_SIDE / Math.max(tl.width, tl.height));
          const tw = Math.max(2, Math.round(tl.width * scaleDown));
          const th = Math.max(2, Math.round(tl.height * scaleDown));
          const slot = slotPool[best.index];
          if (slot && slot.canvas.width === tw && slot.canvas.height === th) {
            const dataUrl = slot.canvas.toDataURL("image/webp", 0.86);
            if (dataUrl && dataUrl.length > 32) {
              return {
                ok: true,
                t: best.t,
                phase: best.phase,
                score: best.score,
                box: mergedBox,
                mode: "img",
                dataUrl,
                imgWidth: tw,
                imgHeight: th,
              };
            }
          }
        }

        // Seek or replay to the winning representative timestamp when it precedes the final candidate.
        if (best.index >= 0 && best.index < candidates.length - 1) {
          if (fastDirect && req.id !== "particles" && !req.id.startsWith("particles-") && req.id !== "media-particles") {
            const bestMs = best.t * 1000;
            clock.set(bestMs);
            flushSync(() => setT(best.t));
            clock.tick(clock.now());
            pinner.sync(bestMs);
            await glStrict(best.t);
            await waitFrameReadyBounded(2000);
          } else {
            releaseLiveCanvases(sceneRoot);
            await mountAtZero(tl);
            await advanceToSec(best.t, tl.fps, fastDirect);
          }
        }

        const snap = createSnapshot(sceneRoot);
        const html = snap.controls[0]?.html ?? "";
        return {
          ok: html.trim().length > 0,
          t: best.t,
          phase: best.phase,
          score: best.score,
          box: mergedBox,
          mode: "dom",
          html,
        };
      } catch (err) {
        console.error("[ThumbStageView] sample failed:", req, err);
        return { ok: false, t: 0, phase: 0, score: 0, box: null, mode: "dom" };
      } finally {
        releaseLiveCanvases(rootRef.current);
        flushSync(() => {
          setTimeline(null);
        });
        glHost.release();
      }
    };

    const api: ThumbStageApi = {
      sample(req: ThumbStageRequest): Promise<ThumbStageResult> {
        const next = queue.then(() => runSample(req));
        queue = next.then(() => undefined, () => undefined);
        return next;
      },
      cardsStamp: () => stampRef.current,
    };

    window.__pcThumbStage = api;
    try {
      window.parent?.postMessage({ type: "pc-thumb-stage-ready" }, location.origin);
    } catch { /* Standalone load */ }

    return () => {
      if (window.__pcThumbStage === api) delete window.__pcThumbStage;
      glHost.dispose();
    };
  }, []);

  const w = timeline?.width ?? 1920;
  const h = timeline?.height ?? 1080;

  return (
    <div
      ref={rootRef}
      data-pc-scene=""
      style={{
        position: "relative",
        width: w,
        height: h,
        overflow: "hidden",
        background: "transparent",
        ...themeStyle(timeline?.themeId),
      }}
    >
      {timeline ? <Stage timeline={timeline} t={t} playToken={token} /> : null}
    </div>
  );
}
