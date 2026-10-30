// P2(云端语音转写)可重复跑的真实探针。
//
//   node scripts/probes/cloud-tools-p2-stt-probe.mjs            # 准备素材 → 跑假脚本单测 + 真 Python 集成测试,缺依赖就失败(不跳过)
//   node scripts/probes/cloud-tools-p2-stt-probe.mjs --setup     # 只准备依赖和素材:把主工作区已装好的 pylibs 和 small 权重复制进 out/p2-stt/
//
// 跑之前设好 PROMPTCUT_ACCOUNT_PROVIDER_ROOT、PROMPTCUT_PASSWORD_ORDER_MODULE(运行授权夹具要用,值见仓库 docs/local.md 里的说明)。
// 真实验证的内容:真 Python + faster-whisper small + ffmpeg;真实语音素材(系统合成语音念已知英文、仓库自带的中文人声);
// 完整链路 项目素材库 → 工作区 → 离线子进程 → 文字稿 → 提交;缺权重/缺引擎/无音轨的回应;撤销时子进程真的退出;超时。
// 探针会设 P2_PIP=1,多跑一条真 pip 安装(装一个很小的锁定包到临时目录;要联网)。
// 步骤和证据行(以 [p2] 开头)直接打在输出里。耗时只记录。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { copyDeps, ensureMedia, realDepsMissing, ROOT, PATHS } from '../../server/test/cloud-tools-p2-real-lib.mjs';

const setupOnly = process.argv.includes('--setup');
copyDeps();
const media = ensureMedia();
console.log('[p2] 素材:', Object.fromEntries(Object.entries(media).map(([k, v]) => [k, path.relative(ROOT, v)])));
console.log('[p2] 依赖目录:', path.relative(ROOT, PATHS.out));
if (setupOnly) process.exit(0);
const missing = realDepsMissing();
if (missing) { console.error(`[p2] 依赖不全:${missing}`); process.exit(2); }

const code = await new Promise((resolve) => {
  const child = spawn(process.execPath, [
    '--experimental-test-module-mocks', '--test-global-setup=server/test/global-setup.mjs', '--test', '--test-reporter=spec',
    'cloud/server/test/cloud-tools-p2-stt.test.mjs', 'cloud/server/test/cloud-tools-p2-stt-real.test.mjs',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, P2_VERBOSE: '1', P2_PIP: '1' } });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; process.stdout.write(chunk); });
  child.once('close', (exitCode) => {
    const skipped = Number(/ℹ skipped (\d+)/.exec(text)?.[1] ?? 0);
    if (exitCode === 0 && skipped > 0) { console.error(`[p2] 有 ${skipped} 条被跳过:探针不接受跳过`); resolve(3); } else resolve(exitCode ?? 1);
  });
});
process.exit(code);
