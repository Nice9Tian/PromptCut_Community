/**
 * 草稿的独占锁:同一份 .proc 不该被两个 PromptCut 同时编辑。
 *
 * 两层一起用,缺一层都不够:
 *
 * 1. **Node 那半**(`/api/skill-lock`)—— 原子创建 `<name>.proc.lock`(`open(…,'wx')`),
 *    抢到就是自己的。浏览器里跑也有这一层。它的弱点是持有者被强杀之后锁文件会留下,
 *    只能退回读锁里的 pid 判活,而 pid 会被系统回收,有误判的可能。
 *
 * 2. **外壳那半**(Tauri 命令 `acquire_proc_lock`)—— 用 Windows 共享模式 0 把那个
 *    锁文件的句柄独占住。**进程一死内核立刻收走**,没有残留锁这回事。只有拿得到
 *    原生句柄的一侧做得到,所以放在 Rust 里。
 *
 * 顺序是先 Node 后外壳:Node 那步会把锁文件建出来并判定「有没有别人」,外壳那步只是
 * 把已经属于自己的锁加固成内核级。反过来的话,外壳会先把文件创建并锁住,Node 再去
 * `open(…,'r+')` 探测就会拿到自己造成的 EBUSY,把自己判成「别人占着」。
 *
 * 拿不到锁不是崩溃,是一句话:调用方决定要不要拦住「打开」这个动作。
 */

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。在线页面没有草稿(新建、打开、保存都置灰),
 * 也就不抢、不放草稿锁;在线构建里 /api/skill-lock 调用整段剪掉(M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/** Tauri 的 invoke。浏览器里跑就没有,那时只有 Node 那半 */
function invoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const t = (window as unknown as {
    __TAURI__?: { core?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
  }).__TAURI__;
  return t?.core?.invoke ?? null;
}

export interface LockOutcome {
  ok: boolean;
  /** 拿不到时给用户看的一句话 */
  error?: string;
  /** 上一个持有者已经不在了,锁被接管 */
  stolen?: boolean;
  /** SKILL 模式下不加锁 */
  skipped?: string;
}

async function post(action: "acquire" | "release", body: Record<string, unknown>): Promise<LockOutcome> {
  if (ONLINE_BUILD) return { ok: true, skipped: "online" };
  try {
    const res = await fetch(`/api/skill-lock/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as LockOutcome;
    return { ...data, ok: res.ok && data.ok !== false };
  } catch (e) {
    // 服务端没有这个接口(旧版本)不该把打开项目整个挡掉
    return { ok: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 现在锁着哪一份,放锁时要用同一个 key */
let heldDraftId: string | null = null;
let heldPath: string | null = null;

/**
 * 抢一份草稿的锁。拿不到就把原因给回去,由调用方决定拦不拦。
 * 已经锁着别的草稿会先放掉那一份 —— 一个窗口同一时刻只编辑一个项目。
 */
export async function acquireDraftLock(draftId: string): Promise<LockOutcome> {
  if (heldDraftId === draftId) return { ok: true };
  await releaseDraftLock();
  const out = await post("acquire", { draftId });
  if (!out.ok) return out;
  heldDraftId = draftId;
  // 服务端回了真实路径才能让外壳去锁;没回就只有 Node 那一层(浏览器里本来也只有它)
  const file = (out as LockOutcome & { file?: string }).file;
  if (file && !out.skipped) {
    heldPath = file;
    const call = invoke();
    if (call) {
      try {
        await call("acquire_proc_lock", { procPath: file });
      } catch (e) {
        // 外壳这层加固失败不改变结论:Node 那层已经判定锁是我们的了。
        // 记一行,别把用户拦在门外。
        console.warn("[procLock] 外壳加固失败,只剩 Node 那层保护:", e);
      }
    }
  }
  return out;
}

/**
 * 放掉当前持有的锁。换草稿、回首页、新建项目、关页面都要调。
 *
 * 给了 `onlyId` 就只在当前持有的正是这一份时才放:「换草稿时放上一份」的调用点
 * 用它 —— 那一刻手里可能已经是刚抢到的新草稿的锁了(先 openDraft 再记 activeDraftId),
 * 不带 id 一放就把新锁放掉,正在编辑的草稿就没人锁着了。
 */
export async function releaseDraftLock(onlyId?: string): Promise<void> {
  if (onlyId !== undefined && heldDraftId !== onlyId) return;
  const id = heldDraftId;
  const file = heldPath;
  heldDraftId = null;
  heldPath = null;
  if (file) {
    const call = invoke();
    // 先松内核那层,否则 Node 那半连锁文件都删不掉
    if (call) await call("release_proc_lock", { procPath: file }).catch(() => {});
  }
  if (id) await post("release", { draftId: id });
}

/*
 * 关页面 / 刷新时放锁。
 *
 * 不放的话:刷新之后新的页面去抢同一份草稿,Node 那半看到锁文件还在、里面的 pid
 * 又确实活着(是同一个 vite 进程),于是把自己判成「别人占着」—— 用户刷新一下就
 * 打不开自己的项目了。
 *
 * pagehide 比 beforeunload 可靠(手机端和 bfcache 都会触发);用 sendBeacon 而不是
 * fetch,页面正在卸载时普通请求会被浏览器掐掉。外壳那层的句柄不用管:进程还活着的话
 * 下一句 acquire 会先 release,进程没了内核自己就收走了。
 */
if (!ONLINE_BUILD && typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (!heldDraftId) return;
    try {
      navigator.sendBeacon(
        "/api/skill-lock/release",
        new Blob([JSON.stringify({ draftId: heldDraftId })], { type: "application/json" }),
      );
    } catch {
      /* 卸载途中失败没有补救机会,下次抢锁时 pid 兜底那条会认出是自己 */
    }
  });
}

/** 当前锁着的草稿 id,没有就是 null */
export function lockedDraftId(): string | null {
  return heldDraftId;
}
