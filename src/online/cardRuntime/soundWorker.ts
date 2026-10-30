/**
 * 声音线程的入口(`docs/plan/online-card-exec-contract.md` 3.5):后台舞台起的专用后台线程,同步来的用户卡与素材效果卡的
 * `audio()` 只在这里执行。线程的源是舞台源:没有 `parent`、`document`、`localStorage`,看不到编辑页面的任何存储;
 * 从 blob 地址引导时继承舞台文档的内容安全策略,网络出口与舞台相同(起法在 `soundHost.ts` 的 `spawn`,由舞台给)。
 *
 * 逻辑都在 `soundThread.ts`;这里只接消息、给模块表。
 */
import { createSoundThread, type SoundThreadIn } from "./soundThread.ts";
import { soundHostModules } from "./soundModules.ts";
import { CARD_RUNTIME_VERSION } from "./version.ts";
import { markOnlinePage } from "../pageFlag.ts";
import { setOnlineUserCardAudioGate } from "../soundPolicy.ts";
import { denyPersistentStorage } from "../isolation/harden.ts";
import { installScopeGuard } from "../isolation/scopeGuard.ts";

// 卡片的 `audio()` 也在舞台源上:持久存储、同源实时通道(BroadcastChannel、SharedWorker、锁名)、再起后台线程同样收走或隔离
// (与舞台文档同一个规矩,`harden.ts`、`scopeGuard.ts`)。排在任何卡片代码之前(卡片代码等消息来了才载入)。
// 守卫按 `strict` 装:这一侧没有舞台自检(`isolationCheck.ts`)那样的兜底,关键项没装上就抛错,
// 整段线程脚本不执行、卡片 `audio()` 根本载不进来。
denyPersistentStorage(self);
installScopeGuard(self, { strict: true });

type Scope = { postMessage(message: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent) => void) | null };
const scope = self as unknown as Scope;

// 这里就是隔离环境:放开用户卡、素材效果卡的 `audio()`(`soundPolicy.ts` 的接口);照在线页面的规矩不取素材的采样块
markOnlinePage();
setOnlineUserCardAudioGate(() => true);

const thread = createSoundThread({
  runtime: CARD_RUNTIME_VERSION,
  host: soundHostModules,
  post: (message, transfer) => scope.postMessage(message, transfer ?? []),
});
scope.onmessage = (event) => { void thread.handle(event.data as SoundThreadIn); };
scope.postMessage({ t: "ready" });
