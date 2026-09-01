import React, { useState } from 'react';
import { Download, RefreshCw, X } from 'lucide-react';

import StatusBanner from './ui/StatusBanner';
import ConfirmDialog from './ui/ConfirmDialog';
import { useUpdateCheck } from '../hooks/useUpdateCheck';

/**
 * Tell the user a newer BookVoice exists, and install it on request.
 *
 * Installing closes the app: the backend exits with a code launch.py reads as
 * "replace me", then the staged installer runs msiexec and starts the new
 * build. That is disruptive enough to confirm first -- someone mid-narration
 * should not lose it to a misclick.
 */
export default function UpdateBanner() {
    const {
        status, available, ready, downloading, busy, error, progress,
        dismiss, startDownload, startInstall,
    } = useUpdateCheck();
    const [confirming, setConfirming] = useState(false);

    if (!available) return null;

    const percent = Math.round(progress * 100);
    const tone = error ? 'error' : downloading ? 'loading' : 'info';

    const action = ready ? (
        <button
            type="button"
            className="banner-action"
            onClick={() => setConfirming(true)}
            disabled={busy}
        >
            <RefreshCw size={14} aria-hidden="true" />
            Restart and install
        </button>
    ) : (
        <button
            type="button"
            className="banner-action"
            onClick={startDownload}
            disabled={busy || downloading}
        >
            <Download size={14} aria-hidden="true" />
            {downloading ? `Downloading ${percent}%` : 'Download'}
        </button>
    );

    return (
        <>
            <StatusBanner
                tone={tone}
                action={(
                    <span className="banner-actions">
                        {action}
                        <a
                            className="banner-link"
                            href={status.releaseUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            What&apos;s new
                        </a>
                        <button
                            type="button"
                            className="banner-dismiss"
                            onClick={dismiss}
                            aria-label="Dismiss update notice"
                        >
                            <X size={14} aria-hidden="true" />
                        </button>
                    </span>
                )}
            >
                {error
                    ? `Update to ${status.latest} failed: ${error}`
                    : `BookVoice ${status.latest} is available (you have ${status.current}).`}
            </StatusBanner>
            <ConfirmDialog
                open={confirming}
                title={`Install BookVoice ${status.latest}?`}
                message={
                    'BookVoice will close, install the update, and reopen. '
                    + 'Anything you have not saved will be lost. '
                    + 'Windows will ask you to confirm the installer.'
                }
                confirmLabel="Close and install"
                cancelLabel="Not now"
                onConfirm={() => {
                    setConfirming(false);
                    startInstall();
                }}
                onCancel={() => setConfirming(false)}
            />
        </>
    );
}
