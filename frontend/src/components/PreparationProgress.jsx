import React from 'react';

const CANCELLABLE = new Set(['QUEUED', 'RUNNING', 'PAUSED']);

export default function PreparationProgress({ preparation, onCancel, cancelling = false }) {
    if (!preparation) return null;
    const completed = preparation.completedPages?.length || 0;
    const total = preparation.totalPages || 0;
    const canCancel =
        Boolean(preparation.id) && CANCELLABLE.has(preparation.status) && onCancel;

    return (
        <div className="preparation-progress" role="status">
            <span>
                Prepare book: {String(preparation.status || 'paused').toLowerCase()} ·{' '}
                {completed}/{total} pages
            </span>
            <progress max={total || 1} value={completed} />
            {canCancel ? (
                <button
                    className="btn secondary btn-compact"
                    type="button"
                    onClick={onCancel}
                    disabled={cancelling}
                    aria-label="Cancel preparation"
                >
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
            ) : null}
        </div>
    );
}
