$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) {
    python -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python environment.' }
}
& .\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Could not install Python dependencies.' }
Push-Location -LiteralPath frontend
try {
    if (-not (Test-Path -LiteralPath 'node_modules')) {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Could not install frontend dependencies.' }
    }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the frontend.' }
} finally { Pop-Location }
& .\.venv\Scripts\python.exe backend\manage.py migrate
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the database.' }
Write-Host 'Open http://127.0.0.1:8000 — press Ctrl+C to stop.'
& .\.venv\Scripts\python.exe backend\manage.py runserver 127.0.0.1:8000
