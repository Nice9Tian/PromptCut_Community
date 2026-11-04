/**
 * How a media file should be referenced inside a card.
 *
 * The model used to be able to get only two things: a url starting with blob: (private to the
 * editor page, which rendering and export cannot open) and the path on disk (which it has no tool
 * to read). The /@media/<file name> route had always been there (server/vite-plugin-media.ts), but
 * it was never told about it. In one real chat Opus wanted to replace a wrongly chosen web image on
 * a card with a jpg in the media library, and could only Read the disk path and curl-guess
 * /media/…; all of it was refused, and it finally stopped to ask the user for permission.
 *
 * The conversion rule is the same one used by vision's resolveMediaUrls and by project loading
 * (editor/io): go through /@media by the file name of the path.
 */
export function mediaCardUrl(m: { url?: string; path?: string }): string {
  const url = m.url || "";
  if (url.startsWith("/@media/") || /^https?:\/\//.test(url)) return url;
  const base = m.path ? m.path.split(/[/\\]/).pop() : "";
  return base ? `/@media/${encodeURIComponent(base)}` : "";
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|tiff?|svg|heic|heif)$/i;

/**
 * Whether it is an image.
 *
 * Kind alone is not enough: import_media used to register everything indiscriminately as video, and
 * old projects still contain jpgs whose kind is video and whose duration is 5 seconds. Running shot
 * detection on them yields only a 0.04-second "shot" and a montage that is nothing at all.
 */
export function isImageMedia(m: { kind: string; name?: string; path?: string }): boolean {
  return m.kind === "image" || IMAGE_EXT.test(m.name || "") || IMAGE_EXT.test(m.path || "");
}
