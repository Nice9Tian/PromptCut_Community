/**
 * 后端会话 id 在 localStorage 里的那几个键,以及「换项目时全清掉」。
 *
 * # 为什么单独一个文件
 *
 * 这段逻辑本身不依赖任何别的模块,而它必须能被单测 —— 它管的是一个**看不见的**状态:
 * 界面上对话是空的,后端却可能正接着上一段历史说。这种脱节没有任何界面症状,
 * 只能靠测试守住。
 *
 * # 它管的是什么
 *
 * 会话 id 按驱动存在 `aiSession:<provider>`(多 Agent 分页再带 `:<tabId>` 后缀)。
 * 服务端拿它去 `%TEMP%/promptcut/harness-sessions/<id>.json` 读回整段历史
 * (server/runners/api.mjs),CLI 那三条路则是 `--conversation <id>` / `--resume`。
 *
 * 用户的诊断报告里:全新项目、界面对话是空的、素材库也是空的,而**第一轮请求就发出去
 * 19 条消息**(trace 里 `stage: "request", messages: 19`),模型张口就说出上一个项目里
 * 那条视频的名字 —— 它一次 list_media 都没调,那个名字是从上一段历史里读到的。
 */

/** 会话 id 键的前缀。`aiSession:<provider>` 或 `aiSession:<provider>:<tabId>` */
export const AI_SESSION_PREFIX = "aiSession:";

/**
 * 把所有驱动、所有分页的会话 id 清掉。换项目 / 新建项目时调。
 *
 * 扫前缀而不是按驱动逐个删:分页的键带动态 tabId,这里不可能知道有哪些。
 * 只删这个前缀的 —— `aiProvider`、`aiShowThinking` 这些是长期偏好,不该被换项目牵连。
 */
export function resetAiSessionIds(storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(AI_SESSION_PREFIX)) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch {
    // 读不到 storage(无痕模式、站点数据被禁)也不该把「打开项目」这件事搞挂
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
