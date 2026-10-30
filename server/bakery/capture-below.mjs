/**
 * 依赖下层的流(`kind: 'below'`)的每一帧怎么取:**差分取层**(渲染重构「戊二」的「下层二」,
 * `docs/plan/prerender-products-contract.md` 第 5.3 节)—— Node 一侧。
 *
 * 这种流的隔离工程里留着目标卡和它下面的全部层(`server/frame-stream.mjs` 的 `isolatedBelowProject`)。每一帧截两张:
 *
 *   - 上张 R:带目标卡(就是 `bakeStream` 原来那一次截图);
 *   - 下张 L:**同一个页面、同一个时刻**把目标卡那一层藏起来再截一张。
 *
 * 再算出一层 S,使「S 按普通的叠加盖在 L 上」等于 R(`diffLayer`),交给编码器的是 S。目标卡没有改动的地方 S 全透明,
 * 所以稀疏那一趟照旧能量出实体框、第二趟收紧,流里只有目标卡改动的那一块。
 *
 * # 两张的下层为什么是同一帧的状态
 *
 * 藏目标卡不重灌页面、不推时间、不动 React:只往 `<head>` 里加一条带 `!important` 的样式,把目标卡那一层的不透明度压成 0,
 * 截完原样撤掉(照 `./chrome.mjs` 里毛玻璃遮罩那一套的做法:只压过渡的时长、不碰 `transition-property`,撤的时候分两步,
 * 不惊动任何正在跑的动画)。两张之间下层的 DOM、动画、素材、画布一样都没动;页面时钟钉在这一帧(`src/kernel/exportClock.ts`),
 * 多出来的这一拍对读时间的循环是同一个数、对按间隔走的循环间隔为 0。
 *
 * 光靠「按理不会变」不够,每个分段的第一帧实测两件事(`verify`,缺省开):
 *
 *   - 藏着的时候再截一张,和下张逐字节相同(截到的不是合成器里上一拍的旧画面);
 *   - 撤掉以后再截一张,和上张逐字节相同(藏和撤没有改动页面;页面在多出来的几拍里自己也没有变)。
 *
 * 哪一条不成立,这个分段就失败(不交出可能算错的帧);第一条不成立时,这条流以后每张下张都先丢一张再截。
 *
 * # 截图矩形和交出去的矩形
 *
 * 两张都按 `view` 截(这种流是整个画面),算完再裁到 `rect`(稀疏那一趟是上界矩形,第二趟是收紧后的矩形)。
 * 不把截图矩形收紧:毛玻璃要采样自己四周的下层,画面被裁小以后靠近边上的模糊会变(实测数字在 `docs/reports/AGENT-rr-below-diff.md`)。
 *
 * 只有 `bakeStream` 的调用方(`server/frame-stream.mjs`)用它;导出和快照那几条路不经过这里。
 */
import { captureFrame } from './capture-frame.mjs';
import { decodePngRgba } from './capture-canvas.mjs';

/** 和 `./bake.mjs` 里轨道流的截图参数同一种:带透明的 PNG */
const SHOT = { format: 'png', optimizeForSpeed: true };

/* ======================================================================== *
 * 算那一层(纯函数)
 * ======================================================================== */

/**
 * 颜色的下限放宽多少(预乘色,满分 1;1/255 就是 8 位里的一级)。两张截图各自四舍五入到 8 位,它们的差本来就有一级左右的噪声;
 * 下限是拿这个差去除以 `L色`(或 `1 − L色`)得到的,除数很小的时候噪声被放大成整张不透明(实测纯色的视频底上阴影那一圈
 * 的不透明度在「该有的值」和 1 之间乱跳)。所以每条下限按自己的除数放宽:除数接近 1 的几乎不放,除数接近 0 的等于不看。
 * 代价是盖回去的颜色最多差这么一级。
 */
export const DIFF_TOLERANCE = 1 / 255;

/**
 * 把毛玻璃的外框(圆角矩形)画成掩码。`glass`:`[{ x, y, w, h, radii }]`,坐标是场景像素(可以带小数);
 * `radii` 是左上、右上、右下、左下四个角的 `[横半径, 纵半径]`,可以不给。`area`:掩码对应的矩形 `{ x, y, w, h }`(场景坐标,整数)。
 * 像素中心落在圆角矩形里的记 1。回 `Uint8Array(area.w × area.h)`。
 */
