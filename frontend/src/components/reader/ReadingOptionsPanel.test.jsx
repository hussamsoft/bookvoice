import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../Toast';
import ReadingOptionsPanel from './ReadingOptionsPanel';

const baseProps = {
    modelReady: true,
    activeVoiceId: 'voice-a',
    onVoiceChange: () => {},
    targetLanguage: 'en',
    onLanguageChange: () => {},
    disabled: false,
    isOcring: false,
    onForceOcr: () => {},
};

function renderPanel(props = {}) {
    return render(
        <ToastProvider>
            <ReadingOptionsPanel {...baseProps} {...props} />
        </ToastProvider>,
    );
}

function openPanel() {
    fireEvent.click(screen.getByRole('button', { name: /voice & options/i }));
}

describe('ReadingOptionsPanel trigger and popover', () => {
    it('opens from its own trigger and closes on Escape, restoring focus', () => {
        const { container } = renderPanel();
        expect(screen.queryByRole('dialog')).toBeNull();

        const trigger = screen.getByRole('button', { name: /voice & options/i });
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        openPanel();

        const dialog = screen.getByRole('dialog');
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).not.toBe(document.body);

        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(trigger);
        expect(container.querySelector('.reading-options-scrim')).toBeNull();
    });

    it('closes when the scrim is clicked', () => {
        renderPanel();
        openPanel();
        expect(screen.getByRole('dialog')).toBeTruthy();

        fireEvent.click(document.querySelector('.reading-options-scrim'));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('keeps Tab focus inside the open surface', () => {
        renderPanel();
        openPanel();
        const dialog = screen.getByRole('dialog');
        const close = screen.getByRole('button', { name: /close reading options/i });
        close.focus();

        fireEvent.keyDown(dialog, { key: 'Tab' });
        expect(dialog.contains(document.activeElement)).toBe(true);

        fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
        expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('offers whole-book OCR for PDFs but not for text books', () => {
        const pdf = renderPanel({ isTextBook: false });
        openPanel();
        expect(screen.getByRole('button', { name: /re-run ocr/i })).toBeInTheDocument();
        pdf.unmount();

        renderPanel({ isTextBook: true });
        openPanel();
        expect(screen.queryByRole('button', { name: /re-run ocr/i })).toBeNull();
    });
});
