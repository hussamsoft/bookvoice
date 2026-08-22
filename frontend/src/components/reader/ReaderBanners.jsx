import React from 'react';
import { Loader2 } from 'lucide-react';
import StatusBanner from '../ui/StatusBanner';

/**
 * Model / prefetch status banners above the reader stage.
 */
export default function ReaderBanners({
    modelReady,
    modelStatusDetail,
    modelError,
    retryLoad,
    deviceInfo,
    prefetchHint,
    isGenerating,
}) {
    return (
        <>
            {!modelReady && modelStatusDetail && (
                <StatusBanner tone="loading">
                    <Loader2 className="spinner" size={14} aria-hidden="true" /> {modelStatusDetail}
                </StatusBanner>
            )}
            {modelError && (
                <StatusBanner
                    tone="error"
                    action={
                        <button type="button" className="btn secondary btn-compact" onClick={retryLoad}>
                            Retry
                        </button>
                    }
                >
                    Error: {modelError}
                </StatusBanner>
            )}
            {deviceInfo === 'cpu' && modelReady && (
                <StatusBanner tone="error">
                    Narration is running on the CPU, so it will be much slower than with a GPU.
                </StatusBanner>
            )}
            {prefetchHint && modelReady && !isGenerating && (
                <StatusBanner tone="prefetch">
                    <Loader2 className="spinner" size={12} aria-hidden="true" /> {prefetchHint}
                </StatusBanner>
            )}
        </>
    );
}
