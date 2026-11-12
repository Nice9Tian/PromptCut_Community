import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Stage, type StagePlaneProps } from "./Stage";
import { createSnapshot } from "./createSnapshot";
import { measureImageBox, worthCropping, type NormBox } from "./alphaBox";
import { placeClip3D, sortBoardsByDepth, type BoardSubBox, type SortableBoard3D } from "../kernel/place3d";
import { cameraFrustum3D } from "../kernel/frustum3d";
import { boardWorldCorners, cameraFor, DEFAULT_FOV_DEG, isBoardBehindCamera, type CameraPose3D } from "../kernel/space3d";
import { resolveClipFrameAt } from "../kernel/frameExpr.mjs";
import { resolveFrameSize } from "../kernel/frameSize.mjs";
import { activeCutEntry, defaultCutFovDeg, resolveCamera3DAt } from "../kernel/camera.mjs";
import {
  cardOpacityAt,
  flattenBoards3D,
  flattenOverlay,
  hasOpacityControls,
  isImageMedia,
  MEDIA_BOARD_CARD,
  opacityAt,
  type Board3DClip,
  type MediaAsset,
  type Project,
  type TrackClip,
} from "../kernel/project";
import { clipSpeed, mediaTimeAt } from "../kernel/clipTime.mjs";
import { clipFilterOpsAt, cssFilter } from "../kernel/filters.mjs";
import { emphasisFilter } from "../kernel/emphasis";
import { pixelMapOfClip, type PixelMapDef } from "../kernel/pixelMap.mjs";
import { drawPixelMap } from "./pixelMapGl";
import { driveMedia, releaseMedia, targetTimeOf } from "./mediaDrive";
import { playbackUrl } from "./mediaTier";
import { cardMountedAt } from "./frameWindow.mjs";
import { clipFrameMode } from "../kernel/frameMode.mjs";
import { getCard } from "../kernel/registry";
import {
  addLights,
  applyTexture,
  geometryOf,
  materialOf,
  poseMesh,
  radiusFor,
  shapeOf,
  type Scene3DParams,
} from "../cards/native/scene3dObject";
import type { Timeline } from "../kernel/types";

declare global {
  interface Window {
    __pcRender3DCut?: () => Promise<void>;
  }
}

const NO_HASHES: readonly string[] = [];

function exportMediaTime(clip: Pick<TrackClip, "start" | "mediaOffset" | "speed">, t: number): number {
  return Math.max(0, clipSpeed(clip as TrackClip) === 1 ? (clip.mediaOffset ?? 0) + t - clip.start : mediaTimeAt(clip as TrackClip, t));
}

function domToSvg(nodes: Iterable<Node>, width: number, height: number, css = ""): string {
  const ser = new XMLSerializer();
  let body = "";
  for (const n of nodes) body += ser.serializeToString(n);
  const style = css ? `<style><![CDATA[${css.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]></style>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${width}px;height:${height}px;overflow:hidden">${style}${body}</div>` +
    `</foreignObject></svg>`
  );
}

function collectPageCss(doc: Document): string {
  let out = "";
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of Array.from(rules)) out += r.cssText + "\n";
  }
  return out;
}

let sharedRenderer: THREE.WebGLRenderer | null = null;
function getSharedRenderer(width: number, height: number): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    sharedRenderer.setPixelRatio(1);
    sharedRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const sz = sharedRenderer.getSize(new THREE.Vector2());
  if (sz.x !== width || sz.y !== height) {
    sharedRenderer.setSize(width, height, false);
  }
  return sharedRenderer;
}

interface Registered3DCut {
  getDepth: () => number;
  render: () => Promise<void>;
}

const active3DCuts = new Set<Registered3DCut>();

function installGlobalRender3DCut(): void {
  if (typeof window === "undefined") return;
  window.__pcRender3DCut = async () => {
    const ordered = [...active3DCuts].sort((a, b) => b.getDepth() - a.getDepth());
    for (const item of ordered) {
      await item.render();
    }
  };
}

