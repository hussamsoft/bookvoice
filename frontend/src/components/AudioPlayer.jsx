import React, { useRef, useState, useEffect } from 'react';
import { Play, Pause, SkipBack, Forward } from 'lucide-react';

export default function AudioPlayer({ audioUrl, onNextPage }) {
    const audioRef = useRef(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackRate, setPlaybackRate] = useState(1);
    
    useEffect(() => {
        if (audioRef.current) {
            audioRef.current.play().catch(e => console.error("Autoplay failed:", e));
        }
    }, [audioUrl]);

    const togglePlay = () => {
        if (audioRef.current) {
            if (isPlaying) {
                audioRef.current.pause();
            } else {
                audioRef.current.play();
            }
        }
    };

    const skipBack = () => {
        if (audioRef.current) {
            audioRef.current.currentTime -= 10;
        }
    };

    const changeSpeed = () => {
        const rates = [0.5, 1, 1.25, 1.5, 2];
        const nextIndex = (rates.indexOf(playbackRate) + 1) % rates.length;
        const newRate = rates[nextIndex];
        
        setPlaybackRate(newRate);
        if (audioRef.current) {
            audioRef.current.playbackRate = newRate;
        }
    };

    return (
        <div className="audio-player">
            <audio 
                ref={audioRef} 
                src={audioUrl} 
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
            />
            
            <div className="player-controls">
                <button onClick={skipBack} className="control-btn" title="Skip back 10s">
                    <SkipBack size={24} />
                </button>
                
                <button onClick={togglePlay} className="control-btn primary-control">
                    {isPlaying ? <Pause size={32} /> : <Play size={32} />}
                </button>
                
                <button onClick={changeSpeed} className="control-btn text-btn" title="Playback Speed">
                    {playbackRate}x
                </button>
            </div>
            
            <button onClick={onNextPage} className="btn primary full-width mt-4">
                Capture Next Page <Forward size={16} />
            </button>
        </div>
    );
}
