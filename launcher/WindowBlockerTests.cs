using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Uses only disposable windows launched by this test. Never selects a user application.
internal static class WindowBlockerTests
{
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    private static void Wait(Func<bool> condition, string message, int timeout = 6000)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeout) {
            Application.DoEvents();
            if (condition()) return;
            Thread.Sleep(15);
        }
        throw new Exception(message);
    }
    private static IntPtr Window(Process process)
    {
        process.Refresh();
        return process.MainWindowHandle;
    }
    private static void Restore(Process process)
    {
        NativeWindows.ShowWindowAsync(Window(process), 9);
        SetForegroundWindow(Window(process));
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        if (Array.IndexOf(args, "--fixture") >= 0) {
            Application.Run(new Form { Text = "Realtime disposable blocker test", Width = 310, Height = 100, ShowInTaskbar = true });
            return 0;
        }
        Process fixture = null, allowed = null;
        try {
            // A control installs the WinForms synchronization context for async native-helper polling.
            using (var control = new Control()) {
                IntPtr controlHandle = control.Handle;
                string executable = Process.GetCurrentProcess().MainModule.FileName;
                string otherExe = Path.Combine(Path.GetDirectoryName(executable), "WindowFixtureAllowed.exe");
                File.Copy(executable, otherExe, true);
                using (var server = new HelperFixture(executable.ToLowerInvariant())) {
                    using (var blocker = new WindowBlocker(server.Url, "fixture-secret", delegate { })) {
                        Assert(blocker.Ready, "Foreground event hook must install.");
                        Assert(!NativeWindows.AllowedPath(@"C:\Apps\brave.exe"), "Brave must remain accessible.");
                        Assert(!NativeWindows.AllowedPath(@"C:\Apps\Realtime.exe"), "Realtime must remain accessible.");
                        Assert(!NativeWindows.AllowedPath(Environment.GetFolderPath(Environment.SpecialFolder.System) + @"\taskmgr.exe"), "System tools must remain accessible.");
                        Wait(() => server.Polls > 0, "Native helper must authenticate and send a heartbeat.");
                        fixture = Process.Start(new ProcessStartInfo(executable, "--fixture") { UseShellExecute = false, CreateNoWindow = true });
                        Wait(() => Window(fixture) != IntPtr.Zero, "Disposable test window did not open.");
                        server.Active = true;
                        Wait(() => blocker.IsBlocking, "Focus should enable blocking.");
                        Restore(fixture);
                        // Foreground activation can be denied while someone uses another app.
                        // Exercise the same minimization policy directly against our fixture only.
                        blocker.MinimizeSelectedWindow(Window(fixture));
                        Wait(() => NativeWindows.IsIconic(Window(fixture)), "Selected fixture should minimize.");
                        Assert(!fixture.HasExited, "Minimization must leave the selected process running.");
                        server.Active = false;
                        Wait(() => !blocker.IsBlocking, "Pause/reset should release blocking.");
                        Restore(fixture);
                        Thread.Sleep(100); Application.DoEvents();
                        Assert(!NativeWindows.IsIconic(Window(fixture)), "Paused focus must allow restoring the window.");
                        server.Active = true;
                        Wait(() => blocker.IsBlocking, "Resume should enable blocking.");
                        allowed = Process.Start(new ProcessStartInfo(otherExe, "--fixture") { UseShellExecute = false, CreateNoWindow = true });
                        Wait(() => Window(allowed) != IntPtr.Zero, "Allowed fixture did not open.");
                        Restore(allowed);
                        blocker.MinimizeSelectedWindow(Window(allowed));
                        var watch = Stopwatch.StartNew();
                        while (watch.ElapsedMilliseconds < 700) { Application.DoEvents(); Thread.Sleep(15); }
                        Assert(!NativeWindows.IsIconic(Window(allowed)), "An unselected app must remain open.");
                        blocker.Pause();
                        Assert(!blocker.IsBlocking, "Reminder Pause must release immediately.");
                        Wait(() => !server.Active, "Reminder Pause must update shared focus state.");
                        server.Active = true;
                        Wait(() => blocker.IsBlocking, "A later session must resume after reminder Pause.");
                        server.Deadline = DateTime.UtcNow.AddMilliseconds(750);
                        Wait(() => !blocker.IsBlocking, "Expiry must release blocking without browser ticks.");
                        server.Deadline = DateTime.UtcNow.AddMinutes(1);
                        Wait(() => blocker.IsBlocking, "New session should enable blocking.");
                        server.Fail = true;
                        Wait(() => !blocker.IsBlocking, "A backend failure must release blocking.");
                        server.Fail = false;
                        Wait(() => blocker.IsBlocking, "Helper should recover after a connection failure.");
                        blocker.Dispose(); blocker.Dispose();
                        Assert(!blocker.IsBlocking, "Shutdown must release blocking and be safe twice.");
                        Restore(fixture);
                        Application.DoEvents();
                        Assert(!NativeWindows.IsIconic(Window(fixture)), "Disposed blocker must allow restoring apps.");
                    }
                }
            }
            Console.WriteLine("PASS: native hook, heartbeat, selected-window minimization, process preservation, pause/resume, reminder Pause, unselected apps, expiry, connection failure, cleanup.");
            return 0;
        } catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        finally {
            // These exact Process instances were created by this test, never discovered user processes.
            foreach (var process in new[] { fixture, allowed }) if (process != null) {
                if (!process.HasExited) { process.CloseMainWindow(); if (!process.WaitForExit(2000)) process.Kill(); }
                process.Dispose();
            }
        }
    }

    private sealed class HelperFixture : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Task worker;
        private readonly string app;
        private volatile bool disposed;
        internal volatile bool Active, Fail;
        internal int Polls;
        private long deadlineTicks = DateTime.UtcNow.AddMinutes(1).Ticks;
        internal DateTime Deadline { get { return new DateTime(Interlocked.Read(ref deadlineTicks), DateTimeKind.Utc); } set { Interlocked.Exchange(ref deadlineTicks, value.Ticks); } }
        internal string Url { get; private set; }
        internal HelperFixture(string app)
        {
            this.app = app;
            listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
            Url = "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/";
            worker = Task.Run((Action)Serve);
        }
        private void Serve()
        {
            while (!disposed) try {
                using (var client = listener.AcceptTcpClient())
                using (var stream = client.GetStream()) {
                    stream.ReadTimeout = 3000;
                    var headerBytes = new List<byte>();
                    while (true) {
                        int next = stream.ReadByte(); if (next < 0) throw new IOException();
                        headerBytes.Add((byte)next);
                        int count = headerBytes.Count;
                        if (count >= 4 && headerBytes[count - 4] == 13 && headerBytes[count - 3] == 10 && headerBytes[count - 2] == 13 && headerBytes[count - 1] == 10) break;
                        if (count > 32768) throw new IOException();
                    }
                    var lines = Encoding.ASCII.GetString(headerBytes.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
                    string first = lines[0];
                    int length = 0; bool auth = false;
                    foreach (string line in lines) {
                        if (line.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase)) length = Int32.Parse(line.Substring(15).Trim());
                        if (line.Equals("X-Realtime-Helper: fixture-secret", StringComparison.OrdinalIgnoreCase)) auth = true;
                    }
                    var body = new byte[length]; int read = 0;
                    while (read < length) { int n = stream.Read(body, read, length - read); if (n == 0) break; read += n; }
                    Assert(auth && first.StartsWith("POST /api/focus/helper/ "), "Helper request must authenticate.");
                    var json = new JavaScriptSerializer();
                    var data = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
                    if (data.ContainsKey("pause") && (bool)data["pause"]) Active = false;
                    Interlocked.Increment(ref Polls);
                    byte[] response = Encoding.UTF8.GetBytes(json.Serialize(new {
                        focus = new { block_enabled = Active, deadline = Active ? Deadline.ToString("o", CultureInfo.InvariantCulture) : null },
                        apps = new[] { new { path = app, name = "Disposable fixture" } }
                    }));
                    byte[] headers = Encoding.ASCII.GetBytes("HTTP/1.1 " + (Fail ? "503 Unavailable" : "200 OK") + "\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + response.Length + "\r\n\r\n");
                    stream.Write(headers, 0, headers.Length); stream.Write(response, 0, response.Length);
                }
            } catch (Exception) { if (!disposed) Fail = true; }
        }
        public void Dispose() { disposed = true; listener.Stop(); worker.Wait(3500); }
    }
}
