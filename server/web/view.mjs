/**
 * 「让模型看见网页」的那一层:一张图 + 一份可点清单。
 *
 * ## 为什么不是只给图,也不是只给树
 *
 * 实测(MDN 的 fetch 文档页,视口 1280x800):
 *   - 完整 a11y 树:1362 个节点、193k 字符 ≈ 48k token。看两次上下文就满了。
 *   - 只留视口内可交互的:47 个 ≈ 620 token。
 *   - 800 长边的截图 ≈ 640 token。
 * 图 + 清单合计约 1.2k token,比整棵树便宜近 40 倍,而且模型同时有视觉和能调用的把手。
 *
 * 分工是:**图负责「读」,清单负责「点」**,两边不重复。清单里只有可交互元素,静态
 * 文字一个都不放 —— 那些字在图上,再抄一遍就是白花钱。
 *
 * ## 为什么长边缩到 800 而不是固定 800x600
 *
 * 固定尺寸会改变宽高比(1280x800 是 1.6,800x600 是 1.33),图被横向压扁,模型报的坐标
 * 还原回页面时两个轴的比例不一样,很容易错。长边匹配 + 等比缩放之后**只有一个 scale**,
 * 正反变换都是乘除同一个数。
 *
 * ## 为什么用 clip.scale 缩,而不是 deviceScaleFactor,更不是截完再 resize
 *
 * 三条路都试过:
 *   - 截完用 pngjs 缩:纯 CPU 重采样,把主线程堵住(见 server/harness/README 对同步操作的态度);
 *   - 改 `deviceScaleFactor` 再截:**踩过坑**。有头窗口下 setViewport 是一次真实的窗口
 *     resize,页面正在跳转时它会挂住 —— 实测 `web_view` 卡满 45 秒超时才返回,而且
 *     一次 capture 要来回改两次(截前设、截后还原),等于两次 resize;
 *   - `clip.scale`:Chrome 在合成阶段直接出缩好的位图,**视口一动不动**,没有 resize、
 *     没有布局回流、没有还原步骤。就是它。
 *
 * 顺带一个好处:视口不变,elementFromPoint 的坐标系自然也不变,命中检测不会因为
 * 截图这个动作而偏。
 */
import { VIEWPORT, IMAGE_LONG_EDGE } from './browser.mjs';

/** 图坐标 = 页面坐标 x scale。永不放大 —— 视口比 800 还小的时候原样给 */
export function scaleOf(viewport = VIEWPORT) {
  return Math.min(1, IMAGE_LONG_EDGE / Math.max(viewport.width, viewport.height));
}

/**
 * 这一页**现在实际多大**。截图和命中检测都必须用它,不能各自回退到常量。
 *
 * `page.viewport()` 在有仿真时返回我们设的那个尺寸,但**没有仿真时返回 null**。
 * 壳模式(agent 的浏览器是 Tauri 主窗口里的子 webview)下,web_handoff 把面板交给
 * 用户时会 `setViewport(null)` 解除仿真、让 webview 跟着面板走 —— 这时候如果还按
 * 常量 1280x800 算,会出两个错,而且是两种不同的坏法:
 *
 *   1. **截图**:clip 比真实视口大,puppeteer 为此打开 captureBeyondViewport,
 *      那会把设备指标仿真又套回去 —— 用户正在操作的面板当场错位;
 *   2. **命中检测**:图坐标按 1280x800 反算,而页面其实是别的尺寸,
 *      **点击会静默落到错误的位置**。这个比错位更坏,因为它不报错。
 *
 * 所以两边都从这里取,量不出来才退回常量。
 */
export async function liveViewport(page) {
  const vp = page.viewport();
  if (vp && vp.width > 0 && vp.height > 0) return vp;
  try {
    const m = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (m && m.width > 0 && m.height > 0) return m;
  } catch { /* 页面崩了 / 评估不了 —— 退回常量总比抛出去强 */ }
  return VIEWPORT;
}

