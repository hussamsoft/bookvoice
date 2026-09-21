import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Sidebar from './Sidebar';

// F-42: every navigation control must live inside a navigation landmark.
// The Settings button used to sit in a plain footer <div>, outside
// <nav aria-label="Main">, so landmark lists showed an incomplete "Main".
describe('Sidebar landmarks (F-42)', () => {
    it('wraps every nav control, Settings included, in a nav landmark', () => {
        render(<Sidebar view="home" onNavigate={vi.fn()} />);

        const settings = screen.getByRole('button', { name: 'Settings' });
        expect(settings.closest('nav')).not.toBeNull();
        expect(settings.closest('nav')).toHaveAttribute('aria-label', 'Secondary');

        // The primary rail stays exactly as labelled.
        const main = screen.getByRole('navigation', { name: 'Main' });
        expect(main).toBeInTheDocument();
        expect(main.querySelectorAll('.sidebar-item')).toHaveLength(4);
    });

    it('the secondary nav is also a navigation landmark', () => {
        render(<Sidebar view="settings" onNavigate={vi.fn()} />);
        const secondary = screen.getByRole('navigation', { name: 'Secondary' });
        const settings = screen.getByRole('button', { name: 'Settings' });
        expect(secondary.contains(settings)).toBe(true);
        expect(settings).toHaveAttribute('aria-current', 'page');
    });
});
