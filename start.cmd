@echo off
rem Start beside this file, including folders with spaces or non-ASCII names.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 pause
