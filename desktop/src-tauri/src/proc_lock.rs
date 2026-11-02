//! The exclusive lock on `.proc`, held by the shell.
//!
//! # Why the lock lives here and not in Node
//!
//! Node's fs has no lock primitives at all. Tested: while one process holds `open(file,'r+')`, another process still writes just fine.
//! All it can do is "atomically create a .lock file" (`open(path,'wx')` is atomic; in testing, with 20 processes
//! racing concurrently, only 1 wins). But this kind of lock has an incurable flaw: **if the holder is force-killed, the lock file stays behind**.
//! So the only option is to write the pid into the lock and check liveness when the lock is next read; but pids get recycled by the system, and once a dead process's number is taken by a new process
//! it is misjudged as "someone is still holding it", and the user can never open their own project.
//!
//! Windows file share modes do not have this problem: handles are managed by the kernel, which **reclaims them as soon as the process dies** (tested: after force-killing
//! the holder, another process can open the file immediately). Only the side that can get hold of native handles can do this, so it lives in the shell.
//! And no extra dependency is needed: `std::os::windows::fs::OpenOptionsExt::share_mode` is in the standard library.
//!
//! # What is locked is the .lock, not the .proc itself
//!
//! This rule was forced by testing: after locking the .proc **file itself** with share_mode(0), Node cannot even read it
//! (EBUSY), and writing and deleting fail the same way. And the .proc is precisely the file the Node sidecar has to read and write, so locking it amounts to
//! shutting our own people out. So we lock an **empty side file** `<name>.proc.lock`:
//!   * Nobody needs to write to it, only the single signal of "can it be opened";
//!   * When `open(lock,'r+')` on the Node side gets EBUSY it knows someone holds the lock, and since this signal comes from the kernel,
//!     there is no need to check liveness and no chance of a misjudgment;
//!   * In testing, while it is held other processes cannot even **delete it**, so the lock cannot be stolen.
//!   * The held handle carries DELETE_ON_CLOSE: on a normal exit or when terminated, the kernel deletes its own side file.
//!     The shell forcibly ends the sidecar on exit, so this step cannot rely on Node's exit callback.
//!
//! # No lock in SKILL mode
//!
//! At that time the headless instance is writing project.proc in the task directory, and both the shell and the user's own instance have to read it to update their state.
//! An exclusive lock would block reads too. Safety during that period is guaranteed by "only the agent is writing": the user's instance's
//! AI panel is locked.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Locks held by this process. As long as the handle is alive the lock exists; removing it from here (Drop) releases the lock.
pub struct ProcLocks(Mutex<HashMap<PathBuf, File>>);

impl ProcLocks {
    pub fn new() -> Self {
        ProcLocks(Mutex::new(HashMap::new()))
    }
}

impl Default for ProcLocks {
    fn default() -> Self {
        Self::new()
    }
}

fn lock_path(proc_path: &Path) -> PathBuf {
    let mut s = proc_path.as_os_str().to_os_string();
    s.push(".lock");
    PathBuf::from(s)
}

/// Open the side lock file and take it **exclusively**. Getting Ok means the lock is acquired; keep holding the handle and do not drop it.
#[cfg(windows)]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        // GENERIC_READ | GENERIC_WRITE | DELETE. When the last exclusive handle is closed the kernel deletes
        // the side file, so there is no need to delete it by path after drop (which could collide with the next holder).
        .access_mode(0xc0010000)
        .custom_flags(0x04000000) // FILE_FLAG_DELETE_ON_CLOSE
        // 0 = nobody can open this file again; reading, writing and deleting are all blocked. That is the entire implementation of "exclusive",
        // with no need for LockFileEx or any third-party crate.
        .share_mode(0)
        .open(path)
}

/// There is no share-mode machinery on non-Windows. The desktop shell only ships Windows packages, and this is just to make the code compile;
/// real support for other platforms should go through flock(2), but that is a separate matter and we do not pretend to have done it here.
#[cfg(not(windows))]
fn open_exclusive(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).write(true).create(true).open(path)
}

/// Acquire the lock. If we already hold it, return success directly (opening the same project twice must not fail).
pub fn acquire(locks: &ProcLocks, proc_path: &str) -> Result<(), String> {
    let target = PathBuf::from(proc_path);
    let mut held = locks.0.lock().map_err(|e| e.to_string())?;
    if held.contains_key(&target) {
        return Ok(());
    }
    match open_exclusive(&lock_path(&target)) {
        Ok(f) => {
            held.insert(target, f);
            Ok(())
        }
        // Failing to acquire means someone is holding it. The kernel says so, no need to check liveness again
        Err(e) => Err(crate::ui_text::text("This project file is open in another PromptCut ({0})", &[&e])),
    }
}

/// Release the lock. Dropping the handle makes the kernel release the lock and delete the side file this process holds at the same time.
pub fn release(locks: &ProcLocks, proc_path: &str) {
    if let Ok(mut held) = locks.0.lock() {
        held.remove(&PathBuf::from(proc_path));
    }
}

