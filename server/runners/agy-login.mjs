// Isolated ConPTY host: agy can perform interactive OAuth without displaying a
// console window. `models` does not enter the editor or its workspace Trust UI.
// Keep this native addon out of the long-lived server process.
import pty from 'node-pty';

const selfTest = process.argv[2] === '--self-test';
const exe = selfTest ? process.execPath : process.argv[2];
if (!exe) process.exit(1);
try {
  const terminal = pty.spawn(exe, selfTest ? ['-e', 'console.log("PROMPTCUT_PTY_OK")'] : ['models'], {
    name: 'xterm-256color', cols: 2000, rows: 30,
    cwd: process.cwd(), env: process.env,
  });
  terminal.onData(data => process.stdout.write(data));
  terminal.onExit(({ exitCode }) => {
    // ConPTY's native worker handles can outlive the terminal. This disposable
    // host must exit as soon as agy finishes, rather than keeping the job alive.
    process.stdout.write('', () => process.exit(exitCode));
  });
  process.stdin.on('data', data => terminal.write(data));
} catch (error) {
  process.stderr.write(`后台登录组件启动失败：${error.message}\n`, () => process.exit(1));
}
