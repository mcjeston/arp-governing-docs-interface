Option Explicit

Dim shell, fso, root, nodeDir, javaDir, installCmd, serverCmd, browserUrl, exitCode, nodeModulesDir, pidFile, taskKillCmd, pid

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
nodeDir = root & "\.tools\node-v24.14.0-win-x64"
javaDir = root & "\.tools\jdk-17.0.18+8\bin"
browserUrl = "http://127.0.0.1:4182"
nodeModulesDir = root & "\node_modules"
pidFile = root & "\.preview-server.json"

If Not fso.FileExists(nodeDir & "\node.exe") Then
  MsgBox "Portable Node.js was not found in:" & vbCrLf & nodeDir, vbCritical, "Governing Documents Interface"
  WScript.Quit 1
End If

If Not fso.FileExists(javaDir & "\java.exe") Then
  MsgBox "Portable Java was not found in:" & vbCrLf & javaDir, vbCritical, "Governing Documents Interface"
  WScript.Quit 1
End If

If Not fso.FolderExists(nodeModulesDir) Then
  installCmd = "cmd.exe /c cd /d """ & root & """ && set ""PATH=" & nodeDir & ";" & javaDir & ";%PATH%"" && call """ & nodeDir & "\npm.cmd"" install"
  exitCode = shell.Run(installCmd, 0, True)
  If exitCode <> 0 Then
    MsgBox "Dependency install failed. The preview app was not opened.", vbCritical, "Governing Documents Interface"
    WScript.Quit exitCode
  End If
End If

pid = ReadPidFromFile(pidFile)
If pid <> "" Then
  taskKillCmd = "cmd.exe /c taskkill /PID " & pid & " /T /F >nul 2>nul"
  shell.Run taskKillCmd, 0, True
  On Error Resume Next
  If fso.FileExists(pidFile) Then
    fso.DeleteFile pidFile, True
  End If
  On Error GoTo 0
End If

serverCmd = "cmd.exe /c cd /d """ & root & """ && set ""PATH=" & nodeDir & ";" & javaDir & ";%PATH%"" && """ & nodeDir & "\node.exe"" """ & root & "\server\app-server.mjs"""
shell.Run serverCmd, 0, False

WScript.Sleep 900
shell.Run browserUrl, 1, False

Function ReadPidFromFile(filePath)
  Dim file, contents, matches

  ReadPidFromFile = ""
  If Not fso.FileExists(filePath) Then
    Exit Function
  End If

  On Error Resume Next
  Set file = fso.OpenTextFile(filePath, 1, False)
  contents = file.ReadAll
  file.Close
  On Error GoTo 0

  Set matches = CreateObject("VBScript.RegExp")
  matches.Pattern = """pid""\s*:\s*(\d+)"
  matches.Global = False

  If matches.Test(contents) Then
    ReadPidFromFile = matches.Execute(contents)(0).SubMatches(0)
  End If
End Function
