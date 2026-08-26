import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StatusBanner from './StatusBanner';

describe('StatusBanner', () => {
    it('renders the warning tone with its class and icon', () => {
        render(<StatusBanner tone="warning">Narration is running on the CPU.</StatusBanner>);

        const banner = screen.getByRole('status');
        expect(banner).toHaveClass('status-banner', 'warning');
        expect(banner.querySelector('svg')).toBeInTheDocument();
        expect(banner).toHaveTextContent('Narration is running on the CPU.');
    });

    it('leaves genuine errors on the error tone', () => {
        render(<StatusBanner tone="error">Model failed to load</StatusBanner>);

        expect(screen.getByRole('status')).toHaveClass('status-banner', 'error');
    });
});
