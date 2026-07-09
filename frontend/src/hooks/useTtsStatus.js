import { useEffect, useState } from 'react';
import { getTtsStatus } from '../utils/api';

/**
 * Poll TTS model status until ready (or leave on error with slower retry).
 * Stops frequent polling once the model is ready.
 */
export function useTtsStatus() {
    const [modelReady, setModelReady] = useState(false);
    const [modelError, setModelError] = useState(null);
    const [modelStatusDetail, setModelStatusDetail] = useState('Warming up AI voices...');

    useEffect(() => {
        let cancelled = false;
        let timer = null;

        const poll = async () => {
            try {
                const status = await getTtsStatus();
                if (cancelled) return;

                if (status.status === 'ready') {
                    setModelReady(true);
                    setModelError(null);
                    setModelStatusDetail('');
                    return; // stop polling
                }

                if (status.status === 'loading') {
                    setModelReady(false);
                    setModelStatusDetail(status.detail || 'Warming up AI voices...');
                    timer = setTimeout(poll, 1500);
                } else if (status.status === 'error') {
                    setModelError(status.detail || 'Model failed to load');
                    setModelReady(false);
                    setModelStatusDetail('');
                    // Slow retry in case user fixes env / downloads complete
                    timer = setTimeout(poll, 8000);
                } else {
                    setModelStatusDetail(status.detail || 'Initializing model preload...');
                    timer = setTimeout(poll, 2000);
                }
            } catch {
                if (!cancelled) {
                    timer = setTimeout(poll, 2500);
                }
            }
        };

        poll();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, []);

    return { modelReady, modelError, modelStatusDetail };
}
