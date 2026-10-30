import type { MediaAsset } from "../../kernel/project";
import { kindFromExtension, type AssetKind } from "./mediaKinds.ts";
import { publishMediaMigrations, type MediaKindMigration } from "./mediaMigrationBus.ts";
import { confirmedMissing } from "../../audio/missingMaterialRecord.ts";

/**
 * 素材地址在「存盘 → 再打开」之间怎么保持能播。
 *
 * 编辑器里刚导入的素材,url 是 URL.createObjectURL 出来的 blob: —— 只在当前这个页面活着,
 * 存进 .proc 之后再打开就是一个死地址。能跨会话找回文件的只有 path:导入时上传到服务端
 * 素材目录(见 index.ts 的 importVideoFiles / importVideoFromServer),按文件名走
 * /@media/<文件名> 就能取到。
 *
 * 以前只有旧格式导入 importProjectFile 做这步换算;.proc 改走 parseProc 之后这步被绕开,
 * 打开项目后 url 是一个裸文件名,<video> 拿到的是 index.html:预览里视频层是空的,
 * 导出页等不到视频就绪,导出卡在第 0 帧。所以两条路现在都调这里,只有一份规则。
 *
 * 这个文件不引任何运行时模块,单测可以直接加载(见 mediaUrls.test.mjs)。
 */

/**
 * 素材键(内容 sha256)的地址。A1 之后这是素材地址的唯一正解:
 * 换文件名、改 mtime、换一台机器打开,只要内容一样就还是这个地址。
 */
export function mediaUrlFromHash(hash: string | undefined): string | null {
  return hash && /^[0-9a-f]{64}$/i.test(hash) ? `/@media/${hash.toLowerCase()}` : null;
}

/** 服务端素材目录里这个文件的地址。没有 path 返回 null */
export function mediaUrlFromPath(path: string | undefined, opts: { external?: boolean } = {}): string | null {
  const base = path ? path.split(/[/\\]/).pop() : "";
  if (!base) return null;
  // Projects imported from an older installation may point at a real file in
  // the user's Videos/PromptCut/media directory.  Keep the compact /@media
  // form for normal assets, but let the loader ask the server to resolve that
  // durable path when it is outside the current project's out/media folder.
  return opts.external
    ? `/api/media/file?path=${encodeURIComponent(path || "")}`
    : `/@media/${encodeURIComponent(base)}`;
}

/** 不随页面失效的地址:网络地址、data:、同源绝对路径(/@media/...) */
function isDurable(url: string): boolean {
  return /^(https?:|data:)/.test(url) || url.startsWith("/");
}

const MISSING = "(缺失) ";

/**
 * 从文件里读回来的素材表 → 能播的素材表。不改入参。
 *
 * - 有 hash(A1 之后导入的):换成 /@media/<hash>,优先级最高 —— 哈希是身份,文件在内容库里;
 * - 只有 path(迁移期的老 .proc):换成 /@media/<文件名>(和旧格式导入一样);
 * - 没 path 但地址本来就能用:原样;
 * - 其余(死掉的 blob:、裸文件名):清空 url、名字前面标「(缺失)」,并记进 missing ——
 *   空 url 的素材预览和导出都会跳过,不会再拿一个打不开的地址去等。
 */
export function restoreMediaUrls(media: MediaAsset[], opts: { externalPathUrl?: boolean } = {}): { media: MediaAsset[]; missing: MediaAsset[]; moved: MediaKindMigration[] } {
  const missing: MediaAsset[] = [];
  const moved: MediaKindMigration[] = [];
  const out = media.map((m) => {
    const extKind = kindFromExtension(m.name) ?? kindFromExtension(m.path || "") ?? kindFromExtension(m.url || "");
    // A derived audio asset intentionally keeps audio kind even when its source is .mp4.
    const shouldMove = !!extKind && extKind !== m.kind && !(m.kind === "audio" && m.soundOf);
    // 认定过「确认缺失」的素材原样留着:占位核对的是记录与素材的类别、名字、地址逐字相同,这里改了哪一项占位就失效
    // (重新找回、清掉记录是 mediaUpload.ts 后台检查的事)。
    if (confirmedMissing(m) && m.url) {
      return m.pending ? { ...m, pending: undefined } : m;
    }
    const normalized = shouldMove ? { ...m, kind: extKind as AssetKind } : m;
    if (shouldMove) moved.push({ id: m.id, name: m.name, from: m.kind, to: extKind as AssetKind });
    // 有内容哈希就只认 /@media/<hash> —— 文件在内容库里按哈希存,path 只是它当时的落点。
    // pending 是「这一次会话里还没传完」,从文件读回来时一定已经过期,顺手清掉。
    const fromHash = mediaUrlFromHash(normalized.hash);
    if (fromHash) return { ...normalized, url: fromHash, pending: undefined };
    const fromPath = mediaUrlFromPath(normalized.path, { external: opts.externalPathUrl });
    if (fromPath) return { ...normalized, url: fromPath, pending: undefined };
    const url = normalized.url || "";
    if (!url || isDurable(url)) return normalized.pending ? { ...normalized, pending: undefined } : normalized;
    missing.push(normalized);
    return { ...normalized, url: "", pending: undefined, name: normalized.name.startsWith(MISSING) ? normalized.name : `${MISSING}${normalized.name}` };
  });
  publishMediaMigrations(moved);
  return { media: out, missing, moved };
}
