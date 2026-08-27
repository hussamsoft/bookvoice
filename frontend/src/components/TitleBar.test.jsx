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
        expect(screen.getByTestId('titlebar-palette')).toBeVisible();
    });

    it('persists an accessible dark theme toggle', () => {
        localStorage.clear();
        render(<TitleBar />);

        fireEvent.click(screen.getByRole('button', { name: 'Use dark mode' }));

        expect(document.documentElement).toHaveAttribute('data-mode', 'dark');
        expect(localStorage.getItem('bookvoice.mode')).toBe('dark');
        expect(screen.getByRole('button', { name: 'Use light mode' })).toBeVisible();
    });

    it('renders and switches themes when local storage is blocked', () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked');
        });
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('blocked');
        });

        render(<TitleBar />);
        fireEvent.click(screen.getByRole('button', { name: 'Use dark mode' }));

        expect(document.documentElement).toHaveAttribute('data-mode', 'dark');
        getItem.mockRestore();
        setItem.mockRestore();
    });

    it('follows prefers-color-scheme when no preference is stored', () => {
        localStorage.clear();
        mockMatchMedia(true);

        render(<TitleBar />);

        expect(document.documentElement).toHaveAttribute('data-mode', 'dark');
        expect(screen.getByRole('button', { name: 'Use light mode' })).toBeVisible();
    });

    it('prefers the stored theme over the system preference', () => {
        localStorage.setItem('bookvoice.mode', 'light');
        mockMatchMedia(true);

        render(<TitleBar />);

        expect(document.documentElement).toHaveAttribute('data-mode', 'light');
    });

    it('updates meta theme-color when toggling themes', () => {
        localStorage.clear();
        mockMatchMedia(false);
        const meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        meta.setAttribute('content', '#f7f5f1');
        document.head.appendChild(meta);

        render(<TitleBar />);

        expect(meta).toHaveAttribute('content', '#f7f5f1');

        fireEvent.click(screen.getByRole('button', { name: 'Use dark mode' }));
        expect(meta).toHaveAttribute('content', '#161513');
    });

    it('shows the theme selector dropdown when clicked', () => {
        localStorage.clear();
        render(<TitleBar />);

        const trigger = screen.getByRole('button', { name: /Theme: / });
        fireEvent.click(trigger);

        expect(screen.getByRole('menu')).toBeVisible();
        expect(screen.getAllByText('Paper Slate').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Ethereal Blue').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Sage Green').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Muted Plum').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Sand Clay').length).toBeGreaterThan(0);
    });

    it('persists the selected palette', () => {
        localStorage.clear();
        render(<TitleBar />);

        fireEvent.click(screen.getByRole('button', { name: /Theme: / }));
        const blueOptions = screen.getAllByText('Ethereal Blue');
        fireEvent.click(blueOptions[0]);

        expect(document.documentElement).toHaveAttribute('data-palette', 'blue');
        expect(localStorage.getItem('bookvoice.palette')).toBe('blue');
    });
});
