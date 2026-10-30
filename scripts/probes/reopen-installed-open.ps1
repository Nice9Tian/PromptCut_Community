# Ask Windows Explorer to open one path the way it opens anything: a program starts, a file goes
# to whatever program its type is registered for. Used by reopen-installed.mjs to start the installed
# application with the user's ordinary environment, and for its shell-open stand-in.
# Writes no registry value and injects no input. Prints the helper process id so the caller can
# recognise a child of this very request.
param([Parameter(Mandatory = $true)][string] $Path)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'path is not an existing file' }
$explorer = Join-Path $env:WINDIR 'explorer.exe'
$started = Start-Process -FilePath $explorer -ArgumentList ('"' + $Path + '"') -PassThru
[Console]::Out.WriteLine((@{ pid = $started.Id; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress))
