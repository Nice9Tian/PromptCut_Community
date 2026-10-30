/**
 * 把本页「能运行哪些用户卡与素材效果卡」写进登记处(`src/online/nodeCardInfo.ts`,块 N,
 * `docs/plan/online-card-exec-contract.md` 第 7 节第 1 条):纯浏览器节点的能力位、`cardSourceVersions`
 * 和清单计划的 `input.browser` 都读那里。
 *
 * 输入(任一变了就重算):本页能不能执行**画面**(`cardRuntime/gate.ts` 的 `cardVisualExecAvailable`:节点做的是画面的快照;只靠脚本加固拦 WebRTC 的浏览器上画面不执行,不报能力)、同步来的卡(注册表)、每张卡的运行状态
 * (注册表,`ready` 才算「已载入成功」)、这台设备的图形能力(登记处的 `nodeGraphCapable`)。
 * 代码身份用块 T 的 `codeIdentities()` 现算(与桌面 `cardCodeIdentity` 同一算法,算出同一个值),源码读 `OnlineCardSources` 手里的那份。
 * 转译器那一块按需载入:只在本页能执行、且有 `ready` 的同步卡时才 `import()`;桌面构建里整段剪掉。
 *
 * 由 `browserNodeHost.ts` 起,随宿主一起停;在线页面里宿主在双舞台、身份为电脑时当节点(手机、单舞台只为本页产稀疏版,最低一档都不做)。
 */
import { onCardRunStatesChanged, onSyncedUserCardsChanged, cardRunState, syncedUserCards } from "../kernel/registry";
import { cardVisualExecAvailable, subscribeCardExecGate } from "../online/cardRuntime/gate";
import { CARD_RUNTIME_VERSION } from "../online/cardRuntime/version";
import { computeNodeCardInfo, nodeGraphCapable, setNodeCardInfo, subscribeNodeCardInfo } from "../online/nodeCardInfo";
import { activeCardSourceReader } from "./sync/onlineCardSources";

const EMPTY = { cardRuntime: null, userCards: false, graphCards: false, cardSources: {} } as const;

export function startNodeCardInfoLive(): () => void {
  let seq = 0;
  let stopped = false;
  const refresh = async () => {
    const mine = ++seq;
    if (stopped) return;
    if (import.meta.env.VITE_PC_ONLINE !== "1" || !cardVisualExecAvailable()) { setNodeCardInfo(EMPTY); return; }
    const cards = [...syncedUserCards().values()];
    const ready = cards.filter((c) => !!c.source && cardRunState(c.id)?.state === "ready");
    let identities: Record<string, string> = {};
    const reader = activeCardSourceReader();
    if (reader && ready.length) {
      try {
        const m = await import("../online/cardRuntime/transpile.browser");
        identities = await m.codeIdentities({ entries: [...new Set(ready.map((c) => c.source as string))], read: reader.read });
      } catch { identities = {}; }
      if (stopped || mine !== seq) return;
    }
    setNodeCardInfo(computeNodeCardInfo({
      runtime: CARD_RUNTIME_VERSION, available: true, graphCapable: nodeGraphCapable(),
      cards, stateOf: (id) => cardRunState(id)?.state, identities,
    }));
  };
  const kick = () => { void refresh(); };
  const offs = [onCardRunStatesChanged(kick), onSyncedUserCardsChanged(kick), subscribeCardExecGate(kick)];
  // 图形能力变了也要重算;登记处自己的通知会回到这里,算出来没变就不再通知,不会绕圈
  offs.push(subscribeNodeCardInfo(kick));
  kick();
  return () => {
    stopped = true;
    for (const off of offs) { try { off(); } catch { /* 已经退订 */ } }
    setNodeCardInfo(EMPTY);
  };
}
