using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

internal static class Program
{
    internal static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    internal const string Url = "http://127.0.0.1:8000/";
    private static readonly object LogLock = new object();

    [STAThread]
    private static int Main(string[] args)
    {
        bool smokeTest = Array.IndexOf(args, "--smoke-test") >= 0;
        bool check = Array.IndexOf(args, "--check") >= 0;
        bool uiSmokeTest = Array.IndexOf(args, "--ui-smoke-test") >= 0;
        try
        {
            if (check)
            {
                ValidateFiles();
                string browser = FindBrowser();
                Log("Launcher checks passed. Browser: " + (browser ?? "Windows default browser"));
                return 0;
            }
            if (smokeTest)
            {
                using (var server = new LocalServer(0))
                {
                    server.Start();
                    using (var client = new WebClient())
                    {
                        client.Proxy = null;
                        string entries = client.DownloadString(server.Url + "api/entries/");
                        if (!entries.Contains("\"categories\"") || !entries.Contains("\"entries\""))
                            throw new Exception("The entries API returned an unexpected response.");
                        var cookies = new CookieContainer();
                        cookies.SetCookies(new Uri(server.Url), client.ResponseHeaders["Set-Cookie"]);
                        client.Headers["Cookie"] = cookies.GetCookieHeader(new Uri(server.Url));
                        client.Headers["X-CSRFToken"] = cookies.GetCookies(new Uri(server.Url))["csrftoken"].Value;
                        client.Headers["Content-Type"] = "application/json";
                        string shutdown = client.UploadString(server.Url + "api/shutdown/", "POST", "{}");
                        if (!shutdown.Contains("true")) throw new Exception("The stop request failed.");
                    }
                    Thread.Sleep(1200);
                    if (!server.ShutdownRequested) throw new Exception("The launcher did not receive the stop request.");
                    Log("Smoke test passed: frontend, entries API, and Stop app request.");
                }
                Log("Smoke test server stopped.");
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (uiSmokeTest)
            {
                using (var open = new EventWaitHandle(false, EventResetMode.AutoReset))
                using (var stop = new EventWaitHandle(false, EventResetMode.AutoReset))
                using (var context = new LauncherContext(open, stop, true))
                {
                    Application.Run(context);
                    // WinForms can dispose the context as its message loop exits.
                    // Call disposal again to guard against repeated cleanup.
                    context.Dispose();
                    context.Dispose();
                    if (context.Failure != null) throw context.Failure;
                    if (context.ServerRunning) throw new Exception("The UI shutdown left its server running.");
                }
                Log("UI smoke test passed: Stop app exited the message loop, cleaned up tray controls, and stopped the server.");
                return 0;
            }
            string instanceName;
            using (var sha = SHA256.Create())
                instanceName = "Local\\Realtime-" + BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Root.ToLowerInvariant()))).Replace("-", "");
            using (var openRequest = new EventWaitHandle(false, EventResetMode.AutoReset, instanceName + "-Open"))
            using (var stopRequest = new EventWaitHandle(false, EventResetMode.AutoReset, instanceName + "-Stop"))
            {
                if (Array.IndexOf(args, "--stop") >= 0) { stopRequest.Set(); return 0; }
                bool created;
                using (var mutex = new Mutex(true, instanceName, out created))
                {
                    if (!created)
                    {
                        openRequest.Set();
                        return 0;
                    }
                    try
                    {
                        using (var context = new LauncherContext(openRequest, stopRequest))
                            Application.Run(context);
                    }
                    finally { mutex.ReleaseMutex(); }
                }
            }
            return 0;
        }
        catch (Exception ex)
        {
            Log("ERROR: " + ex.ToString());
            if (!check && !smokeTest && !uiSmokeTest)
                MessageBox.Show(ex.Message + "\n\nDetails: " + Path.Combine(Root, "launcher.log"), "Realtime", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    internal static void ValidateFiles()
    {
        if (!File.Exists(Path.Combine(Root, ".venv", "Scripts", "python.exe")) ||
            !File.Exists(Path.Combine(Root, "backend", "manage.py")) ||
            !File.Exists(Path.Combine(Root, "frontend", "dist", "index.html")))
            throw new Exception("Keep Realtime.exe in the RealTime project folder. Run scripts\\start.ps1 once to set up Python and build the app, then stop that server before using this launcher.");
    }

    internal static string FindBrowser()
    {
        // The Windows app execution alias follows DuckDuckGo updates automatically.
        string alias = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps", "DuckDuckGo.exe");
        return File.Exists(alias) ? alias : null;
    }

    internal static void OpenBrowser()
    {
        OpenBrowser(FindBrowser(), delegate(ProcessStartInfo start) { Process.Start(start); });
    }

    internal static void OpenBrowser(string duckDuckGo, Action<ProcessStartInfo> launch)
    {
        if (!string.IsNullOrEmpty(duckDuckGo))
        {
            try
            {
                launch(new ProcessStartInfo(duckDuckGo, Url) { UseShellExecute = true });
                return;
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                // A stale or disabled app alias can exist after uninstalling.
                Log("DuckDuckGo unavailable; using the default browser: " + ex.Message);
            }
        }
        launch(new ProcessStartInfo(Url) { UseShellExecute = true });
    }

    internal static void Log(string message)
    {
        lock (LogLock)
        {
            try
            {
                string path = Path.Combine(Root, "launcher.log");
                if (File.Exists(path) && new FileInfo(path).Length > 1024 * 1024)
                    File.WriteAllText(path, "");
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine);
            }
            catch { /* Logging must not prevent shutdown. */ }
        }
    }
}

