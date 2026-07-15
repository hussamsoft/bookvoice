import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TitleBar from './TitleBar';

describe('TitleBar', () => {
    it('uses a concise product identity without the retired tagline', () => {
        render(<TitleBar />);

        expect(screen.getByRole('heading', { name: 'BookVoice' })).toBeVisible();
        expect(screen.queryByText('Read with your ears')).not.toBeInTheDocument();
        expect(screen.queryByText(/Local reader|Private by default/i)).not.toBeInTheDocument();
        expect(screen.getByTestId('titlebar-sparkle')).toBeVisible();
    });

    it('persists an accessible dark theme toggle', () => {
        localStorage.clear();
        render(<TitleBar />);

        fireEvent.click(screen.getByRole('button', { name: 'Use dark theme' }));

        expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
        expect(localStorage.getItem('bookvoice:theme')).toBe('dark');
        expect(screen.getByRole('button', { name: 'Use light theme' })).toBeVisible();
    });
});