function OffscreenBoardMedia({
  board,
  width,
  height,
  project,
  t,
  live,
  playing,
  scrubbing,
  localHashes = NO_HASHES,
}: {
  board: Board3DClip;
  width: number;
  height: number;
  project: Project;
  t: number;
  live: boolean;
  playing: boolean;
  scrubbing: boolean;
  localHashes?: readonly string[];
}) {
  const media = board.media!;
  const pixelDef = pixelMapOfClip(project, board as unknown as TrackClip);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pmCanvasRef = useRef<HTMLCanvasElement>(null);
  const pmSourceRef = useRef<HTMLVideoElement | HTMLImageElement>(null);
  const pmTargetRef = useRef<HTMLVideoElement | HTMLImageElement>(null);
  const stagedRef = useRef<HTMLCanvasElement | null>(null);

  const drawPm = useCallback(() => {
    if (!pixelDef) return;
    const c = pmCanvasRef.current;
    const s = pmSourceRef.current;
    const ready = (el: HTMLVideoElement | HTMLImageElement) =>
      el instanceof HTMLVideoElement ? el.readyState >= 2 : el.complete && el.naturalWidth > 0;
    if (!c || !s || !ready(s)) return;
    let src: CanvasImageSource = s;
    if (pixelDef.source.stage === "after_filters" && board.filter) {
      const ops = project.filters?.length ? clipFilterOpsAt(project, board as unknown as TrackClip, t) : null;
      const css = ops ? cssFilter(ops) : "";
      if (css) {
        const mid = stagedRef.current ?? (stagedRef.current = document.createElement("canvas"));
        if (mid.width !== width || mid.height !== height) {
          mid.width = width;
          mid.height = height;
        }
        const mx = mid.getContext("2d");
        if (mx) {
          mx.clearRect(0, 0, width, height);
          mx.filter = css;
          mx.drawImage(s, 0, 0, width, height);
          mx.filter = "none";
          src = mid;
        }
      }
    }
    const ts = pmTargetRef.current;
    const target = pixelDef.to?.kind === "media" && ts && ready(ts) ? ts : null;
    try {
      drawPixelMap(c, { def: pixelDef, source: src as TexImageSource, target: target as TexImageSource | null, width, height, t });
    } catch (err) {
      console.error("[Cut3DScene pixelMap]", err);
    }
  }, [pixelDef, board, project, t, width, height]);

  useEffect(() => {
    if (!pixelDef) return;
    document.addEventListener("pc:frame-media-ready", drawPm);
    return () => document.removeEventListener("pc:frame-media-ready", drawPm);
  }, [pixelDef, drawPm]);

  useLayoutEffect(() => {
    if (!live) return;
    if (pixelDef) {
      const sv = pmSourceRef.current;
      if (sv instanceof HTMLVideoElement) {
        driveMedia(sv, { target: targetTimeOf(board as unknown as TrackClip, t), playing, volume: 0, scrubbing, rate: clipSpeed(board as unknown as TrackClip) });
        sv.requestVideoFrameCallback(() => drawPm());
      }
      const tv = pmTargetRef.current;
      if (tv instanceof HTMLVideoElement) {
        driveMedia(tv, { target: Math.max(0, t), playing, volume: 0, scrubbing });
        tv.requestVideoFrameCallback(() => drawPm());
      }
      drawPm();
      return;
    }
    const v = videoRef.current;
    if (v) {
      driveMedia(v, { target: targetTimeOf(board as unknown as TrackClip, t), playing, volume: 0, scrubbing, rate: clipSpeed(board as unknown as TrackClip) });
    }
  });

  useLayoutEffect(() => {
    if (!live) return;
    const v = videoRef.current;
    const sv = pmSourceRef.current;
    const tv = pmTargetRef.current;
    return () => {
      if (v) releaseMedia(v);
      if (sv instanceof HTMLVideoElement) releaseMedia(sv);
      if (tv instanceof HTMLVideoElement) releaseMedia(tv);
    };
  }, [live]);

  const srcOf = (m?: MediaAsset | null) => (live && m ? playbackUrl(m, localHashes) || undefined : undefined);
  const preload = live ? "auto" : "none";
  const boxStyle: React.CSSProperties = { width, height, objectFit: "cover", display: "block" };

  if (pixelDef) {
    const targetMedia =
      pixelDef.to?.kind === "media"
        ? project.media.find((m) => m.id === (pixelDef.to as Extract<PixelMapDef["to"], { kind: "media" }>).mediaId)
        : null;
    const hiddenStyle: React.CSSProperties = { ...boxStyle, visibility: "hidden", position: "absolute" };
    return (
      <div data-pc-3d-media={board.id} style={{ position: "relative", width, height }}>
        {isImageMedia(media) ? (
          <img
            ref={pmSourceRef as any}
            src={srcOf(media)}
            onLoad={live ? () => drawPm() : undefined}
            data-pc-media-src={live ? undefined : media.url}
            data-pc-media-hidden="true"
            alt=""
            style={hiddenStyle}
          />
        ) : (
          <video
            ref={pmSourceRef as any}
            muted
            playsInline
            preload={preload}
            src={srcOf(media)}
            data-pc-media-src={live ? undefined : media.url}
            data-pc-media-hidden="true"
            data-pc-media-time={live ? undefined : exportMediaTime(board, t)}
            style={hiddenStyle}
          />
        )}
        {targetMedia ? (
          isImageMedia(targetMedia) ? (
            <img
              ref={pmTargetRef as any}
              src={srcOf(targetMedia)}
              onLoad={live ? () => drawPm() : undefined}
              data-pc-media-src={live ? undefined : targetMedia.url}
              data-pc-media-hidden="true"
              alt=""
              style={hiddenStyle}
            />
          ) : (
            <video
              ref={pmTargetRef as any}
              muted
              playsInline
              preload={preload}
              src={srcOf(targetMedia)}
              data-pc-media-src={live ? undefined : targetMedia.url}
              data-pc-media-hidden="true"
              data-pc-media-time={live ? undefined : Math.max(0, t)}
              style={hiddenStyle}
            />
          )
        ) : null}
        <canvas ref={pmCanvasRef} data-pc-3d-media-source="" width={width} height={height} style={boxStyle} />
      </div>
    );
  }

  if (isImageMedia(media)) {
    return (
      <div data-pc-3d-media={board.id} style={{ position: "relative", width, height }}>
        <img
          data-pc-3d-media-source=""
          src={srcOf(media)}
          data-pc-media-src={live ? undefined : media.url}
          data-pc-media-hidden="true"
          alt=""
          style={boxStyle}
        />
      </div>
    );
  }

  return (
    <div data-pc-3d-media={board.id} style={{ position: "relative", width, height }}>
      <video
        ref={videoRef}
        data-pc-3d-media-source=""
        muted
        playsInline
        preload={preload}
        src={srcOf(media)}
        data-pc-media-src={live ? undefined : media.url}
        data-pc-media-hidden="true"
        data-pc-media-time={live ? undefined : exportMediaTime(board, t)}
        style={boxStyle}
      />
    </div>
  );
}

