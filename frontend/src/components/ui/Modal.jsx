import React, { useEffect, useRef } from 'react';

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Accessible modal dialog: focus moves in on open, is trapped while open,
 * Escape closes, and focus returns to whoever opened it.
 */
export default function Modal({ open, onClose, title, children, actions, closeLabel = 'Close' }) {
    const panelRef = useRef(null);
    const previouslyFocused = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        previouslyFocused.current = document.activeElement;
        const panel = panelRef.current;
        const first = panel?.querySelector(FOCUSABLE);
        (first || panel)?.focus();

        const handleKey = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onClose?.();
                return;
            }
            if (event.key !== 'Tab' || !panel) return;
            const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
                (element) => element.offsetParent !== null
            );
            if (!items.length) return;
            const firstItem = items[0];
            const lastItem = items[items.length - 1];
            if (event.shiftKey && document.activeElement === firstItem) {
                event.preventDefault();
                lastItem.focus();
            } else if (!event.shiftKey && document.activeElement === lastItem) {
                event.preventDefault();
                firstItem.focus();
            }
        };

        document.addEventListener('keydown', handleKey, true);
        return () => {
            document.removeEventListener('keydown', handleKey, true);
            if (previouslyFocused.current?.focus) previouslyFocused.current.focus();
        };
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div
            className="modal-overlay"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose?.();
            }}
        >
            <div
                ref={panelRef}
                className="modal-panel"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
            >
                {title ? <h2 className="modal-title">{title}</h2> : null}
                {children}
                {actions ? (
                    <div className="modal-actions">
                        {actions.map(({ label, onClick, variant, key }) => (
                            <button
                                key={key ?? label}
                                type="button"
                                className={
                                    variant === 'primary'
                                        ? 'btn primary'
                                        : variant === 'danger'
                                            ? 'btn danger'
                                            : 'btn secondary'
                                }
                                onClick={onClick}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export { FOCUSABLE };
