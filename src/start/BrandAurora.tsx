/**
 * 登录页左边那块的底:流动的极光 + 条纹毛玻璃 + 噪点颗粒(用户 2026-10-23 定的方向)。
 *
 * 三层叠起来,都在这一块的范围里,右边表单那一侧一点不受影响:
 *   1. **极光**:三团大色斑,用品牌色(`--ui-accent` 青、`--ui-accent-2` 紫)画成径向渐变再重度模糊,
 *      三团各走各的周期(时长互不整除),所以看上去一直在变、不打拍子;
 *   2. **条纹毛玻璃**:盖在极光上的一层,`backdrop-filter` 把身后的极光糊掉,再用条纹遮罩只让一道道
 *      斜条磨砂 —— 条纹之间是清的,于是极光被切成明暗相间的带子;
 *   3. **噪点**:`feTurbulence` 生成的颗粒,很低的透明度压在最上面,去掉大色块的塑料感。
 *
 * **为什么不是预渲染的 GIF**(用户提过 Three + 光追渲成 GIF 循环):
 *   - GIF 只有 256 色,极光全是平滑渐变,出来一定有色阶断层,要盖住就得抖动,文件更大;
 *   - 这是在线编辑器的首屏,一张铺满整块的动图要几 MB,拖慢第一次打开;
 *   - 最要紧的是**颜色要跟着皮肤走**:品牌色由 `--ui-accent` 定,用户换皮肤、改强调色它就得跟着变
 *     (`src/skins/`),预渲染的图是焗死的,换了皮肤就对不上。
 *   CSS 这一套是矢量的、跟着变量走、不额外下载任何东西,动起来的样子和描述的一致。
 *   真要那种只有离线渲染才做得出的效果(体积光、真实折射),可以单独做一张静态底图压在极光下面,
 *   那时再谈;现在不值得为它牺牲换肤和首屏。
 *
 * 参数都在 CSS 自定义属性里(`start.css` 的 `.ps-aurora`),改数就换花样。
 * 关掉动画的人(`prefers-reduced-motion`)只看到静止的那一帧,构图不变。
 */
import { useId } from "react";
import type { JSX } from "react";

export function BrandAurora(): JSX.Element {
  // 噪点滤镜的 id:同一页可能有多个实例,不能撞(Logo.tsx 也是这么做的)
  const uid = useId().replace(/:/g, "");
  return (
    <div className="ps-aurora" aria-hidden="true">
      <span className="ps-aurora-blob is-a" />
      <span className="ps-aurora-blob is-b" />
      <span className="ps-aurora-blob is-c" />
      {/* 条纹毛玻璃:backdrop-filter 糊身后的极光,条纹遮罩只让斜条磨砂 */}
      <span className="ps-aurora-glass" />
      {/* 噪点:颗粒本身是滤镜生成的,不下载图片 */}
      <svg className="ps-aurora-grain">
        <filter id={`pc-grain-${uid}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#pc-grain-${uid})`} />
      </svg>
    </div>
  );
}
