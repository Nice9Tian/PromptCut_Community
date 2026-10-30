/**
 * 副作用模块：一被引入就摘掉本进程继承来的 `PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`，
 * 让之后起的子进程（编辑器、预渲染进程、托管组合、导出）和同进程里的 `FramePipeline` 落在仓库 `out/`
 * 或调用方自己显式设的临时目录，不落进桌面版的 `%USERPROFILE%\Videos\PromptCut`。原因与用法见 `user-dirs.mjs`。
 *
 * 必须是入口脚本的**第一个** import：ES 模块按引入顺序求值，排在它前面的模块若在顶层读了这两个变量，
 * 读到的还是外面的值。摘掉了什么打一行到 stderr，方便排查。
 *
 * 另设 `PROMPTCUT_NO_PORT_FILE=1`：之后起的编辑器不写公共的 `%TEMP%\promptcut\port.json`（原因见 `user-dirs.mjs`）。
 */
import { scrubUserDirEnv, markNoPortFile } from './user-dirs.mjs';

markNoPortFile(process.env);

for (const { key, value } of scrubUserDirEnv(process.env)) {
  console.error(`[no-user-dirs] 不继承外部的 ${key}=${value}（测试与探针不写用户目录，见 scripts/lib/user-dirs.mjs）`);
}
