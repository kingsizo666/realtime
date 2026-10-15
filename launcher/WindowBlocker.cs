using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

// Runs inside the launcher's message loop. No injection, process termination or elevation.
internal sealed class WindowBlocker : IDisposable
{
    private readonly string url;
    private readonly string token;
    private readonly Action openTracker;
    private readonly System.Windows.Forms.Timer timer;
    private readonly NativeWindows.WinEvent callback;
    private readonly IntPtr hook;
    private readonly Stopwatch heartbeatAge = Stopwatch.StartNew();
    private readonly Stopwatch scanAge = Stopwatch.StartNew();
    private readonly Stopwatch noticeAge = Stopwatch.StartNew();
    private List<AppInfo> runningApps = new List<AppInfo>();
    private Dictionary<string, string> rules = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    private DateTime deadline;
    private bool busy, disposed, active, pausePending;
    private int pauseGeneration;
    private string lastBlocked = "", error = "";
    private FocusReminder reminder;
    private IntPtr lastWindow;
    private long lastAttempt;
    internal bool Ready { get { return hook != IntPtr.Zero; } }

    internal WindowBlocker(string url, string token, Action openTracker)
    {
        this.url = url;
        this.token = token;
        this.openTracker = openTracker;
        callback = delegate(IntPtr h, uint e, IntPtr w, int o, int c, uint t, uint ms) { CheckForeground(w); };
        hook = NativeWindows.SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 2);
        if (!Ready) error = "Windows app detection is unavailable. Restart Realtime.";
        timer = new System.Windows.Forms.Timer { Interval = 350 };
        timer.Tick += delegate { CheckForeground(NativeWindows.GetForegroundWindow()); Poll(); };
        timer.Start();
        Poll();
    }

    private async void Poll()
    {
        if (busy || disposed) return;
        busy = true;
        bool scan = runningApps.Count == 0 || scanAge.ElapsedMilliseconds >= 3000;
        int sentPause = pauseGeneration;
        bool sendPause = pausePending;
        string report = error, blocked = lastBlocked;
        bool ready = Ready;
        try
        {
            HelperReply reply = await Task.Run(delegate {
                if (scan) runningApps = NativeWindows.ListApps();
                var serializer = new JavaScriptSerializer();
                byte[] body = Encoding.UTF8.GetBytes(serializer.Serialize(new { apps = runningApps, ready = ready, pause = sendPause, last_blocked = blocked, error = report }));
                var request = (HttpWebRequest)WebRequest.Create(url + "api/focus/helper/");
                request.Proxy = null;
                request.Method = "POST";
                request.ContentType = "application/json";
                request.Headers["X-Realtime-Helper"] = token;
                request.Timeout = 1500;
                request.ReadWriteTimeout = 1500;
                request.ContentLength = body.Length;
                using (var stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                    return serializer.Deserialize<HelperReply>(reader.ReadToEnd());
            });
            if (disposed) return;
            if (scan) scanAge.Restart();
            heartbeatAge.Restart();
            if (sendPause && pauseGeneration == sentPause) pausePending = false;
            rules.Clear();
            if (reply.apps != null) foreach (var app in reply.apps)
                if (NativeWindows.AllowedPath(app.path)) rules[app.path] = app.name;
            deadline = DateTime.MinValue;
            active = !pausePending && Ready && reply.focus != null && reply.focus.block_enabled &&
                DateTime.TryParse(reply.focus.deadline, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out deadline);
            if (!active || DateTime.UtcNow >= deadline) HideReminder();
        }
        catch (Exception) {
            // A stale/disconnected backend must never keep enforcing an old session.
            active = false;
            HideReminder();
        }
        finally { busy = false; }
    }

    internal bool IsBlocking { get { return !disposed && active && !pausePending && heartbeatAge.ElapsedMilliseconds < 4000 && DateTime.UtcNow < deadline; } }

    private void CheckForeground(IntPtr window)
    {
        if (window == IntPtr.Zero || window != NativeWindows.GetForegroundWindow()) return;
        MinimizeSelectedWindow(window);
    }

    internal void MinimizeSelectedWindow(IntPtr window)
    {
        if (!IsBlocking) { HideReminder(); return; }
        if (window == IntPtr.Zero || NativeWindows.IsIconic(window)) return;
        string path = NativeWindows.WindowPath(window);
        string name;
        if (path == null || !rules.TryGetValue(path, out name)) return;
        long now = Stopwatch.GetTimestamp();
        if (lastWindow == window && (now - lastAttempt) / (double)Stopwatch.Frequency < 1) return;
        lastWindow = window;
        lastAttempt = now;
        if (!NativeWindows.ShowWindowAsync(window, 6)) {
            error = "Could not minimize " + name + ". Elevated apps may need to be closed manually.";
            return;
        }
        lastBlocked = name;
        error = "";
        if (reminder == null || noticeAge.ElapsedMilliseconds >= 10000) {
            HideReminder();
            reminder = new FocusReminder(name, openTracker, Pause);
            reminder.Show();
            noticeAge.Restart();
        }
    }

    internal void Pause()
    {
        pausePending = true;
        pauseGeneration++;
        active = false;
        HideReminder();
        Poll();
    }

    private void HideReminder()
    {
        if (reminder == null) return;
        reminder.Dispose();
        reminder = null;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        active = false;
        timer.Stop(); timer.Dispose();
        if (hook != IntPtr.Zero) NativeWindows.UnhookWinEvent(hook);
        HideReminder();
        GC.KeepAlive(callback);
    }

    internal sealed class HelperReply { public FocusState focus { get; set; } public AppInfo[] apps { get; set; } }
    internal sealed class FocusState { public bool block_enabled { get; set; } public string deadline { get; set; } }
}

