@echo off
rem PromptCut 更新补丁 — 双击运行
rem 直接调 PowerShell 脚本，绕开「未签名脚本禁止运行」的默认策略。
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply-patch.ps1" %*
