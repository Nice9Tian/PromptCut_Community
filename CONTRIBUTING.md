# 参与 PromptCut Community

欢迎 issue 和 PR。这份文件说清三件事：**语义优先**、**哪些区域现在收 PR**、**提交前自己跑什么**。

English: [CONTRIBUTING.en.md](CONTRIBUTING.en.md)。

## 先读语义库

`docs/semantics/` 是这个项目的契约，不是参考资料：**语义与代码冲突时以语义为准**。

- 按改动范围该读哪几份，见 [docs/semantics/README.md](docs/semantics/README.md) 的表。不用通读。
- 必须守的硬约束在 [docs/semantics/guide_files/constraints.md](docs/semantics/guide_files/constraints.md)。其中最容易踩的是**分层**：`kernel ← render ← editor / mcp / ai`，下层不引用上层，有守门测试会拦。
- 怎么验证、什么改动必跑哪一项，在 [docs/semantics/guide_files/verification.md](docs/semantics/guide_files/verification.md)。

如果你的改动要求语义本身变一变，**先开 issue 把这件事谈下来**，不要在 PR 里顺手改语义文档。

## 哪些区域现在收 PR

这个仓库是上游：闭源的商业版和 Lite 版都继承这里的代码，合进 `main` 的改动会带过去。下面这些区域都收 PR。

| 区域 | 现在 |
|---|---|
| `src/kernel/`、`src/render/`、`src/store/`、`src/parts/` | 欢迎 PR |
| `src/cards/`、`server/catalog/`（卡片与内置库） | 欢迎 PR，**最容易上手** |
| `src/skins/`、`src/themes/`、`src/ui/` | 欢迎 PR |
| `src/mcp/`、`src/voice/` | 欢迎 PR |
| `server/bakery/`、`server/harness/`、`server/runners/`、`server/vision/`、`server/voice/`、`server/render-queue/` | 欢迎 PR |
| `python/`、`scripts/`、`docs/` | 欢迎 PR |
| `src/editor/`（含 `sync/`、`right/`）、`src/start/`、`src/ai/` | 欢迎 PR |
| `src/online/`、`src/mobile/`、`server/auth/`、`server/lan/`（局域网共享与手机界面） | 欢迎 PR |
| `desktop/` | 欢迎 PR，但只有 Windows x64 验证过 |

## 界面文字

界面有英文、简体中文、日语三种，源语言是英文。

- 界面文字用英文写，经 `src/i18n/index.ts` 的 `tr()` 显示。`{0}`、`{1}` 是要填进去的值。
- 每条新文字的中文和日语写进 `src/i18n/table.json`。
- 界面代码里出现中文或日文，`src/i18n/interface-text.test.mjs` 会拦。中文字面量如果是数据而不是给人看的文字（协议标记、老项目里带的标记、在用户内容里匹配的词），保留它，并在上一行写 `i18n-allow:` 注释说明原因。
- 画进成片画面的文字永远不经 `tr()`：同一个项目不管界面是什么语言，画面都要一模一样。

## 提交前自己跑什么

```bash
npx tsc -b                  # 类型检查，必须零报错
npm test                    # 全量单测，必须零失败（约 3 分钟）
npm test src/你改的/那个.test.mjs   # 也可以只跑一部分
```

改到画面（渲染、卡片、预览、导出）的 PR，请在描述里附上**改前改后的截图或导出帧**。这个项目的渲染有确定性要求，光看代码判断不了。

`scripts/probes/` 下是各功能的探针（端到端小程序，起真的浏览器）。改到对应功能时跑一下相关探针，把输出贴进 PR。

## 提交规范

- **一个 PR 一件事。** 顺手重构请单独开。
- **PR、issue、提交信息一律用英文**，标题、正文、评论都是（2026-11-13 起，之前的历史不改）。
- **提交信息写清“改了什么、为什么”**。标题写成 `<类别>: <做了什么>`，类别见 [docs/semantics/guide_files/git_and_release.md](docs/semantics/guide_files/git_and_release.md)。
- **签署 DCO**：每个提交都要带 `Signed-off-by` 一行，`git commit -s` 会自动加。这表示你确认自己有权把这段代码按 MIT 贡献出来。没有 CLA，不需要签别的东西。
- 代码风格**跟着周围的代码走**：注释密度、命名、惯用写法。这个仓库的注释写得比一般项目密，而且注释是正式文档的一部分——新加的代码请照这个密度写。

## 许可

你的贡献按 [MIT](LICENSE) 授权。这意味着它也会进入继承这份代码的闭源商业版（MIT 允许，署名会保留）。提交 PR 即表示你同意这一点。
