using Microsoft.Win32;

namespace BookVoice.App.Backend;

/// <summary>
/// Per-user .bookvoice file association (HKCU\Software\Classes), so the
/// portable payload can take double-clicked prepared books without an MSI.
/// Opt-in via BookVoice.exe --register-bookvoice; --unregister-bookvoice
/// removes it.
/// </summary>
internal static class BookVoiceFileAssociation
{
    private const string ProgId = "BookVoice.PreparedBook";

    public static string Apply(bool register)
    {
        try
        {
            var exe = Environment.ProcessPath
                ?? Path.Combine(AppContext.BaseDirectory, "BookVoice.exe");
            if (register)
            {
                using (var progId = Registry.CurrentUser.CreateSubKey($"Software\\Classes\\{ProgId}"))
                {
                    progId.SetValue(null, "BookVoice prepared book");
                    using var icon = progId.CreateSubKey("DefaultIcon");
                    icon.SetValue(null, $"\"{exe}\",0");
                    using var command = progId.CreateSubKey("shell\\open\\command");
                    command.SetValue(null, $"\"{exe}\" \"%1\"");
                }
                using var extension = Registry.CurrentUser.CreateSubKey("Software\\Classes\\.bookvoice");
                extension.SetValue(null, ProgId);
                return "BookVoice now opens .bookvoice files on double-click (for this user).";
            }
            Registry.CurrentUser.DeleteSubKeyTree($"Software\\Classes\\{ProgId}", throwOnMissingSubKey: false);
            using (var classes = Registry.CurrentUser.OpenSubKey("Software\\Classes", writable: true))
            {
                classes?.DeleteSubKeyTree(".bookvoice", throwOnMissingSubKey: false);
            }
            return "The .bookvoice file association was removed for this user.";
        }
        catch (Exception ex)
        {
            return $"The file association could not be changed:{Environment.NewLine}{ex.Message}";
        }
    }
}