export function glassMask(glass, area, mask = new Uint8Array(area.w * area.h)) {
  const { w, h } = area;
  for (const g of glass ?? []) {
    if (!(g?.w > 0 && g?.h > 0)) continue;
    const x0 = g.x - area.x, y0 = g.y - area.y, x1 = x0 + g.w, y1 = y0 + g.h;
    const corner = n => { const c = g.radii?.[n]; return [Math.max(0, Number(c?.[0]) || 0), Math.max(0, Number(c?.[1]) || 0)]; };
    const tl = corner(0), tr = corner(1), br = corner(2), bl = corner(3);
    // CSS 的规矩:相邻两个角的半径加起来超过边长时,四个角按同一个比例缩小
    const fit = (len, a, b) => (a + b > len ? len / (a + b) : 1);
    const f = Math.min(1, fit(g.w, tl[0], tr[0]), fit(g.w, bl[0], br[0]), fit(g.h, tl[1], bl[1]), fit(g.h, tr[1], br[1]));
    for (const c of [tl, tr, br, bl]) { c[0] *= f; c[1] *= f; }
    // 这一行上圆角吃掉多宽:角的半径是 (rx, ry),这一行离圆心的纵向距离是 dy
    const eaten = (rx, ry, dy) => (rx > 0 && ry > 0 && dy > 0 ? rx * (1 - Math.sqrt(Math.max(0, 1 - (dy / ry) * (dy / ry)))) : 0);
    const rowFrom = Math.max(0, Math.ceil(y0 - 0.5)), rowTo = Math.min(h, Math.ceil(y1 - 0.5));
    for (let py = rowFrom; py < rowTo; py++) {
      const cy = py + 0.5;
      const left = x0 + Math.max(eaten(tl[0], tl[1], y0 + tl[1] - cy), eaten(bl[0], bl[1], cy - (y1 - bl[1])));
      const right = x1 - Math.max(eaten(tr[0], tr[1], y0 + tr[1] - cy), eaten(br[0], br[1], cy - (y1 - br[1])));
      const from = Math.max(0, Math.ceil(left - 0.5)), to = Math.min(w, Math.ceil(right - 0.5));
      if (to > from) mask.fill(1, py * w + from, py * w + to);
    }
  }
  return mask;
}

/**
 * 差分取层:由带目标卡的画面 `upper`(R)和不带目标卡的画面 `lower`(L)算出一层 S,使 S 按普通的叠加盖在 L 上等于 R。
 * 三张都是 straight RGBA(PNG 的口径,进编码器的也是这一种);`upper`、`lower` 是 `width × height` 的整张,
 * `crop`(整数,缺省整张)是要交出去的那一块。回 `{ rgba, width, height, changed }`:S 的像素(`crop` 那么大)、不透明度大于 0 的像素数。
 *
 * 按预乘色,每个像素要满足的是:
 *
 *     R色 = S色 + L色 × (1 − a)        R的不透明度 = a + L的不透明度 × (1 − a)        0 ≤ S色 ≤ a ≤ 1
 *
 * a 定了,S色 就是 `R色 − L色 × (1 − a)`,所以只要定 a:
 *
 *   - R 和 L 相同:全透明(a = 0)。
 *   - L 全透明:S 就是 R。
 *   - L 完全不透明:不透明度那条式子对 a 没有要求,a 取能让 S色 落在 [0, a] 里的最小值,即各颜色通道的两条下限
 *     `1 − R色 / L色` 与 `(R色 − L色) / (1 − L色)` 里最大的那个(契约第 5.3 节的算式)。阴影、压暗、提亮这一类算出来正是它本来的那一层。
 *     两条下限各按 `DIFF_TOLERANCE` 放宽:前一条减 `容差 × (1 − L色) / L色`,后一条减 `容差 × L色 / (1 − L色)`。
 *   - L 半透明:不透明度那条式子给出 `aα = (R的不透明度 − L的不透明度) / (1 − L的不透明度)`。颜色要的下限 b 不比它大就取 aα,两条都严格成立;
 *     颜色要的下限更大时(8 位量化的噪声,在 L 很暗或很亮的像素上会被放大),两头各让一点:取使「不透明度的误差」和「颜色的误差」
 *     相等的那个 a,`(aα × (1 − L的不透明度) + b × m) / ((1 − L的不透明度) + m)`,m 是那条颜色下限对 a 的斜率(`L色` 或 `1 − L色`)。
 *     L 完全不透明时它就是上一条;只取 b(契约原来的写法)在这种像素上会把不透明度抬高十几级。
 *   - **毛玻璃的外框里、L 又完全不透明的像素:a 取 1,S 就是 R。**(`glass`:页面量到的毛玻璃外框,见 `pageHideTarget`。)
 *     这些像素上 a 从最小值到 1 随便取哪个,盖回同一张 L 都等于 R;取 1 是因为这块本来就是「滤过的下层」整块盖上去的:
 *     取最小值的话 S 的不透明度是一张跟着下层细节起伏的图,贴回舞台时下层只要和产流时差一点(视频差一帧、活渲的卡差半帧),
 *     下层的清晰细节就会从本该模糊的玻璃里透出来,编码误差也更大。
 *
 * a 四舍五入到 8 位以后再算一遍 S色(夹在 [0, a] 里),交出去的是 straight 色(`S色 / a`)。
 */
