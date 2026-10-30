// Simulated CLI: only task control files, no credentials or external requests.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const home = process.env.PROMPTCUT_CLI_HOME;
const control = path.join(home, 'simulation.json');
const read = () => JSON.parse(fs.readFileSync(control, 'utf8'));
const cfg = read();
const args = process.argv.slice(2);
const delay = ms => new Promise(r => setTimeout(r, ms));
fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ args, pid: process.pid }) + '\n');
if (args.includes('--version')) console.log('codex-cli simulation');
else if (args[0] === 'login' && args[1] === 'status') {
  await delay(cfg.probeDelay || 0);
  console.log(cfg.loggedIn === false ? 'Not logged in' : 'Logged in');
} else if (args[0] === 'login') {
  console.log('https://auth.openai.com/simulation');
  await delay(cfg.loginDelay || 0);
  if (cfg.loginOutcome === 'hang') await new Promise(() => setInterval(() => {}, 1000));
  if (cfg.loginOutcome === 'fail') process.exit(1);
  fs.writeFileSync(control, JSON.stringify({ ...read(), loggedIn: cfg.loginOutcome !== 'unconfirmed' }));
} else if (args[0] === 'exec') {
  process.stdin.resume();
  if (cfg.descendant) {
    const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    fs.appendFileSync(path.join(home, 'calls.jsonl'), JSON.stringify({ descendant: c.pid }) + '\n');
  }
  await delay(cfg.runDelay || 0);
  if (cfg.denied) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', error: 'permission denied' } }));
  if (cfg.scenario === 'split') {
    process.stderr.write('x'.repeat(3000) + ' token_'); await delay(30);
    process.stderr.write('revoked'); await delay(30); process.stderr.write('\nFailed to refresh token: token_revoked\n');
  } else if (cfg.scenario === 'stderr') process.stderr.write(cfg.error || 'token_revoked');
  else if (cfg.scenario === 'mcp') console.log(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'external', error: { code: 'token_revoked', message: '401 Unauthorized permission' } } }));
  else if (cfg.scenario === 'stdout') console.log(JSON.stringify({ type: 'error', error: { code: 'token_revoked', message: 'Unauthorized' } }));
  else if (cfg.scenario === 'exit') process.exit(3);
  else if (cfg.scenario === 'hold') await new Promise(() => setInterval(() => {}, 1000));
  if (!['split', 'stderr', 'stdout'].includes(cfg.scenario)) console.log(JSON.stringify({ type: 'turn.completed' }));
  await new Promise(() => setInterval(() => {}, 1000)); // prove terminal cleanup, not voluntary exit
} else console.log('simulation');
