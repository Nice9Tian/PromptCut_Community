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

## 在 Linux 上开发

这个项目是在 Windows 上写的，CI 原先也只在 Windows 上跑。`npm run build` 和测试在 Linux 上同样能跑；下面列的是 Linux 机器比 Windows 多要准备的东西，在 Ubuntu 26.04、Node 24 上验证过。还没解决的 Linux 问题在 issue 里（搜 "Linux"），现状看 `.github/workflows/test.yml` 里的 `test-linux` 任务。

**ffmpeg** 要在 `PATH` 上（`sudo apt install ffmpeg`）。导出和音频工具要用它，它们的测试也要用。

**Chrome 的沙箱（Ubuntu 23.10 起）。** Ubuntu 只允许有 AppArmor 配置的程序创建非特权用户命名空间，而 Chrome 的沙箱需要它。系统自带了 Google Chrome 的配置，但 `npm ci` 时 puppeteer 下载的那份 Chrome 没有，所以它一启动就报 `No usable sandbox!`。照系统给自家 Chrome 的那份配置，给它也做一份：

```bash
cache="${PUPPETEER_CACHE_DIR:-$HOME/.cache/puppeteer}"
sed -e "s|^profile chrome [^ ]* |profile chrome-puppeteer $cache/{chrome,chrome-headless-shell}/linux-*/chrome{,-headless-shell}-linux64/{chrome,chrome-headless-shell} |" \
    -e 's|<local/chrome>|<local/chrome-puppeteer>|' /etc/apparmor.d/chrome | sudo tee /etc/apparmor.d/chrome-puppeteer
sudo apparmor_parser -r /etc/apparmor.d/chrome-puppeteer
```

配置是按路径生效的。默认缓存目录在你的主目录下，拷到那个路径的任何程序也就都能创建用户命名空间。如果你的机器在意这一点，把浏览器放到只有 root 能写的目录（`PUPPETEER_CACHE_DIR`），配置指向那里。另一个办法是 `PROMPTCUT_CHROME_NO_SANDBOX=1`，它让 Chrome 不带沙箱启动，只在没别的办法时用。

**没有显示器。** AI 助手的网页浏览器（`server/web/browser.mjs`）会开一个真的 Chrome 窗口，所以在没有桌面会话的机器上，要在虚拟显示下启动开发服务器：`xvfb-run -a npm run dev`。跑测试不需要。

**Python。** 语音转文字、素材收集、镜头 / 主体 / 运动识别都跑在 Python 上。Linux 上没有随包的解释器，自己建一个虚拟环境，并告诉开发服务器它在哪：

```bash
python3 -m venv python/.venv
# 让虚拟环境能 import 到 python/ 下的包。语音转文字用 -I 启动 Python，-I 会忽略 PYTHONPATH，
# 所以要靠一个 .pth 文件让这些包可见。
python/.venv/bin/python -c "import pathlib, sysconfig; pathlib.Path(sysconfig.get_paths()['purelib'], 'promptcut-src.pth').write_text(str(pathlib.Path('python').resolve()) + '\n')"
export PROMPTCUT_PYTHON="$PWD/python/.venv/bin/python3"
```

Debian 和 Ubuntu 上 `python3 -m venv` 需要先装 `python3-venv`。这一步不会装重的库。语音转文字和素材收集要的库（whisper、yt-dlp）由它们各自的面板装进 `out/pylibs`。

**开发端口。** `npm run dev` 监听 5190，被占用就拒绝启动。同一台机器上的第二个检出要自己换端口起 vite：`npx vite --port 5191 --strictPort --host 0.0.0.0`。

**AI 命令行工具。** AI 服务面板里的一键安装在 Linux 和 macOS 上也能用，跑的是各家官方的 shell 安装脚本：Claude Code 装到 `~/.local/bin`，Codex 和 Antigravity 装到应用自己的目录 `~/promptcut/cli`。自己装的工具放在 `PATH` 或 `~/.local/bin` 里也能被找到。

## 提交规范

- **一个 PR 一件事。** 顺手重构请单独开。
- **PR、issue、提交信息一律用英文**，标题、正文、评论都是（2026-11-13 起，之前的历史不改）。
- **提交信息写清“改了什么、为什么”**。标题写成 `<类别>: <做了什么>`，类别见 [docs/semantics/guide_files/git_and_release.md](docs/semantics/guide_files/git_and_release.md)。
- **签署 DCO**：每个提交都要带 `Signed-off-by` 一行，`git commit -s` 会自动加。这表示你确认自己有权把这段代码按 MIT 贡献出来。没有 CLA，不需要签别的东西。
- 代码风格**跟着周围的代码走**：注释密度、命名、惯用写法。这个仓库的注释写得比一般项目密，而且注释是正式文档的一部分——新加的代码请照这个密度写。

## 许可

你的贡献按 [MIT](LICENSE) 授权。这意味着它也会进入继承这份代码的闭源商业版（MIT 允许，署名会保留）。提交 PR 即表示你同意这一点。
