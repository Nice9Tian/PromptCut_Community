/**
 * 由一个字符串定出一个稳定的色相。
 *
 * 和 AI 角色头像(`src/editor/right/RoleAvatar.tsx` 的 `hueOf`)同一路子,理由也一样:项目和账号
 * 都没有图片资源,又要「一眼认得出是哪个」,所以颜色由 id 哈希出来 —— 不能用 Math.random,
 * 否则每次重渲染缩略图的颜色都在变。
 */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}
