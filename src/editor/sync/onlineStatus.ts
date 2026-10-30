/**
 * 在线页面顶栏的连接状态措辞(C10 契约第 10 节、第 17 节表 A)与离线常驻提示。纯函数,Node 单测可载入。
 *
 * 五条状态(文案一字不差照表 A):
 *   - 断网:             当前没有网络连接。
 *   - 连不上文档服务:   连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。
 *   - 连不上素材服务:   连不上素材服务，素材原尺寸和预渲染结果暂时显示不了。
 *   - 恢复中:           已恢复连接，正在提交离线时的修改…
 *   - 恢复完成:         离线时的修改已全部提交。
 * 离线且有未提交的改动时另有常驻提示(表 A「常驻提示」),关页面时挂浏览器原生的离开确认。
 *
 * **HT-a 会话接续期间不闪**:传输断了在会话层里接续(`src/editor/sync/link.ts`),DocSync 看不见,状态本来就不变;
 * 另外进入离线类措辞要持续 `OFFLINE_SHOW_DELAY_MS` 才显示(会话刚结束又马上建新会话的那一下也不闪)。
 * 「同步已暂停」(离线批次第一条被拒,C6.5)照旧用原来的小部件,不在这五条里。
 */
import type { SyncStatus } from "../../store/docsync";

export const ONLINE_STATUS_TEXT = {
  noNetwork: "当前没有网络连接。",
  docDown: "连不上服务器，请稍后再试。你的修改先留在本页，恢复后会自动提交。",
  assetDown: "连不上素材服务，素材原尺寸和预渲染结果暂时显示不了。",
  recovering: "已恢复连接，正在提交离线时的修改…",
  recovered: "离线时的修改已全部提交。",
} as const;

export type OnlineStatusKind = keyof typeof ONLINE_STATUS_TEXT;

/**
 * 离线且有未提交的改动时的常驻提示(表 A)。〔裁:2026-10-22 主会话,conflict-merge 报告第六节第 7 条〕按改动到底存没存下来分两句:
 * - 存下来了(账号云端项目:落盘到浏览器本地缓存;桌面版:本机恢复文件);
 * - 没存下来(在线页面里旧办法的口令房间:不落盘,只在本页内存里)。
 * 原文「当前离线，有未提交的修改。关闭页面将丢失这些操作。」作废:对账号项目是一句假警告。
 */
export const OFFLINE_UNSENT_TEXT = {
  saved: "当前离线。你的改动已存在本机，连上网络后会合并回项目。",
  page: "当前离线。你的改动只在这个页面里，关掉页面就会丢失。",
} as const;

/** 离线改动现在存在哪:本机(浏览器本地缓存、本机恢复文件)还是只在这个页面里 */
export type OfflineStore = keyof typeof OFFLINE_UNSENT_TEXT;

export function offlineUnsentText(store: OfflineStore): string {
  return OFFLINE_UNSENT_TEXT[store];
}

/**
 * 在本页里离开编辑界面(顶栏「氛围式」、回首页;手机版的返回与系统后退用 `UNSENT_LEAVE_BODY`,
 * 配自己的确认框「留下 / 离开」,不带那一问)之前问的那一句。判据与浏览器原生离开确认是同一个(`unsentAtRisk`):
 * 关页面会丢的那些情形,在本页里离开编辑界面一样会丢(离开就断开文档服务连接、换回开始页)。
 * 改动已存在本机(`store: "saved"`)的不问:再进这个项目会把它接着提交(`syncManager.ts` 的 `restoreBrowserJournal`)。
 * 「项目还没保存」那一类提示不在这里:在线页面都是云端项目,没有本机草稿这回事(issue #16)。
 */
export const UNSENT_LEAVE_BODY = "当前离线，你的改动只在这个页面里。离开编辑界面会丢失它们。";
/** 顶栏那两条路用浏览器原生的 `confirm`(按钮是「确定 / 取消」),所以末尾要带一问 */
export const UNSENT_LEAVE_TEXT = `${UNSENT_LEAVE_BODY}继续？`;

/**
 * 离线改动这会儿到底存在哪。**存不住就得说存不住**:这台浏览器连 IndexedDB 和 localStorage 都给不了时,
 * `offlineCache.ts` 的 `defaultStore()` 退到内存版,写进去不报错、关页面却没了 —— 那不是「已存在本机」,
 * 是「只在这个页面里」,不然常驻提示、浏览器离开确认和顶栏那一问都会被这份假的「已存」瞒过去。
 */
export function offlineStoreOf(o: { durable: boolean; account: boolean; online: boolean }): OfflineStore {
  if (!o.durable) return "page";
  return o.account || !o.online ? "saved" : "page";
}

