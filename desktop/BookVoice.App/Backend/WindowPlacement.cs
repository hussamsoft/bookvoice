using System.IO;
using System.Text.Json;

namespace BookVoice.App.Backend;

internal sealed record WindowBounds(int X, int Y, int Width, int Height, bool Maximized);

/// <summary>Persists the shell window's bounds between runs, clamped on restore.</summary>
internal static class WindowPlacement
{
    private const int DefaultWidth = 1440;
    private const int DefaultHeight = 900;

    public static WindowBounds Default() => new(0, 0, DefaultWidth, DefaultHeight, Maximized: false);

    public static WindowBounds? Load(string runtimeDir)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(runtimeDir, "window-placement.json")));
            var root = document.RootElement;
            return new WindowBounds(
                root.GetProperty("x").GetInt32(),
                root.GetProperty("y").GetInt32(),
                root.GetProperty("width").GetInt32(),
                root.GetProperty("height").GetInt32(),
                root.TryGetProperty("maximized", out var maximized) && maximized.GetBoolean());
        }
        catch (Exception ex) when (ex is IOException or JsonException or KeyNotFoundException or FormatException)
        {
            return null;
        }
    }

    public static void Save(string runtimeDir, WindowBounds bounds)
    {
        try
        {
            Directory.CreateDirectory(runtimeDir);
            var path = Path.Combine(runtimeDir, "window-placement.json");
            var tmp = path + ".tmp";
            var payload = JsonSerializer.Serialize(new
            {
                x = bounds.X,
                y = bounds.Y,
                width = bounds.Width,
                height = bounds.Height,
                maximized = bounds.Maximized,
            });
            File.WriteAllText(tmp, payload);
            File.Move(tmp, path, overwrite: true);
        }
        catch (IOException)
        {
        }
    }
}