/// Release all (on quit / when entering SKILL mode).
pub fn release_all(locks: &ProcLocks) {
    if let Ok(mut held) = locks.0.lock() {
        held.clear();
    }
}

/// Only **probe**, never create. `open_exclusive` carries `create(true)`, and using it to probe would, out of nowhere on disk,
/// leave behind a 0-byte `.lock`: the handle is dropped right away but nobody deletes the file. That empty-shell lock makes the Node half
/// get an empty string when reading the lock, fall all the way into the fallback "if the lock cannot be written, do not block opening the project" and silently let it through, and the pid layer of defense
/// is permanently disabled for this project from then on. So probing must use the variant without create.
#[cfg(windows)]
fn probe_exclusive(path: &Path) -> Option<std::io::Result<File>> {
    use std::os::windows::fs::OpenOptionsExt;
    if !path.exists() {
        return None; // There is no lock file at all, so naturally nobody holds it
    }
    Some(OpenOptions::new().read(true).write(true).share_mode(0).open(path))
}

#[cfg(not(windows))]
fn probe_exclusive(path: &Path) -> Option<std::io::Result<File>> {
    if !path.exists() {
        return None;
    }
    Some(OpenOptions::new().read(true).write(true).open(path))
}

/// Whether someone else is holding it right now. For the Node side to query: it cannot see this signal itself.
pub fn is_locked_by_other(locks: &ProcLocks, proc_path: &str) -> bool {
    let target = PathBuf::from(proc_path);
    if let Ok(held) = locks.0.lock() {
        if held.contains_key(&target) {
            return false; // One we hold ourselves does not count as "someone else"
        }
    }
    // Try taking it exclusively: if it opens, nobody holds it, and we drop it right away to release. File does not exist = nobody holds it; do not create it
    match probe_exclusive(&lock_path(&target)) {
        None => false,
        Some(r) => r.is_err(),
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn project_path(label: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("promptcut-lock-{label}-{}-{stamp}.proc", std::process::id()))
    }

    #[test]
    fn r4_release_removes_only_owned_sidecar() {
        let p = project_path("release");
        std::fs::write(&p, b"project must survive").unwrap();
        let locks = ProcLocks::new();
        acquire(&locks, p.to_str().unwrap()).unwrap();
        assert!(lock_path(&p).exists());
        assert!(is_locked_by_other(&ProcLocks::new(), p.to_str().unwrap()));
        assert!(std::fs::read(lock_path(&p)).is_err(), "held file remains exclusive");
        release(&locks, p.to_str().unwrap());
        let remains = lock_path(&p).exists();
        assert_eq!(std::fs::read(&p).unwrap(), b"project must survive");
        std::fs::remove_file(&p).unwrap();
        if remains { std::fs::remove_file(lock_path(&p)).unwrap(); }
        assert!(!remains, "R4: release must remove the sidecar lock");
    }

    #[test]
    fn r4_release_all_removes_both_locks_and_allows_reacquire() {
        let a = project_path("all-a");
        let b = project_path("all-b");
        let locks = ProcLocks::new();
        for p in [&a, &b] { acquire(&locks, p.to_str().unwrap()).unwrap(); }
        release_all(&locks);
        let remains = [lock_path(&a),lock_path(&b)].iter().filter(|p| p.exists()).count();
        for p in [&a,&b] { if lock_path(p).exists() { std::fs::remove_file(lock_path(p)).unwrap(); } }
        assert_eq!(remains,0,"R4: exit must remove every owned sidecar lock");
        acquire(&locks,a.to_str().unwrap()).unwrap();
        release_all(&locks);
        assert!(!lock_path(&a).exists());
    }

    #[test]
    #[ignore]
    fn r4_child_holds_lock() {
        let Ok(p) = std::env::var("PROMPTCUT_LOCK_TEST_CHILD") else { return; };
        let locks=ProcLocks::new();
        acquire(&locks,&p).unwrap();
        println!("LOCK_READY");
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    #[test]
    fn r4_killed_holder_removes_lock_without_node_cleanup() {
        let p=project_path("killed");
        let mut child=Command::new(std::env::current_exe().unwrap())
            .args(["--ignored","r4_child_holds_lock","--nocapture"])
            .env("PROMPTCUT_LOCK_TEST_CHILD",&p)
            .stdout(Stdio::piped()).spawn().unwrap();
        let ready=BufReader::new(child.stdout.take().unwrap()).lines()
            .any(|s| s.unwrap().contains("LOCK_READY"));
        assert!(ready);
        assert!(is_locked_by_other(&ProcLocks::new(),p.to_str().unwrap()));
        child.kill().unwrap();
        child.wait().unwrap();
        let remains=lock_path(&p).exists();
        if remains { std::fs::remove_file(lock_path(&p)).unwrap(); }
        assert!(!remains,"R4: kernel must clean up after holder termination");
    }
}
