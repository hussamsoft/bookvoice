using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace BookVoice.App.Backend;

/// <summary>
/// Resolves the application payload and writable runtime locations.
/// Mirrors launch.resolve_app_dir / resolve_runtime_dir / install_id so the
/// desktop shell and the Python launcher share one runtime directory
/// (sessions, voice library, logs, config).
/// </summary>
internal static class AppPaths
{
    /// <summary>The packaged app directory, or null when the payload is absent.</summary>
    public static string? FindAppDir()
    {
        var exeDir = AppContext.BaseDirectory;
        if (LooksLikeAppDir(exeDir))
        {
            return exeDir;
        }
        var parent = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(exeDir));
        if (parent != null && LooksLikeAppDir(parent))
        {
            return parent;
        }
        return null;
    }

    public static bool LooksLikeAppDir(string path) =>
        File.Exists(Path.Combine(path, "main.py")) && Directory.Exists(Path.Combine(path, "static"));

    /// <summary>Reproduce launch.validate_package's payload checks.</summary>
    public static string? ValidatePackage(string appDir)
    {
        if (!File.Exists(Path.Combine(appDir, "main.py")))
        {
            return $"main.py missing in:\n{appDir}";
        }
        if (!File.Exists(Path.Combine(appDir, "static", "index.html")))
        {
            return "static/index.html missing — run python build.py";
        }
        if (!File.Exists(Path.Combine(appDir, "data", "models", "en", "tokenizer.json")))
        {
            return "Bundled English TTS models missing (data/models/en/).\nRebuild from full source: python build.py";
        }
        return null;
    }

    /// <summary>
    /// App version, preferring git describe exactly like launch.read_app_version
    /// (git searches parent directories, so a dist inside a checkout resolves a
    /// commit-level version and lands in the same runtime dir as the Python
    /// side). Without git — the packaged case — the VERSION file decides.
    /// </summary>
    // Cached result of ReadVersion. ReadVersion can stall for up to 2 s
    // when git is slow or missing (audit finding C-6). It is called from
    // MainWindow.ConfigureWindow and MainWindow.ResolvePaths — both on
    // the UI thread — so we cache the result after the first call. The
    // appdir is fixed for the lifetime of the process (MainWindow
    // resolves it once in the constructor), so this is safe.
    private static string? _cachedVersion;
    private static string? _cachedVersionAppDir;

    public static string ReadVersion(string appDir)
    {
        if (_cachedVersion is not null && _cachedVersionAppDir == appDir)
        {
            return _cachedVersion;
        }
        var version = ReadVersionUncached(appDir);
        _cachedVersion = version;
        _cachedVersionAppDir = appDir;
        return version;
    }

    private static string ReadVersionUncached(string appDir)
    {
        try
        {
            var psi = new ProcessStartInfo("git", "describe --tags --dirty --always")
            {
                WorkingDirectory = appDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var process = Process.Start(psi);
            var output = process?.StandardOutput.ReadToEnd().Trim() ?? "";
            process?.WaitForExit(2000);
            if (process?.ExitCode == 0 && output.Length > 0)
            {
                return output.StartsWith("v", StringComparison.Ordinal) ? output[1..] : output;
            }
        }
        catch (Exception ex) when (ex is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // No git on PATH or not a checkout; the VERSION file decides below.
        }
        try
        {
            return File.ReadAllText(Path.Combine(appDir, "VERSION")).Trim();
        }
        catch (IOException)
        {
            return "0.0.0";
        }
    }

    public static string LegacyRuntimeDir() =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "BookVoice");

    public static bool IsPortable()
    {
        if (string.Equals(Environment.GetEnvironmentVariable("BOOKVOICE_PORTABLE")?.Trim().ToLowerInvariant(), "1")
            || IsTruthy(Environment.GetEnvironmentVariable("BOOKVOICE_PORTABLE")))
        {
            return true;
        }
        // A layout marker in the exe directory declares the install portable
        // without forcing the launcher to set an environment variable.
        try
        {
            var marker = Path.Combine(AppContext.BaseDirectory, "portable.txt");
            return File.Exists(marker);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static bool IsTruthy(string? value) =>
        value is not null && value.Trim().ToLowerInvariant() is "true" or "yes";

    public static string RuntimeDir(string appDir)
    {
        if (IsPortable())
        {
            return Path.Combine(appDir, ".bookvoice");
        }
        var id = InstallId(appDir, ReadVersion(appDir));
        return Path.Combine(LegacyRuntimeDir(), "installs", id);
    }

    /// <summary>sha256(normcase(abs(appDir))|version)[:12], as launch.install_id.</summary>
    public static string InstallId(string appDir, string version)
    {
        var normalized = Path.GetFullPath(appDir).ToLowerInvariant().Replace('/', '\\');
        var payload = $"{normalized}|{version.Trim()}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(payload));
        return Convert.ToHexString(hash)[..12].ToLowerInvariant();
    }

    public static string ServerLogPath(string runtimeDir) => Path.Combine(runtimeDir, "bookvoice_server.log");
    public static string ServerStatePath(string runtimeDir) => Path.Combine(runtimeDir, "server-state.json");
    public static string WindowPlacementPath(string runtimeDir) => Path.Combine(runtimeDir, "window-placement.json");
    public static string InstanceRequestPath(string runtimeDir) => Path.Combine(runtimeDir, "instance-request.json");
    public static string WebViewDataPath(string runtimeDir) => Path.Combine(runtimeDir, "webview2");
}
