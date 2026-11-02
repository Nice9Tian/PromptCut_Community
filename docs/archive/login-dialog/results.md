# 登录弹窗（issue #2）验证结果

分支 `claude/login-dialog`（叠在 `claude/i18n-rest` @094a0ad 上），2026-11-03。命令都在 worktree 根目录跑。

## 构建与测试

| 项 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc -b --force` | 退出码 0，零错误 |
| 构建 | `npm run build` | 退出码 0（`✓ built`） |
| 受影响的测试（第一轮） | `npm test -- src/start/accountErrors.test.mjs src/i18n/i18n.test.mjs src/i18n/interface-text.test.mjs src/editor/sync/accountExtensions.test.mjs src/editor/saveLock.test.mjs src/editor/sync/lanBoot.test.mjs src/online/onlinePrune.test.mjs server/test/build-extensions.test.mjs server/test/c10a-online-build.test.mjs` | 退出码 0；56 项，53 过，0 失败，3 跳过（BEXT1/6/7：社区版没有 `cloud/`，本来就跳） |
| 受影响的测试（改完最后一版再跑） | `npm test -- src/start/accountErrors.test.mjs src/i18n/i18n.test.mjs src/i18n/interface-text.test.mjs src/editor/sync/accountExtensions.test.mjs src/layering.test.mjs src/online/onlinePrune.test.mjs server/test/c10a-online-build.test.mjs` | 退出码 0；37 项全过 |

## 探针

| 探针 | 命令 | 结果 |
|---|---|---|
| `scripts/probes/login-dialog-probe.mjs`（新） | `node scripts/probes/login-dialog-probe.mjs --out <截图目录>` | 退出码 0；`{"ok":true,"passed":31,"total":31,"fails":[]}`，D1–D18 全过；截图 44 张（6 页 × en/zh-CN/ja × 深/浅，另有 Google 连不上、手机宽度各一张） |
| `scripts/probes/i18n-screens-probe.mjs` | `node scripts/probes/i18n-screens-probe.mjs --out <目录>` | 退出码 0；`{"ok":true,"fails":0}`（它走的是桌面版氛围式和编辑器，共用的 `TopBar` 在三种语言下无截断、无未译文字） |
| `scripts/probes/vibe-desktop-probe.mjs` | 没跑 | 要真的桌面外壳（WebView2 调试口），无头环境跑不了；它只看桌面版的顶栏（`start-top-account` 不出现），桌面版不传 `onSignIn`，这次的改动碰不到 |
| `scripts/probes/guest-readonly-ui-probe.mjs` | 没跑 | 它验编辑器里的只读和手机版，没有登录页的选择器；这次没动编辑器和手机版 |

登录弹窗探针用的是真的 `OnlineStart` + `LoginDialog`，账号业务层和账号客户端是假的（`src/start/login-dialog-harness.tsx`，社区版本来没有账号层）；Google 的脚本用一个普通按钮代替，「连不上 Google」那一项把 accounts.google.com 的请求掐掉。所以真 Google 按钮的样子、真账号服务的往返都没在这里验，要在闭源仓库的探针里验。
