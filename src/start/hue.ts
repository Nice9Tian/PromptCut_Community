/**
 * Derive a stable hue from a string.
 *
 * Same approach as the AI role avatar (`hueOf` in `src/editor/right/RoleAvatar.tsx`), for the same
 * reason: projects and accounts have no image assets, yet need to be "recognizable at a glance",
 * so the color is hashed from the id. Math.random can't be used, otherwise the thumbnail's color
 * would change on every re-render.
 */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}