/** 清单最多给这么多条。密集页面(后台系统、商品列表)一屏能有几百个,全给等于没给 */
const MAX_ITEMS = 60;

/**
 * 页面里跑的那半:给可交互元素打 uid,并量出它们在图上的包围盒。
 *
 * 打在 DOM 上的 `data-pcuid` 是 view 和 hit 之间唯一的约定 —— click_at 的命中检测靠它
 * 把「点到的那个元素」翻回 uid。每次 capture 都重编号,所以编号只对最近一次截图有效;
 * 工具描述里必须写明这一点,不然模型会拿三轮前的 e7 来点。
 */
/* c8 ignore start — 这个函数体是序列化后送进页面执行的,不在 node 里跑 */
function tagAndList(scale, maxItems) {
  const SEL = 'a[href],button,input,select,textarea,summary,'
    + '[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=true]';
  // 上一轮的标记要清掉:页面可能没跳转只是滚动了,残留的 uid 会让命中检测指到已经不在视口的元素
  for (const el of document.querySelectorAll('[data-pcuid]')) el.removeAttribute('data-pcuid');

  /**
   * 这个元素在它自己的位置上**真的点得到吗**。
   *
   * 光看 getBoundingClientRect 是不够的:它返回的是布局位置,**祖先的 overflow 裁剪
   * 不体现在里面**。MDN 侧边栏那种「元素排在那儿、但被祖先裁掉了」的情况,rect 看着
   * 完全正常,elementsFromPoint 却根本扫不到它 —— 清单里留着它就是给模型一个
   * 点不动的编号,正是本仓库那条「模型看得见但调不动」最怕的东西(见
   * server/test/tool-schema.test.mjs 里三处对齐的注释)。
   *
   * 探中心加四个内缩点:中心被别的东西压住是常事(图标上盖一层 tooltip),
   * 只要有一个点能落回自己(或自己的后代)就算点得到。
   *
   * 返回 'ok' | 'covered' | 'ghost':
   *   - covered 是「在,但被上层盖着」—— 留着并标出来,模型得知道有这么个按钮,
   *     只是要先把上面那层关掉;
   *   - ghost 是「压根扫不到」—— 直接丢掉,留着只会骗模型。
   */
  const reachability = (el, r) => {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const cx = clamp((r.left + r.right) / 2, 1, innerWidth - 1);
    const cy = clamp((r.top + r.bottom) / 2, 1, innerHeight - 1);
    const inset = Math.min(4, r.width / 4, r.height / 4);
    const pts = [[cx, cy],
      [clamp(r.left + inset, 1, innerWidth - 1), cy],
      [clamp(r.right - inset, 1, innerWidth - 1), cy],
      [cx, clamp(r.top + inset, 1, innerHeight - 1)],
      [cx, clamp(r.bottom - inset, 1, innerHeight - 1)]];
    for (const [x, y] of pts) {
      const stack = document.elementsFromPoint(x, y);
      for (const hit of stack) {
        if (hit === el || el.contains(hit)) return 'ok';
        // 扫到了别的东西但自己也在这条 z 轴上 → 被盖住,不是不存在
        if (stack.includes(el)) return 'covered';
      }
    }
    return 'ghost';
  };

  const vis = [];
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    // 完全在视口外的丢掉;**跨边界的留着** —— 被上边裁掉一半的元素在图上看得见,
    // 清单里没有的话模型会以为那儿什么都没有
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') continue;
    const reach = reachability(el, r);
    if (reach === 'ghost') continue;
    vis.push({ el, r, covered: reach === 'covered' });
  }

  // 阅读顺序:先按行分档(24px 一档,约一行文字),档内按 x。这样清单的顺序和图上
  // 从上到下、从左到右的视觉顺序一致,模型对照着扫就行,不用在 DOM 顺序里乱翻
  vis.sort((a, b) => (Math.floor(a.r.top / 24) - Math.floor(b.r.top / 24)) || (a.r.left - b.r.left));

  const total = vis.length;
  // 超上限时按面积留大的:小图标点错了代价小,大按钮才是主路径
  const kept = total <= maxItems
    ? vis
    : vis.slice().sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height).slice(0, maxItems)
        .sort((a, b) => (Math.floor(a.r.top / 24) - Math.floor(b.r.top / 24)) || (a.r.left - b.r.left));

  const px = (v) => Math.round(v * scale);
  const items = kept.map((o, i) => {
    const u = 'e' + (i + 1);
    o.el.setAttribute('data-pcuid', u);
    const name = (
      o.el.getAttribute('aria-label') || o.el.innerText || o.el.value ||
      o.el.getAttribute('placeholder') || o.el.getAttribute('title') || o.el.getAttribute('alt') || ''
    ).trim().replace(/\s+/g, ' ').slice(0, 40);
    const row = {
      u,
      t: o.el.tagName.toLowerCase(),
      n: name,
      b: [px(o.r.left), px(o.r.top), px(o.r.right), px(o.r.bottom)],
    };
    // 输入框要告诉模型里面现在有什么,不然它不知道该不该先清空
    if (o.el.tagName === 'INPUT' || o.el.tagName === 'TEXTAREA') {
      row.v = String(o.el.value || '').slice(0, 30);
      if (o.el.type) row.it = o.el.type;
    }
    // 被上层盖住:留在清单里(模型得知道有这个按钮),但要标出来 —— 直接点会打在
    // 上面那层身上,正确动作是先把弹窗/横幅关掉
    if (o.covered) row.covered = true;
    return row;
  });
  return { items, total, url: location.href, title: document.title.slice(0, 120) };
}
/* c8 ignore stop */

