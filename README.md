# Realtime

A personal time tracker built with Django, React, and MobX.

## Check and install requirements

Open PowerShell and check the following. A missing command or an older version means you need to install or update that requirement.

| Requirement | How to check | If missing or outdated |
| --- | --- | --- |
| Python 3.12–3.14 and pip | Run `python --version` and `python -m pip --version`. | Download a **Python 3.14 Windows installer** from [Python.org](https://www.python.org/downloads/windows/). Enable **Add python.exe to PATH** and keep **pip** selected. |
| Node.js 22.12+ and npm | Run `node --version` and `npm.cmd --version`. | Install **Node.js 24 LTS** using the Windows installer from [Node.js](https://nodejs.org/en/download). Keep npm and the PATH option enabled. |

Use Python 3.12–3.14 for this project's [Django 5.2 compatibility](https://docs.djangoproject.com/en/5.2/faq/install/#what-python-version-can-i-use-with-django).

## First-time setup

Download or clone the project and open PowerShell in its root folder. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

This installs dependencies, builds the frontend, creates your database, and starts the app at http://127.0.0.1:8000.

Once it loads, press **Ctrl+C** to stop it, then build the executable:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-launcher.ps1
```

## Run and stop

Double-click **Realtime.exe**. It opens DuckDuckGo when available, otherwise your default browser.

Click **Stop app** to shut down.

Keep the executable in the project root. Entries and automatically saved notepad text are stored in `backend/db.sqlite3` and restored on startup; personal data and generated files are excluded from Git.

## Add your own task categories

Edit the `CATEGORIES` list in `backend/tracking/models/entry.py`.

Stop and reopen **Realtime.exe**, then refresh the page. Category list changes need no migrations or frontend rebuild.

## Connect Spotify

Spotify Premium is required. Create an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard), select **Web API**, and register this exact redirect URI:

```text
http://127.0.0.1:8000/spotify/callback
```

Open Realtime at `http://127.0.0.1:8000`, paste the app's **Client ID** into the Spotify panel, and click **Connect Spotify**. No client secret is needed. Start a song in Spotify on your computer or phone; the panel shows the song and artist with previous, play/pause, and next controls.

For another listener, add their account to the app's **User Management** allowlist (new development apps support up to five users). Spotify settings and sign-in files stay locally in `backend/` and are excluded from Git. **Disconnect** removes the saved sign-in.
