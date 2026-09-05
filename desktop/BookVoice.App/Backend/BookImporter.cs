using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;

namespace BookVoice.App.Backend;

/// <summary>Streams a .bookvoice archive into the running backend (POST /api/books).</summary>
internal static class BookImporter
{
    public static async Task<string> ImportAsync(string baseUrl, string archivePath)
    {
        if (!archivePath.EndsWith(".bookvoice", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(archivePath))
        {
            throw new InvalidOperationException(
                "The prepared-book file does not exist or is not a .bookvoice archive.");
        }
        try
        {
            using var form = new MultipartFormDataContent();
            var stream = File.OpenRead(archivePath);
            await using (stream.ConfigureAwait(false))
            {
                var fileContent = new StreamContent(stream, 1024 * 1024);
                fileContent.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
                form.Add(fileContent, "file", Path.GetFileName(archivePath));
                using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(300) };
                using var response = await client.PostAsync($"{baseUrl}/api/books", form).ConfigureAwait(false);
                var payload = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                using var document = JsonDocument.Parse(payload);
                if (!response.IsSuccessStatusCode)
                {
                    throw new InvalidOperationException(DetailMessage(document) ?? "The prepared book could not be imported.");
                }
                var id = document.RootElement.GetProperty("id").GetString() ?? "";
                if (id.Length != 64)
                {
                    throw new InvalidOperationException("The backend returned an invalid prepared-book identity.");
                }
                return id;
            }
        }
        catch (JsonException)
        {
            throw new InvalidOperationException("The backend returned an unreadable response while importing the book.");
        }
    }

    private static string? DetailMessage(JsonDocument document) =>
        document.RootElement.ValueKind == JsonValueKind.Object
        && document.RootElement.TryGetProperty("detail", out var detail)
        && detail.ValueKind == JsonValueKind.Object
        && detail.TryGetProperty("message", out var message)
        ? message.GetString()
        : null;
}
