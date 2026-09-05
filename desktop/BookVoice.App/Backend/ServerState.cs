using System.IO;
using System.Text.Json;

namespace BookVoice.App.Backend;

/// <summary>The launcher state serve_bookvoice.py publishes while it runs.</summary>
internal sealed record ServerStateInfo(
    string State,
    string? Host,
    int? Port,
    string? Book,
    string? Error,
    string? TunnelUrl = null)
{
    public static ServerStateInfo? TryRead(string path)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            var root = document.RootElement;
            return new ServerStateInfo(
                State: StringOrNull(root, "state") ?? "",
                Host: StringOrNull(root, "host"),
                Port: root.TryGetProperty("port", out var port)
                        && port.ValueKind == JsonValueKind.Number
                        && port.TryGetInt32(out var p)
                    ? p
                    : null,
                Book: StringOrNull(root, "book"),
                Error: StringOrNull(root, "error"),
                TunnelUrl: StringOrNull(root, "tunnelUrl"));
        }
        catch (Exception ex) when (ex is IOException or JsonException)
        {
            // Written atomically via os.replace, but a torn read is still
            // possible between the tmp write and the rename — treat as absent.
            return null;
        }
    }

    private static string? StringOrNull(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
