import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getVoices, uploadVoice } from '../utils/api';
import { recordStreamToWav } from '../utils/wav';
import { useToast } from './Toast';
import { Mic, Upload, StopCircle, RefreshCw } from 'lucide-react';

export default function VoiceSettings({ activeVoiceId, onVoiceChange }) {
    const toast = useToast();
    const [voices, setVoices] = useState([]);
    const [isRecording, setIsRecording] = useState(false);
    const [loading, setLoading] = useState(false);
    const [newVoiceName, setNewVoiceName] = useState('');
    const [uploadName, setUploadName] = useState('');

    const recorderRef = useRef(null);
    const streamRef = useRef(null);
    const fileInputRef = useRef(null);
    // Avoid re-clearing the same missing id (prevents update loops).
    const clearedMissingRef = useRef(null);

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

    const fetchVoices = useCallback(async () => {
        try {
            const data = await getVoices();
            setVoices(data);
            validateActiveVoice(data, activeVoiceId);
            return data;
        } catch (error) {
            console.error(error);
            toast.error('Could not load voices. Is the backend still starting?');
            return null;
        }
    }, [activeVoiceId, toast, validateActiveVoice]);

    useEffect(() => {
        fetchVoices();
        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
            }
        };
        // Mount-only: voice list is revalidated when activeVoiceId changes below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Revalidate after async config restores a saved voice (or user selection).
    useEffect(() => {
        if (!voices.length) return;
        validateActiveVoice(voices, activeVoiceId);
    }, [activeVoiceId, voices, validateActiveVoice]);

    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const name = uploadName.trim();
        if (!name) {
            toast.error('Enter a name for this voice profile first.');
            e.target.value = null;
            return;
        }

        setLoading(true);
        try {
            const result = await uploadVoice(file, name);
            await fetchVoices();
            onVoiceChange(result.id);
            setUploadName('');
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
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((t) => t.stop());
                streamRef.current = null;
            }
            recorderRef.current = null;

            if (!blob || blob.size < 1000) {
                toast.error('Recording too short. Try again.');
                return;
            }

            const result = await uploadVoice(blob, newVoiceName.trim());
            const savedName = result.name || newVoiceName;
            await fetchVoices();
            onVoiceChange(result.id);
            setNewVoiceName('');
            toast.success(`Voice "${savedName}" saved`);
        } catch (error) {
            toast.error(error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="voice-settings">
            <div className="voice-selector">
                <label>Voice</label>
                <select
                    value={activeVoiceId || ''}
                    onChange={(e) => onVoiceChange(e.target.value || null)}
                >
                    <option value="">Default voice</option>
                    {voices.map((v) => (
                        <option key={v.id} value={v.id}>
                            {v.name}
                        </option>
                    ))}
                </select>
                <button className="icon-btn" onClick={fetchVoices} title="Refresh voices">
                    <RefreshCw size={16} />
                </button>
            </div>

            <div className="voice-creation">
                <h4>Create new voice</h4>
                <div className="creation-controls">
                    <div className="record-section">
                        <input
                            type="text"
                            placeholder="Voice name"
                            value={uploadName}
                            onChange={(e) => setUploadName(e.target.value)}
                            disabled={loading}
                        />
                        <button
                            className="btn secondary file-upload"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={loading || !uploadName.trim()}
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
                            value={newVoiceName}
                            onChange={(e) => setNewVoiceName(e.target.value)}
                            disabled={isRecording || loading}
                        />
                        {!isRecording ? (
                            <button
                                className="btn secondary"
                                onClick={startRecording}
                                disabled={loading || !newVoiceName.trim()}
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
                {loading && <p className="hint">Saving voice profile...</p>}
            </div>
        </div>
    );
}
