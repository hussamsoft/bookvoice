import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TitleBar from './TitleBar';

describe('TitleBar', () => {
    it('uses a concise product identity without the retired tagline', () => {
        render(<TitleBar />);

        expect(screen.getByRole('heading', { name: 'BookVoice' })).toBeVisible();
        expect(screen.queryByText('Read with your ears')).not.toBeInTheDocument();
    });
});
