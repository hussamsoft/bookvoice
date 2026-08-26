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

  it('exposes the transcript as a single tab stop with plain word spans', () => {
    const { container } = render(<Transcript {...baseProps} />);
    const wordsContainer = container.querySelector('.transcript-words');
    expect(wordsContainer.getAttribute('tabindex')).toBe('0');
    expect(wordsContainer.getAttribute('role')).toBe('region');
    expect(wordsContainer.getAttribute('aria-label')).toBe('Narration transcript');

    const words = container.querySelectorAll('.transcript-word');
    expect(words).toHaveLength(3);
    words.forEach((el) => {
      expect(el.getAttribute('tabindex')).toBeNull();
      expect(el.getAttribute('role')).toBeNull();
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });
  });

  it('moves the cursor with arrow keys and activates with Enter or Space', () => {
    const onWordActivate = vi.fn();
    const { container } = render(
      <Transcript {...baseProps} currentWord={0} onWordActivate={onWordActivate} />
    );
    const wordsContainer = container.querySelector('.transcript-words');

    // With no cursor yet, movement starts from the narrated word (index 0).
    fireEvent.keyDown(wordsContainer, { key: 'ArrowRight' });
    expect(
      wordsContainer.querySelector('[data-word-index="1"]').classList.contains('cursor')
    ).toBe(true);

    fireEvent.keyDown(wordsContainer, { key: 'Enter' });
    expect(onWordActivate).toHaveBeenCalledTimes(1);
    expect(onWordActivate.mock.calls[0][0]).toBe(1);
    expect(onWordActivate.mock.calls[0][1]).toBe('world');

    fireEvent.keyDown(wordsContainer, { key: ' ' });
    expect(onWordActivate).toHaveBeenCalledTimes(2);
  });

  it('jumps to the ends with Home and End and clamps at the boundaries', () => {
    const { container } = render(<Transcript {...baseProps} />);
    const wordsContainer = container.querySelector('.transcript-words');

    fireEvent.keyDown(wordsContainer, { key: 'End' });
    expect(
      wordsContainer.querySelector('[data-word-index="2"]').classList.contains('cursor')
    ).toBe(true);

    // ArrowRight past the last word stays clamped.
    fireEvent.keyDown(wordsContainer, { key: 'ArrowRight' });
    expect(
      wordsContainer.querySelector('[data-word-index="2"]').classList.contains('cursor')
    ).toBe(true);

    fireEvent.keyDown(wordsContainer, { key: 'Home' });
    expect(
      wordsContainer.querySelector('[data-word-index="0"]').classList.contains('cursor')
    ).toBe(true);
  });

  it('clears the cursor on Escape and on blur', () => {
    const { container } = render(<Transcript {...baseProps} currentWord={0} />);
    const wordsContainer = container.querySelector('.transcript-words');

    fireEvent.keyDown(wordsContainer, { key: 'End' });
    const last = wordsContainer.querySelector('[data-word-index="2"]');
    expect(last.classList.contains('cursor')).toBe(true);

    fireEvent.keyDown(wordsContainer, { key: 'Escape' });
    expect(last.classList.contains('cursor')).toBe(false);

    fireEvent.keyDown(wordsContainer, { key: 'Home' });
    const first = wordsContainer.querySelector('[data-word-index="0"]');
    expect(first.classList.contains('cursor')).toBe(true);

    fireEvent.blur(wordsContainer);
    expect(first.classList.contains('cursor')).toBe(false);
  });

  it('does not activate anything while no word is cursored', () => {
    const onWordActivate = vi.fn();
    const { container } = render(
      <Transcript {...baseProps} onWordActivate={onWordActivate} />
    );
    const wordsContainer = container.querySelector('.transcript-words');

    fireEvent.keyDown(wordsContainer, { key: 'Enter' });
    expect(onWordActivate).not.toHaveBeenCalled();
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
    fireEvent.click(container.querySelector('.transcript-word'));
    expect(container.querySelector('.word-pronounce-spinner')).toBeNull();
    expect(container.querySelector('.transcript-word').textContent).toBe('Hello');
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
