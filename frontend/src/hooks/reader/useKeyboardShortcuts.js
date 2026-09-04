import { useEffect, useRef } from 'react';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

/**
 * Reader-level keyboard shortcuts.
 *
 * The original PdfViewer wired only Space (play/pause) and ←/→ (10 s
 * skip). The plan's §2.3.8 extends that to the Apple-grade reader set:
 *
 *   Space         play / pause
 *   ←  /  →       seek -10 s / +10 s
 *   PageUp/PageDown    previous / next page (the standard reader key)
 *   Cmd/Ctrl+[ / Cmd/Ctrl+]    previous / next page (macOS)
 *   Home / End    first / last page
 *   F            open Find
 *   B            toggle bookmark
 *   M            toggle mute
 *   ?            open the keyboard-shortcuts sheet
 *
 * Shortcuts are *ignored* when the user is typing in a text input, a
 * textarea, a contenteditable region, or a button-like role, so Space
 * still activates the focused button instead of toggling narration. The
 * Cmd/Ctrl keys are platform-detected at module load.
 *
 * @param {object}   args
 * @param {() => void} [args.onPlayPause]
 * @param {() => void} [args.onSeekBack]
 * @param {() => void} [args.onSeekForward]
 * @param {() => void} [args.onPrevPage]
 * @param {() => void} [args.onNextPage]
 * @param {() => void} [args.onFirstPage]
 * @param {() => void} [args.onLastPage]
 * @param {() => void} [args.onFind]
 * @param {() => void} [args.onToggleBookmark]
 * @param {() => void} [args.onToggleMute]
 * @param {() => void} [args.onShowShortcuts]
 * @param {() => boolean} [args.isEnabled]   Optional gate (e.g. require a
 *   document loaded). Default always-true.
 */
export function useKeyboardShortcuts(handlers) {
    // Ref so the listener (registered once) always invokes the latest
    // callback without re-binding on every render. The hook reads
    // `handlersRef.current` instead of destructuring `handlers`, so the
    // linter is happy and the no-op branches (e.g. `?.()`) are explicit.
    const handlersRef = useRef(handlers || {});
    useEffect(() => {
        handlersRef.current = handlers || {};
    });

    useEffect(() => {
        const isTypingTarget = (target) => {
            if (!target) return false;
            const tag = target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
            if (target.isContentEditable) return true;
            const role = target.getAttribute && target.getAttribute('role');
            if (role === 'button' || role === 'switch' || role === 'tab') return true;
            return false;
        };

        const onKeyDown = (event) => {
            const h = handlersRef.current || {};
            if (h.isEnabled && !h.isEnabled()) return;
            if (isTypingTarget(event.target)) return;

            const mod = isMac ? event.metaKey : event.ctrlKey;
            const key = event.key;
            const code = event.code;

            // Page nav (PageUp/PageDown + Cmd/Ctrl+[/]).
            if (key === 'PageUp' || (mod && key === '[')) {
                event.preventDefault();
                h.onPrevPage?.();
                return;
            }
            if (key === 'PageDown' || (mod && key === ']')) {
                event.preventDefault();
                h.onNextPage?.();
                return;
            }
            if (key === 'Home') {
                event.preventDefault();
                h.onFirstPage?.();
                return;
            }
            if (key === 'End') {
                event.preventDefault();
                h.onLastPage?.();
                return;
            }

            // Playback.
            if (code === 'Space' || key === ' ') {
                event.preventDefault();
                h.onPlayPause?.();
                return;
            }
            if (key === 'ArrowLeft') {
                event.preventDefault();
                h.onSeekBack?.();
                return;
            }
            if (key === 'ArrowRight') {
                event.preventDefault();
                h.onSeekForward?.();
                return;
            }

            // Single-letter shortcuts. The typing-target guard already
            // prevents them from firing while the user is in a text field.
            if (!mod && !event.altKey) {
                const lower = String(key).toLowerCase();
                if (lower === 'f') {
                    event.preventDefault();
                    h.onFind?.();
                    return;
                }
                if (lower === 'b') {
                    event.preventDefault();
                    h.onToggleBookmark?.();
                    return;
                }
                if (lower === 'm') {
                    event.preventDefault();
                    h.onToggleMute?.();
                    return;
                }
                if (key === '?' || (event.shiftKey && lower === '/')) {
                    event.preventDefault();
                    h.onShowShortcuts?.();
                    return;
                }
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);
}
