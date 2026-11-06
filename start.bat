@echo off
chcp 65001 >nul
title Nuri Launcher
cd /d "%~dp0"

if exist "%~dp0AI-Native-Browser.exe" (
    start "" "%~dp0AI-Native-Browser.exe"
    exit /b 0
)

call "%~dp0AI-Native-Browser.bat"
exit /b 0
