# Realtime

A personal time tracker built with Django, React, and MobX.

## Requirements

- Windows 11 with .NET Framework 4.8 or newer (normally included).
- Python 3.12+ and Node.js 22.12+, both available on PATH.
- Internet access for initial setup. DuckDuckGo is optional.

## First-time setup

Download or clone the project and open PowerShell in its root folder. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

This installs dependencies, builds the frontend, creates your database, and starts the app at http://127.0.0.1:8000.

Press **Ctrl+C** to stop it, then build the executable (excluded from Git):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-launcher.ps1
```

## Run and stop

Double-click **Realtime.exe**. It opens DuckDuckGo when available, otherwise your default browser.

Click **Stop app** to shut down. If the browser is closed, run:

```powershell
.\Realtime.exe --stop
```

Keep the executable in the project root. Entries are saved in `backend/db.sqlite3`; personal data and generated files are excluded from Git.
