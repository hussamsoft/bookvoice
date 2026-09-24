import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TextEditor from './TextEditor';
import { ToastProvider } from './Toast';
import { translateText } from '../utils/api';

vi.mock('../utils/api', () => ({
    translateText: vi.fn(),
}));

describe('TextEditor translation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('applies translatedText and explains the data boundary', async () => {
        translateText.mockResolvedValue({ translatedText: 'مرحبا' });
        render(
            <ToastProvider>
                <TextEditor
                    initialText="Hello"
                    onNarrate={vi.fn()}
                    targetLanguage="ar"
                    onTranslateChange={vi.fn()}
                />
            </ToastProvider>
        );

        fireEvent.click(screen.getByRole('button', { name: 'Translate to Arabic' }));

        await waitFor(() => expect(screen.getByLabelText('Extracted text')).toHaveValue('مرحبا'));
        expect(translateText).toHaveBeenCalledWith('Hello', 'ar');
        expect(screen.getByText(/selected text is sent to Google Translate/i)).toHaveTextContent(
            'OCR, TTS, and Voice Studio remain local. No telemetry.'
        );
    });
});
