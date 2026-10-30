/**
 * 预渲染小尺寸(`docs/plan/c10a-contract.md` 第 9 节;语义 `product/rendering.md`「重管线:预渲染」的「两档」)。
 *
 * # 尺寸〔契约第 9 节,与素材小尺寸一致〕
 *
 * 等比缩进 800×600 以内,不放大,保持项目画幅:缩放比 `s = min(1, 800 / 项目宽, 600 / 项目高)`,
 * 像素尺寸向下取整(16:9 → 800×450,9:16 → 337×600)。
 *
 * 一张 HTML 快照是一张卡**包裹层里面**的子树(`src/render/createSnapshot.ts`:只记包裹层的 innerHTML,
 * 位置 / 不透明度 / 滤镜由包裹层在挂回时生成),页面把它挂在包裹层里 `inset: 0` 的快照平面上。
 * 所以小位图画的是**包裹层的框**(片段框 w×h,`src/kernel/frameSize.mjs`)里的内容,按同一个 `s` 缩:
 * 没设框的卡框就是整个舞台,正好是上面那两个例子;在线页面把它铺满快照平面,和原尺寸 HTML 快照占同一块地方。
 *
 * # 生成〔契约第 9 节〕
 *
 * - **HTML 快照**:在渲染节点的受控舞台里(预渲染 Chrome 的另一个受帧控制的页面,导出页 `/?export=1`,字体与
 *   原快照的重放环境相同 —— `capture-snapshot.mjs` 同一套做法),把这一帧的快照 HTML 放进一个框大小的盒子、
 *   整体 `scale(s)`,截成 WebP(带 alpha,质量 80)。原 HTML 快照不变。
 * - **PNG**:整幅透明舞台图等比缩一次,同样出 WebP(`renderSmallPng`)。
 *
 * 本模块只管「给一段 HTML / 一张 PNG,出一张小位图」;什么时候生成、存在哪、怎么推由 `frame-pipeline.mjs` 管。
 */
import { captureFrame } from './capture-frame.mjs';

export const SMALL_MAX_WIDTH = 800;
export const SMALL_MAX_HEIGHT = 600;
/** WebP 质量(契约第 9 节〔裁〕) */
export const SMALL_WEBP_QUALITY = 80;
/** 小位图在本机帧库里的文件名后缀:`<localFrame>.small.webp`,和 `<localFrame>.html` 同目录 */
export const SMALL_SUFFIX = '.small.webp';

/** 项目画幅 → 缩放比(不放大) */
export function smallScale(projectWidth, projectHeight) {
  const w = Number(projectWidth), h = Number(projectHeight);
  if (!(w > 0) || !(h > 0)) return 1;
  return Math.min(1, SMALL_MAX_WIDTH / w, SMALL_MAX_HEIGHT / h);
}

/**
 * 一个框按项目的缩放比缩下来的像素尺寸(向下取整,至少 1)。
 * `boxWidth` / `boxHeight` 缺省是整个舞台(没设框的卡)。
 */
export function smallSize({ projectWidth, projectHeight, boxWidth = projectWidth, boxHeight = projectHeight }) {
  const scale = smallScale(projectWidth, projectHeight);
  const px = v => Math.max(1, Math.floor(Number(v) * scale + 1e-9));
  return { scale, width: px(boxWidth), height: px(boxHeight) };
}

/** WebP 文件头(RIFF....WEBP) */
export function isWebp(buf) {
  return !!buf && buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

/** WebP 的像素尺寸(VP8 / VP8L / VP8X 三种头都认);认不出回 null */
export function webpSize(buf) {
  if (!isWebp(buf) || buf.length < 30) return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  return null;
}

/**
 * 一个受帧控制的页面(`chrome.mjs` 的 `openExtraSession` / 预渲染间本身)上画小位图的渲染器。
 * 同一页面上串行用;`session` 要有 `page`、`client`、`beginFrame`(`captureFrame` 要的那几样)。
 */
export function createSmallRenderer(session) {
  let viewport = null;
  const ensureViewport = async (width, height) => {
    if (viewport && viewport.width === width && viewport.height === height) return;
    await session.page.setViewport({ width, height, deviceScaleFactor: 1 });
    await session.client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    viewport = { width, height };
    // 尺寸变了之后头几拍可能没有像素(`capture-frame.mjs` 的说明):先空出一拍
    await session.beginFrame?.({ screenshot: { format: 'jpeg', quality: 0 } }).catch(() => {});
  };
  const shoot = async (mount) => {
    await session.page.evaluate(mount.fn, mount.arg);
    try {
      return await captureFrame(session, { format: 'webp', quality: SMALL_WEBP_QUALITY });
    } finally {
      await session.page.evaluate(() => {
        document.getElementById('pc-small-bitmap')?.remove();
        const root = document.getElementById('root');
        if (root && root.dataset.pcSmallDisplay !== undefined) { root.style.display = root.dataset.pcSmallDisplay; delete root.dataset.pcSmallDisplay; }
      }).catch(() => {});
    }
  };
  return {
    /** 一帧 HTML 快照 → WebP。`boxWidth` / `boxHeight` 是片段框(包裹层)的宽高 */
    async renderHtml({ html, projectWidth, projectHeight, boxWidth = projectWidth, boxHeight = projectHeight }) {
      const size = smallSize({ projectWidth, projectHeight, boxWidth, boxHeight });
      await ensureViewport(size.width, size.height);
      return shoot({
        arg: { html: String(html ?? ''), w: Number(boxWidth), h: Number(boxHeight), s: size.scale },
        fn: ({ html: h, w, h: bh, s }) => {
          const root = document.getElementById('root');
          if (root && root.dataset.pcSmallDisplay === undefined) { root.dataset.pcSmallDisplay = root.style.display; root.style.display = 'none'; }
          const box = document.createElement('div');
          box.id = 'pc-small-bitmap';
          // 包裹层的框:绝对定位、框大小、整体缩到小尺寸。快照平面在页面上也是包裹层里 inset:0 的一层
          box.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${bh}px;transform:scale(${s});transform-origin:0 0;isolation:isolate;overflow:visible`;
          const template = document.createElement('template');
          template.innerHTML = h;
          // 和 capture-snapshot.mjs 同一道清洗:快照是数据,不是能执行的页面
          template.content.querySelectorAll('script,iframe,object,embed,base,meta,link').forEach(el => el.remove());
          for (const element of template.content.querySelectorAll('*')) {
            for (const attr of [...element.attributes]) {
              if (/^on/i.test(attr.name) || /^(?:javascript|vbscript):/i.test(attr.value.trim())) element.removeAttribute(attr.name);
            }
          }
          const plane = document.createElement('div');
          plane.style.cssText = 'position:absolute;inset:0';
          plane.appendChild(template.content);
          box.appendChild(plane);
          document.body.appendChild(box);
        },
      });
    },
    /** 一张整幅舞台 PNG → 等比缩一次的 WebP */
    async renderPng({ png, projectWidth, projectHeight }) {
      const size = smallSize({ projectWidth, projectHeight });
      await ensureViewport(size.width, size.height);
      const src = 'data:image/png;base64,' + Buffer.from(png).toString('base64');
      return shoot({
        arg: { src, w: size.width, h: size.height },
        fn: ({ src: url, w, h }) => {
          const root = document.getElementById('root');
          if (root && root.dataset.pcSmallDisplay === undefined) { root.dataset.pcSmallDisplay = root.style.display; root.style.display = 'none'; }
          const img = document.createElement('img');
          img.id = 'pc-small-bitmap';
          img.src = url;
          img.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px`;
          document.body.appendChild(img);
        },
      });
    },
  };
}