/**
 * Deterministic Three.js compositor for `"3d"` cuts (top-level and nested `@cut` segments) across
 * export, `see_frames(view: "camera" | "space")`, and nested 3D cut segments inside 2D stage views.
 */
export function Cut3DScene({
  project,
  t,
  directT = t,
  playToken,
  graph,
  live = false,
  mediaT = t,
  playing = false,
  scrubbing = false,
  localHashes = NO_HASHES,
  flatPrefix,
  planes,
}: {
  project: Project;
  t: number;
  directT?: number;
  playToken: number;
  graph?: Timeline["graph"];
  live?: boolean;
  mediaT?: number;
  playing?: boolean;
  scrubbing?: boolean;
  localHashes?: readonly string[];
  flatPrefix?: string;
  planes?: StagePlaneProps;
}) {
  const outCanvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenRef = useRef<HTMLDivElement>(null);
  const cssCacheRef = useRef<string | null>(null);

  const stageSize = useMemo(() => ({ width: Math.max(1, project.width), height: Math.max(1, project.height) }), [project.width, project.height]);
  const boards = useMemo(() => flattenBoards3D(project), [project]);

  const timeForBoard = useCallback(
    (b: Board3DClip): number => {
      if (b.cardId === MEDIA_BOARD_CARD) return live ? mediaT : t;
      const def = b.cut ? undefined : getCard(b.cardId);
      return clipFrameMode(b, def) === "direct" ? directT : t;
    },
    [live, mediaT, t, directT],
  );

  const activeBoards = useMemo(() => {
    return boards
      .map((b, trackOrder) => {
        const bt = timeForBoard(b);
        const inRange =
          b.cardId === MEDIA_BOARD_CARD
            ? bt >= b.start && bt < b.end
            : live
              ? cardMountedAt(b, bt)
              : bt >= b.start && bt < b.end;
        if (!inRange) return null;
        const op =
          b.cardId === MEDIA_BOARD_CARD || b.cut
            ? opacityAt(b, bt)
            : hasOpacityControls(b)
              ? cardOpacityAt(b, bt)
              : 1;
        if (!live && op <= 0) return null;
        const effFrame = b.frameExpr
          ? resolveClipFrameAt(b.frame, b.frameExpr, Math.max(0, bt - b.start), b.end - b.start)
          : b.frame;
        const rawSize = resolveFrameSize(effFrame, stageSize);
        const bw = Math.max(1, Math.round(rawSize.w));
        const bh = Math.max(1, Math.round(rawSize.h));
        return { board: b, trackOrder, bt, op, effFrame, bw, bh };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [boards, timeForBoard, live, stageSize]);

  const stateRef = useRef({
    project,
    t,
    directT,
    mediaT,
    live,
    stageSize,
    activeBoards,
  });
  stateRef.current = { project, t, directT, mediaT, live, stageSize, activeBoards };

  const renderNow = useCallback(async () => {
    const outCanvas = outCanvasRef.current;
    if (!outCanvas) return;
    const { project: proj, t: curT, mediaT: curMediaT, live: isLive, stageSize: stg, activeBoards: items } = stateRef.current;
    const W = stg.width;
    const H = stg.height;
    if (outCanvas.width !== W || outCanvas.height !== H) {
      outCanvas.width = W;
      outCanvas.height = H;
    }

    const isSpaceView = proj._renderView === "space";
    const activeCut = activeCutEntry(proj);
    const defaultFov = defaultCutFovDeg(proj, activeCut);
    const camTime = isLive ? curMediaT : curT;
    const cam3d = resolveCamera3DAt(activeCut?.cameras, stg, camTime, defaultFov);

    const scene = new THREE.Scene();
    const disposables: Array<{ dispose: () => void }> = [];
    const meshById = new Map<string, THREE.Mesh>();
    const boardEntries: Array<{
      id: string;
      mesh: THREE.Mesh;
      effFrame: Board3DClip["frame"];
      trackOrder: number;
      subBox?: BoardSubBox;
    }> = [];

    const cssText = cssCacheRef.current ?? (cssCacheRef.current = collectPageCss(document));

    for (let idx = 0; idx < items.length; idx++) {
      const { board, trackOrder, bt, op, effFrame, bw, bh } = items[idx];
      if (op <= 0) continue;
      const pl = placeClip3D(effFrame, stg);

      const pivot = new THREE.Group();
      pivot.position.set(...pl.pivot);
      const inner = new THREE.Group();
      inner.rotation.z = pl.rollZ;
      inner.scale.setScalar(pl.scale);
      const spin = new THREE.Group();
      spin.add(inner);
      spin.rotation.y = pl.spinY;
      const tilt = new THREE.Group();
      tilt.add(spin);
      tilt.rotation.x = pl.tiltX;
      tilt.position.z = pl.translateZ;
      pivot.add(tilt);
      scene.add(pivot);

      if (board.cardId === "scene-3d" && !board.cut) {
        const def = getCard(board.cardId);
        if (!def) continue;
        const params = { ...def.defaults, ...board.params } as Scene3DParams;
        const geo = geometryOf(THREE, shapeOf(params.shape), radiusFor(params, pl.size.height));
        const mat = materialOf(THREE, params);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...pl.meshOffset);
        poseMesh(mesh, params, Math.max(0, bt - board.start));
        inner.add(mesh);
        disposables.push(geo, mat);

        const camD = cameraFor({ width: pl.size.width, height: pl.size.height }, params.fov > 0 ? params.fov : defaultFov).distance;
        addLights(THREE, inner, params.light, camD);

        let hasTex = false;
        if (params.texture) {
          await new Promise<void>((resolve) => {
            const loaded = applyTexture(
              THREE,
              mat,
              params.texture,
              () => {
                hasTex = true;
                resolve();
              },
              () => resolve(),
            );
            if (loaded && typeof loaded.dispose === "function") disposables.push(loaded);
          });
        }
        const wantTransparent = hasTex || op < 1;
        mat.transparent = wantTransparent;
        mat.depthWrite = !wantTransparent;
        mat.opacity = op;
        mat.needsUpdate = true;

        meshById.set(board.id, mesh);
        boardEntries.push({ id: board.id, mesh, effFrame, trackOrder });
        continue;
      }

      if (board.cardId === MEDIA_BOARD_CARD && board.media) {
        const host = offscreenRef.current?.querySelector(`[data-pc-3d-media="${CSS.escape(board.id)}"]`);
        const srcEl = host?.querySelector("[data-pc-3d-media-source]") as HTMLImageElement | HTMLVideoElement | HTMLCanvasElement | null;
        if (!srcEl) continue;

        if (!isLive && srcEl instanceof HTMLImageElement && !(srcEl.complete && srcEl.naturalWidth > 0) && board.media.url) {
          srcEl.src = board.media.url;
          await srcEl.decode().catch(() => {});
        }

        let sw = 0;
        let sh = 0;
        if (srcEl instanceof HTMLImageElement) {
          sw = srcEl.naturalWidth;
          sh = srcEl.naturalHeight;
        } else if (srcEl instanceof HTMLVideoElement) {
          if (srcEl.readyState >= 2) {
            sw = srcEl.videoWidth;
            sh = srcEl.videoHeight;
          }
        } else if (srcEl instanceof HTMLCanvasElement) {
          sw = srcEl.width;
          sh = srcEl.height;
        }
        if (!(sw > 0 && sh > 0)) continue;

        const texCanvas = document.createElement("canvas");
        texCanvas.width = bw;
        texCanvas.height = bh;
        const tx = texCanvas.getContext("2d");
        if (!tx) continue;
        const ops = proj.filters?.length && !pixelMapOfClip(proj, board as unknown as TrackClip)
          ? clipFilterOpsAt(proj, board as unknown as TrackClip, bt)
          : null;
        const filterStr = [ops ? cssFilter(ops) : "", emphasisFilter(board.emphasis) || ""].filter(Boolean).join(" ");
        const coverScale = Math.max(bw / sw, bh / sh);
        const dw = sw * coverScale;
        const dh = sh * coverScale;
        const dx = (bw - dw) / 2;
        const dy = (bh - dh) / 2;
        tx.clearRect(0, 0, bw, bh);
        if (filterStr) tx.filter = filterStr;
        tx.drawImage(srcEl, dx, dy, dw, dh);
        tx.filter = "none";

        const tex = new THREE.CanvasTexture(texCanvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        const geo = new THREE.PlaneGeometry(pl.size.width, pl.size.height);
        const mat = new THREE.MeshBasicMaterial({
          map: tex,
          side: THREE.DoubleSide,
          transparent: true,
          depthWrite: false,
          opacity: op,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(...pl.meshOffset);
        inner.add(mesh);
        disposables.push(geo, mat, tex);
        meshById.set(board.id, mesh);
        boardEntries.push({ id: board.id, mesh, effFrame, trackOrder });
        continue;
      }

      // Card or nested cut-segment board
      const wrapEl = offscreenRef.current?.querySelector(`[data-pc-3d-card="${CSS.escape(board.id)}"]`);
      if (!wrapEl) continue;
      const snap = createSnapshot(wrapEl, { embedMedia: true });
      if (!snap.html) continue;
      const tpl = document.createElement("template");
      tpl.innerHTML = snap.html;
      const svg = domToSvg(tpl.content.childNodes, bw, bh, cssText);
      const img = new Image();
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      try {
        await img.decode();
      } catch {
        continue;
      }

      const texCanvas = document.createElement("canvas");
      texCanvas.width = bw;
      texCanvas.height = bh;
      const tx = texCanvas.getContext("2d");
      if (!tx) continue;
      const emp = emphasisFilter(board.emphasis);
      tx.clearRect(0, 0, bw, bh);
      if (emp) tx.filter = emp;
      tx.drawImage(img, 0, 0, bw, bh);
      tx.filter = "none";

      const measured: NormBox | null = measureImageBox(texCanvas);
      if (measured && (measured.w <= 0 || measured.h <= 0)) continue;

      const tex = new THREE.CanvasTexture(texCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      let subBox: BoardSubBox | undefined;
      let planeW = pl.size.width;
      let planeH = pl.size.height;
      let meshX = pl.meshOffset[0];
      let meshY = pl.meshOffset[1];
      const meshZ = pl.meshOffset[2];

      if (measured && worthCropping(measured)) {
        planeW = pl.size.width * measured.w;
        planeH = pl.size.height * measured.h;
        const cdx = (measured.x + measured.w / 2) * pl.size.width - pl.size.width / 2;
        const cdy = pl.size.height / 2 - (measured.y + measured.h / 2) * pl.size.height;
        meshX += cdx;
        meshY += cdy;
        tex.repeat.set(measured.w, measured.h);
        tex.offset.set(measured.x, 1 - measured.y - measured.h);
        subBox = { x: measured.x, y: measured.y, w: measured.w, h: measured.h };
      }
      tex.needsUpdate = true;

      const geo = new THREE.PlaneGeometry(planeW, planeH);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: false,
        opacity: op,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(meshX, meshY, meshZ);
      inner.add(mesh);
      disposables.push(geo, mat, tex);
      meshById.set(board.id, mesh);
      boardEntries.push({ id: board.id, mesh, effFrame, trackOrder, subBox });
    }

    let camera: THREE.PerspectiveCamera;
    let activePose: CameraPose3D;

    if (isSpaceView) {
      // Stage z=0 reference frame
      const hw = W / 2;
      const hh = H / 2;
      const edgeGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-hw, hh, 0),
        new THREE.Vector3(hw, hh, 0),
        new THREE.Vector3(hw, -hh, 0),
        new THREE.Vector3(-hw, -hh, 0),
      ]);
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.7 });
      scene.add(new THREE.LineLoop(edgeGeo, edgeMat));
      disposables.push(edgeGeo, edgeMat);

      // Active output camera frustum + camera body gizmo
      const frustumData = cameraFrustum3D(stg, cam3d);
      const frGeo = new THREE.BufferGeometry();
      frGeo.setAttribute("position", new THREE.Float32BufferAttribute(frustumData.positions, 3));
      const frMat = new THREE.LineBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.95 });
      scene.add(new THREE.LineSegments(frGeo, frMat));
      disposables.push(frGeo, frMat);

      const camBodySize = Math.max(24, Math.min(W, H) * 0.045);
      const bodyGeo = new THREE.BoxGeometry(camBodySize * 1.3, camBodySize * 0.9, camBodySize);
      const bodyMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b });
      const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
      bodyMesh.position.set(...cam3d.position);
      bodyMesh.rotation.order = "YXZ";
      bodyMesh.rotation.set(
        (cam3d.rx * Math.PI) / 180,
        (cam3d.ry * Math.PI) / 180,
        (cam3d.rz * Math.PI) / 180,
      );
      scene.add(bodyMesh);
      disposables.push(bodyGeo, bodyMat);

      // Compute world bounding box over stage frame, active camera frustum, and all board corners
      let minX = -hw, maxX = hw;
      let minY = -hh, maxY = hh;
      let minZ = 0, maxZ = 0;
      const includePt = (px: number, py: number, pz: number) => {
        if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) return;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        if (pz < minZ) minZ = pz;
        if (pz > maxZ) maxZ = pz;
      };
      includePt(cam3d.position[0], cam3d.position[1], cam3d.position[2]);
      for (const c of frustumData.corners) includePt(c[0], c[1], c[2]);
      for (const entry of boardEntries) {
        for (const c of boardWorldCorners(entry.effFrame, stg, entry.subBox)) {
          includePt(c[0], c[1], c[2]);
        }
      }

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const spanX = Math.max(W * 0.5, maxX - minX);
      const spanY = Math.max(H * 0.5, maxY - minY);
      const spanZ = Math.max(Math.min(W, H) * 0.5, maxZ - minZ);
      const radius = Math.hypot(spanX, spanY, spanZ) * 0.5;
      const spaceFov = 45;
      const halfV = ((spaceFov * Math.PI) / 180) * 0.5;
      const halfH = Math.atan(Math.tan(halfV) * (W / H));
      const minHalf = Math.max(0.15, Math.min(halfV, halfH));
      const dist = (radius / Math.sin(minHalf)) * 1.18;
      const dir = new THREE.Vector3(0.56, 0.42, 0.71).normalize();
      const eye = new THREE.Vector3(cx, cy, cz).addScaledVector(dir, dist);

      camera = new THREE.PerspectiveCamera(spaceFov, W / H, Math.max(1, dist * 0.01), Math.max(dist * 6, 20000));
      camera.position.copy(eye);
      camera.lookAt(cx, cy, cz);
      camera.updateMatrixWorld();
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      activePose = {
        position: [camera.position.x, camera.position.y, camera.position.z],
        forward: [fwd.x, fwd.y, fwd.z],
        near: camera.near,
      };
    } else {
      camera = new THREE.PerspectiveCamera(cam3d.fovDeg, W / H, cam3d.near, cam3d.far);
      camera.position.set(...cam3d.position);
      camera.rotation.order = "YXZ";
      camera.rotation.set(
        (cam3d.rx * Math.PI) / 180,
        (cam3d.ry * Math.PI) / 180,
        (cam3d.rz * Math.PI) / 180,
      );
      camera.updateMatrixWorld();
      activePose = {
        position: cam3d.position,
        forward: cam3d.forward,
        near: cam3d.near,
      };
    }

    // Near-plane culling + back-to-front depth sorting
    const sortInput: SortableBoard3D[] = [];
    for (const entry of boardEntries) {
      const culled = !isSpaceView && isBoardBehindCamera(entry.effFrame, stg, cam3d.fovDeg, activePose, entry.subBox);
      entry.mesh.visible = !culled;
      if (!culled) {
        sortInput.push({
          id: entry.id,
          frame: entry.effFrame,
          trackOrder: entry.trackOrder,
          subBox: entry.subBox,
        });
      }
    }
    const sorted = sortBoardsByDepth(sortInput, stg, cam3d.fovDeg, activePose);
    for (const s of sorted) {
      const m = meshById.get(s.id);
      if (m) m.renderOrder = s.renderOrder;
    }

    const renderer = getSharedRenderer(W, H);
    if (isSpaceView) {
      renderer.setClearColor(0x0f172a, 1);
    } else {
      renderer.setClearColor(0x000000, 0);
    }
    renderer.clear();
    renderer.render(scene, camera);

    const outCtx = outCanvas.getContext("2d");
    if (outCtx) {
      outCtx.clearRect(0, 0, W, H);
      outCtx.drawImage(renderer.domElement, 0, 0, W, H);
    }

    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        // Ignore disposal errors
      }
    }
  }, []);

  useLayoutEffect(() => {
    installGlobalRender3DCut();
    const reg: Registered3DCut = {
      getDepth: () => {
        let depth = 0;
        let cur: Element | null = outCanvasRef.current?.parentElement ?? null;
        while (cur) {
          if (cur.hasAttribute("data-pc-3d-offscreen")) depth++;
          cur = cur.parentElement;
        }
        return depth;
      },
      render: renderNow,
    };
    active3DCuts.add(reg);
    return () => {
      active3DCuts.delete(reg);
    };
  }, [renderNow]);

  // On live stage views (e.g. a 3D @cut segment inside a 2D cut preview), keep the output canvas refreshed.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await renderNow();
    })();
    return () => {
      cancelled = true;
    };
  }, [live, t, directT, mediaT, playToken, activeBoards, renderNow]);

  const captionTimeline = useMemo<Timeline | null>(() => {
    if (project._renderView === "space") return null;
    const caps = flattenOverlay(project).clips.filter((c) => c.cardId === "caption-track");
    if (!caps.length) return null;
    return {
      width: stageSize.width,
      height: stageSize.height,
      fps: project.fps,
      duration: project.duration,
      clips: caps,
      ...(project.themeId ? { themeId: project.themeId } : null),
      ...(graph ? { graph } : null),
    };
  }, [project, stageSize.width, stageSize.height, graph]);

  return (
    <div style={{ position: "absolute", inset: 0, width: stageSize.width, height: stageSize.height, overflow: "hidden" }}>
      <canvas
        ref={outCanvasRef}
        data-pc-3d-cut=""
        width={stageSize.width}
        height={stageSize.height}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      {captionTimeline && (
        <div
          data-pc="cut3d-caption-layer"
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        >
          <Stage
            timeline={captionTimeline}
            t={t}
            directT={directT}
            playToken={playToken}
            nested
            flatPrefix={flatPrefix}
            {...planes}
          />
        </div>
      )}
      <div
        ref={offscreenRef}
        data-pc-3d-offscreen=""
        style={{
          position: "fixed",
          left: -100000,
          top: -100000,
          width: stageSize.width,
          height: stageSize.height,
          pointerEvents: "none",
        }}
      >
        {activeBoards.map(({ board, bw, bh }) => {
          if (board.cardId === "scene-3d" && !board.cut) return null;
          if (board.cardId === MEDIA_BOARD_CARD && board.media) {
            return (
              <OffscreenBoardMedia
                key={board.id}
                board={board}
                width={bw}
                height={bh}
                project={project}
                t={live ? mediaT : t}
                live={live}
                playing={playing}
                scrubbing={scrubbing}
                localHashes={localHashes}
              />
            );
          }
          const flatClip = {
            ...board,
            frame: undefined,
            frameExpr: undefined,
            motion: undefined,
            opacity: undefined,
            fadeIn: undefined,
            fadeOut: undefined,
            cutEnv: undefined,
          };
          const boardTimeline: Timeline = {
            width: bw,
            height: bh,
            fps: project.fps,
            duration: project.duration,
            clips: [flatClip],
            ...(project.themeId ? { themeId: project.themeId } : null),
            ...(graph ? { graph } : null),
          };
          return (
            <div
              key={board.id}
              data-pc-3d-card={board.id}
              style={{ position: "relative", width: bw, height: bh, overflow: "hidden" }}
            >
              <Stage
                timeline={boardTimeline}
                t={t}
                directT={directT}
                playToken={playToken}
                nested
                flatPrefix={flatPrefix}
                {...planes}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
