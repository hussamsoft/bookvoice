using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using BookVoice.App.Backend;
using Microsoft.UI.Xaml;

namespace BookVoice.App;

public partial class App : Application
{
    // Flags the shell understands itself; serve_bookvoice.py sees only the
    // forwardable ones. --tunnel matches launch.py's semantics (value optional).
    private static readonly string[] ForwardableFlags =
        { "--tunnel", "--tunnel-name", "--tunnel-hostname", "--tunnel-token", "--port" };

    public static MainWindow? Window { get; private set; }

    public App()
    {
        InitializeShellLog();
        this.UnhandledException += (_, e) =>
            LogException("Application.UnhandledException", e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            LogException("AppDomain.UnhandledException", e.ExceptionObject);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            LogException("TaskScheduler.UnobservedTaskException", e.Exception);
            e.SetObserved();
        };
        InitializeComponent();
    }

    private static void LogException(string source, object? error)
    {
        ShellLog.Write($"{source}: {error?.ToString() ?? "No error object was supplied."}");
    }

    private static void InitializeShellLog()
    {
        var appDir = AppPaths.FindAppDir();
        if (appDir is not null && AppPaths.IsPortable())
        {
            ShellLog.Dir = Path.Combine(appDir, ".bookvoice");
        }
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        ConfigureWebViewGpuArgs();
        var argv = Environment.GetCommandLineArgs().Skip(1).ToArray();

        var registration = argv.FirstOrDefault(arg =>
            arg is "--register-bookvoice" or "--unregister-bookvoice");
        if (registration != null)
        {
            var message = BookVoiceFileAssociation.Apply(registration == "--register-bookvoice");
            ShellLog.Write($"file association: {registration} -> {message.ReplaceLineEndings(" | ")}");
            NativeMethods.MessageBoxW(nint.Zero, message, "BookVoice", 0);
            Exit();
            return;
        }

        var bookPath = GetBookFromCommandLine(argv);
        var forwardable = ExtractForwardableArgs(argv);

        if (!SingleInstance.TryAcquire())
        {
            // Another shell owns the backend: hand over the open request and exit.
            PassToRunningInstance(bookPath);
            SingleInstance.SignalExisting();
            Exit();
            return;
        }

        try
        {
            Window = new MainWindow();
            SingleInstance.Listen(() => Window?.OnSecondInstanceSignal());
            Window.Start(bookPath, forwardable);
            Window.Activate();
        }
        catch (Exception ex)
        {
            LogException("OnLaunched startup failure", ex);
            NativeMethods.MessageBoxW(
                nint.Zero,
                "BookVoice could not start its desktop window. See bookvoice_shell.log for details.",
                "BookVoice",
                0x10);
            Environment.Exit(1);
        }
    }

    private static string? GetBookFromCommandLine(string[] argv)
    {
        return argv.FirstOrDefault(arg => arg.EndsWith(".bookvoice", StringComparison.OrdinalIgnoreCase)
            && File.Exists(arg));
    }

    /// <summary>Pick the launcher flags worth forwarding to serve_bookvoice.py.</summary>
    private static List<string> ExtractForwardableArgs(string[] argv)
    {
        var forward = new List<string>();
        for (var i = 0; i < argv.Length; i++)
        {
            var arg = argv[i];
            var equalsIndex = arg.IndexOf('=');
            var flagName = equalsIndex >= 0 ? arg[..equalsIndex] : arg;
            if (!ForwardableFlags.Contains(flagName, StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }
            if (equalsIndex >= 0)
            {
                // --flag=value form keeps the flag and value in one argv slot.
                forward.Add(arg);
                continue;
            }
            forward.Add(arg);
            if (i + 1 < argv.Length && !argv[i + 1].StartsWith('-'))
            {
                forward.Add(argv[++i]);
            }
        }
        return forward;
    }

    private static readonly int InstancePayloadMaxBytes = 4 * 1024 * 1024;

    private static void PassToRunningInstance(string? bookPath)
    {
        var appDir = AppPaths.FindAppDir();
        if (appDir == null)
        {
            return;
        }
        var runtimeDir = AppPaths.RuntimeDir(appDir);
        try
        {
            Directory.CreateDirectory(runtimeDir);
            var payload = JsonSerializer.Serialize(new { book = bookPath });
            // Cap the request size so a corrupt or malicious instance
            // handoff cannot force the running shell to allocate a 4 GB
            // buffer trying to parse it.
            if (Encoding.UTF8.GetByteCount(payload) > InstancePayloadMaxBytes)
            {
                return;
            }
            File.WriteAllText(AppPaths.InstanceRequestPath(runtimeDir), payload);
        }
        catch (IOException)
        {
        }
    }

    /// <summary>
    /// Render the WebView2 shell on the CPU instead of the GPU.
    ///
    /// The Chatterbox TTS model loads ~1 GB onto the same GPU that WebView2
    /// uses for hardware-accelerated rendering; while it warms up, a heavy
    /// repaint can tip the display driver into a TDR reset and the window
    /// blanks. Mirrors launch.configure_webview_gpu().
    /// </summary>
    private static void ConfigureWebViewGpuArgs()
    {
        if (Environment.GetEnvironmentVariable("BOOKVOICE_ENABLE_GPU") == "1")
        {
            return;
        }
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")))
        {
            return;
        }
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu");
    }
}
