/**
 * 页面的启动序列（C10a 契约第 2、4 节）。`main.tsx` 第二个就引它（紧跟渲染时钟）：
 * ES 模块按引入顺序求值，这样守卫在别的模块的顶层代码跑之前就装好（有的模块一载入就去取 `/api/*`）。
 *
 * ── 为什么这些事不留在 `boot.ts` 里（2026-10-28 补回来的） ──
 *
 * 基线的 `src/online/boot.ts` 既是启动钩子又什么都干。活 E 把它改写成「接缝注册表」时，
 * 这整段启动序列**被删掉而且没有任何接替者** —— 两位审查者各自独立查出来的头号问题。
 * 后果是实打实的：邀请链接不再被捕获（而基线那一句**不带 `ONLINE` 判据**，所以**桌面版和局域网版
 * 一起坏**，正是保留局域网层的全部意义）、跨源舞台的加固与自检不装、在线页面标记永不置位
 * （三十多个模块读它）、双舞台运行配置不取（在线预览区的舞台 iframe 永远渲染不出来）。
 * 而 `main.tsx` 那一行 `import "./online/boot"` 一个字没动，旁边的注释还写着「必须在别的模块求值之前」。
 *
 * 根因不是手滑：`src/online/online-seam.test.mjs` 静态 import `boot.ts`，而守门测试 C10A-MODE-01
 * 不许被单测载入的模块静态引 `mode.ts` —— 为了让新测试过，`boot.ts` 里的 `import { ONLINE }`
 * 被摘掉了，启动序列是被一起带走的。所以修法是**拆文件**，不是把 `ONLINE` 加回 `boot.ts`：
 * 这个文件引 `mode.ts`（没有任何 Node 单测引它），`boot.ts` 保持无 mode 依赖的纯注册表。
 *
 * ── 为什么云端表在这里是**静态** import ──
 *
 * 守卫、代码版本这些的真实现都在闭源侧，要先注册进 `boot.ts` 的注册表才能用。静态 import 让
 * 云端表在本文件的函数体之前求值完（ES 模块深度优先），于是：守卫仍然装在别的模块之前
 * （契约要求），`CODE_VERSION` 这个 live binding 在 `Shell.tsx` 顶层读它之前就已经有值
 * （不然 iPad 身份预判永远按 `"dev"` 算）。社区版里这个别名解析到空桩，什么都不注册，
 * 下面每一项各自安全降级。
 */
import { ONLINE } from "./mode";
// 云端表自己在模块顶层调 `registerOnlineExtensions`；社区版是空桩，什么都不导出、什么都不注册
import "#promptcut-cloud-online";
import { bootApiGuard, CODE_VERSION } from "./boot";
// 云端 AI 提供方：必须在 React 渲染之前登记好。中途替换会让同一个组件的 hook 数量变化，
// React 当场抛（2026-10-28 的局域网探针就是这么崩的，细节见 extensionsBrowser.ts 的文件头）
import { registerAiCloudProviderFromTable } from "../ai/extensionsBrowser";
import { captureInviteFromLocation } from "./invite";
import { markOnlinePage } from "./pageFlag";
import { loadStageConfig } from "./stageOrigins";
import { bootStageGuard } from "./isolation/stageGuard";
import { bootStageGate, forcedTierOf } from "./stageGate";
import { ensureDecodeLimit } from "./mediaGate";

// 跨源舞台(在线构建的 `stage.html`):加固与自检排在别的模块求值之前、任何卡片代码之前
// (契约 `online-card-exec-contract.md` 第 3 节)。桌面运行环境、编辑器页、同源单舞台不做事
bootStageGuard({ online: ONLINE, base: import.meta.env.BASE_URL });
// 运行期标记先设:会被 Node 单测载入、不能静态引 mode.ts 的模块读它停掉 /api 调用(pageFlag.ts)
if (ONLINE) markOnlinePage();
// `online` 判据不能省:桌面构建里装上这个守卫,桌面编辑器自己的 /api/* 会被拒
bootApiGuard(ONLINE, { base: import.meta.env.BASE_URL });
registerAiCloudProviderFromTable();
// 这一句**不带 ONLINE**:桌面版与局域网版的手机扫码加入也靠它读 `#invite=` 并把口令从地址栏抹掉
captureInviteFromLocation();
const editorPage = ONLINE && typeof location !== "undefined" && !new URLSearchParams(location.search).has("stage");
if (editorPage) void loadStageConfig({ base: import.meta.env.BASE_URL });
// 舞台闸门(`stageGate.ts`):读崩溃记录、定这次试到哪一级,结果交给 `onlineTier.ts`;`?tier=` 只给开发和验收用
// 素材闸门的解码上限打开时测一次(这次使用期间不变),载入原尺寸撑崩过的往下调几级(崩溃记录里记着)
if (editorPage) {
  void bootStageGate({ version: CODE_VERSION ?? "dev", env: { forced: forcedTierOf(location.search) } })
    .then((g) => ensureDecodeLimit({ lowered: g.mediaLowered() }));
}
