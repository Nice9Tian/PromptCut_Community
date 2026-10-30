/**
 * 命中检测:把模型看图报的坐标翻译成 uid。
 *
 * ## 为什么要有这一层
 *
 * 模型是看着图说话的,「点右上角那个登录」在它脑子里是一个位置,不是一个 id。让它先在
 * clickable 清单里找 uid 再点,等于逼它做一次人不会做的查表。但真正的点击又必须走 uid ——
 * 坐标点击(CDP 的 Input.dispatchMouseEvent)不等可点击性、不滚动、不处理被遮挡,而
 * puppeteer 的 Locator 这些都替你做了。所以这层的职责就是:**收坐标,交 uid**。
 *
 * ## 真正的风险不是「点空」,是「静默点错邻居」
 *
 * 实测 MDN 顶部导航,相邻项的包围盒是**零间隙**的:
 *     e6 «HTML» b=[128,79,183,107]   e7 «CSS» b=[183,79,229,107]
 * 从 HTML 中心往右偏 30 图像素就落进 CSS,而且是**精确命中** —— 没有任何一层会报错,
 * 页面跳走了模型下一轮才发现不对。半径搜索反倒是安全的:真空白处 R=0/6/20 都正确落空。
 *
 * 所以这里的设计是两条:
 *   1. `expect`:模型把「我要点的是什么」一起交上来,命中的名字对不上就**不点**,返候选。
 *      实测偏 30px 落在 CSS 上、带 expect:"HTML" 时能正确救回 e6。
 *   2. 边界骑跨、z 轴堆叠、名字对不上 —— 一律返候选让模型选,而不是替它赌一把。
 *
 * 候选里带 uid,模型下一轮直接 web_click({u}) 就行。**不要做成「回复 1/2/3」** —— 那是
 * 一个只在那条响应里有效的临时编号空间,得存状态、跨轮对齐,而 uid 本来就是现成的。
 * 序号只是给人和模型读着顺眼,可调用的永远是 u。
 */

import { scaleOf, liveViewport } from './view.mjs';

/** 半径搜索的上限,单位是**图**的像素。14 约等于页面上 22px,一个小图标的量级 */
const DEFAULT_RADIUS = 14;

/** 最多返几个候选。密集页面一个点周围能扒出十几个,全返回等于把问题原样丢回去 */
const MAX_CANDIDATES = 5;

