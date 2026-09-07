using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using BookVoice.App.Backend;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;

namespace BookVoice.App;

public sealed partial class MainWindow : Window
{
    // UI floor, not a preference: the reader toolbar wraps at <=720px CSS px
    // and panels scroll below that, so 780x560 keeps every control reachable.
    private const int MinWidth = 780;
    private const int MinHeight = 560;

    private string _appDir = "";
    private string _runtimeDir = "";
    private IReadOnlyList<string> _passthroughArgs = Array.Empty<string>();
    private BackendHost? _host;
    private ServerStateInfo? _lastReady;
    private string? _pendingBookPath;
    private bool _webViewReady;
    private bool _contentShown;
    private bool _restartPending;
    private bool _runtimeMissing;
    private DateTime _startedAt = DateTime.UtcNow;

    public MainWindow()
    {
        InitializeComponent();
        Title = "BookVoice";
        Closed += (_, _) => OnClosed();
        ResolvePaths();
        ConfigureWindow();
    }

    /// <summary>Begin serving the UI; call once after Activate().</summary>
    public void Start(string? bookPath, IReadOnlyList<string>? passthroughArgs = null)
    {
        _pendingBookPath = bookPath;
        _passthroughArgs = passthroughArgs ?? Array.Empty<string>();
        StartBackend();
    }

    private void ResolvePaths()
    {
        var appDir = AppPaths.FindAppDir();
        if (appDir == null)
        {
            _runtimeMissing = true;
            return;
        }
        _appDir = appDir;
        _runtimeDir = AppPaths.RuntimeDir(appDir);
        ShellLog.Dir = _runtimeDir;
        try
        {
            Directory.CreateDirectory(_runtimeDir);
        }
        catch (IOException)
        {
        }
        ShellLog.Write($"shell start; appDir={_appDir}; runtime={_runtimeDir}; version={AppPaths.ReadVersion(_appDir)}");
        SplashFooter.Text = $"Version {AppPaths.ReadVersion(_appDir)} · Local desktop app";
    }

