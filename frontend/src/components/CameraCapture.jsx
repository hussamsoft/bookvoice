import React, { useRef, useState, useEffect } from 'react';
import { Camera, RefreshCw, Zap, ZapOff, ZoomIn } from 'lucide-react';
import { capturePageRegion } from '../utils/cameraCrop';

export default function CameraCapture({ onCapture }) {
    const videoRef = useRef(null);
    const cutoutRef = useRef(null);
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
                    // Prefer portrait sensor when available (phone-style page capture)
                    width: { ideal: 1440 },
                    height: { ideal: 1920 },
                    aspectRatio: { ideal: 0.707 }, // ~1/√2 portrait
                },
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
                    console.warn('Could not get track capabilities', e);
                }
            }
        } catch (err) {
            console.error('Error accessing camera:', err);
            if (err.name === 'NotAllowedError') {
                setError('Camera permission denied. Allow access in your browser settings.');
            } else if (err.name === 'NotFoundError') {
                setError('No camera found on this device.');
            } else {
                setError('Could not access camera. Check permissions and connection.');
            }
        }
    };

    useEffect(() => {
        startCamera();
        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach((track) => track.stop());
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
                advanced: [{ torch: newTorchState }],
            });
            setTorchOn(newTorchState);
        } catch (err) {
            console.error('Failed to toggle torch', err);
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
                advanced: [{ zoom: newZoom }],
            });
        } catch (err) {
            console.error('Failed to apply zoom', err);
        }
    };

    const captureImage = () => {
        if (!videoRef.current || !cutoutRef.current) return;

        // Prefer crop to the portrait page frame; fall back to full frame.
        let imageDataUrl = capturePageRegion(videoRef.current, cutoutRef.current, 0.92);
        if (!imageDataUrl) {
            const video = videoRef.current;
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            imageDataUrl = canvas.toDataURL('image/jpeg', 0.9);
        }
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

                    <div className="viewfinder-overlay" aria-hidden="true">
                        {/* ISO A-series portrait page frame (≈ book page) */}
                        <div className="viewfinder-cutout" ref={cutoutRef}>
                            <div className="corner top-left" />
                            <div className="corner top-right" />
                            <div className="corner bottom-left" />
                            <div className="corner bottom-right" />
                            <span className="viewfinder-page-label">Book page</span>
                        </div>
                        <p className="viewfinder-instruction">
                            Align the book page inside the portrait frame
                        </p>
                    </div>

                    <div className="camera-controls">
                        {capabilities?.torch && (
                            <button
                                onClick={toggleTorch}
                                className={`control-btn ${torchOn ? 'active' : ''}`}
                                title="Toggle flashlight"
                            >
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
        </div>
    );
}
