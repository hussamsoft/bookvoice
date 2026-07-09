import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Loader2, Play, Pause, ChevronUp, ChevronDown, X } from 'lucide-react';
import { narrateText, getTtsStatus } from '../utils/api';
import { useToast } from './Toast';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import VoiceSettings from './VoiceSettings';
import Transcript from './Transcript';

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export default function PdfViewer() {
    const toast = useToast();
    const [file, setFile] = useState(null);
    const [numPages, setNumPages] = useState(null);
    const [pageNumber, setPageNumber] = useState(1);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentSentenceIndex, setCurrentSentenceIndex] = useState(-1);
    const [sentences, setSentences] = useState([]);
    const [audioUrl, setAudioUrl] = useState(null);
    const [audioPage, setAudioPage] = useState(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [activeVoiceId, setActiveVoiceId] = useState(null);
    const [targetLanguage, setTargetLanguage] = useState("en");
    const [modelReady, setModelReady] = useState(false);
    const [modelError, setModelError] = useState(null);
    const [modelStatusDetail, setModelStatusDetail] = useState("Warming up AI voices...");
    const [showResumeChoice, setShowResumeChoice] = useState(false);
    const [pageText, setPageText] = useState("");
    const [pageWords, setPageWords] = useState([]);
    const [wordStartTimes, setWordStartTimes] = useState([]);
    const [currentWord, setCurrentWord] = useState(-1);

    const audioRef = useRef(null);
    const containerRef = useRef(null);

    const chunkText = (text) => {
        return text.match(/[^.!?]+[.!?]+/g) || [text];
    };

    const extractTextFromPage = async (pdf, pageNum) => {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const textItems = textContent.items.map(item => item.str);
        return textItems.join(' ');
    };

    // Poll TTS model status until ready
    useEffect(() => {
        const poll = async () => {
            try {
                const status = await getTtsStatus();
                if (status.status === "ready") {
                    setModelReady(true);
                    setModelError(null);
                    setModelStatusDetail("");
                } else if (status.status === "loading") {
                    setModelStatusDetail(status.detail || "Warming up AI voices...");
                } else if (status.status === "error") {
                    setModelError(status.detail || "Model failed to load");
                    setModelReady(false);
                    setModelStatusDetail("");
                } else if (status.status === "idle") {
                    setModelStatusDetail("Initializing model preload...");
                }
            } catch {
                // Backend not ready yet, keep polling
            }
        };
        const interval = setInterval(poll, 2000);
        poll();
        return () => clearInterval(interval);
    }, []);

    // Compute word timings when audio metadata loads
    const computeWordTimings = useCallback((text, duration) => {
        const words = text.split(/\s+/).filter(Boolean);
        if (!words.length || !duration) return;
        setPageWords(words);
        const totalChars = words.reduce((sum, w) => sum + w.length, 0);
        let cumulative = 0;
        const times = words.map(w => {
            const start = cumulative;
            cumulative += (w.length / totalChars) * duration;
            return start;
        });
        setWordStartTimes(times);
    }, []);

    // Track word position during playback
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || pageWords.length === 0) return;

        const handleTimeUpdate = () => {
            const duration = audio.duration;
            const currentTime = audio.currentTime;
            if (!duration) return;

            // Sentence highlighting (existing)
            const totalChars = sentences.join('').length;
            if (sentences.length > 0) {
                let charAcc = 0;
                const progressRatio = currentTime / duration;
                const targetChar = progressRatio * totalChars;
                let foundIndex = 0;
                for (let i = 0; i < sentences.length; i++) {
                    charAcc += sentences[i].length;
                    if (charAcc >= targetChar) { foundIndex = i; break; }
                }
                setCurrentSentenceIndex(foundIndex);

                const textLayer = document.querySelector('.react-pdf__Page__textContent');
                if (textLayer && sentences[foundIndex]) {
                    const spans = Array.from(textLayer.querySelectorAll('span'));
                    const words = sentences[foundIndex].split(' ').filter(w => w.length > 3);
                    spans.forEach(span => {
                        span.classList.remove('highlight-active');
                        if (words.some(w => span.textContent.includes(w))) {
                            span.classList.add('highlight-active');
                        }
                    });
                }
            }

            // Word tracking
            let idx = -1;
            for (let i = wordStartTimes.length - 1; i >= 0; i--) {
                if (currentTime >= wordStartTimes[i]) { idx = i; break; }
            }
            setCurrentWord(idx);
        };

        const handleLoadedMetadata = () => {
            if (pageText) {
                computeWordTimings(pageText, audio.duration);
            }
        };

        const handleEnded = () => {
            setIsPlaying(false);
            setCurrentSentenceIndex(-1);
            setCurrentWord(-1);
        };

        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('loadedmetadata', handleLoadedMetadata);
        audio.addEventListener('ended', handleEnded);
        return () => {
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
            audio.removeEventListener('ended', handleEnded);
        };
    }, [sentences, pageWords, wordStartTimes, pageText, computeWordTimings]);

    const generateAudio = async (pageNum, text) => {
        setIsGenerating(true);
        try {
            const url = await narrateText(text, 'pdf_session_' + Date.now(), pageNum, activeVoiceId, targetLanguage);
            setAudioUrl(url);
            setAudioPage(pageNum);
            if (audioRef.current) {
                audioRef.current.src = url;
                audioRef.current.play();
            }
            setIsPlaying(true);
            setCurrentSentenceIndex(0);
            setCurrentWord(0);
        } catch (error) {
            toast.error("Failed to narrate: " + error.message);
        } finally {
            setIsGenerating(false);
        }
    };

    const handlePlay = async () => {
        if (!file || !numPages) return;

        if (isPlaying) {
            audioRef.current?.pause();
            setIsPlaying(false);
            return;
        }

        // If we have audio for the CURRENT page, resume
        if (audioUrl && audioPage === pageNumber) {
            audioRef.current?.play();
            setIsPlaying(true);
            return;
        }

        // If we have audio for a DIFFERENT page, show choice
        if (audioUrl && audioPage !== pageNumber) {
            setShowResumeChoice(true);
            return;
        }

        // No existing audio — generate for current page
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        const text = await extractTextFromPage(pdf, pageNumber);
        setPageText(text);
        setSentences(chunkText(text));
        setPageWords([]);
        setWordStartTimes([]);
        setCurrentWord(-1);
        await generateAudio(pageNumber, text);
    };

    const handleResume = () => {
        setShowResumeChoice(false);
        if (audioRef.current) {
            audioRef.current.play();
            setIsPlaying(true);
        }
    };

    const handleReadNewPage = async () => {
        setShowResumeChoice(false);
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
        const text = await extractTextFromPage(pdf, pageNumber);
        setPageText(text);
        setSentences(chunkText(text));
        setPageWords([]);
        setWordStartTimes([]);
        setCurrentWord(-1);
        await generateAudio(pageNumber, text);
    };

    const handleSeek = (time) => {
        if (audioRef.current) {
            audioRef.current.currentTime = time;
            if (!isPlaying) {
                audioRef.current.play();
                setIsPlaying(true);
            }
        }
    };

    const visiblePages = [];
    if (numPages) {
        visiblePages.push(pageNumber);
        if (pageNumber + 1 <= numPages) visiblePages.push(pageNumber + 1);
        if (pageNumber + 2 <= numPages) visiblePages.push(pageNumber + 2);
    }

    const getPlayButtonState = () => {
        if (modelError) return { text: "AI model error", disabled: true, icon: null };
        if (!modelReady) return { text: "Warming up AI voices…", disabled: true, icon: <Loader2 className="spinner" size={16}/> };
        if (isGenerating) return { text: " Generating…", disabled: true, icon: <Loader2 className="spinner" size={16}/> };
        if (isPlaying) return { text: " Pause", disabled: false, icon: <Pause size={16}/> };
        if (audioUrl && audioPage !== pageNumber) return { text: " Read Page " + pageNumber, disabled: false, icon: <Play size={16}/> };
        return { text: " Read Page " + pageNumber, disabled: false, icon: <Play size={16}/> };
    };

    const playBtn = getPlayButtonState();

    return (
        <div className="pdf-viewer-container">
            {!file ? (
                <div className="upload-state pdf-upload-state">
                    <input
                        type="file"
                        accept=".pdf"
                        onChange={(e) => setFile(e.target.files[0])}
                        id="pdf-upload"
                        className="file-input"
                    />
                    <label htmlFor="pdf-upload" className="btn primary">
                        Select PDF Book
                    </label>
                </div>
            ) : (
                <>
                    <div className="voice-settings-bar">
                        <VoiceSettings activeVoiceId={activeVoiceId} onVoiceChange={setActiveVoiceId} />
                    </div>
                    <div className="pdf-controls-bar">
                        <button className="btn secondary" onClick={() => setPageNumber(Math.max(1, pageNumber - 1))} disabled={pageNumber === 1}>
                            <ChevronUp size={16}/> Prev
                        </button>
                        <button className="btn primary" onClick={handlePlay} disabled={playBtn.disabled}>
                            {playBtn.icon}
                            {playBtn.text}
                        </button>
                        <button className="btn secondary" onClick={() => setPageNumber(Math.min(numPages, pageNumber + 1))} disabled={pageNumber === numPages}>
                            Next <ChevronDown size={16}/>
                        </button>
                        <span className="pdf-page-indicator">Page {pageNumber} of {numPages}</span>
                    </div>

                    {!modelReady && modelStatusDetail && (
                        <div className="model-loading-status-bar">
                            <Loader2 className="spinner" size={14} />
                            <span>{modelStatusDetail}</span>
                        </div>
                    )}
                    {modelError && (
                        <div className="model-loading-status-bar error">
                            <span>Error: {modelError}</span>
                        </div>
                    )}

                    {/* Resume/New Page Choice Modal */}
                    {showResumeChoice && (
                        <div className="resume-modal-overlay" onClick={() => setShowResumeChoice(false)}>
                            <div className="resume-modal" onClick={(e) => e.stopPropagation()}>
                                <button className="resume-modal-close" onClick={() => setShowResumeChoice(false)}>
                                    <X size={18} />
                                </button>
                                <h3>Resume or start new?</h3>
                                <p>You have audio for <strong>Page {audioPage}</strong>.</p>
                                <div className="resume-modal-actions">
                                    <button className="btn secondary" onClick={handleResume}>
                                        Resume Page {audioPage}
                                    </button>
                                    <button className="btn primary" onClick={handleReadNewPage}>
                                        Read Page {pageNumber}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="pdf-layout">
                        <div className="pdf-main">
                            <div className="pdf-scroll-area" ref={containerRef}>
                                <Document
                                    file={file}
                                    onLoadSuccess={({ numPages }) => setNumPages(numPages)}
                                    loading={<div className="pdf-loading"><Loader2 className="spinner" size={40} /></div>}
                                >
                                    {visiblePages.map(page => (
                                        <div key={page} className="pdf-page-wrapper">
                                            <Page
                                                pageNumber={page}
                                                width={800}
                                                renderAnnotationLayer={false}
                                            />
                                        </div>
                                    ))}
                                </Document>
                            </div>
                        </div>
                        <div className="pdf-transcript">
                            <Transcript
                                words={pageWords}
                                wordStartTimes={wordStartTimes}
                                currentWord={currentWord}
                                isPlaying={isPlaying}
                                isPaused={!!audioUrl && !isPlaying && !isGenerating}
                                sessionId={'pdf_session_' + Date.now()}
                                pageIndex={pageNumber}
                                voiceId={activeVoiceId}
                                languageId={targetLanguage}
                                onSeek={handleSeek}
                                audioRef={audioRef}
                            />
                        </div>
                    </div>
                </>
            )}
            <audio ref={audioRef} style={{ display: 'none' }} />
        </div>
    );
}
