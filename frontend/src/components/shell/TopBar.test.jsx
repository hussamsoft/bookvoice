import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TopBar from './TopBar';
import { engineStatusFromTts } from './engineStatus';

const themeStub = (mode) => ({
    palette: 'paper',
    mode,
    setPalette: vi.fn(),
    setMode: vi.fn(),
    toggleMode: vi.fn(),
});

vi.mock('../SettingsPanel', () => ({ default: () => <div data-testid="settings-panel-mock" /> }));

describe('TopBar', () => {
    it('shows the context title and the shared engine chip', () => {
        render(
            <TopBar
                title="Library"
                engineStatus={{ tone: 'is-ready', label: 'Voices ready', detail: '' }}
                theme={themeStub('dark')}
                onThemeToggle={() => {}}
            />
        );

        expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
        const chip = screen.getByRole('status');
        expect(chip).toHaveTextContent('Voices ready');
        expect(chip).toHaveClass('is-ready');
    });

    it('toggles the theme and persists the choice', () => {
        const toggle = vi.fn();
        render(
            <TopBar
                title="Home"
                engineStatus={{ tone: 'is-warming', label: 'Warming up…', detail: 'warming' }}
                theme={themeStub('dark')}
                onThemeToggle={toggle}
            />
        );

        const button = screen.getByRole('button', { name: 'Use light mode' });
        fireEvent.click(button);
        expect(toggle).toHaveBeenCalledTimes(1);
    });
});

describe('engineStatusFromTts', () => {
    it('reports warming while the model loads', () => {
        const status = engineStatusFromTts({
            modelReady: false,
            modelError: null,
            modelStatusDetail: 'Warming up AI voices... (12s)',
        });
        expect(status).toMatchObject({ tone: 'is-warming', label: 'Warming up…' });
        expect(status.detail).toContain('12s');
    });

    it('reports ready once the model is up', () => {
        const status = engineStatusFromTts({
            modelReady: true,
            modelError: null,
            modelStatusDetail: '',
        });
        expect(status).toMatchObject({ tone: 'is-ready', label: 'Voices ready' });
    });

    it('reports errors with the underlying detail', () => {
        const status = engineStatusFromTts({
            modelReady: false,
            modelError: 'Model failed to load',
            modelStatusDetail: '',
        });
        expect(status).toMatchObject({ tone: 'is-error', label: 'Engine error', detail: 'Model failed to load' });
    });
});
