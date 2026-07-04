import React, { useState } from 'react';
import CameraCapture from './CameraCapture';
import TextEditor from './TextEditor';
import AudioPlayer from './AudioPlayer';
import { extractTextFromImage } from '../utils/ocr';
import { cleanExtractedText } from '../utils/cleanup';
import { narrateText } from '../utils/api';
import { Loader2 } from 'lucide-react';

export default function BookSession() {
    const [sessionId] = useState(() => 'session_' + Date.now());
    const [pages, setPages] = useState([]);
    const [currentPageIndex, setCurrentPageIndex] = useState(0);
    const [step, setStep] = useState('capture'); // capture, processing, review, playback
    const [currentText, setCurrentText] = useState("");
    
    const handleCapture = async (imageDataUrl) => {
        setStep('processing');
        try {
            const rawText = await extractTextFromImage(imageDataUrl);
            const cleaned = cleanExtractedText(rawText);
            
            if (!cleaned.trim()) {
                alert("OCR did not find any recognizable text on this page. Please try again with better lighting or focus.");
                setStep('capture');
                return;
            }
            
            setCurrentText(cleaned);
            setStep('review');
        } catch (error) {
            console.error(error);
            alert("Failed to process image: " + error.message);
            setStep('capture');
        }
    };
    
    const handleNarrate = async (text) => {
        try {
            const audioUrl = await narrateText(text, sessionId, currentPageIndex);
            
            setPages([...pages, { text, audioUrl }]);
            setStep('playback');
        } catch (error) {
            console.error("TTS Generation Error:", error);
            alert("Backend Error: " + (error.message || "Failed to generate audio."));
            // Keep the user on the review step so they can try again
            setStep('review');
        }
    };
    
    const handleNextPage = () => {
        setCurrentPageIndex(pages.length);
        setCurrentText("");
        setStep('capture');
    };
    
    return (
        <div className="book-session">
            <header className="session-header">
                <h2>BookVoice Session</h2>
                <div className="page-indicator">Page {currentPageIndex + 1}</div>
            </header>
            
            <div className="session-content">
                {step === 'capture' && (
                    <CameraCapture onCapture={handleCapture} />
                )}
                
                {step === 'processing' && (
                    <div className="loading-state">
                        <Loader2 className="spinner" size={48} />
                        <p>Extracting text...</p>
                    </div>
                )}
                
                {step === 'review' && (
                    <TextEditor 
                        initialText={currentText} 
                        onNarrate={handleNarrate}
                        onRetake={() => setStep('capture')}
                    />
                )}
                
                {step === 'playback' && (
                    <AudioPlayer 
                        audioUrl={pages[currentPageIndex].audioUrl} 
                        onNextPage={handleNextPage} 
                    />
                )}
            </div>
            
            {pages.length > 0 && (
                <div className="history">
                    <h3>Session History</h3>
                    <div className="history-list">
                        {pages.map((p, i) => (
                            <button 
                                key={i} 
                                className={`history-item ${i === currentPageIndex ? 'active' : ''}`}
                                onClick={() => {
                                    setCurrentPageIndex(i);
                                    setStep('playback');
                                }}
                            >
                                Page {i + 1}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
