/**
 * The function half of `scene-3d` (R9 M1 / M5): the `three` contract entering the shared WebGL renderer.
 *
 * **Does not import React, does not touch the DOM**: this file runs in the GL Worker (runs the same
 * copy on the stage main thread during capability fallback). The renderer is not created here: the
 * single `THREE.WebGLRenderer` on the shared context is created once by `render/gl/renderer.ts`;
 * here we only create the scene and camera, and pose them each tick according to `t`. Geometry,
 * materials, lighting, and poses still come solely from `scene3dObject.ts` (which the 3D inspection
 * view also pulls from), so it is the exact same object in the final video and the inspection view.
 *
 * The visual output remains a pure function of t (`rotation.y = t · spinY · 2π`), with no rAF and
 * no delta: `reset` has no meaning for this card (no internal state to clear), so ignore it.
 */
import { cameraFor, DEFAULT_FOV_DEG } from "../../kernel/space3d";
import type { ThreeProgram } from "../../render/gl/CanvasCardProgram";
import { addLights, geometryOf, materialOf, poseMesh, radiusFor, shapeOf, type Scene3DParams } from "./scene3dObject";

export const program: ThreeProgram = {
  kind: "three",
  build(THREE, raw, { width, height, stage, textures }) {
    const params = raw as unknown as Scene3DParams;
    // fov: 0 (default) = follows the project camera; falls back to default 40° when project has 3D
    // disabled (see scene-3d.tsx for rationale)
    const fov = params.fov > 0 ? params.fov : (stage.camera3dFov ?? DEFAULT_FOV_DEG);
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const cam = cameraFor({ width: w, height: h }, fov);
    const camera = new THREE.PerspectiveCamera(cam.fovDeg, cam.aspect, cam.near, cam.far);
    camera.position.set(...cam.position);
    camera.lookAt(0, 0, 0);

    const scene = new THREE.Scene();
    addLights(THREE, scene, params.light, cam.distance);
    const geometry = geometryOf(THREE, shapeOf(params.shape), radiusFor(params, h));
    const material = materialOf(THREE, params);
    const map = textures.map;
    if (map) {
      // Consistent with original applyTexture: prerendered cards have transparent backgrounds;
      // without transparent, edges become black blocks
      material.map = map;
      material.transparent = true;
      material.needsUpdate = true;
    }
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    return {
      scene,
      camera,
      update(t) { poseMesh(mesh, params, t); },
      // The texture is shared in the renderer cache and is not disposed by this card
      dispose() { geometry.dispose(); material.dispose(); },
    };
  },
};
