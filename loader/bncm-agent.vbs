' bncm-agent.vbs -- start the BetterNCM agent with no console window.
'
' Invoked by loader/startup.ps1 (logon watchdog / -Start), by loader/create-shortcut.ps1 and by the
' release launchers:
'
'   wscript.exe "loader\bncm-agent.vbs"                 -- logon watchdog (--at-logon)
'   wscript.exe "loader\bncm-agent.vbs" --launch --ncm X:\CloudMusic --data D:\bncmdata
'
' A .vbs shim exists because .ps1 files are blocked by the machine execution policy and a .cmd
' would flash a console window on every logon.  Every argument after the script path is forwarded
' to the agent verbatim, so a launcher can pin --ncm/--data/--plugins without this file knowing
' anything about them.
'
' The Node interpreter is resolved in this order:
'   1. %BNCM_NODE%
'   2. <package root>\bin\node.exe   (the runtime bundled with a release package)
'   3. the DSH development runtime   (this checkout's machine)
'   4. "node.exe" from PATH
Option Explicit

Dim shell, fso, here, root, node, mode, cmd, args, i, bundled, dev

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)          ' ...\loader\.. -> package root

node = shell.ExpandEnvironmentStrings("%BNCM_NODE%")
If node = "%BNCM_NODE%" Or Len(node) = 0 Then node = ""
If Len(node) > 0 And Not fso.FileExists(node) Then node = ""

If Len(node) = 0 Then
    bundled = root & "\bin\node.exe"
    If fso.FileExists(bundled) Then node = bundled
End If
If Len(node) = 0 Then
    dev = shell.ExpandEnvironmentStrings("%USERPROFILE%") & _
          "\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
    If fso.FileExists(dev) Then node = dev
End If
If Len(node) = 0 Then node = "node.exe"

args = ""
If WScript.Arguments.Count = 0 Then
    args = " --at-logon"
Else
    For i = 0 To WScript.Arguments.Count - 1
        args = args & " " & Quote(WScript.Arguments(i))
    Next
End If

cmd = """" & node & """ """ & root & "\tools\bncm_agent.mjs""" & args
' 0 = hidden window, False = do not wait
shell.Run cmd, 0, False

Function Quote(s)
    Quote = """" & s & """"
End Function
