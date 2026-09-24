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
    // These are physical pixels (Win32 window size), so a 250% DPI monitor
    // may surface a window that looks larger than expected; the values are
    // a usability floor, not a hard cap.
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
    // Last non-maximized window rect; updated on every AppWindow.Changed
    // event while not maximized. Used by SavePlacement so the maximize-
    // then-close path persists the user's real pre-maximize rect instead
    // of the (0, 0, MinWidth, MinHeight) placeholder (audit C-8).
    private WindowBounds? _lastNormalBounds;
    private bool _isClosing;

    public MainWindow()
    {
        InitializeComponent();
        Title = "BookVoice";
        Closed += (_, _) => OnClosed();
        ResolvePaths();
        ConfigureBackdrop();
        ConfigureWindow();
        if (AppWindow != null)
        {
            // Runtime monitor changes (laptop dock, screen swap) can move
            // the window off-screen; clamp on the next Changed event.
            AppWindow.Changed += OnAppWindowChanged;
        }
    }

    private void ConfigureBackdrop()
    {
        try
        {
            // Apply the backdrop before the window is shown so the first
            // frame paints with Mica instead of falling back to the system
            // backdrop and then switching.
            SystemBackdrop = new MicaBackdrop();
        }
        catch (Exception ex)
        {
            ShellLog.Write($"mica backdrop init failed: {ex.Message}");
            // Mica needs Windows 11; the default backdrop is fine on Windows 10.
        }
    }

    private void OnAppWindowChanged(AppWindow sender, AppWindowChangedEventArgs args)
    {
        if (!args.DidPositionChange && !args.DidSizeChange)
        {
            return;
        }
        // Track the user's last non-maximized rect for SavePlacement.
        var maximized = sender.Presenter is OverlappedPresenter p
            && p.State == OverlappedPresenterState.Maximized;
        if (!maximized)
        {
            _lastNormalBounds = new WindowBounds(
                sender.Position.X,
                sender.Position.Y,
                sender.Size.Width,
                sender.Size.Height,
                Maximized: false);
        }
        // Audit finding C-9: clamp against the display the window is
        // actually on, not always the Primary display. A window on a
        // secondary monitor that briefly drifts outside Primary would
        // otherwise be teleported into Primary.
        var displayArea = ResolveWorkAreaFor(sender);
        var work = displayArea.WorkArea;
        var pos = sender.Position;
        var size = sender.Size;
        if (pos.X < work.X - 32 || pos.Y < work.Y - 32
            || pos.X + size.Width > work.X + work.Width + 32
            || pos.Y + size.Height > work.Y + work.Height + 32)
        {
            // Off-screen: re-clamp into the window's current display so
            // the window remains reachable.
            var width = Math.Min(size.Width, work.Width);
            var height = Math.Min(size.Height, work.Height);
            var x = Math.Clamp(pos.X, work.X, work.X + Math.Max(0, work.Width - width));
            var y = Math.Clamp(pos.Y, work.Y, work.Y + Math.Max(0, work.Height - height));
            sender.MoveAndResize(new RectInt32(x, y, width, height));
        }
    }

    private static DisplayArea ResolveWorkAreaFor(AppWindow window)
    {
        // The window may be on a non-primary monitor. Find the
        // display that currently contains the window's center; fall
        // back to Primary when no display claims the window (e.g.
        // between monitors during a drag).
        var center = new PointInt32(
            window.Position.X + window.Size.Width / 2,
            window.Position.Y + window.Size.Height / 2);
        var areas = DisplayArea.FindAll();
        for (var i = 0; i < areas.Count; i++)
        {
            var area = areas[i];
            if (RectContains(area.WorkArea, center.X, center.Y))
            {
                return area;
            }
        }
        return DisplayArea.Primary;
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
        catch (IOException ex)
        {
            ShellLog.Write($"create runtime directory failed: {ex.Message}");
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
        catch (Exception ex)
        {
            ShellLog.Write($"set window icon failed: {ex.Message}");
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
        catch (NotSupportedException ex)
        {
            ShellLog.Write($"set presenter minimum size failed: {ex.Message}");
        }

        var saved = _runtimeDir.Length == 0 ? null : WindowPlacement.Load(_runtimeDir);
        var work = ResolveWorkArea(saved);
        var bounds = saved ?? DefaultBounds(work);
        var width = Math.Min(bounds.Width, work.Width);
        var height = Math.Min(bounds.Height, work.Height);
        var x = Math.Clamp(bounds.X, work.X, work.X + Math.Max(0, work.Width - width));
        var y = Math.Clamp(bounds.Y, work.Y, work.Y + Math.Max(0, work.Height - height));
        if (bounds.Maximized)
        {
            // Cast is null-safe: when the window is configured with a
            // different presenter kind, Maximize is skipped silently.
            (AppWindow.Presenter as OverlappedPresenter)?.Maximize();
        }
        else
        {
            AppWindow.MoveAndResize(new RectInt32(x, y, width, height));
        }
    }

    private static RectInt32 ResolveWorkArea(WindowBounds? saved)
    {
        if (saved is { } bounds)
        {
            // Find the display that currently contains the saved rectangle;
            // falls back to Primary when the saved position is off-screen
            // (e.g. a monitor was removed between runs).
            var areas = DisplayArea.FindAll();
            for (var i = 0; i < areas.Count; i++)
            {
                var area = areas[i];
                var work = area.WorkArea;
                if (RectContains(work, bounds.X, bounds.Y)
                    || RectContains(work, bounds.X + bounds.Width, bounds.Y + bounds.Height))
                {
                    return work;
                }
            }
        }
        return DisplayArea.Primary.WorkArea;
    }

    private static bool RectContains(RectInt32 rect, int x, int y) =>
        x >= rect.X && x < rect.X + rect.Width && y >= rect.Y && y < rect.Y + rect.Height;

    /// <summary>
    /// First-launch size: about 65% of the monitor's work area, centered.
    /// Displays too small for every element to compress to that scale get
    /// the UI floor instead (MinWidth/MinHeight).
    /// </summary>
    private static WindowBounds DefaultBounds(RectInt32 work)
    {
        // Round to nearest so a 1366px work area gives 887 (not 887 from
        // integer truncation) and similar edge cases.
        var width = Math.Max(MinWidth, (int)Math.Round(work.Width * 0.65));
        var height = Math.Max(MinHeight, (int)Math.Round(work.Height * 0.65));
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
        // BackendHost raises events from background tasks (pump loop,
        // watchdog). Touching XAML from a thread-pool thread is unsafe on
        // WinUI 3; marshal to the UI thread before mutating controls.
        _ = DispatcherQueue.TryEnqueue(() => UpdateSplash(title, detail, percent, indeterminate));
    }

    private void UpdateSplash(string title, string detail, int percent, bool indeterminate)
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

    private void OnReady(ServerStateInfo state)
    {
        // Marshal to UI thread so all XAML access is single-threaded.
        _ = DispatcherQueue.TryEnqueue(async () => await OnReadyAsync(state));
    }

    private async Task OnReadyAsync(ServerStateInfo state)
    {
        if (_isClosing)
        {
            return;
        }
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
                if (_isClosing)
                {
                    return;
                }
                url += $"?book={id}";
            }
            catch (Exception ex)
            {
                if (_isClosing)
                {
                    return;
                }
                await ShowDialogAsync("Could not open the prepared book", ex.Message);
            }
        }

        if (_isClosing)
        {
            return;
        }
        if (state.Book is { } serverBook && url == baseUrl)
        {
            url += $"?book={serverBook}";
        }

        try
        {
            await ShowContentAsync(url);
        }
        catch (Exception) when (_isClosing)
        {
            ShellLog.Write("content initialization cancelled during shutdown");
        }
        catch (Exception ex)
        {
            ShellLog.Write($"show content failed:{Environment.NewLine}{ex}");
            ShowError("The reading engine reached the ready state but the interface could not open.", ex.Message);
        }
    }

    private async Task ShowContentAsync(string url)
    {
        if (_isClosing)
        {
            return;
        }
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
                if (_isClosing)
                {
                    return;
                }
                await Web.EnsureCoreWebView2Async(environment);
                if (_isClosing)
                {
                    return;
                }
                var core = Web.CoreWebView2;
                if (core is null)
                {
                    throw new InvalidOperationException("WebView2 core is unavailable after initialization.");
                }
                _webViewReady = true;
                core.NavigationCompleted += (_, navArgs) => OnNavigationCompleted(navArgs);
                // The shell is an app frame, not a browser: links that ask for
                // a new window (target=_blank, external docs) go to the
                // system's default browser instead of being swallowed.
                core.NewWindowRequested += (_, newWindowArgs) =>
                {
                    newWindowArgs.Handled = true;
                    if (_isClosing)
                    {
                        return;
                    }
                    var uriText = newWindowArgs.Uri;
                    if (uriText == null)
                    {
                        return;
                    }
                    if (!Uri.TryCreate(uriText, UriKind.Absolute, out var uri))
                    {
                        ShellLog.Write($"new-window request ignored: invalid URI {uriText}");
                        return;
                    }
                    if (!IsAllowedExternalScheme(uri.Scheme))
                    {
                        ShellLog.Write($"new-window request blocked: scheme '{uri.Scheme}' is not in the allow-list ({uri})");
                        return;
                    }
                    try
                    {
                        Process.Start(
                            new ProcessStartInfo(uri.ToString())
                            {
                                UseShellExecute = true,
                            });
                    }
                    catch (Exception ex)
                    {
                        ShellLog.Write($"new-window request failed for {uri}: {ex.Message}");
                    }
                };
            }
            catch (Exception) when (_isClosing)
            {
                ShellLog.Write("webview initialization cancelled during shutdown");
                return;
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

        if (_isClosing)
        {
            return;
        }
        SplashPanel.Visibility = Visibility.Collapsed;
        ErrorPanel.Visibility = Visibility.Collapsed;
        ContentPanel.Visibility = Visibility.Visible;
        _contentShown = true;
        Web.Source = new Uri(url);
    }

    private void OnNavigationCompleted(CoreWebView2NavigationCompletedEventArgs args)
    {
        if (_isClosing || args.IsSuccess)
        {
            return;
        }
        if (args.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled)
        {
            ShellLog.Write(
                $"webview navigation canceled: id={args.NavigationId} http={args.HttpStatusCode}");
            return;
        }
        ShellLog.Write(
            $"webview navigation failed: status={args.WebErrorStatus} "
            + $"http={args.HttpStatusCode} id={args.NavigationId}");
        ShowError($"The app page failed to load ({args.WebErrorStatus}).", _host?.ReadLogTail());
    }

    private void OnFailed(string message)
    {
        // Marshal to UI thread before mutating XAML. The TryEnqueue bool
        // is intentionally discarded: if the dispatcher is shutting down,
        // there is no UI to update and the error will resurface through
        // the next process start.
        _ = DispatcherQueue.TryEnqueue(() =>
        {
            ShellLog.Write($"backend host reported failure: {message}");
            ShowError(message, _host?.ReadLogTail());
        });
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
        if (_isClosing)
        {
            return;
        }
        ErrorMessage.Text = SanitizeErrorMessage(message);
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

    private static string SanitizeErrorMessage(string message)
    {
        if (string.IsNullOrEmpty(message))
        {
            return "Something went wrong while starting BookVoice.";
        }
        // Truncate exception stack traces to the first line so the user
        // sees only what is actionable; full detail is in the log tail.
        var firstLine = message.Split('\n', 2)[0].Trim();
        if (firstLine.Length > 240)
        {
            firstLine = firstLine[..240] + "…";
        }
        return firstLine;
    }

    private void OnRetryClick(object sender, RoutedEventArgs e)
    {
        // Audit finding C-19: unsubscribe events before disposing so
        // an in-flight RunAsync task can't dispatch to a stale _host.
        // Dispose calls Stop which cancels the CTS, but the event
        // handlers are still wired to this MainWindow.
        if (_host is not null)
        {
            _host.StatusChanged -= OnStatus;
            _host.BecameReady -= OnReady;
            _host.Failed -= OnFailed;
            _host.Dispose();
            _host = null;
        }
        StartBackend();
    }

    private void OnOpenLogsClick(object sender, RoutedEventArgs e)
    {
        var folder = _runtimeDir.Length == 0 ? AppPaths.LegacyRuntimeDir() : _runtimeDir;
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{folder}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            ShellLog.Write($"open log folder failed: {ex.Message}");
            // Explorer launch is best-effort; the folder path is stable.
        }
    }

    private void OnCloseClick(object sender, RoutedEventArgs e) => Close();

    private void OnSplashImageFailed(object sender, ExceptionRoutedEventArgs e)
    {
        // A missing Assets/bookvoice.png just collapses the splash icon;
        // log it once and keep the splash usable with the title only.
        ShellLog.Write($"splash image failed to load: {e.ErrorMessage}");
        ((Image)sender).Visibility = Visibility.Collapsed;
    }

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
        if (_isClosing)
        {
            return;
        }
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
        catch (Exception ex)
        {
            ShellLog.Write($"dialog show failed: {ex.Message}");
            // The window may be closing; a dialog that cannot show is harmless.
        }
    }

    private void OnClosed()
    {
        _isClosing = true;
        SavePlacement();
        _host?.Dispose();
        _host = null;
    }

    private static bool IsAllowedExternalScheme(string? scheme)
    {
        if (string.IsNullOrEmpty(scheme))
        {
            return false;
        }
        // Lower-case compare; Uri.Scheme is already normalized but be defensive.
        return scheme.ToLowerInvariant() switch
        {
            "http" => true,
            "https" => true,
            "mailto" => true,
            _ => false,
        };
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
            // Audit finding C-8: persist the user's last non-maximized
            // rect (tracked in OnAppWindowChanged while not maximized)
            // instead of the (0, 0, MinWidth, MinHeight) placeholder,
            // which would make the next launch open at the floor size.
            // Fall back to the prior persisted rect if we have not
            // observed a non-maximized position in this session (the
            // user opened the app already maximized).
            var restore = _lastNormalBounds
                ?? WindowPlacement.Load(_runtimeDir)
                ?? new WindowBounds(0, 0, MinWidth, MinHeight, Maximized: false);
            WindowPlacement.Save(_runtimeDir, restore with { Maximized = true });
            return;
        }
        var current = new WindowBounds(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height, Maximized: false);
        _lastNormalBounds = current;
        WindowPlacement.Save(_runtimeDir, current);
    }

    private float GetDpiScale()
    {
        try
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
            var dpi = NativeMethods.GetDpiForWindow(hwnd);
            return dpi > 0 ? dpi / 96f : 1f;
        }
        catch (Exception)
        {
            return 1f;
        }
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

    [LibraryImport("user32.dll")]
    internal static partial uint GetDpiForWindow(nint hwnd);
}
