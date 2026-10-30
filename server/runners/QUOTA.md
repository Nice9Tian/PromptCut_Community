# CLI 额度熔断（Claude Code / Codex）

订阅制的 CLI 有 5 小时和每周两个用量窗口，用完会直接拒绝请求，而且往往是编排做到一半的时候。
`server/runners/quota.mjs` 在用量**逼近**上限（默认 80%）时就把这一路断掉，抛一条说人话的错误。

## 用量从哪儿来

两家都不碰 TUI，不弹窗、不占前台：

| 驱动 | 命令 | 拿到什么 |
|---|---|---|
| Claude Code | `claude -p "/usage" --output-format text` | `Current session: 18% used · resets …`、`Current week (all models): 51% used …`、`Current week (<模型>): 75% used …` 三行；API Key 模式没有这些行 → 不支持、不拦 |
| Codex | `codex app-server`（JSON-RPC over stdio）：`initialize` → `account/rateLimits/read` | `primary`（5 小时窗口）和 `secondary`（每周窗口）的 `usedPercent`、`resetsAt`（unix 秒）、`planType`。用 PromptCut 自己的 `CODEX_HOME`，没登录就查不到 → 不拦 |

Codex 的 TUI `/status` 在 0.153 里只显示模型和目录，不显示用量，所以没走它。

## 什么时候查、什么时候断

`createQuotaGuard()` 一份实例活在 vite 插件里：

1. **每次对话开始前 `gate()`**：这一路没查过、或上次结果超过 10 分钟就先查一次（Claude 那条约 10 秒），
   任一窗口 `usedPercent >= thresholdPercent` 就抛 `QuotaExceededError`。插件把错误写进 SSE
   （`{ type: "error", message, quota }`）然后结束，CLI 根本不起。
2. **每次对话结束 `note(bytes)`**：把这一轮新增的上下文（发出去的提示词 + 收回来的回复，UTF-8 字节数）
   累计到这一路上，超过 `checkEveryBytes`（默认 256 KB）就后台重查；重查发现超线，
   `failProviderRuns()` 把同一路**正在跑**的对话全部掐掉（先写一条 error 事件再 abort）。
3. 查不到用量（没装、没登录、超时、API Key 模式）一律**不拦**：阈值是保护，不该变成新的故障点。

## 配置

`ai.json` 的 `quota` 段（设置窗口 → Claude Code / Codex → 「额度熔断」）：

```json
{ "quota": { "enabled": true, "thresholdPercent": 80, "checkEveryBytes": 262144 } }
```

- `thresholdPercent` 1～100；`checkEveryBytes` 至少 16384。
- `GET /api/ai/quota?provider=claude|codex[&refresh=1]` 返回最近一次结果、当前配置、是否已超线、这一路累计的字节数。

## 测试

`node --test server/test/quota.test.mjs`：解析（两家的输出）、阈值判定、过期重查、字节记账触发重查、并发去重，全部不碰真 CLI。
