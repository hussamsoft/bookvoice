using System.IO;
using System.Text.Json;
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
        InitializeComponent();
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

        Window = new MainWindow();
        SingleInstance.Listen(() => Window?.OnSecondInstanceSignal());
        Window.Start(bookPath, forwardable);
        Window.Activate();
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
            if (!ForwardableFlags.Contains(arg, StringComparer.OrdinalIgnoreCase))
            {
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
