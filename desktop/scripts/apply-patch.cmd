@echo off
rem PromptCut update patch: double-click to run
rem Call the PowerShell script directly to get around the default policy "unsigned scripts are not allowed to run".
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-patch.ps1" %*
