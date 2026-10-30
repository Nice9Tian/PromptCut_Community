import { registerCards, resetCards, allCards, setUserCardSources, getCard, userCardSources, noteCardsUpdated } from "../kernel/registry";
import { configureCardAudio } from "../audio/cardAudio";
import { cardSourceVersion } from "../render/cardSourceVersion.mjs";
import { builtinCardSourceFiles } from "../render/cardSourceFiles.mjs";
import { cyrb53 } from "../render/cyrb53.mjs";
import { magicuiCards } from "./magicui";
import { nativeCards } from "./native";
import { userCards, userCardFiles, userCardFileOf, userCardDependencies } from "./user";
import { assetCards } from "./assets";
// 部件库(组合卡的零件)和卡片一起装:src/parts/index.ts 自己注册,这里只要确保它被加载
import "../parts";
import { probeCards } from "./_probe";

// 这个模块会被 HMR 重新执行(新建或修改 src/cards/user/ 下的卡就会触发),
// 所以每次都从空开始重装一遍:删掉的卡片文件不会赖在库里,重复注册也不会报错。
resetCards();
// 素材封装卡(Lottie / 粒子目录翻译出来的)和内置卡一起注册:它们是构建时生成的,id 有保留前缀
registerCards([...magicuiCards, ...nativeCards, ...assetCards, ...probeCards]);

// 用户 / AI 建的卡最后注册,并且要先滤掉和内置卡撞车的 id。
// 这些文件是运行时新增的,一张撞车的卡不该让整个编辑器起不来 ——
// 建卡这条路不能有「写错一次就打不开软件」的失败模式。
// create_card 那边也会提前拦一次,这里是兜底。
const taken = new Set(allCards().map((c) => c.id));
const safeUserCards = userCards.filter((c) => {
  if (taken.has(c.id)) {
    console.warn(`[cards/user] 卡片 id "${c.id}" 和已有卡片重复,已跳过。改个 id 再试。`);
    return false;
  }
  taken.add(c.id);
  return true;
});
registerCards(safeUserCards);
// 定制卡源码原文交给注册表,存 .proc 时打包用(为什么不让 procCards 直接 import,见 registry.ts)
setUserCardSources(userCardFiles, userCardFileOf, userCardDependencies);

/**
 * 音频素材效果卡在页面里求值,`src/audio/cardAudio.ts` 要的定义和源码版本从这里注入
 * (模块级,不逐层传参)。每次 HMR 重跑这个模块都会再调一次,`cardAudio` 那边的
 * 版本号跟着 +1 —— 换了卡之后 project 引用不变,靠它让预览重新取块。
 *
 * `userCardSources()` **每次调用时才取**:`setUserCardSources` 排在 registerCards 之后,
 * 注册时快照下来是空表。源码版本的算法照 ExportView.tsx 那份(第二参是 dependencies,
 * 不是 files —— files 的键是剥掉 `./` 和 `.tsx` 的裸文件名,cardSourceVersion 按 /src/… 路径解析)。
 */
configureCardAudio({
  getCard,
  sourceVersionOf: (id: string) => {
    const card = getCard(id);
    if (!card) return `missing:${id}`;
    const user = userCardSources();
    const file = user.fileOf[id];
    const source = file && user.files[file] !== undefined
      ? `user:${cardSourceVersion(card, { ...builtinCardSourceFiles, ...user.dependencies }, `/src/cards/user/${file}.tsx`)}`
      : `builtin:${cardSourceVersion(card, builtinCardSourceFiles)}`;
    // 整段源码闭包正文过一次同步的非密码学哈希(key() 是同步的,src/ 里没有 node:crypto,
    // crypto.subtle.digest 是 Promise)
    return cyrb53(source);
  },
});

/*
 * 热更新的边界(C6.6 集成 3b):卡片文件一改,热更新沿「卡片 → 本模块」冒上来,在这里接住 ——
 * 本模块重跑一遍(上面从空重装整套卡片),不再往上冒到 Editor、Preview、StageView。
 * 以前冒上去之后,它们的 effect 在 Fast Refresh 里重跑:Preview 的握手 effect 清掉了舞台的 RPC 客户端,
 * 而舞台没重载、不会再发 `pc-stage-ready`,于是舞台停在旧画面,预览就此不再更新。
 * 引用本模块的地方都只是 `import "./cards"` 取副作用,不拿绑定,所以接住之后无需通知它们换引用;
 * 要看新卡的一方经注册表的 `onCardsUpdated` 订阅。通知放在这一批热更新全部落地之后
 * (`vite:afterUpdate`),免得订阅方读到半截(卡片源码表 `cardSourceFiles.mjs` 同一批更新)。
 */
if (import.meta.hot) {
  const data = import.meta.hot.data as { loaded?: boolean; changed?: boolean };
  if (data.loaded) data.changed = true;
  data.loaded = true;
  import.meta.hot.accept();
  import.meta.hot.on("vite:afterUpdate", (payload: { updates?: { timestamp?: number }[] }) => {
    if (!data.changed) return;
    data.changed = false;
    const stamp = Math.max(0, ...(payload?.updates ?? []).map((u) => Number(u.timestamp) || 0));
    noteCardsUpdated(stamp || Date.now());
  });
}
