import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import { useReaderToolbar } from './useReaderToolbar';

function TestConsumer() {
    const {
        moreOpen,
        setMoreOpen,
        moreRootRef,
        moreTriggerRef,
        closeMore,
    } = useReaderToolbar();

    return (
        <div>
            <button
                ref={moreTriggerRef}
                data-testid="more-trigger"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                aria-haspopup="true"
            >
                More
            </button>
            {moreOpen && (
                <div ref={moreRootRef} data-testid="more-menu">
                    <button data-testid="menu-item-1">Search</button>
                    <button data-testid="menu-item-2" onClick={closeMore}>Close</button>
                </div>
            )}
        </div>
    );
}

function renderHook() {
    return render(<TestConsumer />);
}

describe('useReaderToolbar', () => {
    it('starts closed and opens on trigger click', () => {
        renderHook();
        const trigger = screen.getByTestId('more-trigger');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByTestId('more-menu')).toBeNull();

        fireEvent.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByTestId('more-menu')).toBeInTheDocument();
    });

    it('closes on Escape and returns focus to trigger', () => {
        renderHook();
        const trigger = screen.getByTestId('more-trigger');
        fireEvent.click(trigger);
        expect(screen.getByTestId('more-menu')).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('more-menu')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('closes on outside click', () => {
        renderHook();
        const trigger = screen.getByTestId('more-trigger');
        fireEvent.click(trigger);
        expect(screen.getByTestId('more-menu')).toBeInTheDocument();

        fireEvent.mouseDown(document.body);
        expect(screen.queryByTestId('more-menu')).toBeNull();
    });

    it('traps Tab focus within the menu', () => {
        renderHook();
        const trigger = screen.getByTestId('more-trigger');
        fireEvent.click(trigger);

        const item1 = screen.getByTestId('menu-item-1');
        const item2 = screen.getByTestId('menu-item-2');

        item1.focus();
        expect(document.activeElement).toBe(item1);

        // Tab from last item wraps to first
        item2.focus();
        fireEvent.keyDown(screen.getByTestId('more-menu'), { key: 'Tab' });
        expect(document.activeElement).toBe(item1);

        // Shift+Tab from first item wraps to last
        item1.focus();
        fireEvent.keyDown(screen.getByTestId('more-menu'), { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(item2);
    });

    it('closes via closeMore callback', () => {
        renderHook();
        const trigger = screen.getByTestId('more-trigger');
        fireEvent.click(trigger);

        fireEvent.click(screen.getByTestId('menu-item-2'));
        expect(screen.queryByTestId('more-menu')).toBeNull();
    });
});
