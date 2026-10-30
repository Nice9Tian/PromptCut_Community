@echo off
REM Fake interpreter for vite-plugin-collect: replays fixed JSONL so the
REM endpoints and the job table can be tested without yt-dlp or the network.
REM Point PROMPTCUT_PYTHON at this file. The plugin invokes it as
REM   fake-collect.cmd -m promptcut_collect <subcmd> [...]
REM so %3 is the subcommand; every other argument is ignored.
REM
REM NOTE: this file must stay pure ASCII (cmd.exe parses batch files in the
REM console OEM codepage). Non-ASCII text goes out as JSON \uXXXX escapes.

set "SUBCMD=%3"

if "%SUBCMD%"=="status" goto status
if "%SUBCMD%"=="install" goto install
if "%SUBCMD%"=="probe" goto probe
if "%SUBCMD%"=="search" goto search
if "%SUBCMD%"=="download" goto download

echo {"event":"error","message":"fake-collect: unknown subcommand %SUBCMD%"}
exit /b 2

:status
echo {"event":"status","version":"0.1.0","ready":true,"ytdlp":{"installed":true,"version":"fake","error":null},"ffmpeg":"C:\\fake\\ffmpeg","pylibs":null,"presets":[{"name":"bilibili","notes":"fake"},{"name":"generic","notes":"fake"}]}
exit /b 0

:install
echo {"event":"log","line":"Collecting yt-dlp"}
echo {"event":"log","line":"Successfully installed yt-dlp-2026.8.19"}
echo {"event":"installed","ready":true,"ytdlp":{"installed":true,"version":"2026.8.19","error":null},"ffmpeg":"C:\\fake\\ffmpeg"}
exit /b 0

:probe
if defined PROMPTCUT_FAKE_FAIL goto probe_fail
echo {"event":"retry","attempt":1,"wait":1.5,"message":"HTTP Error 412: Precondition Failed"}
echo {"event":"done","id":"BV1FAKE00000","title":"Fake Video \u6d4b\u8bd5","duration":12.5,"uploader":"tester","extractor":"BiliBili","site":"bilibili","url":"https://www.bilibili.com/video/BV1FAKE00000","heights":[1080,720],"parts":null,"subtitles":[],"formats":[],"warnings":[]}
exit /b 0

:probe_fail
echo [BiliBili] fake stderr line 1>&2
echo {"event":"error","message":"Unable to download webpage: HTTP Error 404: Not Found"}
exit /b 1

:search
echo {"event":"done","query":"fake","site":"bilibili","results":[{"id":"BV1FAKE00000","title":"Fake Search Hit","url":"https://www.bilibili.com/video/BV1FAKE00000","duration":12.5,"uploader":"tester","view_count":1234,"max_height":1080},{"url":"https://www.bilibili.com/video/BV1FAKE00001","error":"HTTP Error 404: Not Found"}],"warnings":[]}
exit /b 0

:download
if defined PROMPTCUT_FAKE_FAIL goto download_fail
REM Write the reported file into --out-dir (the plugin's per-job temp dir):
REM after the process exits the plugin ingests it through the asset service.
set "OUTDIR="
:scan_args
if "%~1"=="" goto scanned_args
if "%~1"=="--out-dir" set "OUTDIR=%~2"
shift
goto scan_args
:scanned_args
if defined OUTDIR echo fake video bytes>"%OUTDIR%\Fake Video [BV1FAKE00000].mp4"
echo {"event":"start","url":"BV1FAKE00000","out_dir":"C:\\fake\\media","quality":1080,"audio_only":false,"all_parts":false}
echo {"event":"retry","attempt":1,"wait":1.5,"message":"HTTP Error 412: Precondition Failed"}
echo {"event":"info","id":"BV1FAKE00000","title":"Fake Video \u6d4b\u8bd5","duration":12.5,"uploader":"tester","site":"bilibili","url":"https://www.bilibili.com/video/BV1FAKE00000"}
echo {"event":"progress","stage":"video","percent":40.0,"overall":36.0,"downloaded":4000,"total":10000,"speed":1000.0,"eta":6,"format":"30080"}
echo {"event":"progress","stage":"video","percent":100.0,"overall":87.3,"format":"30080"}
echo {"event":"progress","stage":"audio","percent":100.0,"overall":97.0,"format":"30280"}
echo {"event":"progress","stage":"merge","percent":0.0}
echo {"event":"progress","stage":"merge","percent":100.0}
echo {"event":"item","id":"BV1FAKE00000","title":"Fake Video \u6d4b\u8bd5","path":"C:\\fake\\media\\Fake Video [BV1FAKE00000].mp4","filename":"Fake Video [BV1FAKE00000].mp4","bytes":12345,"vcodec":"h264","width":1920,"height":1080,"fps":30.0,"duration":12.5,"transcoded":false,"audio_only":false}
echo {"event":"done","items":[],"site":"bilibili","url":"https://www.bilibili.com/video/BV1FAKE00000","warnings":[]}
REM PROMPTCUT_FAKE_LINGER: stay alive ~2s after "done", like a busy machine
REM where the exit lags behind the last stdout line.
if defined PROMPTCUT_FAKE_LINGER ping -n 3 127.0.0.1 >nul
exit /b 0

:download_fail
echo {"event":"start","url":"BV1FAKE00000","out_dir":"C:\\fake\\media","quality":1080}
echo ERROR: [BiliBili] fake: Video unavailable 1>&2
echo {"event":"error","message":"[BiliBili] fake: Video unavailable"}
exit /b 1
