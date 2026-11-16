/**
 * The app's own directory under the system temporary directory. It holds the editor's port file,
 * the files handed to CLI runners (MCP configuration, system prompts) and the Agent's session
 * history.
 *
 * On Windows `%TEMP%` already belongs to one user, so the directory is `<tmp>/promptcut`, as it
 * has always been. Elsewhere `/tmp` is shared by every user of the machine, and a fixed name
 * there means that whoever starts the app first owns the directory: the next user gets EACCES on
 * every write, and would have read the first user's port file before that. So off Windows the
 * name carries the user id: `<tmp>/promptcut-<uid>`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the directory is. Creates nothing; the parameters are there for tests. */
export function appTempDir({ tmpdir = os.tmpdir(), platform = process.platform, uid = process.getuid?.() } = {}) {
  const name = platform === 'win32' || uid == null ? 'promptcut' : `promptcut-${uid}`;
  return path.join(tmpdir, name);
}

/**
 * Create the directory if it is missing and return it.
 *
 * Off Windows it is created for this user only, and a directory of that name that belongs to
 * someone else (or is a link) is refused. Anyone can create names in a shared `/tmp`, and what
 * goes in here must not land where another user decides what is there.
 */
export function ensureAppTempDir({ tmpdir = os.tmpdir() } = {}) {
  const dir = appTempDir({ tmpdir });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  if (process.platform !== 'win32' && uid != null) {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== uid) {
      throw new Error(`${dir} exists but is not a directory owned by the current user. Remove it, or point TMPDIR at a directory of your own.`);
    }
  }
  return dir;
}

/** The Agent's session history, one `<sessionId>.json` per chat, read back when a chat continues. */
export function sessionHistoryDir(options = {}) {
  return path.join(appTempDir(options), 'harness-sessions');
}
