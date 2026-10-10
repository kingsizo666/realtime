$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The Windows .NET Framework C# compiler is required.' }

# Render separate sizes so Windows does not enlarge the small tray icon.
Add-Type -AssemblyName System.Drawing
$frames = @()
foreach ($size in @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)) {
    $renderSize = $size * 4
    $bitmap = New-Object System.Drawing.Bitmap $renderSize, $renderSize
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#8066e7'))
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 2
    $smallBitmap = New-Object System.Drawing.Bitmap $size, $size
    $smallGraphics = [System.Drawing.Graphics]::FromImage($smallBitmap)
    $pngStream = New-Object System.IO.MemoryStream
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.ScaleTransform(($renderSize / 32.0), ($renderSize / 32.0))
        $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.FillEllipse($brush, 1, 1, 30, 30)
        $graphics.DrawEllipse($pen, 7, 7, 18, 18)
        $graphics.DrawLine($pen, 16, 11, 16, 16)
        $graphics.DrawLine($pen, 16, 16, 20, 18)
        $smallGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $smallGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $smallGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $smallGraphics.Clear([System.Drawing.Color]::Transparent)
        $smallGraphics.DrawImage($bitmap, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
        $smallBitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames += @{ Size = $size; Data = $pngStream.ToArray() }
    } finally {
        $pngStream.Dispose()
        $smallGraphics.Dispose()
        $smallBitmap.Dispose()
        $pen.Dispose()
        $brush.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

# ICO directory followed by transparent PNG frames (256 is encoded as zero).
$iconStream = $null
$writer = $null
try {
    $iconStream = [System.IO.File]::Create((Join-Path $projectRoot 'launcher\realtime.ico'))
    $writer = [System.IO.BinaryWriter]::new($iconStream)
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
        $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.Data.Length)
        $writer.Write([uint32]$offset)
        $offset += $frame.Data.Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Data) }
} finally {
    if ($writer) { $writer.Dispose() }
    if ($iconStream) { $iconStream.Dispose() }
}
& $compiler /nologo /target:winexe /optimize+ /out:Realtime.exe /win32icon:launcher\realtime.ico /reference:System.Windows.Forms.dll /reference:System.Drawing.dll launcher\RealtimeLauncher.cs
if ($LASTEXITCODE -ne 0) { throw 'Could not build Realtime.exe.' }
Write-Host 'Built Realtime.exe. Keep it in this project folder.'
