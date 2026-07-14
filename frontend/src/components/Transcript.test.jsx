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

  it('keeps real spaces between interactive words for natural wrapping', () => {
    const { container } = render(<Transcript {...baseProps} />);
    expect(container.querySelector('.transcript-words').textContent).toBe('Hello world today');
  });

  it('does not insert a layout-changing spinner when a word is activated', () => {
    const pending = new Promise(() => {});
    const { container } = render(
      <Transcript {...baseProps} onWordActivate={() => pending} />
    );
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(container.querySelector('.word-pronounce-spinner')).toBeNull();
    expect(screen.getAllByRole('button')[0].textContent).toBe('Hello');
  });

  it('does not move the text column unless follow narration is enabled', () => {
    const { container, rerender } = render(<Transcript {...baseProps} currentWord={1} />);
    const wordsContainer = container.querySelector('.transcript-words');
    Object.defineProperty(wordsContainer, 'clientHeight', { configurable: true, value: 100 });
    const word = wordsContainer.querySelector('[data-word-index="1"]');
    Object.defineProperty(word, 'offsetTop', { configurable: true, value: 240 });
    Object.defineProperty(word, 'offsetHeight', { configurable: true, value: 20 });

    expect(wordsContainer.scrollTop).toBe(0);
    rerender(<Transcript {...baseProps} currentWord={2} followNarration />);
    const followed = wordsContainer.querySelector('[data-word-index="2"]');
    Object.defineProperty(followed, 'offsetTop', { configurable: true, value: 300 });
    Object.defineProperty(followed, 'offsetHeight', { configurable: true, value: 20 });
    rerender(<Transcript {...baseProps} currentWord={1} followNarration />);
    expect(wordsContainer.scrollTop).toBeGreaterThan(0);
  });
});
