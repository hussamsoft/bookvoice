using System.IO;

namespace BookVoice.App.Backend;

/// <summary>Minimal shell-side diagnostics log (bookvoice_shell.log in the runtime dir).</summary>
internal static class ShellLog
{
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
                File.AppendAllText(
                    Path.Combine(Dir, "bookvoice_shell.log"),
                    $"{DateTime.Now:yyyy-MM-ddTHH:mm:ss.fff} {message}{Environment.NewLine}");
            }
        }
        catch (IOException)
        {
        }
    }
}
