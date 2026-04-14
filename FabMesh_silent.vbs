' Silent launcher for FabMesh — runs the Electron binary with no console.
Dim shell, scriptDir
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
' Clear ELECTRON_RUN_AS_NODE so electron boots as a GUI app, not as a node runtime.
shell.Environment("PROCESS").Item("ELECTRON_RUN_AS_NODE") = ""
' 0 = hidden window, False = don't wait for exit
shell.Run """" & scriptDir & "\node_modules\electron\dist\electron.exe"" """ & scriptDir & """", 0, False
