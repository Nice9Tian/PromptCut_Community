/**
 * 仅供测试。让 runners/cli-runtime.mjs 的 resolveCli(claude / codex / agy)与本机装了什么无关。
 *
 * resolveCli 的第一个候选是 `<PROMPTCUT_CLI_HOME>/<名>/<名>.exe`(非 win32 无后缀),存在就直接返回;
 * 此后 cliCommand 对 .exe 原样返回、不改参数。本机若装的是 npm 版(.cmd 垫片),cliCommand 会把命令
 * 改成 node + 入口脚本,垫片找不到入口时还会包成 PowerShell 的 -EncodedCommand,
 * 断言 spawn 实参的用例就会因机器而异。这里把 PROMPTCUT_CLI_HOME 指到临时目录并放好空的假可执行文件,
 * 三个 CLI 就都解析到它。cliEnv('codex') 要建的 codex-home 也落在这个临时目录,不写用户目录。
 *
 * 用法(文件顶层、import 被测模块之前):
 *   const fakeCli = useFakeCliHome();
 *   after(() => fakeCli.dispose());
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function useFakeCliHome(names = ['claude', 'codex', 'agy']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptcut-fake-cli-home-'));
  const exes = {};
  for (const name of names) {
    const dir = path.join(home, name);
    fs.mkdirSync(dir, { recursive: true });
    exes[name] = path.join(dir, name + (process.platform === 'win32' ? '.exe' : ''));
    fs.writeFileSync(exes[name], '');
  }
  const had = Object.hasOwn(process.env, 'PROMPTCUT_CLI_HOME');
  const old = process.env.PROMPTCUT_CLI_HOME;
  process.env.PROMPTCUT_CLI_HOME = home;
  return {
    home, exes,
    dispose() {
      if (had) process.env.PROMPTCUT_CLI_HOME = old; else delete process.env.PROMPTCUT_CLI_HOME;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
