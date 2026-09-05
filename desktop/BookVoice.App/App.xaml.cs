using System.IO;
using System.Text.Json;
using BookVoice.App.Backend;
using Microsoft.UI.Xaml;

namespace BookVoice.App;

public partial class App : Application
{
    public static MainWindow? Window { get; private set; }

    public App()
    {
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        ConfigureWebViewGpuArgs();
        var bookPath = GetBookFromCommandLine();

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
        Window.Start(bookPath);
        Window.Activate();
    }

    private static string? GetBookFromCommandLine()
    {
        return Environment.GetCommandLineArgs()
            .Skip(1)
            .FirstOrDefault(arg => arg.EndsWith(".bookvoice", StringComparison.OrdinalIgnoreCase)
                && File.Exists(arg));
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
