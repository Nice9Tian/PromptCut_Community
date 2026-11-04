//! Tie the sidecar to the shell process: however the shell dies, the kernel takes the sidecar's whole process tree down with it.
//!
//! # Why this is needed
//!
//! The shell originally cleaned up the sidecar only on the **normal exit** path (`RunEvent::ExitRequested | Exit` →
//! `kill_sidecar_tree`, a single `taskkill /F /T /PID`). Every abnormal exit slips through: ending the process in Task Manager,
//! crashes, and **the installer's own forced kill** (when Tauri's NSIS template finds PromptCut.exe running,
//! it simply kills everything with `KillProcessCurrentUser`, which goes through TerminateProcess, so cleanup code never gets a chance to run).
//!
//! The consequence of the leak is not as light as "one extra idle process": the sidecar and the ffmpeg / Chrome beneath it stay alive,
//! and on Windows a process locks its own image file, so the installer's write to `runtime\ffmpeg\ffmpeg.exe` is denied:
//! what the user sees is "Extract: unable to write file runtime\ffmpeg\ffmpeg.exe". Uninstalling and reinstalling does not fix it either,
//! because the uninstaller uses the same checks and likewise ignores these orphans; only a reboot clears them.
//!
//! # Approach
//!
//! A Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:
//! **when the last handle of a job is closed, the kernel terminates all processes in the job**. We create a job in the shell process,
//! put the sidecar into it, and then hold on to that handle for good. As soon as the shell process disappears (even if it is killed by TerminateProcess
//! or the machine reboots after a blue screen), the handle is reclaimed by the kernel together with the process → the job closes → the sidecar, together with the
//! ffmpeg and Chrome it spawned, is terminated. This path does not depend on whether our code gets a chance to run, so even a forced kill cannot slip through.
//!
//! Child processes inherit the job by default, so the ffmpeg / Chrome the sidecar spawns later are automatically in it and do not need to be registered one by one.
//!
//! The original `taskkill` call is kept: on a normal exit it is faster and more explicit (no waiting for the handle to be reclaimed),
//! the job is the **fallback**, not a replacement.

#[cfg(windows)]
pub use windows_impl::*;

#[cfg(not(windows))]
pub fn attach_to_kill_on_close_job(_pid: u32) -> Result<(), String> {
    // There is no job object machinery on non-Windows, and this app only ships Windows packages.
    // An empty implementation is left purely so that things like `cargo check --target` do not break here.
    Ok(())
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::OnceLock;

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// The job handle must live until the process ends: once it is closed, the processes inside are killed. So it is stored as a process-wide singleton,
    /// and nobody should close it: the timing we want is exactly "the handle goes away only when the process does".
    struct JobHandle(HANDLE);
    // HANDLE is not Send/Sync, but this handle is only read and never modified after creation,
    // and its lifetime equals that of the whole process.
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

    /// Create a kill-on-close job (created only once per process)
    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(None, None).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok.is_err() {
                // A job whose limit cannot be set is pointless: keeping it would only give the illusion that "protection is already in place"
                let _ = CloseHandle(handle);
                return None;
            }
            Some(JobHandle(handle))
        })
        .as_ref()
        .map(|j| j.0)
    }

    /// Put a pid into the kill-on-close job.
    ///
    /// Failure must not stop the app from starting: lacking this layer of protection merely goes back to how things were before (a normal exit still cleans up completely),
    /// so the caller can just log a line and keep going.
    pub fn attach_to_kill_on_close_job(pid: u32) -> Result<(), String> {
        let job = job().ok_or("failed to create the job object")?;
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| format!("failed to open the sidecar process ({pid}): {e}"))?;
            let r = AssignProcessToJobObject(job, proc);
            // The process handle can be given back right away: the job tracks the process itself, not this handle of ours.
            let _ = CloseHandle(proc);
            r.map_err(|e| format!("failed to put the sidecar ({pid}) into the job: {e}"))?;
        }
        Ok(())
    }
}
