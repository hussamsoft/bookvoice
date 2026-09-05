using System.Diagnostics;
using System.IO;
using System.Net.Http;
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
    private readonly HttpClient _http = new() { Timeout = Timeout.InfiniteTimeSpan };
    private readonly object _logLock = new();
    private FileStream? _logStream;
    private Process? _process;
    private CancellationTokenSource? _cts;
    private int _restarts;
    private bool _spawnedOnce;

    public BackendHost(string appDir, string runtimeDir)
    {
        _appDir = appDir;
        _runtimeDir = runtimeDir;
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
            try { File.Delete(statePath); } catch (IOException) { }

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
            // Stopped() cancels the token; the process tree is killed by Stop().
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
        _restarts++;
        if (_restarts > MaxRestarts)
        {
            Fail("Reading service kept failing; gave up after 5 restarts.");
            return false;
        }
        LogLine($"watchdog: {reason}; restart {_restarts}/{MaxRestarts}");
        StatusChanged?.Invoke(
            "Restarting reading service", "The reading engine stopped responding; restarting…", 65, false);
        KillTree();
        return true;
    }

    private void Spawn(string python, CancellationToken ct, bool rotateLog)
    {
        var logPath = AppPaths.ServerLogPath(_runtimeDir);
        if (rotateLog)
        {
            RotateLog(logPath);
        }
        _logStream?.Dispose();
        _logStream = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.Read);

        var psi = new ProcessStartInfo
        {
            FileName = python,
            WorkingDirectory = _appDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add(Path.Combine(_appDir, "serve_bookvoice.py"));
        psi.ArgumentList.Add("--host");
        psi.ArgumentList.Add("127.0.0.1");
        psi.Environment["PYTHONUTF8"] = "1";
        psi.Environment["PYTHONIOENCODING"] = "utf-8";
        psi.Environment["PYTHONNOUSERSITE"] = "1";

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
        catch (Exception)
        {
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
        lock (_logLock)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(
                    $"{DateTime.Now:yyyy-MM-ddTHH:mm:ss} {line}{Environment.NewLine}");
                _logStream!.Write(bytes, 0, bytes.Length);
                _logStream!.Flush();
            }
            catch (IOException)
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
                process.Kill(entireProcessTree: true);
            }
            process.WaitForExit(3000);
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
    }
}