/**
 * 气泡:离线时手里有没提交的改动,而这台浏览器存不下它们(存储用不了、或者写失败)。
 * 常驻提示只说「在哪」,这一句说「为什么」,出一次就够,别每拍都弹。
 */
export const UNSENT_NO_STORE_TOAST = "这台浏览器存不下离线时的修改：它们只在这个页面里，关掉页面或离开编辑界面就会丢。";

/** 离线类措辞持续这么久才显示(不闪) */
export const OFFLINE_SHOW_DELAY_MS = 1500;
/** 「离线时的修改已全部提交」显示多久 */
export const RECOVERED_SHOW_MS = 4000;

export interface OnlineStatusInput {
  /** DocSync 的状态 */
  status: SyncStatus;
  /** `navigator.onLine`(浏览器自己认为有没有网) */
  navigatorOnline: boolean;
  /** 素材服务最近一次请求是不是连不上(网络错误,不是 4xx/5xx) */
  assetDown: boolean;
  /** 恢复阶段:从离线回来、还有离线时的修改没提交完 = recovering;刚提交完 = recovered;其余 null */
  recovery: "recovering" | "recovered" | null;
}

/** 这一刻顶栏该显示哪一条(没有要说的回 null)。离线类的延迟由调用方做 */
export function onlineStatusOf(s: OnlineStatusInput): OnlineStatusKind | null {
  if (s.status === "paused") return null; // 「同步已暂停」由原来的小部件管
  if (s.status === "offline") return s.navigatorOnline ? "docDown" : "noNetwork";
  if (s.recovery) return s.recovery;
  if (s.assetDown) return s.navigatorOnline ? "assetDown" : "noNetwork";
  return null;
}

/** 该不该挂常驻提示(「当前离线…」):离线且手里有没提交的修改。暂停时已经连上了,不说「离线」 */
export function offlineUnsent(status: SyncStatus, unconfirmed: number): boolean {
  return status === "offline" && unconfirmed > 0;
}

/**
 * 该不该挂浏览器原生的离开确认:离线或暂停(离线批次等用户决定)时手里有没提交的修改,而且改动只在这个页面里(关页面就丢)。
 * 改动已存在本机(`store: "saved"`)时不拦。
 */
export function unsentAtRisk(status: SyncStatus, unconfirmed: number, store: OfflineStore = "page"): boolean {
  return store === "page" && (status === "offline" || status === "paused") && unconfirmed > 0;
}

/**
 * 恢复阶段的状态机:上一拍的阶段 + 这一拍的状态与未确认条数 → 新阶段。
 * 离线(或暂停后选了重放)期间攒过修改,回到在线时还有没确认的,就是「恢复中」;确认完变「恢复完成」;
 * 「恢复完成」由调用方按 `RECOVERED_SHOW_MS` 撤掉。
 */
export function nextRecovery(prev: { phase: "recovering" | "recovered" | null; wasOffline: boolean; hadUnsent: boolean },
  status: SyncStatus, unconfirmed: number): { phase: "recovering" | "recovered" | null; wasOffline: boolean; hadUnsent: boolean } {
  // 暂停(离线批次第一条被拒,C6.5):交给离线对话框;之后不论重放还是丢弃,都不再说「离线时的修改已全部提交」
  if (status === "paused") return { phase: null, wasOffline: false, hadUnsent: false };
  if (status === "offline") return { phase: null, wasOffline: true, hadUnsent: prev.hadUnsent || unconfirmed > 0 };
  if (prev.wasOffline) {
    // 刚回来:离线期间有攒着的修改才进恢复阶段
    if (!prev.hadUnsent) return { phase: null, wasOffline: false, hadUnsent: false };
    return unconfirmed > 0
      ? { phase: "recovering", wasOffline: false, hadUnsent: true }
      : { phase: "recovered", wasOffline: false, hadUnsent: false };
  }
  if (prev.phase === "recovering" && unconfirmed === 0 && status === "online") return { phase: "recovered", wasOffline: false, hadUnsent: false };
  return { ...prev, wasOffline: false };
}

/** 在线浏览器断网时「导入媒体」置灰后的提示(2026-10-22 用户定,`workflow/project.md`「断网时能做的事」) */
export const IMPORT_OFFLINE_TEXT = "当前离线";

/**
 * 「导入媒体」要不要置灰:只有在线浏览器断网时(浏览器说没网,或连不上文档服务)。桌面版照常导入,连上后再上传;
 * 改项目内容的其它操作断网时都允许,不经这里。
 */
export function importOfflineOf(s: { online: boolean; status: SyncStatus; active: boolean; navigatorOnline: boolean }): boolean {
  if (!s.online) return false;
  if (!s.navigatorOnline) return true;
  return s.active && s.status === "offline";
}
