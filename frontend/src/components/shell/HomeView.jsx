import { useRef, useState } from 'react';
import { BookOpen, Camera, FolderPlus, Loader2, Play } from 'lucide-react';
import Button from '../ui/Button';
import PreparedBookRow from './PreparedBookRow';
import { usePreparedLibrary } from '../../hooks/reader/usePreparedLibrary';
import { importPreparedBook } from '../../utils/api';
import { useToast } from '../Toast';

const BOOK_ACCEPT = '.pdf,.epub,.txt,.md,.bookvoice,application/pdf,application/zip';

/**
 * Landing view: pick up where you left off, or start something new.
 * The continue-reading list comes straight from the library; the last
 * opened book leads it.
 */
export default function HomeView({ lastBookId, onOpenBook, onNavigate, onError }) {
    const toast = useToast();
    const { books, isLoading, refresh } = usePreparedLibrary({ onError });
    const [isAdding, setIsAdding] = useState(false);
    const fileInputRef = useRef(null);

    const withProgress = books.filter(
        (book) => (book?.progress?.page || 1) > 1 || (book?.progress?.bookmarks || []).length > 0
    );
    const continueBooks = [
        ...withProgress.filter((book) => String(book.id) === String(lastBookId)),
        ...withProgress.filter((book) => String(book.id) !== String(lastBookId)),
    ].slice(0, 3);
    const startBook = books.find((book) => String(book.id) === String(lastBookId))
        || books[0]
        || null;

    const handleAddBook = async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        setIsAdding(true);
        try {
            const book = await importPreparedBook(file);
            await refresh();
            onOpenBook(book);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            toast.error(`Could not add this book: ${err.message}`);
            onError?.(err);
        } finally {
            setIsAdding(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    return (
        <div className="home">
            <section className="home-hero">
                <h1>Turn any book into an audiobook</h1>
                <p>
                    Open a book to hear it narrated page by page, scan physical pages,
                    or create voices in the Studio.
                </p>
            </section>

            {continueBooks.length > 0 && (
                <section className="home-section" aria-labelledby="home-continue-heading">
                    <h2 className="home-section-heading" id="home-continue-heading">Continue reading</h2>
                    <div className="home-continue-list">
                        {continueBooks.map((book, index) => (
                            <PreparedBookRow
                                key={book.id}
                                book={book}
                                onOpen={onOpenBook}
                                featured={index === 0}
                            />
                        ))}
                    </div>
                </section>
            )}

            {isLoading && (
                /* F-41: reserve the continue-reading slot with the same
                   skeletons Library uses, so nothing shifts when the
                   library resolves (was: a bare hint at page bottom). */
                <section className="home-section" aria-busy="true">
                    <h2 className="home-section-heading">Continue reading</h2>
                    <div className="home-continue-list" role="status" aria-label="Loading your library">
                        <div className="skeleton skeleton--book-row" />
                        <div className="skeleton skeleton--book-row" />
                    </div>
                </section>
            )}

            {!continueBooks.length && startBook && !isLoading && (
                <section className="home-section" aria-labelledby="home-start-heading">
                    <h2 className="home-section-heading" id="home-start-heading">Pick up a book</h2>
                    <div className="home-continue-list">
                        <PreparedBookRow book={startBook} onOpen={onOpenBook} />
                    </div>
                </section>
            )}

            <section className="home-section" aria-labelledby="home-actions-heading">
                <h2 className="home-section-heading" id="home-actions-heading">Start something new</h2>
                <div className="home-actions">
                    <div className="home-action-card">
                        <BookOpen size={22} aria-hidden="true" />
                        <div className="home-action-text">
                            <h3>Listen to a book</h3>
                            <p>PDF, EPUB, or text — added to your library automatically.</p>
                        </div>
                        <Button
                            variant="primary"
                            disabled={isAdding}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {/* F-41: swap icon for spinner (not both) and say what's happening. */}
                            {isAdding
                                ? <Loader2 className="spinner" size={16} aria-hidden="true" />
                                : <FolderPlus size={16} aria-hidden="true" />}
                            {isAdding ? 'Adding…' : 'Add a book'}
                        </Button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={BOOK_ACCEPT}
                            className="file-input"
                            aria-label="Choose a book file to add"
                            onChange={handleAddBook}
                        />
                    </div>
                    <div className="home-action-card">
                        <Camera size={22} aria-hidden="true" />
                        <div className="home-action-text">
                            <h3>Scan physical pages</h3>
                            <p>Photograph a page and hear it read aloud.</p>
                        </div>
                        <Button onClick={() => onNavigate('scan')}>
                            <Camera size={16} aria-hidden="true" />
                            Open scanner
                        </Button>
                    </div>
                    <div className="home-action-card">
                        <Play size={22} aria-hidden="true" />
                        <div className="home-action-text">
                            <h3>Voice Studio</h3>
                            <p>Narrate scripts, convert recordings, or fix a phrase.</p>
                        </div>
                        <Button onClick={() => onNavigate('studio')}>
                            Open Studio
                        </Button>
                    </div>
                </div>
            </section>

        </div>
    );
}
