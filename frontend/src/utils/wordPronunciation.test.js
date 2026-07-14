import { describe, expect, it, vi } from 'vitest';
import {
  normalizePronunciationText,
  inferNarratorGender,
  pronounceWithSystemVoice,
  stopSystemPronunciation,
} from './wordPronunciation';

describe('normalizePronunciationText', () => {
  it('keeps the exact Unicode word while removing surrounding punctuation', () => {
    expect(normalizePronunciationText('“Hello,”')).toBe('Hello');
    expect(normalizePronunciationText('don’t')).toBe("don't");
    expect(normalizePronunciationText('مرحبا!')).toBe('مرحبا');
  });
});

describe('inferNarratorGender', () => {
  it('recognizes the bundled narrators', () => {
    expect(inferNarratorGender('Aria')).toBe('female');
    expect(inferNarratorGender('Natasha')).toBe('female');
    expect(inferNarratorGender('Christopher')).toBe('male');
    expect(inferNarratorGender('Ryan')).toBe('male');
    expect(inferNarratorGender('my_custom_voice')).toBeNull();
  });
});

describe('pronounceWithSystemVoice', () => {
  it('cancels stale speech and speaks the exact word with a matching local voice', async () => {
    const voices = [
      { lang: 'ar-SA', name: 'Arabic' },
      { lang: 'en-US', name: 'English' },
    ];
    const synth = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => voices),
      speak: vi.fn((utterance) => utterance.onend()),
    };
    const utterances = [];
    class FakeUtterance {
      constructor(text) {
        this.text = text;
        utterances.push(this);
      }
    }

    await expect(
      pronounceWithSystemVoice('“Hello,”', 'en', {
        speechSynthesis: synth,
        Utterance: FakeUtterance,
      })
    ).resolves.toBe(true);

    expect(synth.cancel).toHaveBeenCalledOnce();
    expect(synth.speak).toHaveBeenCalledOnce();
    expect(utterances[0]).toMatchObject({
      text: 'Hello',
      lang: 'en-US',
      rate: 0.92,
      voice: voices[1],
    });
  });

  it('returns false when system speech is unavailable so neural TTS can take over', async () => {
    await expect(
      pronounceWithSystemVoice('hello', 'en', {
        speechSynthesis: null,
        Utterance: null,
      })
    ).resolves.toBe(false);
  });

  it('matches the system pronunciation gender to the selected female narrator', async () => {
    const voices = [
      { lang: 'en-US', name: 'Microsoft David', localService: true },
      { lang: 'en-US', name: 'Microsoft Zira', localService: true },
    ];
    let spoken;
    const synth = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => voices),
      speak: vi.fn((utterance) => {
        spoken = utterance;
        utterance.onend();
      }),
    };
    class FakeUtterance {}

    await pronounceWithSystemVoice('hello', 'en', {
      speechSynthesis: synth,
      Utterance: FakeUtterance,
      narratorVoiceId: 'Aria',
    });

    expect(spoken.voice).toBe(voices[1]);
  });

  it('matches the system pronunciation gender to the selected male narrator', async () => {
    const voices = [
      { lang: 'en-US', name: 'Microsoft Zira', localService: true },
      { lang: 'en-US', name: 'Microsoft David', localService: true },
    ];
    let spoken;
    const synth = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => voices),
      speak: vi.fn((utterance) => {
        spoken = utterance;
        utterance.onend();
      }),
    };
    class FakeUtterance {}

    await pronounceWithSystemVoice('hello', 'en', {
      speechSynthesis: synth,
      Utterance: FakeUtterance,
      narratorVoiceId: 'Christopher',
    });

    expect(spoken.voice).toBe(voices[1]);
  });

  it('times out a broken host instead of leaving the word click stuck', async () => {
    vi.useFakeTimers();
    const synth = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => []),
      speak: vi.fn(),
    };
    class FakeUtterance {}

    const result = pronounceWithSystemVoice('hello', 'en', {
      speechSynthesis: synth,
      Utterance: FakeUtterance,
    });
    await vi.advanceTimersByTimeAsync(4000);

    await expect(result).resolves.toBe(false);
    expect(synth.cancel).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not send a cancelled stale click to neural TTS', async () => {
    let spoken;
    const synth = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => []),
      speak: vi.fn((utterance) => {
        spoken = utterance;
      }),
    };
    class FakeUtterance {}

    const result = pronounceWithSystemVoice('old', 'en', {
      speechSynthesis: synth,
      Utterance: FakeUtterance,
    });
    spoken.onerror({ error: 'interrupted' });

    await expect(result).resolves.toBe(true);
  });
});

describe('stopSystemPronunciation', () => {
  it('stops instant pronunciation before page narration starts', () => {
    const cancel = vi.fn();
    vi.stubGlobal('speechSynthesis', { cancel });

    stopSystemPronunciation();

    expect(cancel).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
