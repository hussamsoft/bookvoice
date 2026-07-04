import React, { useRef, useState, useEffect } from 'react';
import { Camera, RefreshCw } from 'lucide-react';

export default function CameraCapture({ onCapture }) {
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const [stream, setStream] = useState(null);
    const [error, setError] = useState(null);

    const startCamera = async () => {
        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    facingMode: 'environment',
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                }
            });
            setStream(mediaStream);
            if (videoRef.current) {
                videoRef.current.srcObject = mediaStream;
            }
        } catch (err) {
            console.error("Error accessing camera:", err);
            if (err.name === 'NotAllowedError') {
                setError("Camera permission denied. Please allow camera access in your browser settings.");
            } else if (err.name === 'NotFoundError') {
                setError("No camera device found on your system.");
            } else {
                setError("Could not access camera. Please check permissions and connection.");
            }
        }
    };

    useEffect(() => {
        startCamera();
        return () => {
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
            }
        };
    }, []);

    const captureImage = () => {
        if (!videoRef.current || !canvasRef.current) return;
        
        const video = videoRef.current;
        const canvas = canvasRef.current;
        
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        const imageDataUrl = canvas.toDataURL('image/jpeg', 0.9);
        onCapture(imageDataUrl);
    };

    return (
        <div className="camera-container">
            {error ? (
                <div className="error-message">
                    <p>{error}</p>
                    <button onClick={startCamera} className="btn primary">
                        <RefreshCw size={16} /> Retry
                    </button>
                </div>
            ) : (
                <div className="video-wrapper">
                    <video 
                        ref={videoRef} 
                        autoPlay 
                        playsInline 
                        muted 
                        className="camera-feed"
                    />
                    <button onClick={captureImage} className="capture-btn">
                        <Camera size={24} /> Capture Page
                    </button>
                </div>
            )}
            <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
    );
}
