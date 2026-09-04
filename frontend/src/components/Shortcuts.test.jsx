import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Shortcuts from './Shortcuts';

describe('Shortcuts', () => {
    it('renders the shortcut sections when open', () => {
        render(<Shortcuts open onClose={vi.fn()} />);
        expect(screen.getByText('Reading')).toBeInTheDocument();
        expect(screen.getByText('Actions')).toBeInTheDocument();
        expect(screen.getByText('Help')).toBeInTheDocument();
    });

    it('lists the Apple-grade reader shortcuts', () => {
        render(<Shortcuts open onClose={vi.fn()} />);
        // Reading group.
        expect(screen.getByText('Play / pause narration')).toBeInTheDocument();
        expect(screen.getByText('Seek \u00b110 seconds')).toBeInTheDocument();
        expect(screen.getByText('Previous / next page')).toBeInTheDocument();
        expect(screen.getByText('First / last page')).toBeInTheDocument();
        // Actions group.
        expect(screen.getByText('Find in book')).toBeInTheDocument();
        expect(screen.getByText('Toggle bookmark')).toBeInTheDocument();
        expect(screen.getByText('Mute / unmute')).toBeInTheDocument();
        // Help group.
        expect(screen.getByText('Show this sheet')).toBeInTheDocument();
    });

    it('calls onClose when the Close action is clicked', () => {
        const onClose = vi.fn();
        render(<Shortcuts open onClose={onClose} />);
        fireEvent.click(screen.getByRole('button', { name: /close/i }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
