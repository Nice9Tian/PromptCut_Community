/**
 * 开始页缩略图那一格上的「真画面」与画幅、时长:这台浏览器打开过这个项目时记下的。
 *
 * 云端项目列表(`/api/account/projects`)只给项目号和名字,不给画幅、时长、首帧;不进项目就拿不到项目内容,
 * 也没有不进项目就能取首帧快照的接口。所以这一版的做法(〔裁 vibe-wire-1〕,三级:用户看不出办法的区别,只看得到有没有图):
 *   - 在 Vibe 模式里打开一个项目时(已经连上文档服务、项目内容在页面上),记下它的画幅、时长;
 *   - 首帧取「0 秒那一刻最上面那段可见的视频 / 图片素材」的那一帧(取法与手机版素材格子同一套,`src/mobile/thumbs.ts`、
 *     `Thumb.tsx`:经素材服务带只读票据的预览地址解码、缩成小 JPEG),取到了记下;
 *   - 没打开过、只有卡片没有素材、取不到(解码失败、跨源画不进画布):这一格退回原来的取色色块,不空白、不破图。
 * 它不是合成后的整帧(卡片叠在素材上的样子要舞台才画得出来,舞台在跨源的 iframe 里,父页读不到像素)。
 * 要「预渲染给的合成首帧」得在服务端加一个按项目取首帧快照的接口,列为待办(报告「没做成的」)。
 *
 * 记在本机(localStorage),只留最近 `MAX` 个项目;读写包 try/catch,取不到就当没记过。
 */
import type { SeenMeta } from "./vibeOrg.ts";
import type { Ratio } from "./types.ts";

const KEY = "pc.start.seen";
/** 最多记几个项目(每个缩略图约十几 KB) */
const MAX = 40;

type Store = Record<string, SeenMeta>;

function read(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Store = {};
    for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const ratio = r.ratio === "16:9" || r.ratio === "9:16" || r.ratio === "1:1" ? (r.ratio as Ratio) : null;
      out[id] = {
        ratio,
        duration: typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : null,
        thumb: typeof r.thumb === "string" && r.thumb.startsWith("data:image/") ? r.thumb : null,
        seenAt: typeof r.seenAt === "string" ? r.seenAt : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let cache: Store | null = null;

export function seenProjects(): Store {
  if (!cache) cache = read();
  return cache;
}

export function subscribeSeen(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** 记下一个项目的画面信息。只改给了的那几项;最旧的超出 MAX 就丢掉 */
export function rememberSeen(projectId: string, patch: Partial<SeenMeta>): void {
  const all = { ...seenProjects() };
  const prev = all[projectId] ?? { ratio: null, duration: null, thumb: null, seenAt: null };
  const next: SeenMeta = { ...prev, ...patch };
  if (prev.ratio === next.ratio && prev.duration === next.duration && prev.thumb === next.thumb && prev.seenAt === next.seenAt) return;
  all[projectId] = next;
  const ids = Object.keys(all).sort((a, b) => (all[b].seenAt ?? "").localeCompare(all[a].seenAt ?? ""));
  for (const id of ids.slice(MAX)) delete all[id];
  cache = all;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存满了:把缩略图去掉再试一次,画幅和时长至少留着
    try {
      const slim: Store = {};
      for (const [id, m] of Object.entries(all)) slim[id] = { ...m, thumb: id === projectId ? m.thumb : null };
      localStorage.setItem(KEY, JSON.stringify(slim));
      cache = slim;
    } catch { /* 存不了就只在这次打开期间有效 */ }
  }
  for (const l of [...listeners]) l();
}
