# 语义库

`docs/semantics/` 怎么读：语义分三级，按改动范围该读哪几份。改本仓库时必须守的规则在 `guide_files/` 里。

## 文件

| 文件 | 管什么 |
|---|---|
| `guide_files/constraints.md` | 改代码时必须守的硬性约束 |
| `guide_files/verification.md` | 基线由哪几项组成、什么改动必跑哪项、验证环境 |
| `guide_files/git_and_release.md` | 提交、合并、构建、版本号 |

## 语义的三级

`docs/semantics/` 按级别分三层。判断一条内容属于哪一级，看改了它之后用户会不会看到不同：会看到不同的行为或能力，是二级；看不出区别，是三级。

| 级 | 管什么 | 放在 |
|---|---|---|
| 一级：用户体验 | 用户怎么操作 | `user-workflow.md`、`workflow/` |
| 二级：产品功能 | 系统对用户和其它角色承诺什么；改了用户会看到不同的行为或能力。决定架构形状或成本的决定也算二级，例如素材字节不走文档服务、票据由谁签发由谁核对 | `product/` |
| 三级：具体机制 | 怎么做到；改了用户看不出区别。阈值、参数这类数字一律放在这一级 | `mechanism/` |

- `product-purpose.md`、`architecture.md` 是三级之上的总纲，改它们按二级办。
- 同名的 `product/<名>.md` 与 `mechanism/<名>.md` 是一对：机制从属于产品功能，冲突时以产品功能为准。一句话里前半是承诺、后半是机制的，拆成两句分放两本。没有机制内容的，不建 `mechanism/` 那一本。
- `glossary.md` 每条注明级别。

## 按任务读哪些语义

不需要通读 `docs/semantics/`，按改动范围读下表里的文件（路径相对于 `docs/semantics/`）。拿不准改动属于哪一块时，读 `architecture.md` 的角色表判断。

| 改动范围 | 先读 |
|---|---|
| 渲染、舞台、预渲染、导出（`src/render/`、`server/bakery/`、`server/frame-*`） | `product/rendering.md`、`product/cards.md`；改实现再读 `mechanism/rendering.md`、`mechanism/cards.md` |
| 卡片、部件（`src/cards/`、`src/parts/`） | `product/cards.md`；改实现再读 `mechanism/cards.md` |
| 项目数据、时间轴、效果库（`src/kernel/`、`src/store/`） | `product/project-model.md` |
| 编辑界面（`src/editor/`） | `user-workflow.md`、`workflow/editing.md` |
| Agent 与工具（`src/ai/`、`src/mcp/`、`server/tools/`、`server/runners/`、`server/harness/`） | `product/agent.md`、`workflow/production.md`；改实现再读 `mechanism/agent.md` |
| 素材导入、感知类工具（`server/vite-plugin-media.ts` 等、`python/`） | `workflow/materials.md`、`product/asset-service.md`；改实现再读 `mechanism/asset-service.md` |
| 文档服务、素材服务、云端、协作 | `product/document-service.md`、`product/asset-service.md`、`product/hosting.md`；改实现再读同名的 `mechanism/` |
| 桌面壳、平台差异（`desktop/`） | `product/platforms.md`；改实现再读 `mechanism/platforms.md` |
| 产品方向或架构本身 | `product-purpose.md`、`architecture.md` |
| 遇到不认识的术语 | `glossary.md`，只查那一条 |
