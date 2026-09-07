import { useRef, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import Button from '../ui/Button';
import PreparedBookRow from './PreparedBookRow';
import { usePreparedLibrary } from '../../hooks/reader/usePreparedLibrary';
import { importPreparedBook } from '../../utils/api';

const BOOK_ACCEPT = '.pdf,.epub,.txt,.md,.bookvoice,application/pdf,application/zip';

/**
 * Every book the app knows, with one obvious way in. Whole-book actions
 * (prepare, export) live on this page and inside the reader — never more
 * than one level from the book list.
 */
export default function LibraryView({ onOpenBook, onError }) {
    const { books, isLoading, refresh } = usePreparedLibrary({ onError });
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
                        <PreparedBookRow key={book.id} book={book} onOpen={onOpenBook} />
                    ))}
                </div>
            )}
        </div>
    );
}
