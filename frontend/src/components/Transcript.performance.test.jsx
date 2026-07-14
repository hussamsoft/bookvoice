import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const wordRenderSpy = vi.hoisted(() => vi.fn());

vi.mock('./TranscriptWord', async () => {
  const React = await import('react');
  return {
    default: React.memo(function MockTranscriptWord({ index, word }) {
      wordRenderSpy(index);
      return <span data-word-index={index}>{word}</span>;
    }),
  };
});

import Transcript from './Transcript';

describe('Transcript rendering cost', () => {
  it('updates only the two words whose playback state changed', () => {
    const words = Array.from({ length: 1000 }, (_, index) => `word${index}`);
    const props = {
      words,
      currentWord: 0,
      isPlaying: true,
      isPaused: false,
      onWordActivate: vi.fn(),
      statusHint: '',
      languageId: 'en',
    };
    const { rerender } = render(<Transcript {...props} />);
    expect(wordRenderSpy).toHaveBeenCalledTimes(1000);

    wordRenderSpy.mockClear();
    rerender(<Transcript {...props} currentWord={1} />);

    expect(wordRenderSpy).not.toHaveBeenCalled();
  });
});
