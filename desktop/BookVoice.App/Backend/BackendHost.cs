using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;

namespace BookVoice.App.Backend;

/// <summary>
/// Owns the backend process: spawns the packaged worker running
/// serve_bookvoice.py, waits for its ready state, then watchdogs the running
/// server exactly like launch.py does — a LAN client aborting a connection
/// mid-accept can kill uvicorn's Windows accept loop, so sustained health
/// failure restarts it (up to five times).
/// </summary>
internal sealed class BackendHost : IDisposable
{
    public const int MaxRestarts = 5;

    /// <summary>Raised on the caller's context: title, detail, percent, indeterminate.</summary>
    public event Action<string, string, int, bool>? StatusChanged;

    /// <summary>The server answered and is ready to serve the UI.</summary>
    public event Action<ServerStateInfo>? BecameReady;

    /// <summary>A fatal problem; the string is user-presentable.</summary>
    public event Action<string>? Failed;

    private readonly string _appDir;
    private readonly string _runtimeDir;
    private readonly IReadOnlyList<string> _passthroughArgs;
    private readonly HttpClient _http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly SemaphoreSlim _logWriteGate = new(1, 1);
    private FileStream? _logStream;
    private Process? _process;
    private CancellationTokenSource? _cts;
    private int _restarts;
    private bool _spawnedOnce;

    public BackendHost(string appDir, string runtimeDir, IReadOnlyList<string>? passthroughArgs = null)
    {
        _appDir = appDir;
        _runtimeDir = runtimeDir;
        _passthroughArgs = passthroughArgs ?? Array.Empty<string>();
    }

    public void Run()
    {
        _cts = new CancellationTokenSource();
        _ = RunAsync(_cts.Token);
    }

