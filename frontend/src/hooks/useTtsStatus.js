import { useEffect, useState } from 'react';
import { getTtsStatus } from '../utils/api';

/**
 * Poll TTS model status.
 * - Stops frequent polling once ready (idle).
 * - Keeps polling while loading OR generating so the UI can show chunk progress.
 */
export function useTtsStatus({ pollWhileGenerating = false } = {}) {
    const [modelReady, setModelReady] = useState(false);
    const [modelError, setModelError] = useState(null);
    const [modelStatusDetail, setModelStatusDetail] = useState('Warming up AI voices...');
    const [deviceInfo, setDeviceInfo] = useState(null);

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
                if (typeof status.cuda === 'boolean') {
                    setDeviceInfo((d) => status.device || d);
                }

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
                    setModelStatusDetail(status.detail || 'Warming up AI voices...');
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
    }, [pollWhileGenerating]);

    return { modelReady, modelError, modelStatusDetail, deviceInfo };
}
