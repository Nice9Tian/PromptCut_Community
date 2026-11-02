/**
 * For testing only. Decouples resolveCli(claude / codex / agy) in runners/cli-runtime.mjs from what
 * is installed on the local machine.
 *
 * The first candidate of resolveCli is `<PROMPTCUT_CLI_HOME>/<name>/<name>.exe` (no extension on
 * non-win32); returns directly if it exists. Thereafter, cliCommand returns .exe as is without
 * modifying arguments. If the npm version (.cmd shim) is installed locally, cliCommand rewrites the
 * command to node + entry script; when the shim cannot find the entry point, it even wraps it into
 * PowerShell's -EncodedCommand, causing test cases that assert spawn arguments to vary across
 * machines. Here, PROMPTCUT_CLI_HOME points to a temp directory with empty fake executables placed
 * inside, so all three CLIs resolve to it. The codex-home created by cliEnv('codex') also lands in
 * this temp directory, without writing to the user directory.
 *
 * Usage (file top level, before importing the module under test):
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
