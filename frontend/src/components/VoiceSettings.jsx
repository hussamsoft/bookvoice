import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getVoices, deleteVoice } from '../utils/api';
import { useToast } from './Toast';
import ConfirmDialog from './ui/ConfirmDialog';
import { RefreshCw, Trash2 } from 'lucide-react';

const MAX_FETCH_RETRIES = 10;

export default function VoiceSettings({
    activeVoiceId,
    onVoiceChange,
    compact = false,
    backendReady = false,
}) {
    const toast = useToast();
    const [voices, setVoices] = useState([]);
    const [loading, setLoading] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
    const [fetchFailed, setFetchFailed] = useState(false);

    const backendReadyRef = useRef(backendReady);
    // Avoid re-clearing the same missing id (prevents update loops).
    const clearedMissingRef = useRef(null);


    useEffect(() => {
        backendReadyRef.current = backendReady;
    }, [backendReady]);

    const validateActiveVoice = useCallback(
        (list, voiceId) => {
            if (!voiceId) {
                clearedMissingRef.current = null;
                return;
            }
            if (list.some((v) => v.id === voiceId)) {
                clearedMissingRef.current = null;
                return;
            }
            // Saved voice was deleted since the previous session (or refresh).
            if (clearedMissingRef.current === voiceId) {
                return;
            }
            clearedMissingRef.current = voiceId;
            onVoiceChange(null);
        },
        [onVoiceChange]
    );

    const fetchVoices = useCallback(
        async ({ announceFailure = true, retry = false } = {}) => {
            try {
                const data = await getVoices();
                setVoices(data);
                validateActiveVoice(data, activeVoiceId);
                setFetchFailed(false);
                return data;
            } catch (error) {
                if (announceFailure) {
                    toast.error(
                        backendReadyRef.current
                            ? 'Could not load voice profiles. Try refresh or restart BookVoice.'
                            : 'Waiting for the reading engine to finish starting…'
                    );
                }
                if (retry) setFetchFailed(true);
                return null;
            }

        },
        [activeVoiceId, toast, validateActiveVoice]
    );

    useEffect(() => {
        let cancelled = false;
        let timer = null;
        let failCount = 0;

        const schedule = (ms) => {
            timer = setTimeout(run, ms);
        };

        const run = async () => {
            if (cancelled) return;
            if (failCount >= MAX_FETCH_RETRIES) {
                setFetchFailed(true);
                toast.error(
                    'Could not load voice profiles after several attempts.',
                    0 // persist until dismissed
                );
                return;
            }
            const announceFailure =
                failCount >= 5 || (backendReadyRef.current && failCount >= 2);
            const data = await fetchVoices({ announceFailure });
            if (cancelled) return;
            if (data !== null) {
                failCount = 0;
                return;
            }
            failCount += 1;
            schedule(backendReadyRef.current ? 3000 : 1500);
        };

        run();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [fetchVoices]);

    useEffect(() => {
        if (!backendReady) return;
        fetchVoices({ announceFailure: false });
    }, [backendReady, fetchVoices]);



    // Revalidate after async config restores a saved voice (or user selection).
    useEffect(() => {
        if (!voices.length) return;
        validateActiveVoice(voices, activeVoiceId);
    }, [activeVoiceId, voices, validateActiveVoice]);


    const handleDeleteVoice = async () => {
        if (!activeVoiceId) return;
        setConfirmDeleteOpen(true);
    };

    const confirmDelete = async () => {
        setConfirmDeleteOpen(false);
        setLoading(true);
        try {
            await deleteVoice(activeVoiceId);
            await fetchVoices({ announceFailure: true });
            onVoiceChange(null);
            toast.success('Voice deleted');
        } catch (error) {
            toast.error(error.message);
        }
    };

    const [expanded, setExpanded] = useState(false);
    const dropdownRef = useRef(null);
    const pillRef = useRef(null);

    const activeVoiceName = voices.find((v) => v.id === activeVoiceId)?.name || 'BookVoice Natural';

    // Compact dropdown: Escape closes, outside click closes, focus returns to pill.
    useEffect(() => {
        if (!compact || !expanded) return undefined;
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                setExpanded(false);
                pillRef.current?.focus();
            }
        };
        const onMouseDown = (event) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target)
                && pillRef.current && !pillRef.current.contains(event.target)) {
                setExpanded(false);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mousedown', onMouseDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mousedown', onMouseDown);
        };
    }, [compact, expanded]);

    if (compact) {
        return (
            <div className="voice-settings compact">
                <button
                    ref={pillRef}
                    className="voice-pill"
                    onClick={() => setExpanded(!expanded)}
                    aria-expanded={expanded}
                    aria-label={`Voice: ${activeVoiceName}`}
                >
                    <span className="voice-pill-label" aria-hidden="true">Voice:</span>
                    <span className="voice-pill-name" aria-hidden="true">{activeVoiceName}</span>
                    <span className={`voice-pill-chevron ${expanded ? 'open' : ''}`} aria-hidden="true">▾</span>
                </button>

                {expanded && (
                    <div className="voice-dropdown" ref={dropdownRef}>
                        <div className="voice-selector">
                            <select
                                id="voice-select"
                                value={activeVoiceId || ''}
                                onChange={(e) => onVoiceChange(e.target.value || null)}
                            >
                                <option value="">BookVoice Natural</option>
                                {voices.map((v) => (
                                    <option key={v.id} value={v.id}>
                                        {v.name}
                                    </option>
                                ))}
                            </select>
                            <button
                                className="icon-btn"
                                onClick={() => fetchVoices({ announceFailure: true, retry: true })}
                                aria-label="Refresh voices"
                                title="Refresh voices"
                                disabled={loading}
                            >
                                <RefreshCw size={16} />
                            </button>
                            {fetchFailed && !voices.length && (
                                <span className="voice-fetch-error" role="status">
                                    Couldn't load voices
                                </span>
                            )}
                            {activeVoiceId && (
                                <button
                                    className="icon-btn danger"
                                    onClick={handleDeleteVoice}
                                    disabled={loading}
                                    aria-label="Delete selected voice"
                                    title="Delete selected voice"
                                >
                                    <Trash2 size={16} />
                                </button>
                            )}
                        </div>
                    </div>
                )}
                <ConfirmDialog
                    open={confirmDeleteOpen}
                    title="Delete voice?"
                    message={activeVoiceId ? `This will permanently delete the voice "${voices.find((v) => v.id === activeVoiceId)?.name || activeVoiceId}". This cannot be undone.` : ''}

                    confirmLabel="Delete"
                    confirmVariant="danger"
                    onConfirm={confirmDelete}
                    onCancel={() => setConfirmDeleteOpen(false)}
                />
            </div>
        );
    }


    return (
        <div className="voice-settings">
            <div className="voice-selector">
                <label htmlFor="voice-select">Voice</label>
                <select
                    id="voice-select"
                    value={activeVoiceId || ''}
                    onChange={(e) => onVoiceChange(e.target.value || null)}
                >
                    <option value="">BookVoice Natural</option>
                    {voices.map((v) => (
                        <option key={v.id} value={v.id}>
                            {v.name}
                        </option>
                    ))}
                </select>
                <button
                    className="icon-btn"
                    onClick={() => fetchVoices({ announceFailure: true, retry: true })}
                    aria-label="Refresh voices"
                    title="Refresh voices"
                    disabled={loading}
                >
                    <RefreshCw size={16} />
                </button>
                {fetchFailed && !voices.length && (
                    <span className="voice-fetch-error" role="status">
                        Couldn't load voices
                    </span>
                )}
                {activeVoiceId && (
                    <button
                        className="icon-btn danger"
                        onClick={handleDeleteVoice}
                        disabled={loading}
                        aria-label="Delete selected voice"
                        title="Delete selected voice"
                    >
                        <Trash2 size={16} />
                    </button>
                )}
            </div>

            <ConfirmDialog
                open={confirmDeleteOpen}
                title="Delete voice?"
                message={activeVoiceId ? `This will permanently delete the voice "${activeVoiceId}". This cannot be undone.` : ''}
                confirmLabel="Delete"
                confirmVariant="danger"
                onConfirm={confirmDelete}
                onCancel={() => setConfirmDeleteOpen(false)}
            />
        </div>
    );
}
