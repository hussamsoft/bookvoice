import { useCallback, useEffect, useState } from 'react';
import { getTtsStatus, reloadTtsModel } from '../utils/api';

/**
 * Poll TTS model status.
 * - Stops frequent polling once ready (idle).
 * - Keeps polling while loading OR generating so the UI can show chunk progress.
 * - Exposes retryLoad() so a failed model load can be retried from the UI
 *   without restarting the app.
 */
export function useTtsStatus({ pollWhileGenerating = false } = {}) {
    const [modelReady, setModelReady] = useState(false);
    const [modelError, setModelError] = useState(null);
    const [modelStatusDetail, setModelStatusDetail] = useState('Warming up AI voices...');
    const [deviceInfo, setDeviceInfo] = useState(null);
    const [pollEpoch, setPollEpoch] = useState(0);

    const retryLoad = useCallback(async () => {
        setModelError(null);
        setModelStatusDetail('Reloading model…');
        try {
            await reloadTtsModel();
        } catch (e) {
            console.warn('model reload request failed', e);
        }
        // Restart the polling loop immediately.
        setPollEpoch((n) => n + 1);
    }, []);

    useEffect(() => {
        let cancelled = false;
        let timer = null;

        const schedule = (ms) => {
            timer = setTimeout(poll, ms);
        };

        const poll = async () => {
            try {
                const status = await getTtsStatus();
                if (cancelled) return;

                if (status.device) setDeviceInfo(status.device);

                if (status.status === 'ready') {
                    setModelReady(true);
                    setModelError(null);
                    setModelStatusDetail(status.detail || '');
                    // Keep light polling if caller is generating elsewhere
                    if (pollWhileGenerating) {
                        schedule(2000);
                    }
                    return;
                }

                if (status.status === 'generating') {
                    setModelReady(true);
                    setModelError(null);
                    setModelStatusDetail(status.detail || 'Generating audio…');
                    schedule(800);
                    return;
                }

                if (status.status === 'loading') {
                    setModelReady(false);
                    setModelError(null);
                    const elapsed =
                        typeof status.elapsed_s === 'number' && status.elapsed_s >= 5
                            ? ` (${status.elapsed_s}s)`
                            : '';
                    setModelStatusDetail(
                        (status.detail || 'Warming up AI voices...') + elapsed
                    );
                    schedule(1500);
                    return;
                }

                if (status.status === 'error') {
                    setModelError(status.detail || 'Model failed to load');
                    setModelReady(false);
                    setModelStatusDetail('');
                    schedule(8000);
                    return;
                }

                setModelStatusDetail(status.detail || 'Initializing model preload...');
                schedule(2000);
            } catch {
                if (!cancelled) schedule(2500);
            }
        };

        poll();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, [pollWhileGenerating, pollEpoch]);

    return { modelReady, modelError, modelStatusDetail, deviceInfo, retryLoad };
}
