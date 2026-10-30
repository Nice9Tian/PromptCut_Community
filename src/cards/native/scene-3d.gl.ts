/**
 * `scene-3d` 的函数那一半(R9 M1 / M5):进共享 WebGL 渲染器的 `three` 契约。
 *
 * **不 import React、不碰 DOM** —— 这个文件在 GL Worker 里跑(能力退路时在舞台主线程上跑同一份)。
 * 渲染器不在这里建:共享上下文上的那一个 `THREE.WebGLRenderer` 由 `render/gl/renderer.ts` 建一次,
 * 这里只造 scene 和相机,每拍按 `t` 摆姿势。几何、材质、灯光、姿势仍然只有 `scene3dObject.ts` 那一份
 * (3D 检视视图也从那儿取),所以成片里和检视里是同一个东西。
 *
 * 画面仍是 t 的纯函数(`rotation.y = t · spinY · 2π`),没有 rAF、没有 delta:
 * `reset` 对这张卡没有意义(没有要清的内部状态),忽略它。
 */
import { cameraFor, DEFAULT_FOV_DEG } from "../../kernel/space3d";
import type { ThreeProgram } from "../../render/gl/CanvasCardProgram";
import { addLights, geometryOf, materialOf, poseMesh, radiusFor, shapeOf, type Scene3DParams } from "./scene3dObject";

export const program: ThreeProgram = {
  kind: "three",
  build(THREE, raw, { width, height, stage, textures }) {
    const params = raw as unknown as Scene3DParams;
    // fov:0(默认)= 跟着项目的相机走;项目没开三维时退回默认 40°(理由见 scene-3d.tsx)
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
      // 和原来 applyTexture 一致:预渲染出来的卡是透明底,不开 transparent 四周会变成黑块
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
      // 纹理是渲染器缓存里共用的那一个,不归这张卡释放
      dispose() { geometry.dispose(); material.dispose(); },
    };
  },
};
