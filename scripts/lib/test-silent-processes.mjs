/** Test-only Windows console suppression, including command-line grandchildren.
 * This preload preserves explicit child data directories; callers isolate those before spawning.
 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

if (process.platform === 'win32') {
  const directive = `--import=${import.meta.url}`;
  if (!(process.env.NODE_OPTIONS || '').includes(directive)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, directive].filter(Boolean).join(' ');
  }
  const hidden = options => ({ ...(options || {}), windowsHide: true });
  const call = (target, receiver, args) => {
    while (args.at(-1) === undefined) args.pop();
    return target.apply(receiver, args);
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
    const original = childProcess[name];
    const wrap = target => function (file, args, options, callback) {
      if (Array.isArray(args)) {
        if (typeof options === 'function') return call(target, this, [file, args, hidden(), options]);
        return call(target, this, [file, args, hidden(options), callback]);
      }
      if (typeof args === 'function') return call(target, this, [file, hidden(), args]);
      return call(target, this, [file, hidden(args), options]);
    };
    const wrapped = wrap(original);
    // execFile's custom promise returns { stdout, stderr } and exposes the child.
    if (original[promisify.custom]) Object.defineProperty(wrapped, promisify.custom, { value: wrap(original[promisify.custom]) });
    childProcess[name] = wrapped;
  }
  for (const name of ['exec', 'execSync']) {
    const original = childProcess[name];
    const wrap = target => function (command, options, callback) {
      if (typeof options === 'function') return call(target, this, [command, hidden(), options]);
      return call(target, this, [command, hidden(options), callback]);
    };
    const wrapped = wrap(original);
    if (original[promisify.custom]) Object.defineProperty(wrapped, promisify.custom, { value: wrap(original[promisify.custom]) });
    childProcess[name] = wrapped;
  }
  syncBuiltinESMExports();
}