export function diffLayer(upper, lower, width, height, { crop = null, glass = null, mask = null, tolerance = DIFF_TOLERANCE } = {}) {
  const c = crop ?? { x: 0, y: 0, w: width, h: height };
  if (!(Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.w) && Number.isInteger(c.h)) || c.x < 0 || c.y < 0 || c.w <= 0 || c.h <= 0 || c.x + c.w > width || c.y + c.h > height) {
    throw new Error(`diffLayer:要交出去的矩形不在画面里:${JSON.stringify(c)}(画面 ${width}×${height})`);
  }
  if (upper.length < width * height * 4 || lower.length < width * height * 4) throw new Error('diffLayer:数据比画面小');
  const out = Buffer.alloc(c.w * c.h * 4);
  const m = mask ?? (glass?.length ? glassMask(glass, c) : null);
  let changed = 0;
  for (let y = 0; y < c.h; y++) {
    let i = ((y + c.y) * width + c.x) * 4;
    let o = y * c.w * 4;
    let q = y * c.w;
    for (let x = 0; x < c.w; x++, i += 4, o += 4, q++) {
      const ra8 = upper[i + 3], la8 = lower[i + 3];
      const r0 = upper[i], r1 = upper[i + 1], r2 = upper[i + 2];
      const l0 = lower[i], l1 = lower[i + 1], l2 = lower[i + 2];
      const solid = la8 === 255 && m !== null && m[q] === 1;
      if (ra8 === la8 && r0 === l0 && r1 === l1 && r2 === l2) {
        // 相同:全透明。毛玻璃外框里的不留洞(零星的透明像素编码以后会洇开)
        if (solid) { out[o] = r0; out[o + 1] = r1; out[o + 2] = r2; out[o + 3] = 255; changed++; }
        continue;
      }
      if (ra8 === 0) continue;
      if (la8 === 0 || solid) {
        out[o] = r0; out[o + 1] = r1; out[o + 2] = r2; out[o + 3] = solid ? 255 : ra8;
        changed++;
        continue;
      }
      const wa = (255 - la8) / 255;
      let aa = wa > 0 ? (ra8 - la8) / (255 - la8) : 0;
      if (aa < 0) aa = 0;
      let a = aa;
      const rc0 = r0 * ra8 / 65025, rc1 = r1 * ra8 / 65025, rc2 = r2 * ra8 / 65025;
      const lc0 = l0 * la8 / 65025, lc1 = l1 * la8 / 65025, lc2 = l2 * la8 / 65025;
      let b, v;
      if (lc0 > 0) { b = 1 - (rc0 + tolerance * (1 - lc0)) / lc0; if (b > aa) { v = (aa * wa + b * lc0) / (wa + lc0); if (v > a) a = v; } }
      if (lc0 < 1) { b = (rc0 - lc0 - tolerance * lc0) / (1 - lc0); if (b > aa) { v = (aa * wa + b * (1 - lc0)) / (wa + 1 - lc0); if (v > a) a = v; } }
      if (lc1 > 0) { b = 1 - (rc1 + tolerance * (1 - lc1)) / lc1; if (b > aa) { v = (aa * wa + b * lc1) / (wa + lc1); if (v > a) a = v; } }
      if (lc1 < 1) { b = (rc1 - lc1 - tolerance * lc1) / (1 - lc1); if (b > aa) { v = (aa * wa + b * (1 - lc1)) / (wa + 1 - lc1); if (v > a) a = v; } }
      if (lc2 > 0) { b = 1 - (rc2 + tolerance * (1 - lc2)) / lc2; if (b > aa) { v = (aa * wa + b * lc2) / (wa + lc2); if (v > a) a = v; } }
      if (lc2 < 1) { b = (rc2 - lc2 - tolerance * lc2) / (1 - lc2); if (b > aa) { v = (aa * wa + b * (1 - lc2)) / (wa + 1 - lc2); if (v > a) a = v; } }
      if (a > 1) a = 1;
      const a8 = Math.round(a * 255);
      if (a8 === 0) continue;
      const aq = a8 / 255, keep = 1 - aq;
      let s = rc0 - lc0 * keep; out[o] = s <= 0 ? 0 : s >= aq ? 255 : Math.round(s / aq * 255);
      s = rc1 - lc1 * keep; out[o + 1] = s <= 0 ? 0 : s >= aq ? 255 : Math.round(s / aq * 255);
      s = rc2 - lc2 * keep; out[o + 2] = s <= 0 ? 0 : s >= aq ? 255 : Math.round(s / aq * 255);
      out[o + 3] = a8;
      changed++;
    }
  }
  return { rgba: out, width: c.w, height: c.h, changed };
}

