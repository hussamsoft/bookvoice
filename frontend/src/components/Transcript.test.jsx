import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Transcript from './Transcript';

describe('Transcript accessibility', () => {
  const baseProps = {
    words: ['Hello', 'world', 'today'],
    currentWord: -1,
    isPlaying: false,
    isPaused: false,
    onWordActivate: vi.fn(),
    statusHint: '',
    languageId: 'en',
  };

  it('renders each word as a focusable button with an accessible name', () => {
    render(<Transcript {...baseProps} />);
    const words = screen.getAllByRole('button');
    expect(words).toHaveLength(3);
    words.forEach((el) => {
      expect(el).toHaveProperty('tabIndex', 0);
      expect(el.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('activates a word on Enter and Space', () => {
    const onWordActivate = vi.fn();
    render(<Transcript {...baseProps} onWordActivate={onWordActivate} />);
    const first = screen.getAllByRole('button')[0];

    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onWordActivate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(first, { key: ' ' });
    expect(onWordActivate).toHaveBeenCalledTimes(2);
  });

  it('sets RTL direction for Arabic', () => {
    const { container } = render(<Transcript {...baseProps} languageId="ar" />);
    const wordsContainer = container.querySelector('.transcript-words');
    expect(wordsContainer.getAttribute('dir')).toBe('rtl');
  });

  it('sets LTR direction for English', () => {
    const { container } = render(<Transcript {...baseProps} languageId="en" />);
    const wordsContainer = container.querySelector('.transcript-words');
    expect(wordsContainer.getAttribute('dir')).toBe('ltr');
  });
});
