# 排障

按症状查。标 ⚠ 的是工具缺陷，修好后删掉这一行。

| 症状 | 原因 | 怎么办 |
|---|---|---|
| 探针失败，页面里只有一个舞台 iframe | 舞台端口（+1、+2）被占，退回同源单舞台 | 换一段三个连号都空的端口重起 |
| 探针结果 `reloaded` 为真，或耗时忽高忽低 | 热更新重载；同时有别的改动在落盘 | 等仓库安静后复跑 |
| 探针跑的还是旧代码 | 长时间热更新后，舞台 iframe 停在旧模块上 | 重启 dev server |
| 改了 `server/harness/` 或 `server/runners/` 不生效 | runner 是动态引入的，Node 缓存着旧模块 | 重启 dev server |
| 导出途中失败，页面等不到就绪 | 测量期间 `server/*.ts` 或 `scripts/export-*.mjs` 被改，dev server 重启了 | 测量期间别改这些文件，别人改也会触发 |
| 无头模式下帧间隔约 100 ms | 无头 Chrome 的 rAF 退到 10 Hz | 带 `--disable-gpu-vsync --disable-frame-rate-limit`，或在有头模式下量 |
| 导出比对第一趟差几十帧 | 字体预热 | 丢掉冷启动那一趟 |
| 舞台里 React `<Profiler>` 恒报 0 | 舞台的 `performance.now` 被虚拟化 | 用 `__pcRealNow` |
| 量 AI 栏流式渲染，测出零长任务 | AI 栏默认不渲染回复原文 | 先设 `localStorage.aiViewMode = 'verbose'` |
| 对账程序报「不同」，看图却一样 | 比对方法的问题 | 查 `compare-pitfalls.md` |
| 预览面板起的服务中途停了 | Claude 桌面版的预览面板会停掉它 | 长时间测试在命令行里自己起 |
| 改 `server/` 后类型检查全过，运行时却报错 | 类型检查只覆盖 `src/` | 靠测试和实际跑一遍来验证 |
| `node --test` 加载模块失败 | 被测文件用无扩展名引用其它 `.ts` | 可测逻辑放进 `.mjs` 纯函数 |
| 真实项目里定制卡整张不渲染、也不报错 | 定制卡只在桌面版运行时副本的 `src/cards/user/` 里 | 复制进仓库的 `src/cards/user/`，记清单，测完删 |
| 排查用户现场，仓库 `out/` 里的东西对不上 | 用户桌面版的现场在运行时副本里 | 去 `%LOCALAPPDATA%\PromptCut\runtime\app\` 看，只读 |
| 连着用一段时间后，浏览器侧的工具集体超时 | 期间装了桌面版补丁，运行时副本被整棵覆盖 | 比对运行时副本里文件的修改时间和出事时间 |
| 对话诊断报告太大，读不了 | 它是一整个 JSON，一两 MB | `py -3 scripts/diaglog.py <报告> overview`，再按文件头的用法往下钻 |
| `node -e` 里拼的 Windows 路径落到乱名目录 | 反斜杠被当成 JS 转义 | 先用 `cygpath -m` 转成正斜杠 |
