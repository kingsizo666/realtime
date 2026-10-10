using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;

internal static class BrowserLauncherTests
{
    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static int Main()
    {
        try
        {
            var launches = new List<ProcessStartInfo>();
            Action<ProcessStartInfo> record = delegate(ProcessStartInfo start) { launches.Add(start); };

            Program.OpenBrowser(null, record);
            Assert(launches.Count == 1 && launches[0].FileName == Program.Url && launches[0].UseShellExecute,
                "Missing DuckDuckGo must open the URL with the Windows default browser.");

            launches.Clear();
            Program.OpenBrowser("DuckDuckGo.exe", record);
            Assert(launches.Count == 1 && launches[0].FileName == "DuckDuckGo.exe" && launches[0].Arguments == Program.Url && launches[0].UseShellExecute,
                "Available DuckDuckGo must remain the preferred browser.");

            launches.Clear();
            Program.OpenBrowser("DuckDuckGo.exe", delegate(ProcessStartInfo start)
            {
                launches.Add(start);
                if (start.FileName == "DuckDuckGo.exe") throw new Win32Exception(2);
            });
            Assert(launches.Count == 2 && launches[1].FileName == Program.Url && launches[1].UseShellExecute,
                "An unusable DuckDuckGo alias must fall back to the Windows default browser.");

            bool defaultFailureReported = false;
            try
            {
                Program.OpenBrowser(null, delegate(ProcessStartInfo start) { throw new Win32Exception(1155); });
            }
            catch (Win32Exception) { defaultFailureReported = true; }
            Assert(defaultFailureReported, "A default browser launch failure must be reported to the user.");

            Console.WriteLine("Passed: missing, available, and unusable DuckDuckGo; default browser failure.");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
    }
}
