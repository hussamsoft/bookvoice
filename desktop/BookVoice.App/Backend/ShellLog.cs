using System.IO;

namespace BookVoice.App.Backend;

/// <summary>Minimal shell-side diagnostics log (bookvoice_shell.log in the runtime dir).</summary>
internal static class ShellLog
{
    private const long MaxLogBytes = 5L * 1024 * 1024;
    private static readonly object Gate = new();
    public static string? Dir { get; set; }

    public static void Write(string message)
    {
        if (Dir == null)
        {
            return;
        }
        try
        {
            lock (Gate)
            {
                var path = Path.Combine(Dir, "bookvoice_shell.log");
                var info = new FileInfo(path);
                if (info.Exists && info.Length > MaxLogBytes)
                {
                    var prev = path + ".prev";
                    if (File.Exists(prev))
                    {
                        File.Delete(prev);
                    }
                    File.Move(path, prev);
                }
                File.AppendAllText(
                    path,
                    $"{DateTime.Now:yyyy-MM-ddTHH:mm:ss.fff} {message}{Environment.NewLine}");
            }
        }
        catch (IOException)
        {
        }
    }
}
