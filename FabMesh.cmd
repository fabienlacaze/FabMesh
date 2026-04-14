@echo off
rem Launch FabMesh without any visible console window.
rem WScript runs with no window attached, so the Electron GUI is the
rem only thing the user sees. Logs still go to logs/fabmesh.log.
cd /d "%~dp0"
start "" /B wscript.exe "%~dp0FabMesh_silent.vbs"
