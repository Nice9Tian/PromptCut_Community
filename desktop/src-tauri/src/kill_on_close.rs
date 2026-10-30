//! 把 sidecar 拴在外壳进程上:外壳无论怎么死,内核都把它整棵树一起收走。
//!
//! # 为什么需要这个
//!
//! 外壳原本只在**正常退出**那条路上清理 sidecar(`RunEvent::ExitRequested | Exit` →
//! `kill_sidecar_tree`,一句 `taskkill /F /T /PID`)。非正常退出全都漏:任务管理器结束进程、
//! 崩溃、以及**安装器自己那一下强杀**(Tauri 的 NSIS 模板发现 PromptCut.exe 在跑,
//! 就 `KillProcessCurrentUser` 一刀切,走的是 TerminateProcess,收尾代码根本没机会跑)。
//!
//! 漏掉的后果不是「多一个闲进程」那么轻:sidecar 和它底下的 ffmpeg / Chrome 还活着,
//! 而 Windows 上进程会锁住自己的映像文件,于是安装器写 `runtime\ffmpeg\ffmpeg.exe` 被拒 ——
//! 用户看到的就是「抽取: 无法写入文件 runtime\ffmpeg\ffmpeg.exe」。卸载重装也解不开,
//! 因为卸载器用的是同一套检查,一样不管这些孤儿;只有重启才清得掉。
//!
//! # 做法
//!
//! Windows 的 Job Object 加 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:
//! **job 的最后一个句柄关闭时,内核终止 job 里所有进程**。我们在外壳进程里开一个 job、
//! 把 sidecar 放进去、然后一直攥着那个句柄不放。外壳进程一消失(哪怕是被 TerminateProcess
//! 打死、哪怕是蓝屏后重启),句柄随进程一起被内核回收 → job 关闭 → sidecar 连同它派生的
//! ffmpeg、Chrome 一起被终止。这条路不依赖我们的代码有没有机会执行,所以强杀也漏不掉。
//!
//! 子进程默认继承 job,所以 sidecar 之后 spawn 的 ffmpeg / Chrome 自动在里面,不用逐个登记。
//!
//! 原来那句 `taskkill` 保留:正常退出时它更快、也更明确(不用等句柄回收),
//! job 是**兜底**,不是替代。

#[cfg(windows)]
pub use windows_impl::*;

#[cfg(not(windows))]
pub fn attach_to_kill_on_close_job(_pid: u32) -> Result<(), String> {
    // 非 Windows 上没有 job object 这套东西,而这个应用只发 Windows 包。
    // 留一个空实现,单纯是为了 `cargo check --target` 之类别在这儿断掉。
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

    /// job 句柄要活到进程结束 —— 它一关,里面的进程就被杀了。所以存成进程级的单例,
    /// 谁都别去 close 它:我们要的正是「进程没了句柄才没」这个时机。
    struct JobHandle(HANDLE);
    // HANDLE 不是 Send/Sync,但这个句柄从创建之后就只被读、不被改,
    // 而且生命周期等于整个进程。
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

    /// 建一个 kill-on-close 的 job(全进程只建一次)
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
                // 设不上限制的 job 没有意义:留着反而会给人「已经保护上了」的错觉
                let _ = CloseHandle(handle);
                return None;
            }
            Some(JobHandle(handle))
        })
        .as_ref()
        .map(|j| j.0)
    }

    /// 把某个 pid 放进 kill-on-close 的 job 里。
    ///
    /// 失败不该让应用起不来 —— 少了这层保护只是回到从前(正常退出照样清理干净),
    /// 所以调用方记一条日志继续跑就行。
    pub fn attach_to_kill_on_close_job(pid: u32) -> Result<(), String> {
        let job = job().ok_or("创建 job object 失败")?;
        unsafe {
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|e| format!("打开 sidecar 进程({pid})失败: {e}"))?;
            let r = AssignProcessToJobObject(job, proc);
            // 进程句柄可以马上还回去:job 记的是进程本身,不是我们这个句柄。
            let _ = CloseHandle(proc);
            r.map_err(|e| format!("把 sidecar({pid})放进 job 失败: {e}"))?;
        }
        Ok(())
    }
}
