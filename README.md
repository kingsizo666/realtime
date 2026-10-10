# Realtime

A personal time tracker built with Django, React, and MobX.

## Check and install requirements

Open PowerShell and check the following. A missing command or an older version means you need to install or update that requirement.

| Requirement | How to check | If missing or outdated |
| --- | --- | --- |
| Windows 11 | Run `winver`; the window should show Windows 11. | Follow Microsoft's [Windows 11 installation instructions](https://www.microsoft.com/en-us/software-download/windows11). |
| Python 3.12–3.14 and pip | Run `python --version` and `python -m pip --version`. | Download a **Python 3.14 Windows installer** from [Python.org](https://www.python.org/downloads/windows/). Enable **Add python.exe to PATH** and keep **pip** selected. |
| Node.js 22.12+ and npm | Run `node --version` and `npm.cmd --version`. | Install **Node.js 24 LTS** using the Windows installer from [Node.js](https://nodejs.org/en/download). Keep npm and the PATH option enabled. |
| Web browser and internet | Open a website in your browser. | Windows 11 includes Edge. Connect to Wi-Fi or Ethernet if needed. DuckDuckGo is optional. |

Use Python 3.12–3.14 for this project's [Django 5.2 compatibility](https://docs.djangoproject.com/en/5.2/faq/install/#what-python-version-can-i-use-with-django).

Check **.NET Framework 4.8+** and its compiler (normally included with Windows 11):

```powershell
$frameworkRelease = Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release -ErrorAction SilentlyContinue
$frameworkRelease -ge 528040
(Test-Path "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe") -or (Test-Path "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe")
```

Both results should be `True`. If the first is `False`, install the [Microsoft .NET Framework 4.8.1 Runtime](https://dotnet.microsoft.com/en-us/download/dotnet-framework/net481). If the compiler check is `False`, install the **Developer Pack** from the same page. Follow any restart prompt. [Microsoft's version check](https://learn.microsoft.com/en-us/dotnet/framework/install/how-to-determine-which-versions-are-installed).

After installing Python or Node.js, restart VS Code/PowerShell and repeat the checks. Django, React, MobX, and SQLite need no separate installation; the setup script installs the packages and creates the database.

## First-time setup

Download or clone the project and open PowerShell in its root folder. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

This installs dependencies, builds the frontend, creates your database, and starts the app at http://127.0.0.1:8000.

Once it loads, press **Ctrl+C** to stop it, then build the executable (excluded from Git):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-launcher.ps1
```

## Run and stop

Double-click **Realtime.exe**. It opens DuckDuckGo when available, otherwise your default browser.

Click **Stop app** to shut down.

Keep the executable in the project root. Entries are saved in `backend/db.sqlite3`; personal data and generated files are excluded from Git.
