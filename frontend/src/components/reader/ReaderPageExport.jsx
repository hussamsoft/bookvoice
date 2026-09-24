import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { exportCachedAudio, getPreparedPage } from '../../utils/api';
import {
    buildPageAudioZip,
    createSinglePageDownload,
    pageAudioFilename,
} from '../../utils/pageAudioZip';
import { usePopoverMenu } from '../../hooks/usePopoverMenu';

function downloadFile(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

export default function ReaderPageExport({
    book,
    profile,
    currentPage,
    numPages,
    currentPreparedAudio,
    modelReady,
    sessionId,
    toast,
}) {
    const [open, setOpen] = useState(false);
    const [showRange, setShowRange] = useState(false);
    const [startPage, setStartPage] = useState(String(currentPage));
    const [endPage, setEndPage] = useState(String(currentPage));
    const triggerRef = useRef(null);
    const popoverRef = useRef(null);

    usePopoverMenu({
        open,
        containerRef: popoverRef,
        triggerRef,
        onClose: () => setOpen(false),
    });

    useEffect(() => {
        setStartPage(String(currentPage));
        setEndPage(String(currentPage));
        setShowRange(false);
    }, [currentPage, book?.id]);

    if (!book) return null;
    const hasPreparedAudio = Boolean(currentPreparedAudio?.audioUrl);
    const disabledReason = !modelReady
        ? 'The narration model is not ready.'
        : hasPreparedAudio
            ? ''
            : `Page ${currentPage} has no prepared audio. Generate it first.`;

    const downloadCurrentPage = async () => {
        try {
            let audioUrl = currentPreparedAudio?.audioUrl;
            try {
                const exported = await exportCachedAudio(sessionId, currentPage, currentPage);
                if (exported.pages.includes(currentPage)) audioUrl = exported.audioUrl;
            } catch (error) {
                if (!audioUrl) throw error;
            }
            const file = createSinglePageDownload({
                bookTitle: book.title,
                page: currentPage,
                audioUrl,
            });
            downloadFile(file.downloadUrl, file.filename);
            toast.success(`Downloaded page ${currentPage} audio.`);
        } catch (error) {
            toast.error(error?.message || `Could not download page ${currentPage} audio.`);
        }
    };

    const downloadRange = async () => {
        const start = Number(startPage);
        const end = Number(endPage);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > numPages) {
            toast.error('Choose a valid inclusive page range.');
            return;
        }
        try {
            const selected = await Promise.all(
                Array.from({ length: end - start + 1 }, (_, index) => start + index)
                    .map((page) => getPreparedPage(book.id, profile?.id, page)),
            );
            if (selected.some((page) => !page?.audioUrl)) {
                const missing = selected
                    .map((page, index) => (page?.audioUrl ? null : start + index))
                    .filter(Boolean);
                throw new Error(`No prepared audio for page${missing.length === 1 ? '' : 's'} ${missing.join(', ')}.`);
            }
            const pages = selected.map((page, index) => ({ ...page, page: start + index }));
            const zip = await buildPageAudioZip({
                bookTitle: book.title,
                pages,
                startPage: start,
                endPage: end,
                onProgress: ({ total, page }) => {
                    toast.info(`Downloading page ${page} of ${total}`);
                },
            });
            const url = URL.createObjectURL(zip);
            downloadFile(url, pageAudioFilename(book.title, start, end));
            setTimeout(() => URL.revokeObjectURL(url), 0);
            toast.success(`Downloaded pages ${start}–${end}.`);
        } catch (error) {
            toast.error(error?.message || `Could not download pages ${startPage}–${endPage}.`);
        }
    };

    return (
        <div className="reader-nav-menu-group reader-page-audio-options">
            <span className="reader-nav-menu-label">Page audio</span>
            <button
                type="button"
                className="btn secondary btn-compact"
                ref={triggerRef}
                aria-haspopup="true"
                aria-expanded={open}
                disabled={Boolean(disabledReason)}
                title={disabledReason || 'Download prepared page audio'}
                onClick={() => setOpen((value) => !value)}
            >
                <Download size={14} aria-hidden="true" />
                Download page audio
            </button>
            {open && (
                <div
                    className="reader-page-audio-popover"
                    role="group"
                    aria-label="Page audio export options"
                    ref={popoverRef}
                >
                    {hasPreparedAudio && (
                        <button
                            type="button"
                            className="btn secondary btn-compact"
                            onClick={downloadCurrentPage}
                        >
                            Download this page (WAV)
                        </button>
                    )}
                    <button
                        type="button"
                        className="btn secondary btn-compact"
                        onClick={() => setShowRange(true)}
                    >
                        Download a range (ZIP)
                    </button>
                    {showRange && (
                        <div className="reader-export-range">
                            <label>
                                Start page
                                <input
                                    type="number"
                                    min={1}
                                    max={numPages || 1}
                                    value={startPage}
                                    onChange={(event) => setStartPage(event.target.value)}
                                />
                            </label>
                            <label>
                                End page
                                <input
                                    type="number"
                                    min={1}
                                    max={numPages || 1}
                                    value={endPage}
                                    onChange={(event) => setEndPage(event.target.value)}
                                />
                            </label>
                            <button
                                type="button"
                                className="btn primary btn-compact"
                                onClick={downloadRange}
                            >
                                Download range ZIP
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
