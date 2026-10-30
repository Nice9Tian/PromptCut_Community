/**
 * 素材在卡片里该怎么引用。
 *
 * 模型以前只拿得到两样:blob: 开头的 url(编辑器页面私有,渲染和导出打不开)和磁盘 path
 * (它没有工具能读)。/@media/<文件名> 这条路由一直在(server/vite-plugin-media.ts),却从来
 * 没告诉过它 —— 一次真实对话里 Opus 想把卡片上配错的网图换成素材库里的 jpg,只好去
 * Read 磁盘路径、curl 猜 /media/…,全被拒,最后停下来找用户要权限。
 *
 * 换算规则和 vision 的 resolveMediaUrls、项目载入时(editor/io)的是同一套:按 path 的文件名走 /@media。
 */
export function mediaCardUrl(m: { url?: string; path?: string }): string {
  const url = m.url || "";
  if (url.startsWith("/@media/") || /^https?:\/\//.test(url)) return url;
  const base = m.path ? m.path.split(/[/\\]/).pop() : "";
  return base ? `/@media/${encodeURIComponent(base)}` : "";
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|tiff?|svg|heic|heif)$/i;

/**
 * 是不是一张图片。
 *
 * 不能只看 kind:import_media 以前不分青红皂白都登记成 video,老项目里还躺着 kind 为 video、
 * 时长 5 秒的 jpg —— 对它们跑镜头识别只会得到一个 0.04 秒的「镜头」和一张什么都不是的拼图。
 */
export function isImageMedia(m: { kind: string; name?: string; path?: string }): boolean {
  return m.kind === "image" || IMAGE_EXT.test(m.name || "") || IMAGE_EXT.test(m.path || "");
}