    private void ConfigureWindow()
    {
        if (AppWindow == null)
        {
            return;
        }
        try
        {
            AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "bookvoice.ico"));
        }
        catch (Exception)
        {
            // The exe icon still identifies the window; a missing file icon is cosmetic.
        }
        try
        {
            if (AppWindow.Presenter is OverlappedPresenter presenter)
            {
                presenter.PreferredMinimumWidth = MinWidth;
                presenter.PreferredMinimumHeight = MinHeight;
            }
        }
        catch (NotSupportedException)
        {
        }
        try
        {
            SystemBackdrop = new MicaBackdrop();
        }
        catch (Exception)
        {
            // Mica needs Windows 11; the default backdrop is fine on Windows 10.
        }

        var saved = _runtimeDir.Length == 0 ? null : WindowPlacement.Load(_runtimeDir);
        var work = DisplayArea.Primary.WorkArea;
        var bounds = saved ?? DefaultBounds(work);
        var width = Math.Min(bounds.Width, work.Width);
        var height = Math.Min(bounds.Height, work.Height);
        var x = Math.Clamp(bounds.X, work.X, work.X + Math.Max(0, work.Width - width));
        var y = Math.Clamp(bounds.Y, work.Y, work.Y + Math.Max(0, work.Height - height));
        if (bounds.Maximized)
        {
            (AppWindow.Presenter as OverlappedPresenter)?.Maximize();
        }
        else
        {
            AppWindow.MoveAndResize(new RectInt32(x, y, width, height));
        }
    }

    /// <summary>
    /// First-launch size: about 65% of the monitor's work area, centered.
    /// Displays too small for every element to compress to that scale get
    /// the UI floor instead (MinWidth/MinHeight).
    /// </summary>
    private static WindowBounds DefaultBounds(RectInt32 work)
    {
        var width = Math.Max(MinWidth, work.Width * 65 / 100);
        var height = Math.Max(MinHeight, work.Height * 65 / 100);
        var x = work.X + Math.Max(0, (work.Width - width) / 2);
        var y = work.Y + Math.Max(0, (work.Height - height) / 2);
        return new WindowBounds(x, y, width, height, Maximized: false);
    }

    private void StartBackend()
    {
        _startedAt = DateTime.UtcNow;
        _restartPending = false;
        if (_runtimeMissing || _appDir.Length == 0)
        {
            ShowError(
                "The BookVoice application payload was not found next to BookVoice.exe. "
                + "Reinstall BookVoice, or run it from the built dist folder (the folder "
                + "containing main.py, static/ and runtime/).",
                tail: null);
            return;
        }

        ShowSplash("Starting BookVoice", "Waiting for startup checks…", 5);
        _host = new BackendHost(_appDir, _runtimeDir, _passthroughArgs);
        _host.StatusChanged += OnStatus;
        _host.BecameReady += OnReady;
        _host.Failed += OnFailed;
        _host.Run();
    }

    private void OnStatus(string title, string detail, int percent, bool indeterminate)
    {
        var isRestart = title.StartsWith("Restarting", StringComparison.Ordinal);
        if (_contentShown && !isRestart)
        {
            // The page is up; a transient status does not justify pulling the
            // user back to the splash.
            return;
        }
        if (!_contentShown && DateTime.UtcNow - _startedAt > TimeSpan.FromSeconds(20) && percent < 100)
        {
            detail += " (first start can take a few minutes)";
        }
        _restartPending = isRestart;
        SplashTitle.Text = title;
        SplashDetail.Text = detail;
        SplashProgress.IsIndeterminate = indeterminate;
        SplashProgress.Value = percent;
        SplashPanel.Visibility = _contentShown ? Visibility.Collapsed : Visibility.Visible;
    }

    private async void OnReady(ServerStateInfo state)
    {
        _lastReady = state;
        _restartPending = false;
        var baseUrl = $"http://127.0.0.1:{state.Port}/";
        var url = baseUrl;

        if (_pendingBookPath != null)
        {
            var pending = _pendingBookPath;
            _pendingBookPath = null;
            try
            {
                var id = await BookImporter.ImportAsync(baseUrl, pending);
                url += $"?book={id}";
            }
            catch (Exception ex)
            {
                await ShowDialogAsync("Could not open the prepared book", ex.Message);
            }
        }

        if (state.Book is { } serverBook && url == baseUrl)
        {
            // serve_bookvoice.py imported a book from the command line.
            url += $"?book={serverBook}";
        }

        await ShowContentAsync(url);
    }

    private async Task ShowContentAsync(string url)
    {
        if (!_webViewReady)
        {
            try
            {
                var environment = await CoreWebView2Environment.CreateWithOptionsAsync(
                    browserExecutableFolder: null,
                    userDataFolder: _runtimeDir.Length == 0
                        ? Path.Combine(Path.GetTempPath(), "BookVoice", "webview2")
                        : AppPaths.WebViewDataPath(_runtimeDir),
                    options: new CoreWebView2EnvironmentOptions());
                await Web.EnsureCoreWebView2Async(environment);
                _webViewReady = true;
                Web.NavigationCompleted += (_, navArgs) => OnNavigationCompleted(navArgs);
                // The shell is an app frame, not a browser: links that ask for
                // a new window (target=_blank, external docs) go to the
                // system's default browser instead of being swallowed.
                Web.CoreWebView2.NewWindowRequested += (_, newWindowArgs) =>
                {
                    newWindowArgs.Handled = true;
                    try
                    {
                        Process.Start(
                            new ProcessStartInfo(newWindowArgs.Uri.ToString())
                            {
                                UseShellExecute = true,
                            });
                    }
                    catch (Exception)
                    {
                        // No handler for the scheme; nothing else to try.
                    }
                };
            }
            catch (Exception ex) when (ex.Message.Contains("WebView2 Runtime", StringComparison.OrdinalIgnoreCase)
                || ex.GetType().Name.Contains("RuntimeNotFound", StringComparison.Ordinal))
            {
                ShellLog.Write($"webview runtime missing:{Environment.NewLine}{ex}");
                ShowError(
                    "BookVoice needs the WebView2 Runtime, which renders its interface. "
                    + "It is included with Windows 11 and most up-to-date Windows 10 installs; "
                    + "the link below installs it if yours does not have it.",
                    tail: null);
                RuntimeHelpLink.Visibility = Visibility.Visible;
                return;
            }
            catch (Exception ex)
            {
                ShellLog.Write($"webview init failed:{Environment.NewLine}{ex}");
                ShowError("The embedded browser could not start." + Environment.NewLine + ex, tail: null);
                return;
            }
        }

        SplashPanel.Visibility = Visibility.Collapsed;
        ErrorPanel.Visibility = Visibility.Collapsed;
        ContentPanel.Visibility = Visibility.Visible;
        _contentShown = true;
        Web.Source = new Uri(url);
    }

    private void OnNavigationCompleted(CoreWebView2NavigationCompletedEventArgs args)
    {
        if (args.IsSuccess || _restartPending)
        {
            return;
        }
        ShowError($"The app page failed to load ({args.WebErrorStatus}).", _host?.ReadLogTail());
    }

    private void OnFailed(string message)
    {
        ShellLog.Write($"backend host reported failure: {message}");
        ShowError(message, _host?.ReadLogTail());
    }

    private void ShowSplash(string title, string detail, int percent)
    {
        SplashTitle.Text = title;
        SplashDetail.Text = detail;
        SplashProgress.IsIndeterminate = false;
        SplashProgress.Value = percent;
        SplashPanel.Visibility = Visibility.Visible;
        ErrorPanel.Visibility = Visibility.Collapsed;
        ContentPanel.Visibility = Visibility.Collapsed;
        _contentShown = false;
        _runtimeMissing = false;
    }

    private void ShowError(string message, string? tail)
    {
        ShellLog.Write($"error panel shown: {message}");
        ErrorMessage.Text = message;
        ErrorLog.Text = tail ?? "";
        RuntimeHelpLink.Visibility = Visibility.Collapsed;
        SplashPanel.Visibility = Visibility.Collapsed;
        ContentPanel.Visibility = Visibility.Collapsed;
        ErrorPanel.Visibility = Visibility.Visible;
        _contentShown = false;
        // WCAG 2.2 / Fluent keyboard guidance: primary recovery action first
        // in tab order gets focus so keyboard users start where the fix is.
        _ = DispatcherQueue.TryEnqueue(() => RetryButton.Focus(FocusState.Programmatic));
    }

    private void OnRetryClick(object sender, RoutedEventArgs e)
    {
        _host?.Dispose();
        _host = null;
        StartBackend();
    }

    private void OnOpenLogsClick(object sender, RoutedEventArgs e)
    {
        var folder = _runtimeDir.Length == 0 ? AppPaths.LegacyRuntimeDir() : _runtimeDir;
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{folder}\"") { UseShellExecute = true });
        }
        catch (Exception)
        {
            // Explorer launch is best-effort; the folder path is stable.
        }
    }

    private void OnCloseClick(object sender, RoutedEventArgs e) => Close();

    /// <summary>Another shell launch signalled us: raise the window and hand over any open request.</summary>
    public async void OnSecondInstanceSignal()
    {
        DispatcherQueue.TryEnqueue(async () =>
        {
            RaiseWindow();
            var request = TryTakeInstanceRequest();
            if (request == null)
            {
                return;
            }
            if (_contentShown && _lastReady?.Port is int port)
            {
                try
                {
                    var id = await BookImporter.ImportAsync($"http://127.0.0.1:{port}", request);
                    Web.Source = new Uri($"http://127.0.0.1:{port}/?book={id}");
                }
                catch (Exception ex)
                {
                    await ShowDialogAsync("Could not open the prepared book", ex.Message);
                }
            }
            else
            {
                _pendingBookPath = request;
            }
        });
    }

    private string? TryTakeInstanceRequest()
    {
        if (_runtimeDir.Length == 0)
        {
            return null;
        }
        var path = AppPaths.InstanceRequestPath(_runtimeDir);
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            var book = document.RootElement.TryGetProperty("book", out var value)
                && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
            File.Delete(path);
            return book;
        }
        catch (Exception ex) when (ex is IOException or JsonException or KeyNotFoundException)
        {
            return null;
        }
    }

    private void RaiseWindow()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        if (NativeMethods.IsIconic(hwnd))
        {
            NativeMethods.ShowWindow(hwnd, 9); // SW_RESTORE
        }
        NativeMethods.SetForegroundWindow(hwnd);
        Activate();
    }

    private async Task ShowDialogAsync(string title, string message)
    {
        var dialog = new ContentDialog
        {
            Title = title,
            Content = message,
            CloseButtonText = "OK",
            XamlRoot = Content.XamlRoot,
        };
        try
        {
            await dialog.ShowAsync();
        }
        catch (Exception)
        {
            // The window may be closing; a dialog that cannot show is harmless.
        }
    }

    private void OnClosed()
    {
        SavePlacement();
        _host?.Stop();
        _host = null;
    }

    private void SavePlacement()
    {
        if (_runtimeDir.Length == 0 || AppWindow == null)
        {
            return;
        }
        var maximized = AppWindow.Presenter is OverlappedPresenter presenter
            && presenter.State == OverlappedPresenterState.Maximized;
        if (maximized)
        {
            WindowPlacement.Save(_runtimeDir, new WindowBounds(0, 0, MinWidth, MinHeight, Maximized: true));
            return;
        }
        WindowPlacement.Save(
            _runtimeDir,
            new WindowBounds(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height, Maximized: false));
    }
}

internal static partial class NativeMethods
{
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetForegroundWindow(nint hwnd);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool IsIconic(nint hwnd);

    [LibraryImport("user32.dll")]
    internal static partial void ShowWindow(nint hwnd, int command);

    [LibraryImport("user32.dll", EntryPoint = "MessageBoxW", StringMarshalling = StringMarshalling.Utf16)]
    internal static partial int MessageBoxW(nint window, string text, string caption, int type);
}
