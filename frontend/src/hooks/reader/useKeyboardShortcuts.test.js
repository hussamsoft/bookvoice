import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

// jsdom does not populate navigator.platform reliably; force the
// non-Mac path so the tests are platform-independent.
Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });

const fireKey = (init) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    // `key` may be set on the constructor in modern jsdom; this is a
    // belt-and-suspenders assignment in case the polyfill ignores it.
    Object.defineProperty(event, 'key', { value: init.key, configurable: true });
    Object.defineProperty(event, 'code', { value: init.code || '', configurable: true });
    window.dispatchEvent(event);
    return event;
};

const noop = () => {};

describe('useKeyboardShortcuts', () => {
    it('invokes onPlayPause on Space', () => {
        const onPlayPause = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onPlayPause }));
        fireKey({ key: ' ', code: 'Space' });
        expect(onPlayPause).toHaveBeenCalledTimes(1);
    });

    it('invokes onSeekBack on ArrowLeft and onSeekForward on ArrowRight', () => {
        const onSeekBack = vi.fn();
        const onSeekForward = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onSeekBack, onSeekForward }));
        fireKey({ key: 'ArrowLeft', code: 'ArrowLeft' });
        fireKey({ key: 'ArrowRight', code: 'ArrowRight' });
        expect(onSeekBack).toHaveBeenCalledTimes(1);
        expect(onSeekForward).toHaveBeenCalledTimes(1);
    });

    it('invokes page nav handlers on PageUp / PageDown / Home / End', () => {
        const onPrevPage = vi.fn();
        const onNextPage = vi.fn();
        const onFirstPage = vi.fn();
        const onLastPage = vi.fn();
        renderHook(() => useKeyboardShortcuts({
            onPrevPage, onNextPage, onFirstPage, onLastPage,
        }));
        fireKey({ key: 'PageUp' });
        fireKey({ key: 'PageDown' });
        fireKey({ key: 'Home' });
        fireKey({ key: 'End' });
        expect(onPrevPage).toHaveBeenCalledTimes(1);
        expect(onNextPage).toHaveBeenCalledTimes(1);
        expect(onFirstPage).toHaveBeenCalledTimes(1);
        expect(onLastPage).toHaveBeenCalledTimes(1);
    });

    it('invokes page nav on Ctrl+[ / Ctrl+] (Windows/Linux)', () => {
        const onPrevPage = vi.fn();
        const onNextPage = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onPrevPage, onNextPage }));
        fireKey({ key: '[', ctrlKey: true });
        fireKey({ key: ']', ctrlKey: true });
        expect(onPrevPage).toHaveBeenCalledTimes(1);
        expect(onNextPage).toHaveBeenCalledTimes(1);
    });

    it('invokes single-letter handlers (F, B, M, ?)', () => {
        const onFind = vi.fn();
        const onToggleBookmark = vi.fn();
        const onToggleMute = vi.fn();
        const onShowShortcuts = vi.fn();
        renderHook(() => useKeyboardShortcuts({
            onFind, onToggleBookmark, onToggleMute, onShowShortcuts,
        }));
        fireKey({ key: 'f' });
        fireKey({ key: 'b' });
        fireKey({ key: 'm' });
        fireKey({ key: '?' });
        expect(onFind).toHaveBeenCalledTimes(1);
        expect(onToggleBookmark).toHaveBeenCalledTimes(1);
        expect(onToggleMute).toHaveBeenCalledTimes(1);
        expect(onShowShortcuts).toHaveBeenCalledTimes(1);
    });

    it('ignores shortcuts while typing in an <input>', () => {
        const onPlayPause = vi.fn();
        const onFind = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onPlayPause, onFind }));

        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        // Replace document.activeElement-like behaviour by dispatching
        // directly on the input element.
        const ev = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'key', { value: ' ' });
        Object.defineProperty(ev, 'code', { value: 'Space' });
        input.dispatchEvent(ev);

        // `f` is a printable letter; do not fire onFind when typing.
        const fEv = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true });
        Object.defineProperty(fEv, 'key', { value: 'f' });
        Object.defineProperty(fEv, 'code', { value: 'KeyF' });
        input.dispatchEvent(fEv);

        expect(onPlayPause).not.toHaveBeenCalled();
        expect(onFind).not.toHaveBeenCalled();
        document.body.removeChild(input);
    });

    it('ignores shortcuts when isEnabled() returns false', () => {
        const onPlayPause = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onPlayPause, isEnabled: () => false }));
        fireKey({ key: ' ', code: 'Space' });
        expect(onPlayPause).not.toHaveBeenCalled();
    });

    it('does not throw when a handler is not provided (optional callbacks)', () => {
        renderHook(() => useKeyboardShortcuts({}));
        expect(() => fireKey({ key: ' ', code: 'Space' })).not.toThrow();
        expect(() => fireKey({ key: 'f' })).not.toThrow();
    });

    it('picks up the latest handlers via ref (no listener re-binding)', () => {
        const first = vi.fn();
        const second = vi.fn();
        const { rerender } = renderHook((h) => useKeyboardShortcuts(h), {
            initialProps: { onPlayPause: first },
        });
        rerender({ onPlayPause: second });
        fireKey({ key: ' ', code: 'Space' });
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('preventDefault is called so the browser does not scroll on Space / arrows / Page keys', () => {
        const onPlayPause = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onPlayPause, onPrevPage: noop }));
        const ev = fireKey({ key: ' ', code: 'Space' });
        expect(ev.defaultPrevented).toBe(true);
    });
});