/**
 * 截一屏 + 出清单。返回的 image 用 `__image` 包着 —— 那是 harness/agent.mjs 认的形状,
 * 它会把图从 JSON 里摘出来单独挂到消息末尾(base64 留在 JSON 里会被当普通文本灌进历史)。
 */
export async function captureView(page, { maxItems = MAX_ITEMS, quality = 70 } = {}) {
  // 用实测尺寸,不回退常量 —— 壳模式下用户操作面板时视口仿真是解除的,
  // 按常量算会 clip 出界并把仿真套回去,当场把用户正在看的画面弄错位
  const viewport = await liveViewport(page);
  const scale = scaleOf(viewport);

  // 跳转还没落地时截图会等到天荒地老(踩过:卡满 45 秒超时)。等一下 readyState,
  // 等不到也照样往下走 —— 半张图也比一句超时有用,而且有些站永远到不了 complete。
  await page.waitForFunction(() => document.readyState !== 'loading', { timeout: 8000 })
    .catch(() => { /* 超时就按现状截,别把整个动作拖垮 */ });

  const { items, total, url, title } = await page.evaluate(tagAndList, scale, maxItems);

  // clip.scale 让 Chrome 在合成阶段就把图缩好,**视口一动不动**。
  // 不用 deviceScaleFactor 的原因见文件头。
  const base64 = await page.screenshot({
    type: 'webp',
    quality,
    encoding: 'base64',
    clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale },
  });

  const img = { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale) };
  return {
    url,
    title,
    image: { width: img.width, height: img.height },
    clickable: items,
    ...(total > items.length
      ? { omitted: total - items.length, note: `视口内还有 ${total - items.length} 个可交互元素没列出(按面积留了最大的 ${items.length} 个)。滚动后重新 web_view,或者告诉我你要找什么。` }
      : {}),
    hint: `图是 ${img.width}x${img.height};clickable 里的 b 是元素在这张图上的像素包围盒 [x1,y1,x2,y2]。编号只对本次截图有效,滚动或跳转后必须重新 web_view。`,
    __image: { base64, mime: 'image/webp' },
  };
}
