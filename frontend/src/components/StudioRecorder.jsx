import { useEffect, useRef, useState } from 'react';
import { Check, Mic, Square, Trash2 } from 'lucide-react';
import { recordStreamToWav } from '../utils/wav';
import { canRecord, STUDIO_MIC_CONSTRAINTS } from '../utils/media';
import { formatClock as timeLabel } from '../utils/format';
import AudioPlayer from './AudioPlayer';

const MAX_SECONDS = 300;
const METER_BARS = 28;

/**
 * Record straight into a Voice Studio project.
 *
 * Recording finishes in a review step rather than committing immediately: a
 * take you cannot hear back before it is used is a take you have to delete
 * afterwards. Microphone access needs a secure context, so on a plain-HTTP LAN
 * address this renders an explanation instead of a control that could only fail.
 */
export default function StudioRecorder({ onRecorded, disabled, label = 'Record with your microphone' }) {
    const recorderRef = useRef(null);
    const streamRef = useRef(null);
    const startedAtRef = useRef(0);
    const [recording, setRecording] = useState(false);
    const [levels, setLevels] = useState(() => new Array(METER_BARS).fill(0));
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState('');
    const [take, setTake] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        recorderRef.current?.stop();
    }, []);


    // The object URL backs the review player; revoke it when the take goes away.
    useEffect(() => {
        if (!take?.url) return undefined;
        return () => URL.revokeObjectURL(take.url);
    }, [take]);

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

    const pushLevel = (value) => {
        // Scrolling history rather than one bar, so the meter reads as movement.
        setLevels((current) => [...current.slice(1), Math.min(1, value * 3.2)]);
    };

    const releaseMicrophone = () => {
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
    };

    const start = async () => {
        setError('');
        setTake(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: STUDIO_MIC_CONSTRAINTS,
            });
            streamRef.current = stream;
            recorderRef.current = await recordStreamToWav(stream, {
                maxSeconds: MAX_SECONDS,
                onLevel: pushLevel,
                onAutoStop: (blob) => {
                    if (blob && blob.size >= 1000) {
                        const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
                        setTake({
                            blob,
                            url: URL.createObjectURL(blob),
                            name: `recording-${stamp}.wav`,
                            seconds: (Date.now() - startedAtRef.current) / 1000,
                        });
                    }
                    setRecording(false);
                    setLevels(new Array(METER_BARS).fill(0));
                    releaseMicrophone();
                },
            });
            startedAtRef.current = Date.now();
            setElapsed(0);
            setRecording(true);
        } catch {
            releaseMicrophone();
            setError('Could not use the microphone. Check that permission is allowed.');
        }
    };


    const stop = async () => {
        if (!recorderRef.current) return;
        setRecording(false);
        setLevels(new Array(METER_BARS).fill(0));
        try {
            const blob = await recorderRef.current.stop();
            releaseMicrophone();
            if (!blob || blob.size < 1000) {
                setError('That recording was too short to use. Try again.');
                return;
            }
            const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
            setTake({
                blob,
                url: URL.createObjectURL(blob),
                name: `recording-${stamp}.wav`,
                seconds: (Date.now() - startedAtRef.current) / 1000,
            });
        } catch {
            setError('The recording could not be saved.');
        }
    };

    const keep = async () => {
        if (!take) return;
        setSaving(true);
        try {
            await onRecorded(take.blob, take.name);
            setTake(null);
        } catch (keepError) {
            setError(keepError?.message || 'The recording could not be added.');
        } finally {
            setSaving(false);
        }
    };


    if (take) {
        return (
            <div className="studio-recorder studio-record-review">
                <div className="studio-record-review-head">
                    <strong>Review your recording</strong>
                    <span>{timeLabel(take.seconds)}</span>
                </div>
                <AudioPlayer src={take.url} label="your recording" compact />
                <div className="studio-record-review-actions">
                    <button
                        className="btn text danger"
                        type="button"
                        onClick={() => setTake(null)}
                        disabled={saving}
                    >
                        <Trash2 size={16} /> Delete
                    </button>
                    <button className="btn secondary" type="button" onClick={start} disabled={saving}>
                        <Mic size={16} /> Record again
                    </button>
                    <button className="btn primary" type="button" onClick={keep} disabled={saving}>
                        <Check size={16} /> {saving ? 'Adding…' : 'Use this recording'}
                    </button>
                </div>
                {error && <p className="studio-record-error" role="alert">{error}</p>}
            </div>
        );
    }

    return (
        <div className={`studio-recorder ${recording ? 'is-recording' : ''}`}>
            <button
                className={recording ? 'btn danger studio-record-btn' : 'btn secondary studio-record-btn'}
                type="button"
                onClick={recording ? stop : start}
                disabled={disabled}
                aria-label={recording ? 'Stop recording' : label}
            >
                {recording ? <Square size={18} /> : <Mic size={18} />}
                <span>{recording ? 'Stop recording' : label}</span>
                {recording && <span className="studio-record-clock">{timeLabel(elapsed)}</span>}
            </button>
            {recording && (
                <div className="studio-record-meter" role="status">
                    <div className="studio-record-bars" aria-hidden="true">
                        {levels.map((value, index) => (
                            <span
                                key={index}
                                className="studio-record-bar"
                                style={{ transform: `scaleY(${Math.max(0.06, value)})` }}
                            />
                        ))}
                    </div>
                    <small>Listening — speak normally, then stop.</small>
                </div>
            )}
            {error && <p className="studio-record-error" role="alert">{error}</p>}
        </div>
    );
}
