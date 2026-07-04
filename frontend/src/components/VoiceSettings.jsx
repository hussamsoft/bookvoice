import React, { useState, useEffect, useRef } from 'react';
import { getVoices, uploadVoice } from '../utils/api';
import { Mic, Upload, StopCircle, RefreshCw } from 'lucide-react';

export default function VoiceSettings({ activeVoiceId, onVoiceChange }) {
    const [voices, setVoices] = useState([]);
    const [isRecording, setIsRecording] = useState(false);
    const [loading, setLoading] = useState(false);
    const [newVoiceName, setNewVoiceName] = useState("");
    
    const mediaRecorderRef = useRef(null);
    const chunksRef = useRef([]);

    const fetchVoices = async () => {
        try {
            const data = await getVoices();
            setVoices(data);
        } catch (error) {
            console.error(error);
        }
    };

    useEffect(() => {
        fetchVoices();
    }, []);

    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        let name = prompt("Enter a name for this voice profile:");
        if (!name) return;
        
        setLoading(true);
        try {
            const result = await uploadVoice(file, name);
            await fetchVoices();
            onVoiceChange(result.id);
        } catch (error) {
            alert(error.message);
        } finally {
            setLoading(false);
            e.target.value = null; // reset file input
        }
    };

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            chunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunksRef.current.push(e.data);
            };

            mediaRecorder.onstop = async () => {
                const blob = new Blob(chunksRef.current, { type: 'audio/wav' });
                
                // Stop tracks to release mic
                stream.getTracks().forEach(track => track.stop());
                
                if (!newVoiceName) {
                    alert("Voice name is required.");
                    return;
                }
                
                setLoading(true);
                try {
                    const result = await uploadVoice(blob, newVoiceName);
                    await fetchVoices();
                    onVoiceChange(result.id);
                    setNewVoiceName("");
                } catch (error) {
                    alert(error.message);
                } finally {
                    setLoading(false);
                }
            };

            mediaRecorder.start();
            setIsRecording(true);
        } catch (err) {
            console.error(err);
            alert("Could not access microphone.");
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    return (
        <div className="voice-settings">
            <div className="voice-selector">
                <label>Voice Profile: </label>
                <select 
                    value={activeVoiceId || ""} 
                    onChange={(e) => onVoiceChange(e.target.value || null)}
                >
                    <option value="">Default (No Voice Cloning)</option>
                    {voices.map(v => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                </select>
                <button className="btn icon-btn" onClick={fetchVoices} title="Refresh Voices">
                    <RefreshCw size={16} />
                </button>
            </div>

            <div className="voice-creation">
                <h4>Create New Voice</h4>
                <div className="creation-controls">
                    <label className="btn secondary file-upload">
                        <Upload size={16} /> Upload .wav
                        <input type="file" accept="audio/wav" onChange={handleFileUpload} hidden disabled={loading} />
                    </label>
                    
                    <div className="record-section">
                        <input 
                            type="text" 
                            placeholder="Voice Name" 
                            value={newVoiceName}
                            onChange={(e) => setNewVoiceName(e.target.value)}
                            disabled={isRecording || loading}
                        />
                        {!isRecording ? (
                            <button className="btn secondary" onClick={startRecording} disabled={loading || !newVoiceName.trim()}>
                                <Mic size={16} /> Record
                            </button>
                        ) : (
                            <button className="btn primary danger" onClick={stopRecording}>
                                <StopCircle size={16} /> Stop & Save
                            </button>
                        )}
                    </div>
                </div>
                {loading && <p className="hint">Uploading voice...</p>}
            </div>
        </div>
    );
}
