import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PreparationProgress from './PreparationProgress';

describe('PreparationProgress', () => {
  it('shows progress and lets an active job be cancelled', () => {
    const onCancel = vi.fn();
    render(
      <PreparationProgress
        preparation={{
          id: 'job-1',
          status: 'RUNNING',
          completedPages: [1, 2],
          totalPages: 5,
        }}
        onCancel={onCancel}
      />
    );

    expect(screen.getByText('Prepare book: running · 2/5 pages')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preparation' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not offer cancellation after completion', () => {
    render(
      <PreparationProgress
        preparation={{
          id: 'job-1',
          status: 'COMPLETED',
          completedPages: [1],
          totalPages: 1,
        }}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Cancel preparation' })).toBeNull();
  });
});
