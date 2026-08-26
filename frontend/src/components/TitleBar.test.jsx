import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TitleBar from './TitleBar';

function mockMatchMedia(dark) {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: query.includes('dark') && dark,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
    }));
}

afterEach(() => {
    delete window.matchMedia;
});

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
        expect(localStorage.getItem('bookvoice.theme')).toBe('dark');
        expect(screen.getByRole('button', { name: 'Use light theme' })).toBeVisible();
    });

    it('renders and switches themes when local storage is blocked', () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked');
        });
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('blocked');
        });

        render(<TitleBar />);
        fireEvent.click(screen.getByRole('button', { name: 'Use dark theme' }));

        expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
        getItem.mockRestore();
        setItem.mockRestore();
    });

    it('follows prefers-color-scheme when no preference is stored', () => {
        localStorage.clear();
        mockMatchMedia(true);

        render(<TitleBar />);

        expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
        expect(screen.getByRole('button', { name: 'Use light theme' })).toBeVisible();
    });

    it('prefers the stored theme over the system preference', () => {
        localStorage.setItem('bookvoice.theme', 'light');
        mockMatchMedia(true);

        render(<TitleBar />);

        expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    });

    it('updates meta theme-color when toggling themes', () => {
        localStorage.clear();
        localStorage.clear();
        mockMatchMedia(false);
        const meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        meta.setAttribute('content', '#ffffff');
        document.head.appendChild(meta);

        render(<TitleBar />);

        expect(meta).toHaveAttribute('content', '#ffffff');


        fireEvent.click(screen.getByRole('button', { name: 'Use dark theme' }));
        expect(meta).toHaveAttribute('content', '#18181b');
    });

});