/**
 * `crop` 外面两张有没有不同的像素(逐字节比,很快)。有就回它们的包围盒(整张的像素坐标),没有回 null。
 * 满密度那一趟只交出收紧矩形里的那一块;目标卡要是改到了矩形外面(稀疏那一趟每隔几帧才量一次,中间的帧可能超出),
 * 先用它粗筛,再由 `layerOutside` 细看。
 */
export function changedOutside(upper, lower, width, height, crop) {
  let x0 = width, y0 = -1, x1 = -1, y1 = -1;
  const scan = (y, from, to) => {
    const start = (y * width + from) * 4, end = (y * width + to) * 4;
    if (to <= from || upper.compare(lower, start, end, start, end) === 0) return;
    let first = from, last = to - 1;
    while (upper.readUInt32LE((y * width + first) * 4) === lower.readUInt32LE((y * width + first) * 4)) first++;
    while (upper.readUInt32LE((y * width + last) * 4) === lower.readUInt32LE((y * width + last) * 4)) last--;
    if (y0 < 0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  };
  for (let y = 0; y < height; y++) {
    if (y < crop.y || y >= crop.y + crop.h) scan(y, 0, width);
    else { scan(y, 0, crop.x); scan(y, crop.x + crop.w, width); }
  }
  return y1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * `crop` 外面,算出来的那一层有没有不透明的像素。有就回它们的包围盒(整张的像素坐标),没有回 null。
 * 和稀疏那一趟量实体框是同一个口径(那一层的不透明度大于 0):两张逐字节不同、算出来却仍是全透明的像素不算
 * (下层几乎全透明的地方两张的颜色常常对不上,预乘以后其实没有差别),不然这些像素每一帧都会被当成「改到了矩形外面」。
 */
export function layerOutside(upper, lower, width, height, crop, { glass = null, origin = { x: 0, y: 0 } } = {}) {
  const exact = changedOutside(upper, lower, width, height, crop);
  if (!exact) return null;
  const mask = glass?.length ? glassMask(glass, { x: exact.x + origin.x, y: exact.y + origin.y, w: exact.w, h: exact.h }) : null;
  const ring = diffLayer(upper, lower, width, height, { crop: exact, mask }).rgba;
  let x0 = width, y0 = -1, x1 = -1, y1 = -1;
  for (let y = 0; y < exact.h; y++) {
    const py = y + exact.y, inRows = py >= crop.y && py < crop.y + crop.h;
    for (let x = 0; x < exact.w; x++) {
      if (!ring[(y * exact.w + x) * 4 + 3]) continue;
      const px = x + exact.x;
      if (inRows && px >= crop.x && px < crop.x + crop.w) continue;
      if (y0 < 0) y0 = py;
      y1 = py;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
    }
  }
  return y1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ======================================================================== *
 * 页面里:把目标卡那一层藏起来 / 撤掉
 * ======================================================================== */

/**
 * 在页面里跑(`page.evaluate`,函数体不引用外面的东西)。把片段 `clipId` 那一层的不透明度压成 0,回
 * `{ ok, absent, reason, glass }`:
 *
 *   - `absent`:这一帧页面上没有这张卡(还没到入点、已经出点),什么都没改,上张和下张本来就是同一张;
 *   - `ok: false`:压不住(`reason: 'not-hidden'`,算出来的不透明度不是 0);
 *   - `glass`:目标卡里这一刻真的在滤下层的毛玻璃的外框(场景坐标)和四个角的半径,给 `diffLayer` 当掩码。只收「看得见、
 *     自己和各级祖先都没有让它另起一层(不透明度不是 1、滤镜、混合模式、裁切、遮罩)、没有旋转和三维」的:另起一层的毛玻璃采样不到下层,
 *     旋转过的外框不是它的形状 —— 这些不进掩码,照最小不透明度算(仍然盖回去等于原画面)。
 *
 * 藏的是导出页给每张卡包的那一层 `[data-pc-native-layer]`,没有这一层(旧形状的时间轴)就藏包裹层 `[data-pc-clip]`。
 * 剪辑段里的卡(摊平出来的虚拟片段,〔裁〕R01)藏它在嵌套场景里的包裹层 `[data-pc-flat-clip]`;虚拟片段的 id 带 `~`,和顶层的 id 撞不上。
 * 找毛玻璃外框时往上查祖先查到嵌套场景(`[data-pc-cut-scene]`)为止:嵌套场景是毛玻璃的采样边界(`CutSegmentScene` 的 `clip-path`),
 * 玻璃这一块在场景里是整块盖上去的;场景自己的 `clip-path` 不算「另起一层」。
 */
export function pageHideTarget(clipId) {
  const ID = '__pc_below_hide';
  document.getElementById(ID)?.remove();
  const esc = CSS.escape(String(clipId));
  const sel = `[data-pc-native-layer="${esc}"], [data-pc-clip="${esc}"]:not([data-pc-media]), [data-pc-flat-clip="${esc}"]`;
  const layer = document.querySelector(`[data-pc-native-layer="${esc}"]`) ?? document.querySelector(`[data-pc-clip="${esc}"]:not([data-pc-media])`)
    ?? document.querySelector(`[data-pc-flat-clip="${esc}"]`);
  if (!layer) return { ok: true, absent: true, reason: null, glass: [] };
  const plain = v => !v || v === 'none' || v === 'normal';
  const ownLayer = cs => cs.opacity !== '1' || !plain(cs.filter) || !plain(cs.mixBlendMode) || !plain(cs.clipPath)
    || !plain(cs.maskImage) || !plain(cs.webkitMaskImage);
  const axisAligned = cs => {
    const t = cs.transform;
    if (!t || t === 'none') return true;
    const hit = /^matrix\(([^)]+)\)$/.exec(t);
    if (!hit) return false;
    const n = hit[1].split(',').map(Number);
    return Math.abs(n[1]) < 1e-6 && Math.abs(n[2]) < 1e-6 && n[0] > 0 && n[3] > 0;
  };
  const glass = [];
  for (const el of layer.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const filter = cs.backdropFilter || cs.webkitBackdropFilter;
    if (plain(filter) || cs.visibility !== 'visible' || cs.display === 'none') continue;
    // 自己半透明、带滤镜之类的:玻璃这一块不是整块盖上去的
    if (ownLayer(cs) || !axisAligned(cs)) continue;
    let direct = true;
    for (let p = el.parentElement; p && direct; p = p.parentElement) {
      if (p.hasAttribute('data-pc-cut-scene')) break;
      const ps = getComputedStyle(p);
      if (ownLayer(ps) || !plain(ps.backdropFilter || ps.webkitBackdropFilter) || !axisAligned(ps)) direct = false;
      if (p.hasAttribute('data-pc-scene')) break;
    }
    if (!direct) continue;
    const box = el.getBoundingClientRect();
    if (!(box.width >= 1 && box.height >= 1)) continue;
    const sx = el.offsetWidth > 0 ? box.width / el.offsetWidth : 1, sy = el.offsetHeight > 0 ? box.height / el.offsetHeight : 1;
    const radius = value => {
      const parts = String(value || '0').trim().split(/\s+/);
      const one = (text, base) => (String(text).endsWith('%') ? (parseFloat(text) || 0) / 100 * base : parseFloat(text) || 0);
      return [one(parts[0], el.offsetWidth) * sx, one(parts[1] ?? parts[0], el.offsetHeight) * sy];
    };
    glass.push({ x: box.left, y: box.top, w: box.width, h: box.height,
      radii: [radius(cs.borderTopLeftRadius), radius(cs.borderTopRightRadius), radius(cs.borderBottomRightRadius), radius(cs.borderBottomLeftRadius)] });
  }
  const hold = `${sel} { transition-duration: 0s !important; transition-delay: 0s !important; }`;
  const style = document.createElement('style');
  style.id = ID;
  style.setAttribute('data-hold', hold);
  style.textContent = `${hold}\n${sel} { opacity: 0 !important; }`;
  document.head.appendChild(style);
  const hidden = getComputedStyle(layer).opacity === '0';
  return { ok: hidden, absent: false, reason: hidden ? null : 'not-hidden', glass };
}

/** 在页面里跑:把 `pageHideTarget` 加的那条样式撤掉。分两步:先只留「过渡时长为 0」算一次样式(值变回去也不起过渡),再整个删掉 */
export function pageShowTarget() {
  const style = document.getElementById('__pc_below_hide');
  if (!style) return false;
  style.textContent = style.getAttribute('data-hold') || '';
  void document.body.offsetHeight;
  style.remove();
  void document.body.offsetHeight;
  return true;
}

/* ======================================================================== *
 * 给 `bakeStream` 的取帧钩子
 * ======================================================================== */

/** 一条流的差分取层记录(挂在 `StreamProducer` 的流状态上,`status()` 原样给出去) */
export function newBelowRecord() {
  return {
    /** 实测没过的原因(`upper-changed`:藏和撤以后上张变了);有值以后这条流的分段不再产 */
    failed: null,
    /** 下张要不要先丢一张再截(某一次实测发现藏着的时候连截两张不相同以后打开) */
    primeLower: false,
    /** 取了几帧;其中目标卡不在页面上的、上下两张完全相同的、掩码里有毛玻璃的各几帧;做过几次实测;目标卡改到交出去的矩形外面几次 */
    frames: 0, absent: 0, same: 0, glassFrames: 0, checks: 0, overflows: 0,
    /** 累计耗时(毫秒):上张那一次截图、藏起来截下张再撤掉、实测多截的那两张、解两张 PNG、算那一层 */
    upperMs: 0, lowerMs: 0, verifyMs: 0, decodeMs: 0, diffMs: 0,
    /** 最近一次实测 `{ frame, lowerStable, upperStable }` */
    last: null,
  };
}

const samePixels = (a, b) => {
  if (a.equals(b)) return true;
  const da = decodePngRgba(a), db = decodePngRgba(b);
  return !!da && !!db && da.width === db.width && da.height === db.height && da.data.equals(db.data);
};

/**
 * 给 `bakeStream` 的 `capture` 用:一个分段一个。`capture(frame, shoot)` 回这一帧交给 `onFrame` 的 `{ rgba, width, height }`
 * (差分取层算出来的 S,`rect` 那么大的 straight RGBA)。
 *
 * `clipId`:目标卡的片段;`view`:两张截图的矩形(场景坐标,`bakeStream` 的 `clip` 必须就是它);`rect`:交出去的矩形(场景坐标,在 `view` 里);
 * `record`:这条流的记录(`newBelowRecord`);`verify`:每个分段第一帧做不做那两条实测;`note(message)`:记一条诊断;
 * `tap({ frame, upperPng, lowerPng, glass, absent })`:探针用,把这一帧截到的两张原样交出去看(产品里不给)。
 *
 * 顺序固定为:上张(`shoot()`)→ 藏 → 下张 →(实测时再截一张)→ 撤 →(实测时再截一张)。中间不推时间、不重挂载;
 * 藏了以后无论截图成没成都撤(`finally`)。
 *
 * `rect` 比 `view` 小时,那一层在 `rect` 外面还有不透明的像素(目标卡改到了交出去的矩形外面)就抛 `code: 'below-overflow'` 的错,
 * `box` 是那些像素的包围盒(场景坐标);调用方把矩形放大以后重来。
 */
export function belowSegmentCapture(bakery, { clipId, view, rect, record = newBelowRecord(), signal = null, verify = true, note = () => {}, tap = null }) {
  const crop = { x: rect.x - view.x, y: rect.y - view.y, w: rect.w, h: rect.h };
  if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > view.w || crop.y + crop.h > view.h) {
    throw new Error(`差分取层:交出去的矩形 ${JSON.stringify(rect)} 不在截图矩形 ${JSON.stringify(view)} 里`);
  }
  const fail = (code, message) => Object.assign(new Error(`差分取层:${message}`), { code });
  const shot = () => captureFrame(bakery, SHOT, signal, { prime: false, clip: view });
  let checked = !verify;
  let mask = null, maskKey = '';
  return async (frame, shoot) => {
    if (record.failed) throw fail(record.failed, `这条流上一次实测没过(${record.failed}),不再产`);
    let at = performance.now();
    const upperPng = await shoot();
    record.upperMs += performance.now() - at;
    at = performance.now();
    const checking = !checked;
    const hid = await bakery.page.evaluate(pageHideTarget, clipId);
    let lowerPng = null, lowerAgain = null;
    try {
      if (!hid?.ok) throw fail('not-hidden', `片段 ${clipId} 那一层藏不住(${hid?.reason ?? '页面没有回话'})`);
      if (!hid.absent) {
        if (record.primeLower) await shot();
        lowerPng = await shot();
        if (checking) { record.lowerMs += performance.now() - at; at = performance.now(); lowerAgain = await shot(); }
      }
    } finally {
      if (hid && !hid.absent) await bakery.page.evaluate(pageShowTarget);
    }
    record.frames++;
    if (tap) await tap({ frame, upperPng, lowerPng, glass: hid.glass ?? [], absent: hid.absent === true });
    if (hid.absent) {
      record.lowerMs += performance.now() - at;
      record.absent++;
      return { rgba: Buffer.alloc(crop.w * crop.h * 4), width: crop.w, height: crop.h };
    }
    if (checking) {
      const upperAgain = await shot();
      const lowerStable = samePixels(lowerPng, lowerAgain), upperStable = samePixels(upperPng, upperAgain);
      record.verifyMs += performance.now() - at;
      record.checks++;
      record.last = { frame, lowerStable, upperStable };
      if (!upperStable) {
        record.failed = 'upper-changed';
        note(`差分取层没过:第 ${frame} 帧把片段 ${clipId} 藏起来再撤掉以后,带目标卡的画面变了;这条流不再产`);
        throw fail('upper-changed', `第 ${frame} 帧藏和撤以后带目标卡的画面变了`);
      }
      if (!lowerStable) {
        record.primeLower = true;
        note(`差分取层:第 ${frame} 帧藏着片段 ${clipId} 连截两张不相同,这条流以后每张下张先丢一张再截`);
        throw fail('lower-unstable', `第 ${frame} 帧藏着目标卡连截两张不相同`);
      }
      checked = true;
    } else record.lowerMs += performance.now() - at;
    const glass = hid.glass?.length ? hid.glass : null;
    if (!glass && upperPng.equals(lowerPng)) {
      record.same++;
      return { rgba: Buffer.alloc(crop.w * crop.h * 4), width: crop.w, height: crop.h };
    }
    at = performance.now();
    const upper = decodePngRgba(upperPng), lower = decodePngRgba(lowerPng);
    if (!upper || !lower || upper.width !== view.w || upper.height !== view.h || lower.width !== view.w || lower.height !== view.h) {
      throw fail('png', `第 ${frame} 帧的截图解不开,或者不是 ${view.w}×${view.h}`);
    }
    record.decodeMs += performance.now() - at;
    at = performance.now();
    if (crop.w < view.w || crop.h < view.h) {
      const outside = layerOutside(upper.data, lower.data, view.w, view.h, crop, { glass, origin: view });
      if (outside) {
        record.overflows++;
        throw Object.assign(fail('below-overflow', `第 ${frame} 帧目标卡改到了交出去的矩形外面`), { box: { x: outside.x + view.x, y: outside.y + view.y, w: outside.w, h: outside.h } });
      }
    }
    if (glass) {
      record.glassFrames++;
      const key = JSON.stringify(glass);
      if (key !== maskKey) { mask = glassMask(glass, rect); maskKey = key; }
    }
    const layer = diffLayer(upper.data, lower.data, view.w, view.h, { crop, mask: glass ? mask : null });
    record.diffMs += performance.now() - at;
    return { rgba: layer.rgba, width: layer.width, height: layer.height };
  };
}
