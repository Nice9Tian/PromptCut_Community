# 比对陷阱:画面看着一样,程序却说不一样

做渲染对账(两条管线逐帧比像素、逐帧比 DOM)时,先读这一篇。下面每一条都是 2026-09-11 实测撞过的墙:程序报「不同」,真正的原因却在比对方法上,不在被比的东西上。

**第一条规矩:程序报不同,先用眼睛看。** 把差异最大的那一帧拼成「A | B | 差异 × 8」三联图,只裁有差异的区域,再下结论。这一轮就是看了图,才发现差异是动画中间值的细微差别,而不是错帧。拼图脚本的做法见 `docs/archive/topics/hybrid-sampling-plan.md` 的 E2a。

---

## 1. 截图那一拍不等于目标帧:预热也会截图

**症状**:两边 DOM 从片内第 0 帧起全部对不上。一边的片段容器是空的,另一边卡片已经挂上了。

**原因**:`bakeFrames` 在正式出帧前先预热,会在 t=0 连截 4 次(预热 3 次,重挂载后再 1 次)。给 `bakery.beginFrame` 套一层、按「第几次截图」来记帧,就会把这 4 份空舞台记进去,整体错 4 帧。

**做法**:记录时从页面读当前的导出帧号,只保留目标帧。**不要按调用顺序对位。**

```js
const [f, html] = await page.evaluate(() => [Math.round((window.__pcExportMs / 1000) * 30), document.getElementById('root').innerHTML]);
```

## 2. 样式写法不同:`inset: 0` 和 `inset: 0px`

**症状**:两个 DOM 实现(Chrome 和 happy-dom)逐帧 0/90 相同,差异全是 `0` 对 `0px` 这类写法。

**原因**:React 设的是 `style.inset = 0`。Chrome 的 CSSOM 读回来是 `0px`,happy-dom 原样保留。

**坑中坑**:想借 Chrome 把两边写法统一,把 HTML 塞进 `innerHTML` 再读回来,**这没用**。`style` 属性会原样读回,Chrome 不会重新序列化。必须经 CSSOM 重写一遍:

```js
for (const el of root.querySelectorAll('[style]')) el.style.cssText = el.getAttribute('style');
```

## 3. 属性顺序不同

**症状**:内容完全一样,但 `<svg … style="…">` 和 `<svg style="…" …>` 被判成不同(checklist 0/90)。

**原因**:同一段 React 代码,在两个 DOM 实现里设属性的先后不同。

**做法**:比之前,每个元素的属性按名字排序。

## 4. 浮点末位:Node 和 Chrome 的 V8 不是同一个版本

**症状**:`translateY(0.295972px)` 对 `translateY(0.295971px)`,差百万分之一像素。

**原因**:同一段 JS 在 Node 和 Chrome 里跑,各自的 V8 版本不同,`Math.pow` / `Math.exp` 这类函数在末位上会有差别。

**做法**:把「逐字节相同」和「容差内相同」分成两个数报告,别混为一谈。容差规整时,正则要写对:

```js
h.replace(/-?\d+\.\d+/g, (m) => String(Math.round(Number(m) * 1e4) / 1e4))
```

这条正则还漏一种写法:很小的数会序列化成科学计数法,比如 `7.1747e-05px` 对 `7.17e-05px`,实际只差 1e-9 量级,却会被判成不同。需要的话把 `(?:e-?\d+)?` 也纳进匹配。

**别从 shell 里用 `node -e` 往脚本里写正则。** 这一轮连续两次写坏:反斜杠在 shell 和 JS 字符串两层转义里被吃掉,`/-?\d+\.\d+/` 先变成匹配字面反斜杠的样子,又变成 `/-?d+.d+/`,把 `rounded-full` 改成了 `rounNaN-full`。结果是「容差内相同」的数字全错,却不报任何错。改脚本请用编辑工具。

## 5. WAAPI 和 JS 两条动画路径本来就有细微差别

**症状**:同一张卡,正常导出和关掉 WAAPI(让 Motion 走 JS 动画)逐像素比:rank-bars 65/90、checklist 48/90、mu-blur-fade 85/90、stat-proof 61/90 帧相同,最大通道差 2~42。

**不是错帧**:把一边的第 f 帧和另一边的第 f±1、f±2 帧比,反而对得更少。

**目视**:位置、结构完全一样,差的是透明度和模糊半径的中间值。**推测**:WAAPI 由 Chrome 求缓动,弹簧被近似成 `linear()`;JS 路径是 Motion 自己算。

**做法**:只拿同一条动画路径的产物互相比。拿纯 DOM 环境(没有 WAAPI)的产物去比正常导出,得到的是这类差别,不是 bug。关 WAAPI 的办法,在页面加载前注入:

```js
const own = Object.prototype.hasOwnProperty;
Object.prototype.hasOwnProperty = function (k) { return this === Element.prototype && k === 'animate' ? false : own.call(this, k); };
```

Motion 靠 `Object.hasOwnProperty.call(Element.prototype, 'animate')` 判断浏览器支不支持 WAAPI(`motion-dom/.../waapi/supports/waapi.mjs`)。**不要直接删 `Element.prototype.animate`**:导出内核的 `patchAnimate` 会把它包一层装回去,调用时 `realAnimate` 是 undefined,页面会崩。

## 6. 导出页里的时钟是钉住的,别拿它计时

`performance.now()` 被 `exportClock` 钉到导出毫秒,`Date` 被 `pinEntropy` 钉住。在导出页里,或者在注册了 happy-dom 全局的 Node 进程里,用它们量耗时会得到负数或 0。计时用 `process.hrtime.bigint()`。

## 7. 纯 DOM 环境(happy-dom)跑应用代码的三个坑

- **定时器**:`GlobalRegistrator.register()` 会把全局 `setTimeout` 换成 happy-dom 的,它的返回值没有 `.unref()`,Vite 会崩。做法:先起 Vite,再注册 happy-dom,然后把 Node 原生的定时器装回全局。
- **画布**:卡片注册表会一次性导入所有卡。lottie-web 在**模块加载时**就拿 canvas 的 2D 上下文,happy-dom 给 null,直接崩。做法:给 `getContext` 一个什么都收下的 Proxy 桩。画布卡本来就不在纯算法范围内。
- **CSS 变量解析不了**:动画起点值写成 `var(--pc-accent)` 时,Motion 要靠浏览器把它解析成真实颜色才能插值。happy-dom 解析不了,于是插值停在字符串上。step-timeline 就是这样:Chrome 算出 `rgba(200, 214, 255, 0.498)`,纯算法停在 `var(--pc-accent, #4f8cff)`,片内 41 帧不同。这正是 E1 里「挂载时有提问」的那类卡,必须用 Chrome 录下的答案回放,见 `docs/archive/topics/hybrid-sampling-plan.md` 的方向 B。
- **回放了答案也可能不够。** 给 step-timeline 回放 Chrome 录下的计算样式(命中 25、缺失 0),结果仍然 49/90。Motion 在 happy-dom 里对 `backgroundColor: "transparent"` 报「不可动画」(`value-not-animatable`),走了另一条分支,整段颜色动画没跑;Chrome 里同一段代码没有这个警告。第三方库**按运行环境选分支**,光拦住「问浏览器要数」的接口兜不住这一类。纯算法跑完先看有没有库的警告:`node e2b-pure.mjs <卡> 2>&1 | sort | uniq -c`。

## 8. 实验服务器别碰真实软件

- 任何 dev server 启动时都会把自己的端口写进全局的 `%TEMP%\promptcut\port.json`(`server/vite-plugin-ai.ts`),没有指定端口的 MCP 客户端会照它去连。设了 `PROMPTCUT_NO_PORT_FILE=1` 的不写:测试与探针的公共入口(`scripts/lib/no-user-dirs.mjs`、`npm test` 的全局准备)都设了它,所以只有桌面版和 `npm run dev` 起的会写。
- 手动起 dev server 做验证时也带上 `PROMPTCUT_NO_PORT_FILE=1`;要么把 `TEMP` 指到 scratch 目录再启动,或者用 Vite 的 middlewareMode,不监听端口。
- 用户的真实软件在 5210(`AppData\Local\PromptCut`),实验端口要避开它。

## 9. SVG url(#id) 序列化形式（探针结论）

生成快照(`server/bakery/bake.mjs` 调的 `__pcCreateSnapshot`)要把 id 统一改名,并同步改掉 `url(#…)` / `href="#…"`。
现有正则 `:215` 的字符类是 `[^)"'&]*`,把 `&` 排除在外。疑点:预渲染页地址含 `&`
(`server/frame-pipeline.mjs:183` 的 `'/?export=1&timeline='`),要是 Chrome 把 `fill` 解析成
**带页面 URL 的绝对形式**,`outerHTML` 会把 `&` 写成 `&amp;`,这条正则就一条都匹配不上 ——
共享快照挂到多个片段上时渐变会串台。

探针:`node scripts/probes/svg-url-serialize-probe.mjs`(自起 vite 5208,开一条 `growth-curve` 片段的导出页)。
Chrome 152 headless 实测:

