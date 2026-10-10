$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $projectRoot 'Realtime.exe'
Start-Process -FilePath $launcher -ArgumentList '--stop' -WindowStyle Hidden -Wait
Write-Host 'Stop requested for Realtime.'
