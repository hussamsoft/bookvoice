import React, { useState, useRef, useEffect } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { Loader2, Play, Pause, ChevronUp, ChevronDown } from 'lucide-react';
import { narrateText } from '../utils/api';
import { useToast } from './Toast';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import VoiceSettings from './VoiceSettings';

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
    const [isGenerating, setIsGenerating] = useState(false);
    const [activeVoiceId, setActiveVoiceId] = useState(null);
    const [targetLanguage, setTargetLanguage] = useState("en");

    const audioRef = useRef(null);
    const containerRef = useRef(null);
    
    // Chunking text into rough sentences
    const chunkText = (text) => {
        return text.match(/[^.!?]+[.!?]+/g) || [text];
    };

    const extractTextFromPage = async (pdf, pageNum) => {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const textItems = textContent.items.map(item => item.str);
        return textItems.join(' ');
    };

    const handlePlay = async () => {
        if (!file || !numPages) return;
        
        if (isPlaying) {
            audioRef.current?.pause();
            setIsPlaying(false);
            return;
        }

        if (audioUrl) {
            audioRef.current?.play();
            setIsPlaying(true);
            return;
        }

        setIsGenerating(true);
        try {
            const pdf = await pdfjs.getDocument(file).promise;
            const text = await extractTextFromPage(pdf, pageNumber);
            const pageSentences = chunkText(text);
            setSentences(pageSentences);
            
            // Generate full page TTS for simplicity.
            const url = await narrateText(text, 'pdf_session_' + Date.now(), pageNumber, activeVoiceId, targetLanguage);
            setAudioUrl(url);
            
            if (audioRef.current) {
                audioRef.current.src = url;
                audioRef.current.play();
            }
            setIsPlaying(true);
            setCurrentSentenceIndex(0);
        } catch (error) {
            toast.error("Failed to narrate: " + error.message);
        } finally {
            setIsGenerating(false);
        }
    };

    // Simulate highlighting based on audio progress
    useEffect(() => {
        const audio = audioRef.current;
        if (!audio || sentences.length === 0) return;

        const handleTimeUpdate = () => {
            const duration = audio.duration;
            const currentTime = audio.currentTime;
            if (!duration) return;
            
            const totalChars = sentences.join('').length;
            let charAcc = 0;
            let foundIndex = 0;
            
            const progressRatio = currentTime / duration;
            const targetChar = progressRatio * totalChars;

            for (let i = 0; i < sentences.length; i++) {
                charAcc += sentences[i].length;
                if (charAcc >= targetChar) {
                    foundIndex = i;
                    break;
                }
            }
            setCurrentSentenceIndex(foundIndex);
            
            // Visual highlighting logic - fuzzy match in DOM
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
        };

        const handleEnded = () => {
            setIsPlaying(false);
            setCurrentSentenceIndex(-1);
        };

        audio.addEventListener('timeupdate', handleTimeUpdate);
        audio.addEventListener('ended', handleEnded);
        return () => {
            audio.removeEventListener('timeupdate', handleTimeUpdate);
            audio.removeEventListener('ended', handleEnded);
        };
    }, [sentences]);

    // Handle scroll virtualization - render current page + next
    // For 2.5 pages visibility, we render 3 pages
    const visiblePages = [];
    if (numPages) {
        visiblePages.push(pageNumber);
        if (pageNumber + 1 <= numPages) visiblePages.push(pageNumber + 1);
        if (pageNumber + 2 <= numPages) visiblePages.push(pageNumber + 2);
    }

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
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem', background: 'var(--surface)', padding: '1rem', borderRadius: '0.5rem', boxShadow: 'var(--shadow-sm)' }}>
                        <VoiceSettings activeVoiceId={activeVoiceId} onVoiceChange={setActiveVoiceId} />
                    </div>
                    <div className="pdf-controls-bar">
                        <button className="btn secondary" onClick={() => setPageNumber(Math.max(1, pageNumber - 1))} disabled={pageNumber === 1}>
                            <ChevronUp size={16}/> Prev
                        </button>
                        <button className="btn primary" onClick={handlePlay} disabled={isGenerating}>
                            {isGenerating ? <Loader2 className="spinner" size={16}/> : isPlaying ? <Pause size={16}/> : <Play size={16}/>}
                            {isGenerating ? " Generating..." : isPlaying ? " Pause" : " Read Page " + pageNumber}
                        </button>
                        <button className="btn secondary" onClick={() => setPageNumber(Math.min(numPages, pageNumber + 1))} disabled={pageNumber === numPages}>
                            Next <ChevronDown size={16}/>
                        </button>
                        <span className="pdf-page-indicator">Page {pageNumber} of {numPages}</span>
                    </div>
                    
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
                </>
            )}
            <audio ref={audioRef} style={{ display: 'none' }} />
        </div>
    );
}