/* c8 ignore start — 函数体序列化后送进页面执行,不在 node 里跑 */
function probeAt(ix, iy, expect, radius, maxCands, scale) {
  // 图坐标 → 页面坐标。view.mjs 是长边等比缩的,所以两个轴共用一个 scale,
  // 而且这个 scale 是 node 侧算好传进来的 —— 不在页面里重算,免得两处常量走散
  const px = ix / scale;
  const py = iy / scale;

  const tagged = document.querySelectorAll('[data-pcuid]');
  if (!tagged.length) return { ok: false, reason: 'no_snapshot' };

  const seen = new Map();
  const climb = (el) => {
    let n = el;
    // 往上找 6 层:清单里登记的是 <a>/<button>,但点到的往往是里面的 <span>/<svg>
    for (let d = 0; n && d < 6; d++, n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('data-pcuid')) return n;
    }
    return null;
  };
  const add = (el, dist, stacked) => {
    const u = el.getAttribute('data-pcuid');
    if (!u || seen.has(u)) return;
    const r = el.getBoundingClientRect();
    seen.set(u, {
      u,
      t: el.tagName.toLowerCase(),
      n: (el.getAttribute('aria-label') || el.innerText || el.value || '')
        .trim().replace(/\s+/g, ' ').slice(0, 40),
      b: [Math.round(r.left * scale), Math.round(r.top * scale),
          Math.round(r.right * scale), Math.round(r.bottom * scale)],
      d: Math.round(dist),
      ...(stacked ? { stacked: true } : {}),
    });
  };

  // 1) 点正下方的整条 z 轴。elementsFromPoint 会把被遮挡的层也返回来,所以能识别
  //    「这个按钮压在 cookie 横幅底下」—— 那种候选要标出来,直接点多半会被拦截
  const stack = document.elementsFromPoint(px, py);
  stack.forEach((el, idx) => { const h = climb(el); if (h) add(h, 0, idx > 0); });

  // 2) 半径内的邻居。只在正下方什么都没有、或者要给候选时有用
  for (let r = 2; r <= radius; r += 2) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const h = climb(document.elementFromPoint(px + dx / scale, py + dy / scale));
      if (h) add(h, r, false);
    }
  }

  const cands = [...seen.values()].sort((a, b) => a.d - b.d);
  if (!cands.length) {
    const top = document.elementFromPoint(px, py);
    return {
      ok: false,
      reason: 'empty',
      saw: (top && top.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60),
    };
  }

  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, '');
  if (expect) {
    const e = norm(expect);
    const hit = cands.filter((c) => norm(c.n) && (norm(c.n).includes(e) || e.includes(norm(c.n))));
    // 名字对上且只有一个 → 就是它,哪怕坐标偏到邻居身上了
    if (hit.length === 1) return { ok: true, mode: 'expect', pick: hit[0] };
    // 对上多个,或者一个都没对上 —— 都不该替模型赌
    return { ok: false, reason: hit.length ? 'ambiguous' : 'expect_mismatch',
             expect, cands: cands.slice(0, maxCands) };
  }

  // 没给 expect:只有唯一一个、且没被别的层盖着,才敢直接点
  if (cands.length === 1 && !cands[0].stacked) return { ok: true, mode: 'unique', pick: cands[0] };
  return { ok: false, reason: 'ambiguous', cands: cands.slice(0, maxCands) };
}
/* c8 ignore stop */

/**
 * 图坐标 → uid。
 *
 * 返回要么 `{ ok:true, pick }`(可以点了),要么 `{ ok:false, reason, cands? }`。
 * **不在这里点** —— 点击归 session.mjs,这里只负责把坐标变成一个可靠的 uid 或者一句
 * 说得清的拒绝。分开是为了让这一层能单独测:给定坐标和页面,判定是确定的。
 */
export async function resolveAt(page, ix, iy, { expect = null, radius = DEFAULT_RADIUS } = {}) {
  // 必须和 captureView 用同一个尺寸来源,否则图上的坐标反算回页面会整体偏
  const scale = scaleOf(await liveViewport(page));
  return await page.evaluate(probeAt, ix, iy, expect, radius, MAX_CANDIDATES, scale);
}

/** 把判定结果写成给模型看的一段话。候选带序号只为好读,可调用的是 u */
export function explain(res) {
  if (res.ok) return null;
  if (res.reason === 'no_snapshot') {
    return '这一页还没有截过屏,坐标没有参照。先调 web_view 拿到图和 clickable 清单,再按图上的坐标点。';
  }
  if (res.reason === 'empty') {
    return `那个位置没有可点的东西${res.saw ? `(看到的是文字「${res.saw}」)` : ''}。对照图重新定位,或者用 u 直接指定清单里的元素。`;
  }
  const lines = res.cands.map((c, i) =>
    `  ${i + 1}. u="${c.u}" «${c.n || '(无文字)'}» <${c.t}> b=[${c.b.join(',')}] 距${c.d}px`
    + (c.stacked ? ' ⚠被上层盖住,可能要先关掉上面那层' : ''));
  const head = res.reason === 'expect_mismatch'
    ? `那个位置附近没有叫「${res.expect}」的元素。可能是你看错了位置,也可能这一页变了。附近有:`
    : '那个位置附近有多个可点元素,没法确定你要哪个。请用 web_click({u:"..."}) 指定:';
  return `${head}\n${lines.join('\n')}`;
}
