/**
 * Temporary directory for a probe's output, created only when the command line did not name one.
 *
 * The old form `arg('--out', fs.mkdtempSync(...))` evaluates its default before `arg` looks at the
 * command line, so a run with `--out` still created an empty directory in the system temp dir and
 * never removed it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string | null | undefined} given the value of the option (`--out`, `--data-dir`, ...), if any
 * @param {string} prefix name prefix for the directory created in `os.tmpdir()` when `given` is empty
 * @returns {string} `given` unchanged when it is a non-empty string, else a new directory
 */
export function dirOrTemp(given, prefix) {
  if (typeof given === 'string' && given !== '') return given;
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
