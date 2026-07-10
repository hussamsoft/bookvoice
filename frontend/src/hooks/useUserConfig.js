import { useCallback, useEffect, useRef, useState } from 'react';
import { getUserConfig, saveUserConfig } from '../utils/api';

/**
 * Universal per-user settings (voice, language, …) persisted on the backend
 * in %LocalAppData%\BookVoice\data\config.json — shared by every install
 * format and every session.
 *
 * `config` is null until loaded so callers can apply saved values exactly
 * once without clobbering user interaction.
 *
 * Saves are serialized and coalesced: rapid updates to the same key cannot
 * finish out of order, and a failed save rejects the returned promise and
 * sets `saveError` for the UI/toast layer.
 */
export function useUserConfig() {
    const [config, setConfig] = useState(null);
    const [version, setVersion] = useState('');
    const [saveError, setSaveError] = useState(null);

    // Coalesce keys that arrive while a PUT is in flight.
    const pendingRef = useRef({});
    // Chain so only one network save runs at a time.
    const chainRef = useRef(Promise.resolve());
    // Last successfully loaded/saved server snapshot for optimistic rollback.
    const committedRef = useRef({});

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const data = await getUserConfig();
                if (!cancelled) {
                    const cfg = data.config || {};
                    committedRef.current = cfg;
                    setConfig(cfg);
                    setVersion(data.version || '');
                }
            } catch {
                if (!cancelled) {
                    committedRef.current = {};
                    setConfig({});
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const updateConfig = useCallback((partial) => {
        if (!partial || typeof partial !== 'object') {
            return Promise.resolve();
        }

        setConfig((c) => ({ ...(c || {}), ...partial }));
        pendingRef.current = { ...pendingRef.current, ...partial };

        const run = async () => {
            // Drain whatever is pending at the start of this turn. Anything
            // that arrives while we await is left for the next chained turn.
            const toSave = pendingRef.current;
            pendingRef.current = {};
            if (Object.keys(toSave).length === 0) {
                return;
            }
            try {
                const result = await saveUserConfig(toSave);
                const saved = (result && result.config) || {
                    ...committedRef.current,
                    ...toSave,
                };
                committedRef.current = saved;
                // Only clobber local state if nothing newer is still pending.
                if (Object.keys(pendingRef.current).length === 0) {
                    setConfig(saved);
                } else {
                    setConfig({ ...saved, ...pendingRef.current });
                }
                setSaveError(null);
            } catch (e) {
                const message =
                    e && typeof e.message === 'string'
                        ? e.message
                        : 'Failed to save settings';
                setSaveError(message);
                // Keys queued while this save was in flight (not including toSave).
                const newer = pendingRef.current;
                // Keep failed keys for a later retry; newer values win on merge.
                pendingRef.current = { ...toSave, ...newer };
                // Roll optimistic UI back to last committed + any newer edits only.
                setConfig({ ...committedRef.current, ...newer });
                throw e;
            }
        };

        const next = chainRef.current.then(run, run);
        // Keep the chain alive after rejections so later updates still run.
        chainRef.current = next.catch(() => {});
        return next;
    }, []);

    return { config, version, updateConfig, saveError };
}
