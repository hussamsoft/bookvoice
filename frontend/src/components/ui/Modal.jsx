import { useEffect, useRef, useState } from 'react';
import Button from './Button';

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

let modalTitleId = 0;

/**
 * Accessible modal dialog: focus moves in on open, is trapped while open,
 * Escape closes, focus returns to whoever opened it, body scroll is locked
 * while open, and the title is wired to aria-labelledby on the dialog.
 */
export default function Modal({ open, onClose, title, children, actions }) {
    const panelRef = useRef(null);
    const previouslyFocused = useRef(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const [titleId] = useState(() => `modal-title-${++modalTitleId}`);
    const [shown, setShown] = useState(false);

    // Scroll lock + enter choreography: mount with the hidden state, then flip
    // classes on the next frame so the overlay fade / panel scale transitions
    // run instead of being swallowed by insertion.
    useEffect(() => {
        if (!open) {
            setShown(false);
            document.body.style.overflow = '';
            return undefined;
        }
        document.body.style.overflow = 'hidden';
        let raf2;
        const raf1 = requestAnimationFrame(() => {
            raf2 = requestAnimationFrame(() => setShown(true));
        });
        return () => {
            cancelAnimationFrame(raf1);
            cancelAnimationFrame(raf2);
            document.body.style.overflow = '';
        };
    }, [open]);

    // Focus management: remember where we came from, move focus in on open,
    // trap Tab within the dialog, restore focus on close.
    useEffect(() => {
        if (!open) return undefined;
        previouslyFocused.current = document.activeElement;
        const panel = panelRef.current;
        const first = panel?.querySelector(FOCUSABLE);
        (first || panel)?.focus();

        const handleKey = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onCloseRef.current?.();
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
    }, [open]);

    if (!open) return null;

    return (
        <div
            className={`modal-overlay${shown ? ' is-shown' : ''}`}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    event.preventDefault();
                    onCloseRef.current?.();
                }
            }}
        >
            <div
                ref={panelRef}
                className={`modal-panel${shown ? ' is-shown' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title ? titleId : undefined}
                tabIndex={-1}
            >
                {title ? <h2 className="modal-title" id={titleId}>{title}</h2> : null}
                {children}
                {actions ? (
                    <div className="modal-actions">
                        {actions.map(({ label, onClick, variant, key }) => (
                            <Button key={key ?? label} variant={variant} onClick={onClick}>
                                {label}
                            </Button>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
