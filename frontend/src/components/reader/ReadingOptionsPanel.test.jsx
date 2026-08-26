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
    canPrepareBook: false,
    preparationRunning: false,
    onPrepareWholeBook: () => {},
};

function renderPanel(props = {}) {
    return render(
        <ToastProvider>
            <ReadingOptionsPanel {...baseProps} {...props} />
        </ToastProvider>,
    );
}

function openPanel() {
    fireEvent.click(screen.getByRole('button', { name: /reading options/i }));
}

describe('ReadingOptionsPanel trigger and popover', () => {
    it('opens from its own trigger and closes on Escape, restoring focus', () => {
        const { container } = renderPanel();
        expect(screen.queryByRole('dialog')).toBeNull();

        const trigger = screen.getByRole('button', { name: /reading options/i });
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
});

describe('ReadingOptionsPanel audiobook export', () => {
    it('offers the export only when a narration profile is active', () => {
        const noProfile = renderPanel({ hasProfile: false });
        openPanel();
        expect(screen.queryByRole('button', { name: /export audiobook/i })).toBeNull();
        noProfile.unmount();

        renderPanel({ hasProfile: true });
        openPanel();
        expect(screen.getByRole('button', { name: /export audiobook/i })).toBeTruthy();
    });

    it('switches to a cancel control with progress while exporting', () => {
        const cancel = vi.fn();
        renderPanel({
            hasProfile: true,
            isExportingAudiobook: true,
            audiobookProgress: { jobId: 'j', pagesDone: 2, pageCount: 5 },
            onCancelExportAudiobook: cancel,
        });
        openPanel();

        fireEvent.click(screen.getByRole('button', { name: /cancel export \(2\/5\)/i }));
        expect(cancel).toHaveBeenCalledTimes(1);
    });
});