    private async Task RunAsync(CancellationToken ct)
    {
        try
        {
            StatusChanged?.Invoke("Checking runtime", "Verifying the bundled reading engine…", 10, false);
            var payloadError = AppPaths.ValidatePackage(_appDir);
            if (payloadError != null)
            {
                Fail(payloadError);
                return;
            }
            var python = Path.Combine(_appDir, "runtime", "worker", "python.exe");
            if (!File.Exists(python))
            {
                Fail("The packaged reading engine is incomplete. Reinstall BookVoice.");
                return;
            }

            var statePath = AppPaths.ServerStatePath(_runtimeDir);
            try { File.Delete(statePath); } catch (IOException ex)
            {
                ShellLog.Write($"delete state file failed: {ex.Message}");
            }

            while (!ct.IsCancellationRequested)
            {
                Spawn(python, ct, rotateLog: !_spawnedOnce);
                _spawnedOnce = true;

                StatusChanged?.Invoke(
                    "Starting reading service", "Launching the local reading engine…", 45, false);
                var ready = await WaitForReadyAsync(statePath, ct);
                if (ct.IsCancellationRequested)
                {
                    return;
                }
                if (ready == null)
                {
                    if (!Restart("the reading service failed to start"))
                    {
                        return;
                    }
                    continue;
                }

                StatusChanged?.Invoke(
                    "Loading reading engine", "Waiting for voices and media tools…", 72, false);
                BecameReady?.Invoke(ready);

                var misses = 0;
                var watchReason = "";
                while (!ct.IsCancellationRequested)
                {
                    await Task.Delay(5000, ct);
                    if (_process == null || _process.HasExited)
                    {
                        watchReason = "the reading service exited";
                        break;
                    }
                    if (await HealthOkAsync(ready.Port ?? 0))
                    {
                        misses = 0;
                    }
                    else if (++misses >= 6)
                    {
                        watchReason = "the reading service stopped answering health checks";
                        break;
                    }
                }
                if (ct.IsCancellationRequested)
                {
                    return;
                }
                if (!Restart(watchReason))
                {
                    return;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Stopped() cancels the token; Stop() requests graceful shutdown before its kill fallback.
        }
        catch (Exception ex)
        {
            ShellLog.Write($"backend host failed:{Environment.NewLine}{ex}");
            Fail(ex.Message);
        }
    }

    /// <summary>Poll the launcher state file until ready or fatal; null means restartable startup death.</summary>
    private async Task<ServerStateInfo?> WaitForReadyAsync(string statePath, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(600);
        var announcedPort = false;
        var announcedTunnel = false;
        while (!ct.IsCancellationRequested && DateTime.UtcNow < deadline)
        {
            await Task.Delay(500, ct);
            if (_process == null || _process.HasExited)
            {
                Fail("Backend exited early");
                return null;
            }
            var state = ServerStateInfo.TryRead(statePath);
            switch (state?.State)
            {
                case "ready":
                    return state;
                case "error":
                    Fail(
                        string.IsNullOrEmpty(state.Error)
                            ? "The reading service could not start."
                            : state.Error!);
                    return null;
                default:
                    if (state?.Port is int port && !announcedPort)
                    {
                        announcedPort = true;
                        StatusChanged?.Invoke(
                            "Starting reading service",
                            $"Launching locally on {state.Host}:{port}…", 58, false);
                    }
                    if (!string.IsNullOrEmpty(state?.TunnelUrl) && !announcedTunnel)
                    {
                        announcedTunnel = true;
                        LogLine($"tunnel ready at {state.TunnelUrl}");
                    }
                    break;
            }
        }
        Fail("Backend did not become ready in time");
        return null;
    }

    private async Task<bool> HealthOkAsync(int port)
    {
        if (port <= 0)
        {
            return false;
        }
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            using var response = await _http.GetAsync(
                $"http://127.0.0.1:{port}/api/health", timeout.Token);
            return response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>Stop and respawn the backend; false when the restart budget is spent.</summary>
    private bool Restart(string reason)
    {
        // Cap-check before increment so the reported count matches what the
        // user actually saw and the final message is consistent with the log.
        if (_restarts >= MaxRestarts)
        {
            Fail($"Reading service kept failing; gave up after {MaxRestarts} restarts.");
            return false;
        }
        _restarts++;
        LogLine($"watchdog: {reason}; restart {_restarts}/{MaxRestarts}");
        StatusChanged?.Invoke(
            "Restarting reading service", "The reading engine stopped responding; restarting…", 65, false);
        KillTree();
        return true;
    }

    private void Spawn(string python, CancellationToken ct, bool rotateLog)
    {
        var logPath = AppPaths.ServerLogPath(_runtimeDir);
        // Wait for any in-flight pump writes to finish before swapping the
        // underlying stream; the async pumps continue using the new handle.
        _logWriteGate.Wait();
        try
        {
            if (rotateLog)
            {
                RotateLog(logPath);
            }
            _logStream?.Dispose();
            _logStream = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        }
        finally
        {
            _logWriteGate.Release();
        }

        var psi = new ProcessStartInfo
        {
            FileName = python,
            WorkingDirectory = _appDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            CreateNoWindow = false,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add(Path.Combine(_appDir, "serve_bookvoice.py"));
        psi.ArgumentList.Add("--host");
        psi.ArgumentList.Add("127.0.0.1");
        foreach (var arg in _passthroughArgs)
        {
            psi.ArgumentList.Add(arg);
        }
        psi.Environment["PYTHONUTF8"] = "1";
        psi.Environment["PYTHONIOENCODING"] = "utf-8";
        psi.Environment["PYTHONNOUSERSITE"] = "1";
        if (AppPaths.IsPortable())
        {
            psi.Environment["BOOKVOICE_PORTABLE"] = "1";
        }

        LogLine($"==== desktop shell start (pid {Environment.ProcessId}) ====");
        _process = Process.Start(psi);
        if (_process == null)
        {
            Fail("The backend process could not be started.");
            return;
        }
        LogLine($"started serve pid={_process.Id}");
        _ = PumpAsync(_process.StandardOutput);
        _ = PumpAsync(_process.StandardError);
    }

    private async Task PumpAsync(StreamReader reader)
    {
        try
        {
            while (await reader.ReadLineAsync() is { } line)
            {
                LogLine(line);
            }
        }
        catch (Exception ex)
        {
            ShellLog.Write($"log pump ended: {ex.Message}");
            // Stream torn down with the process; the watchdog owns recovery.
        }
    }

    private void RotateLog(string logPath)
    {
        try
        {
            if (File.Exists(logPath))
            {
                var prev = logPath + ".prev";
                if (File.Exists(prev))
                {
                    File.Delete(prev);
                }
                File.Move(logPath, prev);
            }
        }
        catch (IOException)
        {
        }
    }

    private void LogLine(string line)
    {
        try
        {
            _logWriteGate.Wait();
        }
        catch (ObjectDisposedException)
        {
            ShellLog.Write(line);
            return;
        }
        try
        {
            if (_logStream == null)
            {
                // Validation can fail before Spawn opens the server log.
                // Keep the failure visible to the shell and user instead of
                // dereferencing a stream that does not exist yet.
                ShellLog.Write(line);
                return;
            }
            var bytes = Encoding.UTF8.GetBytes(
                $"{DateTime.Now:yyyy-MM-ddTHH:mm:ss} {line}{Environment.NewLine}");
            _logStream.Write(bytes, 0, bytes.Length);
            _logStream.Flush();
        }
        catch (IOException)
        {
        }
        finally
        {
            try
            {
                _logWriteGate.Release();
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }

    private void KillTree()
    {
        var process = _process;
        _process = null;
        if (process == null)
        {
            return;
        }
        try
        {
            if (!process.HasExited)
            {
                // serve_bookvoice.py installs SIGINT/SIGBREAK handlers so
                // it can stop its child, tunnel, access file, and state file.
                // Keep the shell attached with an ignore attribute while the
                // wrapper exits so the control event cannot terminate us too.
                if (TrySendControlEvent(process))
                {
                    ShellLog.Write("backend graceful stop completed");
                    return;
                }
                if (!process.HasExited)
                {
                    ShellLog.Write("backend graceful stop failed; killing process tree");
                    process.Kill(entireProcessTree: true);
                }
                process.WaitForExit(3000);
            }
        }
        catch (Exception)
        {
            // The process may already be gone; nothing to recover.
        }
        try
        {
            process.Dispose();
        }
        catch (Exception)
        {
        }
    }

    private static bool TrySendControlEvent(Process process)
    {
        // GenerateConsoleCtrlEvent targets every process in group 0. Use a
        // short-lived helper so the interactive shell never receives its
        // own CTRL_BREAK while the helper attaches to the backend console.
        if (process.HasExited)
        {
            return true;
        }

        var executable = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executable))
        {
            ShellLog.Write("backend graceful stop could not locate the shell executable");
            return false;
        }

        var psi = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        psi.ArgumentList.Add("--signal-backend");
        psi.ArgumentList.Add(process.Id.ToString());
        try
        {
            using var helper = Process.Start(psi);
            if (helper == null)
            {
                ShellLog.Write("backend graceful stop helper did not start");
                return false;
            }
            ShellLog.Write("backend graceful stop requested");
            if (!helper.WaitForExit(5000))
            {
                helper.Kill(entireProcessTree: true);
                ShellLog.Write("backend graceful stop helper timed out");
                return false;
            }
            if (!process.WaitForExit(5000))
            {
                ShellLog.Write("backend graceful stop timed out");
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            ShellLog.Write($"backend graceful stop signal failed: {ex.Message}");
            return false;
        }
    }

    private void Fail(string message)
    {
        LogLine($"fatal: {message.ReplaceLineEndings(" | ")}");
        Failed?.Invoke(message);
    }

    public string ReadLogTail(int lines = 25)
    {
        var path = AppPaths.ServerLogPath(_runtimeDir);
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var tail = new Queue<string>();
            while (reader.ReadLine() is { } line)
            {
                if (tail.Count == lines)
                {
                    tail.Dequeue();
                }
                tail.Enqueue(line);
            }
            return string.Join(Environment.NewLine, tail);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return "(the server log could not be read)";
        }
    }

    public void Stop()
    {
        try
        {
            _cts?.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
        KillTree();
    }

    public void Dispose()
    {
        Stop();
        _http.Dispose();
        _logStream?.Dispose();
        _logWriteGate.Dispose();
    }
}

internal static partial class NativeMethods
{
    internal const uint CTRL_BREAK_EVENT = 1;

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool AttachConsole(uint dwProcessId);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool FreeConsole();

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);

    internal static bool SendCtrlBreak(uint processId)
    {
        NativeMethods.FreeConsole();
        if (!NativeMethods.AttachConsole(processId))
        {
            return false;
        }
        if (!NativeMethods.SetConsoleCtrlHandler(IgnoreControlHandler, true))
        {
            NativeMethods.FreeConsole();
            return false;
        }
        try
        {
            return NativeMethods.GenerateConsoleCtrlEvent(
                NativeMethods.CTRL_BREAK_EVENT, 0);
        }
        finally
        {
            NativeMethods.SetConsoleCtrlHandler(IgnoreControlHandler, false);
            NativeMethods.FreeConsole();
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int ConsoleControlHandler(uint controlType);

    private static readonly ConsoleControlHandler IgnoreControlHandlerDelegate =
        IgnoreConsoleControl;
    private static readonly nint IgnoreControlHandler =
        Marshal.GetFunctionPointerForDelegate(IgnoreControlHandlerDelegate);

    [LibraryImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetConsoleCtrlHandler(
        nint handlerRoutine,
        [MarshalAs(UnmanagedType.Bool)] bool add);

    private static int IgnoreConsoleControl(uint controlType) => 1;

}