internal sealed class AppInfo
{
    public string name { get; set; }
    public string path { get; set; }
}

internal static class NativeWindows
{
    internal delegate void WinEvent(IntPtr hook, uint type, IntPtr hwnd, int obj, int child, uint thread, uint time);
    private delegate bool EnumWindow(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] internal static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEvent callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] internal static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    private static readonly int OwnPid = Process.GetCurrentProcess().Id;
    private static readonly string DefaultBrowser = FindDefaultBrowser();
    private static readonly HashSet<string> Protected = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "realtime.exe", "explorer.exe", "taskmgr.exe", "applicationframehost.exe", "runtimebroker.exe",
        "shellexperiencehost.exe", "startmenuexperiencehost.exe", "searchhost.exe", "systemsettings.exe", "securityhealthsystray.exe",
        "cmd.exe", "powershell.exe", "pwsh.exe", "conhost.exe", "windowsterminal.exe", "chrome.exe", "msedge.exe",
        "brave.exe", "firefox.exe", "opera.exe", "duckduckgo.exe", "iexplore.exe", "vivaldi.exe",
        "arc.exe", "zen.exe", "floorp.exe", "librewolf.exe", "waterfox.exe", "chromium.exe"
    };

    internal static bool AllowedPath(string path)
    {
        if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || !path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) return false;
        if (Protected.Contains(Path.GetFileName(path)) || String.Equals(Path.GetFileName(path), DefaultBrowser, StringComparison.OrdinalIgnoreCase)) return false;
        string system = Environment.GetFolderPath(Environment.SpecialFolder.System) + Path.DirectorySeparatorChar;
        return !path.StartsWith(system, StringComparison.OrdinalIgnoreCase);
    }

    private static string FindDefaultBrowser()
    {
        try {
            using (var choice = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice")) {
                string id = choice == null ? null : choice.GetValue("ProgId") as string;
                if (String.IsNullOrEmpty(id)) return null;
                using (var command = Registry.ClassesRoot.OpenSubKey(id + @"\shell\open\command")) {
                    string value = command == null ? null : command.GetValue(null) as string;
                    if (String.IsNullOrEmpty(value)) return null;
                    value = Environment.ExpandEnvironmentVariables(value).Trim();
                    int end = value.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                    return end < 0 ? null : Path.GetFileName(value.Substring(0, end + 4).TrimStart('"'));
                }
            }
        } catch (Exception) { return null; }
    }

    internal static string WindowPath(IntPtr window)
    {
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (pid == 0 || pid == OwnPid) return null;
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return null;
        try {
            int length = 32768;
            var buffer = new StringBuilder(length);
            if (!QueryFullProcessImageName(process, 0, buffer, ref length)) return null;
            string path = buffer.ToString();
            return AllowedPath(path) ? path.ToLowerInvariant() : null;
        } finally { CloseHandle(process); }
    }

    internal static List<AppInfo> ListApps()
    {
        var apps = new Dictionary<string, AppInfo>(StringComparer.OrdinalIgnoreCase);
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (!IsWindowVisible(window) || GetWindow(window, 4) != IntPtr.Zero) return true;
            string path = WindowPath(window);
            if (path == null || apps.ContainsKey(path)) return true;
            string name = Path.GetFileNameWithoutExtension(path);
            try { string description = FileVersionInfo.GetVersionInfo(path).FileDescription; if (!String.IsNullOrWhiteSpace(description)) name = description; } catch (Exception) { }
            apps[path] = new AppInfo { name = name, path = path };
            return true;
        }, IntPtr.Zero);
        var list = new List<AppInfo>(apps.Values);
        list.Sort(delegate(AppInfo a, AppInfo b) { return StringComparer.CurrentCultureIgnoreCase.Compare(a.name, b.name); });
        return list;
    }
}

internal sealed class FocusReminder : Form
{
    private readonly System.Windows.Forms.Timer hideTimer;
    protected override bool ShowWithoutActivation { get { return true; } }
    internal FocusReminder(string name, Action open, Action pause)
    {
        Text = "Realtime focus";
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        ShowInTaskbar = false; TopMost = true; MaximizeBox = false; MinimizeBox = false;
        StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(310, 100);
        BackColor = Color.FromArgb(30, 29, 37); ForeColor = Color.FromArgb(230, 227, 240);
        Font = new Font("Segoe UI", 9);
        var area = Screen.PrimaryScreen.WorkingArea;
        Location = new Point(area.Right - Width - 16, area.Bottom - Height - 16);
        Controls.Add(new Label { Text = name + " can wait. Your focus session is running.", AutoEllipsis = true, Location = new Point(12, 10), Size = new Size(286, 38) });
        var back = new Button { Text = "Return to tracker", Location = new Point(12, 57), Size = new Size(143, 29), FlatStyle = FlatStyle.Flat };
        var stop = new Button { Text = "Pause focus", Location = new Point(164, 57), Size = new Size(132, 29), FlatStyle = FlatStyle.Flat };
        back.Click += delegate { open(); Hide(); };
        stop.Click += delegate { pause(); };
        Controls.Add(back); Controls.Add(stop);
        hideTimer = new System.Windows.Forms.Timer { Interval = 6000 };
        hideTimer.Tick += delegate { Hide(); hideTimer.Stop(); };
        hideTimer.Start();
    }
    protected override void Dispose(bool disposing) { if (disposing && hideTimer != null) hideTimer.Dispose(); base.Dispose(disposing); }
}