internal sealed class LauncherContext : ApplicationContext
{
    private readonly LocalServer server;
    private WindowBlocker blocker;
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer timer;
    private readonly EventWaitHandle openRequest;
    private readonly EventWaitHandle stopRequest;
    private readonly ToolStripMenuItem openItem;
    private readonly ContextMenuStrip menu;
    private bool ready;
    private bool stopping;
    private bool resourcesDisposed;
    private readonly bool smokeTest;
    private readonly DateTime testDeadline = DateTime.UtcNow.AddSeconds(45);
    internal Exception Failure { get; private set; }
    internal bool ServerRunning { get { return server.IsRunning; } }

    internal LauncherContext(EventWaitHandle request, EventWaitHandle stop, bool smokeTest = false)
    {
        this.smokeTest = smokeTest;
        server = new LocalServer(smokeTest ? 0 : 8000);
        openRequest = request;
        stopRequest = stop;
        menu = new ContextMenuStrip();
        openItem = new ToolStripMenuItem("Open Realtime", null, delegate { TryOpenBrowser(); });
        openItem.Enabled = false;
        menu.Items.Add(openItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Stop Realtime and exit", null, delegate { ExitThread(); });
        tray = new NotifyIcon { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), Text = "Realtime - starting...", ContextMenuStrip = menu, Visible = !smokeTest };
        tray.DoubleClick += delegate { if (ready) TryOpenBrowser(); };
        timer = new System.Windows.Forms.Timer { Interval = 500 };
        timer.Tick += delegate
        {
            if (smokeTest && DateTime.UtcNow > testDeadline) { Failure = new Exception("UI shutdown test timed out."); ExitThread(); return; }
            if (stopRequest.WaitOne(0) || (ready && server.ShutdownRequested)) { ExitThread(); return; }
            if (openRequest.WaitOne(0) && ready) TryOpenBrowser();
            if (ready && !server.IsRunning)
            {
                if (smokeTest) Failure = new Exception("The local server stopped unexpectedly during the UI test.");
                else MessageBox.Show("The local server stopped. See launcher.log for details.", "Realtime", MessageBoxButtons.OK, MessageBoxIcon.Error);
                ExitThread();
            }
        };
        timer.Start();
        Application.ApplicationExit += OnApplicationExit;
        StartAsync();
    }

    private async void StartAsync()
    {
        try
        {
            await Task.Run(delegate { server.Start(); });
            if (stopping) return;
            ready = true;
            tray.Text = "Realtime - running";
            openItem.Enabled = true;
            if (smokeTest)
            {
                await Task.Run(delegate
                {
                    using (var client = new WebClient())
                    {
                        client.Proxy = null;
                        client.DownloadString(server.Url + "api/entries/");
                        var cookies = new CookieContainer();
                        cookies.SetCookies(new Uri(server.Url), client.ResponseHeaders["Set-Cookie"]);
                        client.Headers["Cookie"] = cookies.GetCookieHeader(new Uri(server.Url));
                        client.Headers["X-CSRFToken"] = cookies.GetCookies(new Uri(server.Url))["csrftoken"].Value;
                        client.Headers["Content-Type"] = "application/json";
                        var response = client.UploadString(server.Url + "api/shutdown/", "POST", "{}");
                        if (!response.Contains("true")) throw new Exception("UI test stop request failed.");
                    }
                });
            }
            else
            {
                blocker = new WindowBlocker(server.Url, server.HelperToken, TryOpenBrowser);
                TryOpenBrowser();
            }
        }
        catch (Exception ex)
        {
            if (stopping) return;
            Program.Log("ERROR: " + ex.ToString());
            if (smokeTest) Failure = ex;
            else MessageBox.Show(ex.Message + "\n\nDetails: " + Path.Combine(Program.Root, "launcher.log"), "Realtime", MessageBoxButtons.OK, MessageBoxIcon.Error);
            ExitThread();
        }
    }

