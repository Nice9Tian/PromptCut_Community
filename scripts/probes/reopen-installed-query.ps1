# Read-only queries for the installed-application reopen probe. Nothing here writes the
# registry, starts a program or stops a process.
#   -Mode assoc                 which program Windows runs for a .proc file (effective association)
#   -Mode processes -Exe <exe>  every running process of that executable and its WebView2 debugging ports
#   -Mode watch -Exe <exe>      one JSON line per process of that executable started after this watcher
param(
    [Parameter(Mandatory = $true)][ValidateSet('assoc', 'processes', 'watch')][string] $Mode,
    [string] $Exe,
    [int] $TimeoutSec = 3600
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }
function Utc($date) { if ($date) { $date.ToUniversalTime().ToString('o') } else { $null } }
function Row($p) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue
    [pscustomobject]@{
        pid = [int]$p.ProcessId; exe = $p.ExecutablePath; commandLine = $p.CommandLine; createdAt = (Utc $p.CreationDate)
        parentPid = [int]$p.ParentProcessId; parentName = $parent.Name; parentCreatedAt = (Utc $parent.CreationDate)
    }
}

if ($Mode -eq 'assoc') {
    Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class PromptCutAssociation {
    [DllImport("Shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern uint AssocQueryString(uint flags, uint str, string assoc, string extra, StringBuilder buffer, ref uint length);
    public static string Query(uint str, string extension) {
        uint length = 4096; var buffer = new StringBuilder((int)length);
        return AssocQueryString(0, str, extension, null, buffer, ref length) == 0 ? buffer.ToString() : null;
    }
}
'@
    $choice = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.proc\UserChoice'
    $classes = 'Registry::HKEY_CLASSES_ROOT\.proc'
    Emit ([pscustomobject]@{
        exe = [PromptCutAssociation]::Query(2, '.proc'); command = [PromptCutAssociation]::Query(1, '.proc')
        progId = $(if (Test-Path -LiteralPath $classes) { (Get-Item -LiteralPath $classes).GetValue('') } else { $null })
        userChoice = $(if (Test-Path -LiteralPath $choice) { (Get-ItemProperty -LiteralPath $choice).ProgId } else { $null })
    })
    exit 0
}

if (-not $Exe) { throw '-Exe is required' }
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)
$same = { param($path) $path -and $path.Equals($Exe, [StringComparison]::OrdinalIgnoreCase) }

if ($Mode -eq 'processes') {
    $all = Get-CimInstance Win32_Process
    $apps = @($all | Where-Object { & $same $_.ExecutablePath })
    $ids = @($apps | ForEach-Object { [int]$_.ProcessId })
    # The WebView2 browser process is normally a child of the application; its command line names the host program too.
    $hostFlag = '--webview-exe-name=' + [regex]::Escape([IO.Path]::GetFileName($Exe))
    $views = @($all | Where-Object { $_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -match '--remote-debugging-port=(\d+)' -and ($ids -contains [int]$_.ParentProcessId -or $_.CommandLine -match $hostFlag) } |
        ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; port = [int]([regex]::Match($_.CommandLine, '--remote-debugging-port=(\d+)').Groups[1].Value) } })
    Emit ([pscustomobject]@{ processes = @($apps | ForEach-Object { Row $_ }); webviews = $views })
    exit 0
}

# watch: a second launch only lives until it has handed its file to the running window, sometimes
# well under a tenth of a second. WMI is too slow for that, so each new process id is asked directly
# for its command line, parent and start time while its handle is open.
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class PromptCutProcess {
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, IntPtr buffer, int length, out int returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    public class Info { public int Pid; public int ParentPid; public string Exe; public string CommandLine; public long Created; }
    public static Info Query(int pid) {
        IntPtr handle = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle == IntPtr.Zero) return null;
        try {
            var info = new Info { Pid = pid }; int returned;
            IntPtr basic = Marshal.AllocHGlobal(IntPtr.Size * 6);
            try { if (NtQueryInformationProcess(handle, 0, basic, IntPtr.Size * 6, out returned) == 0) info.ParentPid = (int)Marshal.ReadIntPtr(basic, IntPtr.Size * 5); }
            finally { Marshal.FreeHGlobal(basic); }
            IntPtr line = Marshal.AllocHGlobal(65536);      // ProcessCommandLineInformation: a UNICODE_STRING and its characters
            try { if (NtQueryInformationProcess(handle, 60, line, 65536, out returned) == 0) info.CommandLine = Marshal.PtrToStringUni(Marshal.ReadIntPtr(line, IntPtr.Size), (ushort)Marshal.ReadInt16(line, 0) / 2); }
            finally { Marshal.FreeHGlobal(line); }
            var name = new StringBuilder(32768); int size = name.Capacity;
            if (QueryFullProcessImageName(handle, 0, name, ref size)) info.Exe = name.ToString();
            long created, exited, kernel, user;
            if (GetProcessTimes(handle, out created, out exited, out kernel, out user)) info.Created = created;
            return info;
        } finally { CloseHandle(handle); }
    }
}
'@
function Stamp($fileTime) { if ($fileTime -gt 0) { [DateTime]::FromFileTimeUtc($fileTime).ToString('o') } else { $null } }
function Ids() { $list = [Diagnostics.Process]::GetProcessesByName($name); try { $list | ForEach-Object { $_.Id } } finally { $list | ForEach-Object { $_.Dispose() } } }
$seen = @{}
foreach ($id in Ids) { $seen[$id] = $true }
Emit ([pscustomobject]@{ watching = $true; existing = $seen.Count })
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    foreach ($id in Ids) {
        if ($seen.ContainsKey($id)) { continue }
        $seen[$id] = $true
        $info = [PromptCutProcess]::Query($id)
        if (-not $info -or -not $info.Exe) { Emit ([pscustomobject]@{ pid = [int]$id; exitedBeforeQuery = $true }); continue }
        if (-not (& $same $info.Exe)) { continue }
        $parent = if ($info.ParentPid -gt 0) { [PromptCutProcess]::Query($info.ParentPid) } else { $null }
        Emit ([pscustomobject]@{
            pid = [int]$id; exe = $info.Exe; commandLine = $info.CommandLine; createdAt = (Stamp $info.Created)
            parentPid = [int]$info.ParentPid
            parentName = $(if ($parent -and $parent.Exe) { [IO.Path]::GetFileName($parent.Exe) } else { $null })
            parentCreatedAt = $(if ($parent) { Stamp $parent.Created } else { $null })
        })
    }
    Start-Sleep -Milliseconds 10
}
exit 0
