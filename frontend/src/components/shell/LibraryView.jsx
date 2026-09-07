import { useRef, useState } from 'react';
import { BookOpen, Download, FolderPlus, Loader2 } from 'lucide-react';
import Button from '../ui/Button';
import { useToast } from '../Toast';
import PreparedBookRow from './PreparedBookRow';
import { usePreparedLibrary } from '../../hooks/reader/usePreparedLibrary';
import { useBookActions } from '../../hooks/useBookActions';
import { useUserConfig } from '../../hooks/useUserConfig';
import { activePreparedProfile } from '../../utils/preparedPages';
import { importPreparedBook } from '../../utils/api';

const BOOK_ACCEPT = '.pdf,.epub,.txt,.md,.bookvoice,application/pdf,application/zip';

function BookRowMenu({ book, job, actions }) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);
    const profileId = activePreparedProfile(book)?.id || null;
    const hasProfile = Boolean(profileId);

    const close = () => setOpen(false);

    const onKeyDown = (event) => {
        if (event.key === 'Escape') {
            close();
            rootRef.current?.querySelector('button')?.focus();
        }
    };

    const onOutside = (event) => {
        if (rootRef.current && !rootRef.current.contains(event.target)) close();
    };

    return (
        <div
            className="book-actions"
            ref={rootRef}
            onKeyDown={onKeyDown}
            onMouseDown={onOutside}
        >
            <button
                type="button"
                className="btn secondary btn-compact book-actions-trigger"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-haspopup="true"
                aria-label={`Book actions for ${book.title || 'book'}`}
                title="Prepare, save, or export this book"
            >
                <BookOpen size={15} aria-hidden="true" />
            </button>
            {open ? (
                <div className="book-actions-menu" role="menu" aria-label="Book actions">
                    {job ? (
                        <button
                            type="button"
                            role="menuitem"
                            className="btn secondary btn-compact"
                            onClick={() => {
                                actions.cancelJob(book);
                                close();
                            }}
                        >
                            {job.pagesDone
                                ? `Cancel ${job.label} (${job.pagesDone}/${job.pageCount ?? '—'})`
                                : `Cancel ${job.label.toLowerCase()}`}
                        </button>
                    ) : (
                        <button
                            type="button"
                            role="menuitem"
                            className="btn primary btn-compact"
                            onClick={() => {
                                actions.prepareBook(book);
                                close();
                            }}
                            title="Extract every page and narrate it in the background"
                        >
                            Prepare whole book
                        </button>
                    )}
                    <button
                        type="button"
                        role="menuitem"
                        className="btn secondary btn-compact"
                        disabled={!hasProfile}
                        title={hasProfile ? 'Download a portable .bookvoice archive' : 'Prepare the book first'}
                        onClick={() => {
                            actions.exportArchive(book, profileId);
                            close();
                        }}
                    >
                        <Download size={15} aria-hidden="true" /> Save .bookvoice file
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        className="btn secondary btn-compact"
                        disabled={!hasProfile}
                        title={hasProfile ? 'Render a chaptered M4B audiobook' : 'Prepare the book first'}
                        onClick={() => {
                            actions.exportAudiobook(book, profileId);
                            close();
                        }}
                    >
                        Export audiobook
                    </button>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Every book the app knows, with one obvious way in. Whole-book actions
 * (prepare, export) sit beside each row — never more than one level deep.
 */
export default function LibraryView({ onOpenBook, onError }) {
    const { books, isLoading, refresh } = usePreparedLibrary({ onError });
    const { config } = useUserConfig();
    const toast = useToast();
    const actions = useBookActions({
        toast,
        getVoiceId: () => config.voice_id ?? null,
        getLanguageId: () => config.language_id || 'en',
    });
    const [isAdding, setIsAdding] = useState(false);
    const fileInputRef = useRef(null);

    const handleAddBook = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsAdding(true);
        try {
            const book = await importPreparedBook(file);
            await refresh();
            onOpenBook(book);
        } catch (error) {
            onError?.(error instanceof Error ? error : new Error(String(error)));
        } finally {
            setIsAdding(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="library">
            <div className="library-header">
                <div>
                    <h1>Library</h1>
                    <p className="hint">
                        Books open straight into the player. Everything stays on this computer.
                    </p>
                </div>
                <Button variant="primary" disabled={isAdding} onClick={() => fileInputRef.current?.click()}>
                    <FolderPlus size={16} aria-hidden="true" />
                    {isAdding ? <Loader2 className="spinner" size={16} aria-hidden="true" /> : null}
                    Add a book
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept={BOOK_ACCEPT}
                    className="file-input"
                    onChange={handleAddBook}
                />
            </div>

            {isLoading && (
                <div className="library-list" aria-busy="true">
                    <div className="skeleton skeleton--book-row" />
                    <div className="skeleton skeleton--book-row" />
                </div>
            )}

            {!isLoading && books.length === 0 && (
                <div className="empty-state">
                    <p className="empty-state-title">No books yet</p>
                    <p className="empty-state-hint">
                        Add a PDF, EPUB, or text file — or scan pages from a physical book.
                    </p>
                    <Button variant="primary" onClick={() => fileInputRef.current?.click()}>
                        Add a book
                    </Button>
                </div>
            )}

            {!isLoading && books.length > 0 && (
                <div className="library-list">
                    {books.map((book) => (
                        <div className="library-row" key={book.id}>
                            <PreparedBookRow book={book} onOpen={onOpenBook} />
                            <BookRowMenu book={book} job={actions.jobs[book.id]} actions={actions} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
