import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './Toast';
import BookSession from './BookSession';

vi.mock('./CameraCapture', () => ({
    default: ({ onCapture }) => (
        <button type="button" onClick={() => onCapture('data:image/png;base64,x')}>
            mock-capture
        </button>
    ),
}));

vi.mock('./TextEditor', () => ({
    default: ({ onSaveText, initialText }) => (
        <div>
            <span data-testid="editor-text">{initialText}</span>
            <button type="button" onClick={() => onSaveText?.('captured page text')}>
                mock-save-text
            </button>
        </div>
    ),
}));

vi.mock('./NarrationPlayback', () => ({
    default: () => <div data-testid="playback-mock">playback</div>,
}));

vi.mock('./VoiceSettings', () => ({
    default: () => <div data-testid="voice-mock" />,
}));

vi.mock('../hooks/useTtsStatus', () => ({
    useTtsStatus: () => ({
        modelReady: true,
        modelError: null,
        modelStatusDetail: '',
        deviceInfo: 'cuda',
        retryLoad: vi.fn(),
    }),
}));

vi.mock('../hooks/useUserConfig', () => ({
    useUserConfig: () => ({ config: null, updateConfig: vi.fn() }),
}));

const narrateMock = vi.hoisted(() => vi.fn());
const importMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({
    narrateText: narrateMock,
    importPreparedBook: importMock,
}));

vi.mock('../utils/ocr', () => ({
    extractTextFromImage: vi.fn(async () => 'raw page text'),
}));

function renderSession(props = {}) {
    return render(
        <ToastProvider>
            <BookSession epoch={0} onDirty={vi.fn()} {...props} />
        </ToastProvider>,
    );
}

describe('BookSession scan wizard', () => {
    beforeEach(() => {
        narrateMock.mockReset();
        importMock.mockReset();
    });

    it('keeps a captured page as text and offers Save to Library', async () => {
        const onOpenBook = vi.fn();
        importMock.mockResolvedValue({ id: 'b1', title: 'Scanned pages 2026-09-06' });
        renderSession({ onOpenBook });

        // Capture -> OCR -> review.
        fireEvent.click(screen.getByRole('button', { name: 'mock-capture' }));
        expect(await screen.findByTestId('editor-text')).toHaveTextContent('raw page text');

        // Save as text only: back to capture with a page in the bank.
        fireEvent.click(screen.getByRole('button', { name: 'mock-save-text' }));
        expect(await screen.findByRole('button', { name: 'mock-capture' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Page 1' })).toBeInTheDocument();

        // The whole session becomes a real Library book.
        fireEvent.click(screen.getByRole('button', { name: /Save to Library/i }));
        await waitFor(() => expect(onOpenBook).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'b1' })
        ));
        expect(importMock).toHaveBeenCalledTimes(1);
        const [file] = importMock.mock.calls[0];
        expect(file.name).toMatch(/^Scanned pages \d{4}-\d{2}-\d{2}\.txt$/);
        expect(await file.text()).toContain('captured page text');
    });

    it('navigates freely between reached steps', async () => {
        renderSession();

        fireEvent.click(screen.getByRole('button', { name: 'mock-capture' }));
        await screen.findByTestId('editor-text');

        // Review -> Capture is free; Capture -> Review is reachable while
        // text exists; Listen stays locked until audio exists.
        fireEvent.click(screen.getByRole('button', { name: /Capture a page/ }));
        expect(screen.getByRole('button', { name: 'mock-capture' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Review the text/ })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Listen$/ })).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Review the text/ }));
        expect(await screen.findByTestId('editor-text')).toHaveTextContent('raw page text');
    });
});
