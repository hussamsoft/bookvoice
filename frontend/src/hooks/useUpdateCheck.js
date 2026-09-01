import { useCallback, useEffect, useRef, useState } from 'react';

import { downloadUpdate, getUpdateStatus, installUpdate } from '../utils/api';

const POLL_MS = 1500;

/**
 * Track whether a newer BookVoice exists and drive the download/install handoff.
 *
 * The check itself is cached on the server (once a day) and cannot throw a
 * network error into the UI, so this hook treats any failure as "nothing to
 * show" rather than surfacing it. An update someone cannot see is the bug this
 * closes; an error toast about GitHub being unreachable is not worth trading
 * for it.
 */
export function useUpdateCheck() {
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [dismissed, setDismissed] = useState(false);
    const pollRef = useRef(null);

    const refresh = useCallback(async ({ force = false } = {}) => {
        try {
            const next = await getUpdateStatus({ force });
            setStatus(next);
            return next;
        } catch {
            // Offline, or an older backend with no /api/updates. Either way
            // there is nothing useful to say, so stay silent.
            return null;
        }
    }, []);

    useEffect(() => {
        refresh();
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [refresh]);

    // While a download runs, poll until it settles so the button can move from
    // "Download" to "Restart and install" on its own.
    useEffect(() => {
        const state = status?.download?.state;
        if (state !== 'downloading') {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
            return undefined;
        }
        if (pollRef.current) return undefined;
        pollRef.current = setInterval(() => { refresh(); }, POLL_MS);
        return () => {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
        };
    }, [status?.download?.state, refresh]);

    const startDownload = useCallback(async () => {
        if (!status?.latest) return;
        setBusy(true);
        setError(null);
        try {
            await downloadUpdate(status.latest);
            await refresh();
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }, [status?.latest, refresh]);

    const startInstall = useCallback(async () => {
        if (!status?.latest) return;
        setBusy(true);
        setError(null);
        try {
            await installUpdate(status.latest);
            // Deliberately leave `busy` set: the backend exits a moment from
            // now, so re-enabling the button would only invite a second click
            // against a server that is going away.
            return true;
        } catch (err) {
            setError(err.message);
            setBusy(false);
            return false;
        }
    }, [status?.latest]);

    const ready = status?.download?.state === 'ready' || status?.staged === true;
    const downloading = status?.download?.state === 'downloading';
    const failed = status?.download?.state === 'failed';

    return {
        status,
        available: Boolean(status?.updateAvailable) && !dismissed,
        ready,
        downloading,
        failed,
        busy,
        error: error || (failed ? status?.download?.error : null),
        progress: downloading && status?.download?.total
            ? Math.min(1, (status.download.received || 0) / status.download.total)
            : 0,
        dismiss: () => setDismissed(true),
        refresh,
        startDownload,
        startInstall,
    };
}

export default useUpdateCheck;
