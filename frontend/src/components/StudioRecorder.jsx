import React, { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { recordStreamToWav } from '../utils/wav';
import { canRecord } from '../utils/media';

const MAX_SECONDS = 300;

function timeLabel(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Record straight into a Voice Studio project.
 *
 * Microphone access needs a secure context, so on a plain-HTTP LAN address this
 * renders an explanation instead of a control that could only fail.
 */
export default function StudioRecorder({ onRecorded, disabled, label = 'Record with your microphone' }) {
    const recorderRef = useRef(null);
    const streamRef = useRef(null);
    const startedAtRef = useRef(0);
    const [recording, setRecording] = useState(false);
    const [level, setLevel] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState('');

    useEffect(() => () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
    }, []);

    useEffect(() => {
        if (!recording) return undefined;
        const timer = setInterval(() => {
            setElapsed((Date.now() - startedAtRef.current) / 1000);
        }, 200);
        return () => clearInterval(timer);
    }, [recording]);

    if (!canRecord()) {
        return (
            <p className="studio-record-unavailable">
                Recording needs a secure connection. Open BookVoice on this computer, or over
                HTTPS, to record with the microphone. You can still import an audio or video file.
            </p>
        );
    }

    const start = async () => {
        setError('');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            recorderRef.current = await recordStreamToWav(stream, {
                maxSeconds: MAX_SECONDS,
                onLevel: setLevel,
            });
            startedAtRef.current = Date.now();
            setElapsed(0);
            setRecording(true);
        } catch {
            setError('Could not use the microphone. Check that permission is allowed.');
        }
    };

    const stop = async () => {
        if (!recorderRef.current) return;
        setRecording(false);
        setLevel(0);
        try {
            const blob = await recorderRef.current.stop();
            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
            recorderRef.current = null;
            if (!blob || blob.size < 1000) {
                setError('That recording was too short to use. Try again.');
                return;
            }
            const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
            await onRecorded(blob, `recording-${stamp}.wav`);
        } catch {
            setError('The recording could not be saved.');
        }
    };

    return (
        <div className="studio-recorder">
            <button
                className={recording ? 'btn danger' : 'btn secondary'}
                type="button"
                onClick={recording ? stop : start}
                disabled={disabled}
                aria-label={recording ? 'Stop recording' : label}
            >
                {recording ? <Square size={16} /> : <Mic size={16} />}
                {recording ? `Stop recording · ${timeLabel(elapsed)}` : label}
            </button>
            {recording && (
                <div className="studio-record-level" role="status" aria-live="off">
                    <span
                        className="studio-record-level-bar"
                        style={{ width: `${Math.min(100, Math.round(level * 320))}%` }}
                    />
                    <small>Recording — speak normally, then stop.</small>
                </div>
            )}
            {error && <p className="studio-record-error" role="alert">{error}</p>}
        </div>
    );
}