```
page url                 http://127.0.0.1:5208/?export=1&timeline=data%3Aapplication%2Fjson%2C%257B…
gradient ids             ["_r_0_"]
getAttribute("fill")     "url(#_r_0_)"
computed .fill           "url(\"#_r_0_\")"
cssText 里的 fill          "fill:url(\"#_r_0_\")"
生成快照后 outerHTML 里的 fill:
  ;fill:url(&quot;#_r_0_&quot;)
el.style.fill=computed 后的 outerHTML:
  <path d="…" fill="url(#_r_0_)" opacity="0" style="fill: url(&quot;#_r_0_&quot;);"></path>
整棵 control 生成快照后(516806 字节)出现过的形式:
  url(…#…)               ["url(#_r_0_)","url(&quot;#_r_0_&quot;)"]
  href="#…"              []
  id="…"                 [" id=\"_r_0_\""]
  含 &amp;                false
DOMParser 收 id           ["_r_0_"]
正则扫描收 id               ["_r_0_"]
两条路径一致                 true
```

结论:

- **计算样式是相对形式**,Chrome 不把页面 URL 补进 `url()`。整份快照里不含 `&amp;`,`&` 的担心不成立。
- 生成快照后实际只有两种形式:属性上的 `url(#id)`,和计算样式内联出来的 `url(&quot;#id&quot;)`
  (`setAttribute('style', …)` 之后 `outerHTML` 把 `"` 转义成 `&quot;`)。两种现有正则都能命中。
- React 19 的 `useId()` 产出 `_r_0_`,**不再是 `:r1:`**。改名仍按原字符串匹配、不用 `CSS.escape`,
  含冒号的 id 照样能改(消费侧 `src/render/snapshotRename.ts` 有单测钉住)。
- 收 id 的两条路径在这份真快照上给出同一个集合:浏览器里走 `DOMParser`,Node 单测里没有 `DOMParser`,
  落到正则扫描。注意 `DOMParser` 给回来的是**解码后**的 id,要再按属性值序列化规则
  (`&`→`&amp;`、`"`→`&quot;`、U+00A0→`&nbsp;`)转回去,才和「在原字符串上改名」对得齐。

消费侧改名(`src/render/snapshotRename.ts`,A2(7))采用的最终正则,比 `:215` 放开一格:

```
id 属性   /\sid=(["'])([^"']*)\1/
href 引用 /(?:xlink:)?href=(["'])#([^"']*)\1/
url 引用  /url\((&quot;|["'])?([^)"']*?)(&quot;|["'])?\)/   取最后一个 `#` 之后的片段当 id
```

字符类放开成 `[^)"']*` 是防御性的:万一换个 Chrome 版本、换个属性真序列化成绝对形式,这条仍然命中。
命中后**把 `#` 之前的整段前缀丢掉**,重写成 `url(#新id)` —— 快照要挂到别的页面(舞台页,端口和查询串
都和预渲染页不一样)上,不能带着预渲染页的地址。不带 `#` 的 `url()`(`/@media/<hash>` 那类)不碰。

三条并成**一条**交替正则跑一趟,不是分三轮:分轮改的话第二轮会撞上第一轮刚写出来的新 id。
`<style>` 文本里的 `#id` **选择器**不改名(和预渲染侧 `__r` 一样)——`__pcCreateSnapshot` 已经把计算样式
整份内联,样式表规则已被内联值盖掉;全仓两处 `<defs>` 也都写在卡片自己的 `<svg>` 里,不靠样式表选中。
`<style>` 里的 `url(#id)` 则会跟着元素一起改,方向是安全的。

## 10. 快照重放对不上整帧导出:先查这三类

2026-09-23 逐卡逐帧对账(「整帧导出 vs 同一拍生成的快照重放」)撞过的墙,细节和数据见
`docs/archive/restructure_planning/reports/replay-mismatch-report.md` §13。

- **读得到的数只有 6 位有效数字。** `getComputedStyle`、元素自己 `style` 属性的序列化、Typed OM 里没被转成数值的
  (`stroke-dasharray`、`border-radius` 这类列表值)都是 6 位。四位数的位移只剩两位小数,落在像素取整边界上就错一整格。
  排查时拿 Typed OM(`computedStyleMap()`)或 SVG 属性原文换进快照再重放,像素归零就是它。
  JS 直接写进内联样式的全精度数(React 的 `strokeDasharray`、Motion 共享布局改写的 `borderRadius`)在 DOM 里读不回来。
- **合成层判据是 relevant,不只是 current。** 暂停在结尾、靠 `fill` 停在终态的动画,Chrome 照样提层。
  比层用 CDP `LayerTree.compositingReasons`,两边的层数和原因对不上,先看这个。
- **整帧导出的画面也有历史。** 一个合成层只要按非 1 的缩放画过,缩放回到 1 之后文字的栅格结果就和新建的层不同,
  直到这一层重建;这时 DOM 和合成器里的变换都已经是新值。重放一份快照永远是新建的层,这类差别对不上是正常的。
  判断方法:在重放页里先按上一帧的变换画一拍、再原地改成这一帧的值,对上了就是历史。
