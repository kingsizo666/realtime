"""Short-lived native-helper presence; rules and timer state live in the database."""
import ntpath
import threading
import time

from django.conf import settings

PROTECTED = {
    'realtime.exe', 'explorer.exe', 'taskmgr.exe', 'applicationframehost.exe',
    'runtimebroker.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe',
    'searchhost.exe', 'systemsettings.exe', 'securityhealthsystray.exe',
    'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe', 'windowsterminal.exe',
    'chrome.exe', 'msedge.exe', 'brave.exe', 'firefox.exe', 'opera.exe',
    'duckduckgo.exe', 'iexplore.exe', 'vivaldi.exe',
    'arc.exe', 'zen.exe', 'floorp.exe', 'librewolf.exe', 'waterfox.exe', 'chromium.exe',
}
lock = threading.Lock()
presence = {'seen': 0, 'ready': False, 'apps': [], 'last_blocked': '', 'error': ''}


def normalize_path(path):
    if not isinstance(path, str) or len(path) > 1024 or '\x00' in path:
        raise ValueError('Invalid application path.')
    path = ntpath.normpath(path).lower()
    if not ntpath.isabs(path) or not path.endswith('.exe') or ntpath.basename(path) in PROTECTED:
        raise ValueError('Choose a desktop app. Browsers and system tools stay accessible.')
    return path


def heartbeat(data):
    apps = []
    for item in data.get('apps', [])[:500]:
        try:
            path = normalize_path(item['path'])
            name = item['name']
            if not isinstance(name, str) or not name.strip():
                continue
            if not any(app['path'] == path for app in apps):
                apps.append({'path': path, 'name': name[:200]})
        except (ValueError, TypeError, KeyError):
            continue
    with lock:
        presence.update(seen=time.monotonic(), ready=data.get('ready') is True,
                        apps=apps, last_blocked=str(data.get('last_blocked', ''))[:200],
                        error=str(data.get('error', ''))[:300])


def status():
    with lock:
        fresh = bool(settings.REALTIME_HELPER_TOKEN) and time.monotonic() - presence['seen'] < 5
        available = fresh and presence['ready']
        return {'available': available, 'running_apps': list(presence['apps']) if fresh else [],
                'last_blocked': presence['last_blocked'] if fresh else '',
                'message': (presence['error'] if fresh else '') or ('' if available else 'Open Realtime.exe to use app blocking.')}
