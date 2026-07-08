import React, { useState, useEffect, useRef } from 'react';
import { getVoices, uploadVoice } from '../utils/api';
import { useToast } from './Toast';
import { Mic, Upload, StopCircle, RefreshCw } from 'lucide-react';

export default function VoiceSettings({ activeVoiceId, onVoiceChange }) {
    const toast = useToast();
    const [voices, setVoices] = useState([]);
    const [isRecording, setIsRecording] = useState(false);
    const [loading, setLoading] = useState(false);
    const [newVoiceName, setNewVoiceName] = useState("");
    const [uploadName, setUploadName] = useState("");
    
    const mediaRecorderRef = useRef(null);
    const chunksRef = useRef([]);
    const fileInputRef = useRef(null);

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

        const name = uploadName.trim();
        if (!name) {
            toast.error("Enter a name for this voice profile first.");
            e.target.value = null;
            return;
        }
        
        setLoading(true);
        try {
            const result = await uploadVoice(file, name);
            await fetchVoices();
            onVoiceChange(result.id);
            setUploadName("");
            toast.success(`Voice "${name}" saved`);
        } catch (error) {
            toast.error(error.message);
        } finally {
            setLoading(false);
            e.target.value = null;
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
                stream.getTracks().forEach(track => track.stop());
                
                if (!newVoiceName.trim()) {
                    toast.error("Voice name is required.");
                    return;
                }
                
                setLoading(true);
                try {
                    const result = await uploadVoice(blob, newVoiceName);
                    const savedName = result.name || newVoiceName;
                    await fetchVoices();
                    onVoiceChange(result.id);
                    setNewVoiceName("");
                    toast.success(`Voice "${savedName}" saved`);
                } catch (error) {
                    toast.error(error.message);
                } finally {
                    setLoading(false);
                }
            };

            mediaRecorder.start();
            setIsRecording(true);
        } catch (err) {
            console.error(err);
            toast.error("Could not access microphone.");
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
                <label>Voice</label>
                <select 
                    value={activeVoiceId || ""} 
                    onChange={(e) => onVoiceChange(e.target.value || null)}
                >
                    <option value="">Default voice</option>
                    {voices.map(v => (
                        <option key={v.id} value={v.id}>{v.name}</option>
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
                            accept="audio/wav"
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
                            <button className="btn secondary" onClick={startRecording} disabled={loading || !newVoiceName.trim()}>
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
