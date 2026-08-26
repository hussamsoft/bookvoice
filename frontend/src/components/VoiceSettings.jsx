import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getVoices, uploadVoice, deleteVoice } from '../utils/api';
import { recordStreamToWav } from '../utils/wav';
import { useToast } from './Toast';
import ConfirmDialog from './ui/ConfirmDialog';
import { Mic, Upload, StopCircle, RefreshCw, Trash2 } from 'lucide-react';

const MAX_FETCH_RETRIES = 10;

export default function VoiceSettings({
    activeVoiceId,
    onVoiceChange,
    compact = false,
    backendReady = false,
}) {
    const toast = useToast();
    const [voices, setVoices] = useState([]);
    const [isRecording, setIsRecording] = useState(false);
    const [loading, setLoading] = useState(false);
    const [newVoiceName, setNewVoiceName] = useState('');
    const [uploadName, setUploadName] = useState('');
    const [consentConfirmed, setConsentConfirmed] = useState(false);
    const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
    const [fetchFailed, setFetchFailed] = useState(false);

    const recorderRef = useRef(null);
    const streamRef = useRef(null);
    const fileInputRef = useRef(null);
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
                console.error(error);
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
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
            }

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

    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Validate file type client-side against the accept list.
        const isWav =
            file.type === 'audio/wav' ||
            file.type === 'audio/x-wav' ||
            file.name.toLowerCase().endsWith('.wav');
        if (!isWav) {
            toast.error('Please upload a WAV file.');
            e.target.value = null;
            return;
        }

        const name = uploadName.trim();
        if (!name) {
            toast.error('Enter a name for this voice profile first.');
            e.target.value = null;
            return;
        }
        if (!consentConfirmed) {
            toast.error('Confirm that you own or have permission to clone this voice.');
            e.target.value = null;
            return;
        }

        setLoading(true);
        try {
            const result = await uploadVoice(file, name, true);
            await fetchVoices({ announceFailure: true });
            onVoiceChange(result.id);
            setUploadName('');
            setConsentConfirmed(false);
            toast.success(`Voice "${name}" saved`);
        } catch (error) {
            toast.error(error.message);
        } finally {
            setLoading(false);
            e.target.value = null;
        }
    };

    const startRecording = async () => {
        if (!newVoiceName.trim()) {
            toast.error('Voice name is required.');
            return;
        }
        if (!consentConfirmed) {
            toast.error('Confirm that you own or have permission to clone this voice.');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            recorderRef.current = await recordStreamToWav(stream, { maxSeconds: 30 });
            setIsRecording(true);
            toast.info('Recording… speak clearly for a few seconds, then stop.');
        } catch (err) {
            console.error(err);
            toast.error('Could not access microphone.');
        }
    };

    const stopRecording = async () => {
        if (!recorderRef.current || !isRecording) return;
        setIsRecording(false);
        setLoading(true);
        try {
            const blob = await recorderRef.current.stop();
            recorderRef.current = null;

            if (!blob || blob.size < 1000) {
                toast.error('Recording too short. Try again.');
                return;
            }

            const result = await uploadVoice(blob, newVoiceName.trim(), true);
            const savedName = result.name || newVoiceName;
            await fetchVoices({ announceFailure: true });
            onVoiceChange(result.id);
            setNewVoiceName('');
            setConsentConfirmed(false);
            toast.success(`Voice "${savedName}" saved`);
        } catch (error) {
            toast.error(error.message);
        } finally {
            setLoading(false);
        }
    };

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
        } finally {
            setLoading(false);
        }
    };

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
                        Couldn’t load voices
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

            {!compact && <div className="voice-creation">
                <h4>Create new voice</h4>
                <label className="voice-consent">
                    <input
                        type="checkbox"
                        checked={consentConfirmed}
                        onChange={(event) => setConsentConfirmed(event.target.checked)}
                        disabled={loading || isRecording}
                    />
                    <span>I own or have permission to clone this voice.</span>
                </label>
                <div className="creation-controls">
                    <div className="record-section">
                        <input
                            type="text"
                            placeholder="Voice name"
                            aria-label="Voice name"
                            value={uploadName}
                            onChange={(e) => setUploadName(e.target.value)}
                            disabled={loading}
                        />
                        <button
                            className="btn secondary file-upload"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={loading || !uploadName.trim() || !consentConfirmed}
                        >
                            <Upload size={16} /> Upload .wav
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="audio/wav,audio/x-wav,.wav"
                            onChange={handleFileUpload}
                            hidden
                        />
                    </div>

                    <div className="record-section">
                        <input
                            type="text"
                            placeholder="Voice name"
                            aria-label="Voice name"
                            value={newVoiceName}
                            onChange={(e) => setNewVoiceName(e.target.value)}
                            disabled={isRecording || loading}
                        />
                        {!isRecording ? (
                            <button
                                className="btn secondary"
                                onClick={startRecording}
                                disabled={loading || !newVoiceName.trim() || !consentConfirmed}
                            >
                                <Mic size={16} /> Record
                            </button>
                        ) : (
                            <button className="btn primary danger" onClick={stopRecording}>
                                <StopCircle size={16} /> Stop & save
                            </button>
                        )}
                    </div>
                </div>
                {loading && <p className="hint">Saving voice profile…</p>}
            </div>}
        </div>
    );
}
