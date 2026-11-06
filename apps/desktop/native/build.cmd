@echo off
rem Builds anb-desktop.exe (desktop "computer use" helper) with the .NET Framework compiler.
rem A running helper locks the exe, but Windows allows renaming it: move it aside first.
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
set WPF=%FW%\WPF
del /q "%~dp0anb-desktop.old*.exe" 2>nul
if exist "%~dp0anb-desktop.exe" ren "%~dp0anb-desktop.exe" "anb-desktop.old%RANDOM%.exe"
"%FW%\csc.exe" /nologo /target:exe /platform:x64 /optimize+ /out:"%~dp0anb-desktop.exe" ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll ^
  /r:"%WPF%\UIAutomationClient.dll" /r:"%WPF%\UIAutomationTypes.dll" /r:"%WPF%\WindowsBase.dll" ^
  "%~dp0DesktopHelper.cs"
