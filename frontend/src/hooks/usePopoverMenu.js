import { useEffect } from 'react';

// F-27: one keyboard/focus contract for the app's popovers (the Library
// book-actions menu and the Reader "More options" popover). The old
// LibraryView markup declared role="menu"/"menuitem" — promising the ARIA
// menu pattern while delivering none of it (no focus transfer, no arrows).
// Rather than half-implementing that pattern around controls that are not
// menuitems (the Reader popover holds a search field and zoom buttons), both
// popovers drop the menu roles and use this disclosure contract:
//
//   * opening moves focus to the first enabled control;
//   * ArrowDown/ArrowUp cycle focus, wrapping; Home/End jump to the ends;
//   * Escape closes the popover and returns focus to the trigger.
//
// The container element must be the popover itself (children are queried
// from containerRef) and must only be mounted while `open` is true.

const ITEM_SELECTOR = [
    'button:not(:disabled)',
    'input:not(:disabled)',
    'select:not(:disabled)',
    'textarea:not(:disabled)',
    'a[href]',
].join(', ');

export function usePopoverMenu({ open, containerRef, triggerRef, onClose }) {
    useEffect(() => {
        if (!open) return undefined;
        const container = containerRef.current;
        if (!container) return undefined;

        const items = () => Array.from(container.querySelectorAll(ITEM_SELECTOR));
        const first = items()[0];
        first?.focus();

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onClose();
                triggerRef.current?.focus();
                return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const current = items();
            if (!current.length) return;
            const active = document.activeElement;
            const index = current.indexOf(active);
            let next;
            if (event.key === 'Home') next = current[0];
            else if (event.key === 'End') next = current[current.length - 1];
            else if (event.key === 'ArrowDown') next = current[(index + 1) % current.length];
            else next = current[(index - 1 + current.length) % current.length];
            // Only swallow the key while focus is inside the popover, so
            // app-level shortcuts keep working from the trigger.
            if (index === -1 && !container.contains(active)) return;
            event.preventDefault();
            next.focus();
        };

        container.addEventListener('keydown', onKeyDown);
        return () => container.removeEventListener('keydown', onKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
}
