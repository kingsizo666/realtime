$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is required.' }

# Draw a small purple clock for the executable and system tray.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 32, 32
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#8066e7'))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 2
$iconStream = $null
$icon = $null
try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.FillEllipse($brush, 1, 1, 30, 30)
    $graphics.DrawEllipse($pen, 7, 7, 18, 18)
    $graphics.DrawLine($pen, 16, 11, 16, 16)
    $graphics.DrawLine($pen, 16, 16, 20, 18)
    $iconHandle = $bitmap.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
    $iconStream = [System.IO.File]::Create((Join-Path $projectRoot 'launcher\realtime.ico'))
    $icon.Save($iconStream)
} finally {
    if ($iconStream) { $iconStream.Dispose() }
    if ($icon) { $icon.Dispose() }
    $pen.Dispose()
    $brush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
& $compiler /nologo /target:winexe /optimize+ /out:Realtime.exe /win32icon:launcher\realtime.ico /reference:System.Windows.Forms.dll /reference:System.Drawing.dll launcher\RealtimeLauncher.cs
if ($LASTEXITCODE -ne 0) { throw 'Could not build Realtime.exe.' }
Write-Host 'Built Realtime.exe. Keep it in this project folder.'
