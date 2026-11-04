/**
 * What the 3D object in `scene-3d` actually looks like: **the single construction**.
 *
 * Two places need to build the same thing:
 *   1. The card itself (`scene-3d.tsx`), drawn on its own canvas, entering preview and export;
 *   2. 3D inspection view (`src/editor/preview/Scene3DView.tsx`), placing it in the scene as a **real 3D object**.
 *
 * The second place initially pasted a prerendered texture onto a flat quad: that was wrong: orbiting
 * around it was still just a flat picture, whereas this view exists to "see clearly how things are
 * positioned in space". 3D objects in a 3D view must be three-dimensional.
 *
 * Therefore geometry, materials, lighting, and poses are all consolidated here, retrieved by both
 * sides. If written separately, they would diverge sooner or later without throwing errors: simply
 * "what is seen in inspection is not what appears in the final video", which is worse than no inspection.
 */

export type ThreeMod = typeof import("three");

export const SHAPES = ["cube", "sphere", "torus", "knot", "cone", "cylinder", "crystal"] as const;
export type Shape = (typeof SHAPES)[number];

export interface Scene3DParams {
  shape: string;
  color: string;
  metal: number;
  rough: number;
  size: number;
  spinY: number;
  spinX: number;
  tilt: number;
  light: string;
  fov: number;
  wire: string;
  texture: string;
}

const TAU = Math.PI * 2;

/** Fall back to a box if shape in params is unknown; don't let a typo black out the entire card */
export function shapeOf(raw: string): Shape {
  return (SHAPES as readonly string[]).includes(raw) ? (raw as Shape) : "cube";
}

/**
 * "Radius" of the object, in world units (= stage pixels).
 * `size` is the proportion of canvas height, so radius = size × height / 2: the card and inspection
 * view must use the same formula, otherwise the same card would have different sizes in the two places.
 */
export function radiusFor(params: Scene3DParams, canvasHeight: number): number {
  return (Math.min(Math.max(params.size, 0.05), 1) * canvasHeight) / 2;
}

/** Geometry for each shape. See radiusFor for `r` */
export function geometryOf(THREE: ThreeMod, shape: Shape, r: number) {
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(r, 64, 48);
    case "torus":
      return new THREE.TorusGeometry(r * 0.72, r * 0.28, 32, 96);
    case "knot":
      return new THREE.TorusKnotGeometry(r * 0.68, r * 0.22, 160, 32);
    case "cone":
      return new THREE.ConeGeometry(r, r * 1.8, 64);
    case "cylinder":
      return new THREE.CylinderGeometry(r * 0.72, r * 0.72, r * 1.6, 64);
    case "crystal":
      return new THREE.IcosahedronGeometry(r, 0);
    case "cube":
    default:
      return new THREE.BoxGeometry(r * 1.5, r * 1.5, r * 1.5);
  }
}

export function materialOf(THREE: ThreeMod, params: Scene3DParams) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(params.color),
    metalness: Math.min(Math.max(params.metal, 0), 1),
    roughness: Math.min(Math.max(params.rough, 0), 1),
    wireframe: params.wire === "yes",
  });
}

/**
 * Lighting presets. All three presets follow the classic pattern of "ambient + key + fill light",
 * differing only in intensity and direction: having an Agent pick a word is far more reliable
 * than asking it to fill in positions for three light sources.
 *
 * Lights are added to `target` (the whole scene in cards, or this object's own group in the inspection
 * view). The benefit of adding to a group is that lights move with the object: multiple scene-3d objects
 * may appear on screen simultaneously in the inspection view, each carrying its own lights, so each
 * matches how it looks in the final video.
 */
export function addLights(THREE: ThreeMod, target: any, preset: string, d: number) {
  const key = new THREE.DirectionalLight(0xffffff, 1);
  const fill = new THREE.DirectionalLight(0xffffff, 1);
  let ambient = 0.5;
  if (preset === "rim") {
    // Backlight: key light comes from above and behind, leaving only a bright rim, ideal for silhouettes
    ambient = 0.18;
    key.position.set(-0.4, 0.9, -1).multiplyScalar(d);
    key.intensity = 3.2;
    fill.position.set(0.6, -0.2, 0.8).multiplyScalar(d);
    fill.intensity = 0.35;
  } else if (preset === "soft") {
    // Soft light: high ambient light + weak directional light, virtually no hard shadows
    ambient = 1.1;
    key.position.set(0.5, 0.8, 1).multiplyScalar(d);
    key.intensity = 0.9;
    fill.position.set(-0.7, 0.1, 0.5).multiplyScalar(d);
    fill.intensity = 0.5;
  } else {
    // studio: first two lights of standard three-point lighting, brings out metallic textures best
    ambient = 0.45;
    key.position.set(0.7, 1, 0.8).multiplyScalar(d);
    key.intensity = 2.4;
    fill.position.set(-0.9, -0.2, 0.6).multiplyScalar(d);
    fill.intensity = 0.8;
  }
  const amb = new THREE.AmbientLight(0xffffff, ambient);
  target.add(amb, key, fill);
  return [amb, key, fill];
}

/**
 * Pose is determined solely by t and a few parameters: this is the complete implementation of
 * "visual output is a pure function of t". With no delta accumulation, playing forward, scrubbing back,
 * or seeking all yield the same frame (see rationale at the start of scene-3d.tsx).
 * `t` is the seconds **relative to the start of this card**.
 */
export function poseMesh(mesh: any, params: Scene3DParams, t: number) {
  mesh.rotation.set(
    (params.tilt * Math.PI) / 180 + t * params.spinX * TAU,
    t * params.spinY * TAU,
    0,
  );
}

/**
 * Texture. The URL is usually `/@media/xxx.png` prerendered by `bake_card`.
 * Loading is asynchronous; once received, `onReady` must be called to let the caller redraw a
 * frame: t might not change at that moment, so we cannot rely on the render loop catching up on its own.
 */
export function applyTexture(
  THREE: ThreeMod,
  material: any,
  url: string,
  onReady: (tex: any) => void,
  onError?: (error: unknown) => void,
): any {
  return new THREE.TextureLoader().load(
    url,
    (tex: any) => {
      // Color space must be marked correctly, otherwise it appears dark overall (three interprets as
      // linear by default)
      tex.colorSpace = THREE.SRGBColorSpace;
      material.map = tex;
      // Prerendered cards have transparent backgrounds; without transparent, edges become black blocks
      material.transparent = true;
      material.needsUpdate = true;
      onReady(tex);
    },
    undefined,
    error => { console.warn("[scene-3d] 纹理加载失败:", url); onError?.(error); },
  );
}
