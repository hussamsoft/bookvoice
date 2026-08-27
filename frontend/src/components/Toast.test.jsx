import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast';

const EXIT_MS = 160;

function Fire({ message = 'hello', type = 'info' }) {
    const toast = useToast();
    return (
        <button onClick={() => toast[type](message)} type="button">
            fire
        </button>
    );
}

function setup(props) {
    return render(
        <ToastProvider>
            <Fire {...props} />
        </ToastProvider>
    );
}

async function fire() {
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'fire' }));
    });
}

describe('Toast', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('coalesces identical tone+message toasts inside the 2s window', async () => {
        setup();

        await fire();
        await fire();
        await act(async () => {
            vi.advanceTimersByTime(1000);
        });
        await fire();

        expect(screen.getAllByRole('status')).toHaveLength(1);

        // Outside the window a fresh entry stacks.
        await act(async () => {
            vi.advanceTimersByTime(2100);
        });
        await fire();

        expect(screen.getAllByRole('status')).toHaveLength(2);
    });

    it('does not coalesce different messages or tones', async () => {
        const view = render(
            <ToastProvider>
                <Fire message="one" />
            </ToastProvider>
        );
        await fire();

        view.rerender(
            <ToastProvider>
                <Fire message="two" />
            </ToastProvider>
        );
        await fire();

        expect(screen.getAllByRole('status')).toHaveLength(2);
    });

    it('bumps the timestamp on coalesce, restarting the auto-dismiss clock', async () => {
        setup();

        await fire();
        // Re-fire at 3s (inside the 2s window of nothing — first fired at 0,
        // so this must be past the window): advance 3s first, then re-fire
        // inside the new window to prove the clock restarts.
        await act(async () => {
            vi.advanceTimersByTime(3000);
        });
        await fire(); // stacks (3s > 2s window)
        await act(async () => {
            vi.advanceTimersByTime(1000);
        });
        await fire(); // coalesces with the second, bumps timestamp to t=4000

        let alerts = screen.getAllByRole('status');
        expect(alerts).toHaveLength(2);

        // Original duration is 5s: without the bump both entries would be
        // gone by t=8000; the bumped one survives until t=9000.
        await act(async () => {
            vi.advanceTimersByTime(4100); // t=8100
        });
        alerts = screen.getAllByRole('status');
        expect(alerts).toHaveLength(1);

        await act(async () => {
            vi.advanceTimersByTime(1300); // t=9400: past 9000 + exit window
        });
        expect(screen.queryAllByRole('status')).toHaveLength(0);
    });

    it('plays the exit animation before removing a dismissed toast', async () => {
        setup();
        await fire();

        const toastEl = screen.getByRole('status');
        expect(toastEl).not.toHaveClass('toast-leaving');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        });

        expect(screen.getByRole('status')).toHaveClass('toast-leaving');

        await act(async () => {
            vi.advanceTimersByTime(EXIT_MS + 50);
        });
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
});

