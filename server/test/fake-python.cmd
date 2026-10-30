@echo off
REM Fake interpreter: replays fixed JSONL so the STT endpoints and the SSE
REM chain can be validated before the bundled Python is ready.
REM Point PROMPTCUT_PYTHON at this file. The plugin invokes it as
REM   fake-python.cmd -I -m promptcut_stt <subcmd> [...]
REM so %4 is the subcommand; every other argument is ignored.
REM
REM NOTE: this file must stay pure ASCII. cmd.exe parses batch files in the
REM console OEM codepage, so non-ASCII bytes here corrupt the control flow.
REM Chinese sample text is therefore emitted as JSON \uXXXX escapes.

set "SUBCMD=%4"

if "%SUBCMD%"=="status" goto status
if "%SUBCMD%"=="models" goto models
if "%SUBCMD%"=="install" goto install
if "%SUBCMD%"=="transcribe" goto transcribe

echo {"event":"error","message":"fake-python: unknown subcommand"} 1>&2
exit /b 2

:status
REM Set PROMPTCUT_FAKE_INSTALLED=1 to pretend the engines are already installed,
REM which lets the UI reach the "start transcribe" path.
if defined PROMPTCUT_FAKE_INSTALLED goto status_installed
echo {"python":"3.11.9 (fake)","engines":{"faster-whisper":{"installed":false,"version":null},"whisper":{"installed":false,"version":null}},"cuda":false,"models":[]}
exit /b 0

:status_installed
echo {"python":"3.11.9 (fake)","engines":{"faster-whisper":{"installed":true,"version":"1.0.3"},"whisper":{"installed":true,"version":"20231117"}},"cuda":false,"models":["small"]}
exit /b 0

:models
echo {"faster-whisper":["tiny","base","small","medium","large-v3"],"whisper":["tiny","base","small","medium","large"]}
exit /b 0

:install
echo {"event":"log","line":"Collecting faster-whisper"}
echo {"event":"log","line":"  Downloading faster_whisper-1.0.3-py3-none-any.whl (1.8 MB)"}
echo {"event":"log","line":"Installing collected packages: faster-whisper"}
echo {"event":"log","line":"Successfully installed faster-whisper-1.0.3"}
echo {"event":"done"}
exit /b 0

:transcribe
echo {"event":"log","line":"fake-python: extracting audio via ffmpeg"}
echo {"event":"progress","done":0,"total":5}
echo {"event":"segment","start":0.0,"end":1.6,"text":"\u5927\u5bb6\u597d\uff0c\u6b22\u8fce\u6536\u770b\u672c\u671f\u8282\u76ee\u3002"}
echo {"event":"progress","done":2,"total":5}
echo {"event":"segment","start":1.6,"end":3.2,"text":"\u4eca\u5929\u6211\u4eec\u804a\u804a\u89c6\u9891\u526a\u8f91\u3002"}
echo {"event":"progress","done":4,"total":5}
echo {"event":"segment","start":3.2,"end":5.0,"text":"\u8bb0\u5f97\u70b9\u8d5e\u548c\u8ba2\u9605\u3002"}
echo {"event":"progress","done":5,"total":5}
echo {"event":"done","engine":"faster-whisper","model":"small","language":"zh","segments":[{"start":0.0,"end":1.6,"text":"\u5927\u5bb6\u597d\uff0c\u6b22\u8fce\u6536\u770b\u672c\u671f\u8282\u76ee\u3002"},{"start":1.6,"end":3.2,"text":"\u4eca\u5929\u6211\u4eec\u804a\u804a\u89c6\u9891\u526a\u8f91\u3002"},{"start":3.2,"end":5.0,"text":"\u8bb0\u5f97\u70b9\u8d5e\u548c\u8ba2\u9605\u3002"}]}
exit /b 0
