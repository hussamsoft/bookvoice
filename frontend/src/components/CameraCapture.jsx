import React, { useRef, useState, useEffect } from 'react';
import { Camera, RefreshCw, Zap, ZapOff, ZoomIn } from 'lucide-react';

export default function CameraCapture({ onCapture }) {
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const streamRef = useRef(null);
    const [error, setError] = useState(null);
    const [capabilities, setCapabilities] = useState(null);
    const [torchOn, setTorchOn] = useState(false);
    const [zoom, setZoom] = useState(1);

    const startCamera = async () => {
        setError(null);
        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia({
                video: { 
                    facingMode: 'environment',
                    width: { ideal: 1080 },
                    height: { ideal: 1920 }
                }
            });
            streamRef.current = mediaStream;
            if (videoRef.current) {
                videoRef.current.srcObject = mediaStream;
            }
            
            const track = mediaStream.getVideoTracks()[0];
            if (track?.getCapabilities) {
                try {
                    const caps = track.getCapabilities();
                    setCapabilities(caps);
                    if (caps.zoom) {
                        setZoom(track.getSettings().zoom || caps.zoom.min);
                    }
                } catch (e) {
                    console.warn("Could not get track capabilities", e);
                }
            }
        } catch (err) {
            console.error("Error accessing camera:", err);
            if (err.name === 'NotAllowedError') {
                setError("Camera permission denied. Allow access in your browser settings.");
            } else if (err.name === 'NotFoundError') {
                setError("No camera found on this device.");
            } else {
                setError("Could not access camera. Check permissions and connection.");
            }
        }
    };

    useEffect(() => {
        startCamera();
        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }
        };
    }, []);

    const toggleTorch = async () => {
        const stream = streamRef.current;
        if (!stream) return;
        const track = stream.getVideoTracks()[0];
        try {
            const newTorchState = !torchOn;
            await track.applyConstraints({
                advanced: [{ torch: newTorchState }]
            });
            setTorchOn(newTorchState);
        } catch (err) {
            console.error("Failed to toggle torch", err);
        }
    };

    const handleZoomChange = async (e) => {
        const newZoom = parseFloat(e.target.value);
        setZoom(newZoom);
        const stream = streamRef.current;
        if (!stream) return;
        const track = stream.getVideoTracks()[0];
        try {
            await track.applyConstraints({
                advanced: [{ zoom: newZoom }]
            });
        } catch (err) {
            console.error("Failed to apply zoom", err);
        }
    };

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
                    
                    <div className="viewfinder-overlay">
                        <div className="viewfinder-cutout">
                            <div className="corner top-left"></div>
                            <div className="corner top-right"></div>
                            <div className="corner bottom-left"></div>
                            <div className="corner bottom-right"></div>
                        </div>
                        <p className="viewfinder-instruction">Align page within the frame</p>
                    </div>

                    <div className="camera-controls">
                        {capabilities?.torch && (
                            <button onClick={toggleTorch} className={`control-btn ${torchOn ? 'active' : ''}`} title="Toggle flashlight">
                                {torchOn ? <Zap size={20} /> : <ZapOff size={20} />}
                            </button>
                        )}
                        
                        {capabilities?.zoom && (
                            <div className="zoom-control">
                                <ZoomIn size={16} />
                                <input 
                                    type="range" 
                                    min={capabilities.zoom.min} 
                                    max={capabilities.zoom.max} 
                                    step={capabilities.zoom.step || 0.1}
                                    value={zoom}
                                    onChange={handleZoomChange}
                                />
                            </div>
                        )}
                    </div>

                    <button onClick={captureImage} className="capture-btn">
                        <Camera size={22} /> Capture Page
                    </button>
                </div>
            )}
            <canvas ref={canvasRef} style={{ display: 'none' }} />
        </div>
    );
}