    private void TryOpenBrowser()
    {
        try { Program.OpenBrowser(); }
        catch (Exception ex)
        {
            Program.Log("Browser launch failed: " + ex.Message);
            MessageBox.Show("Could not open a browser: " + ex.Message + "\n\nRealtime is running at " + Program.Url, "Realtime", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void OnApplicationExit(object sender, EventArgs args) { Stop(); }

    private void Stop()
    {
        if (stopping) return;
        stopping = true;
        timer.Stop();
        tray.Visible = false;
        if (blocker != null) blocker.Dispose();
        server.Dispose();
    }

    protected override void ExitThreadCore() { Stop(); base.ExitThreadCore(); }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !resourcesDisposed)
        {
            resourcesDisposed = true;
            Stop();
            Application.ApplicationExit -= OnApplicationExit;
            timer.Dispose();
            // NotifyIcon clears ContextMenuStrip during disposal. Keep our own
            // reference and dispose these owned resources only once.
            tray.ContextMenuStrip = null;
            tray.Dispose();
            menu.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal sealed class LocalServer : IDisposable
{
    private int port;
    private Process server;
    private readonly object gate = new object();
    private bool disposed;
    private readonly ProcessJob job = new ProcessJob();
    private readonly string shutdownFile = Path.Combine(Program.Root, ".realtime-stop-" + Guid.NewGuid().ToString("N") + ".signal");
    internal readonly string HelperToken = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");

    internal LocalServer(int port = 8000) { this.port = port; }
    internal string Url { get { return "http://127.0.0.1:" + port + "/"; } }
    internal bool ShutdownRequested { get { return File.Exists(shutdownFile) && File.GetLastWriteTimeUtc(shutdownFile) < DateTime.UtcNow.AddSeconds(-1); } }

    internal bool IsRunning { get { lock (gate) { return !disposed && server != null && !server.HasExited; } } }

    internal void Start()
    {
        Program.ValidateFiles();
        // Do not stop or accidentally use another program listening on this port.
        var portCheck = new TcpListener(IPAddress.Loopback, port);
        portCheck.Server.ExclusiveAddressUse = true;
        try { portCheck.Start(); port = ((IPEndPoint)portCheck.LocalEndpoint).Port; }
        catch (SocketException) { throw new Exception("Port 8000 is already in use. Stop the server started by scripts\\start.ps1 (or the other app using this port), then open Realtime.exe again."); }
        finally { portCheck.Stop(); }

        using (var migration = StartPython("manage.py migrate --noinput"))
        {
            if (!migration.WaitForExit(30000)) throw new Exception("Database setup took too long.");
            migration.WaitForExit();
            if (migration.ExitCode != 0) throw new Exception("Database setup failed. See launcher.log for details.");
        }
        lock (gate)
        {
            if (disposed) throw new OperationCanceledException();
            server = StartPython("manage.py runserver 127.0.0.1:" + port + " --noreload");
        }
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            lock (gate)
            {
                if (disposed) throw new OperationCanceledException();
                if (server.HasExited) throw new Exception("Django could not start. See launcher.log for details.");
            }
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(Url);
                request.Proxy = null;
                request.Timeout = 1000;
                using (var response = (HttpWebResponse)request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                    if (reader.ReadToEnd().Contains("id=\"root\""))
                    {
                        Program.Log("Realtime ready at " + Url);
                        return;
                    }
            }
            catch (WebException) { }
            Thread.Sleep(200);
        }
        throw new Exception("The app did not become ready within 30 seconds. See launcher.log for details.");
    }

    private Process StartPython(string arguments)
    {
        lock (gate)
        {
            if (disposed) throw new OperationCanceledException();
            var start = new ProcessStartInfo(Path.Combine(Program.Root, ".venv", "Scripts", "python.exe"), arguments);
            start.WorkingDirectory = Path.Combine(Program.Root, "backend");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
            start.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            start.EnvironmentVariables["REALTIME_SHUTDOWN_FILE"] = shutdownFile;
            start.EnvironmentVariables["REALTIME_HELPER_TOKEN"] = HelperToken;
            var process = new Process { StartInfo = start };
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) Program.Log(args.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { if (args.Data != null) Program.Log(args.Data); };
            process.Start();
            try { job.Add(process); }
            catch { process.Kill(); process.Dispose(); throw; }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            return process;
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            job.Dispose();
            try { File.Delete(shutdownFile); } catch (IOException) { }
            if (server != null)
            {
                server.WaitForExit(5000);
                server.Dispose();
            }
        }
    }
}

// Closing the launcher (including a crash or Windows shutdown) closes its job
// handle and terminates only the Python processes started by this launcher.
internal sealed class ProcessJob : IDisposable
{
    private IntPtr handle;
    internal ProcessJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(limits);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(handle, 9, buffer, (uint)size))
                throw new System.ComponentModel.Win32Exception();
        }
        catch { Dispose(); throw; }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    internal void Add(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle)) throw new System.ComponentModel.Win32Exception();
    }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long PerProcessTime, PerJobTime;
        public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
