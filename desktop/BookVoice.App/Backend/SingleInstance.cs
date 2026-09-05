namespace BookVoice.App.Backend;

/// <summary>
/// One desktop shell per machine: the shell owns the backend, so a second
/// launch signals the running one (optionally handing it a .bookvoice to
/// import) and exits, like a well-behaved single-window document app.
/// </summary>
internal static class SingleInstance
{
    private const string MutexName = "Local\\BookVoice.DesktopShell";
    public const string EventName = "Local\\BookVoice.ShowWindow";

    private static Mutex? _mutex;

    public static bool TryAcquire()
    {
        var mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
        if (createdNew)
        {
            _mutex = mutex;
            return true;
        }
        mutex.Dispose();
        return false;
    }

    public static void SignalExisting()
    {
        try
        {
            using var evt = new EventWaitHandle(false, EventResetMode.AutoReset, EventName);
            evt.Set();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or WaitHandleCannotBeOpenedException)
        {
        }
    }

    /// <summary>Invoke <paramref name="callback"/> on the listener thread each time another instance signals.</summary>
    public static void Listen(Action callback)
    {
        var thread = new Thread(() =>
        {
            try
            {
                using var evt = new EventWaitHandle(false, EventResetMode.AutoReset, EventName);
                while (evt.WaitOne())
                {
                    callback();
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or WaitHandleCannotBeOpenedException)
            {
            }
        })
        {
            IsBackground = true,
            Name = "BookVoiceInstanceListener",
        };
        thread.Start();
    }
}
