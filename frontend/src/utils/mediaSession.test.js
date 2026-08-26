import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearMediaSession,
  setActionHandlers,
  setPlaybackState,
  setPositionState,
  updateMediaSession,
} from './mediaSession';

const originalDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mediaSession')
  || Object.getOwnPropertyDescriptor(navigator, 'mediaSession');

function stubMediaSession(overrides = {}) {
  const session = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: vi.fn(),
    setPositionState: vi.fn(),
    ...overrides,
  };
  Object.defineProperty(navigator, 'mediaSession', {
    configurable: true,
    value: session,
  });
  return session;
}

function removeMediaSession() {
  delete navigator.mediaSession;
}

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(navigator, 'mediaSession', originalDescriptor);
  } else {
    removeMediaSession();
  }
  vi.restoreAllMocks();
});

describe('mediaSession wrappers', () => {
  it('no-op safely when the Media Session API is unavailable', () => {
    removeMediaSession();
    expect(() => updateMediaSession({ title: 'Page 3', album: 'Book' })).not.toThrow();
    expect(() => setPlaybackState(true)).not.toThrow();
    expect(() => setPositionState({ duration: 10, position: 1, rate: 1 })).not.toThrow();
    expect(() => setActionHandlers({ play: () => {} })).not.toThrow();
    expect(() => clearMediaSession()).not.toThrow();
  });

  it('publishes page metadata', () => {
    const session = stubMediaSession();
    globalThis.MediaMetadata = class {
      constructor(init) { Object.assign(this, init); }
    };
    updateMediaSession({ title: 'Page 12', album: 'Dune', artist: 'Narrator' });
    expect(session.metadata.title).toBe('Page 12');
    expect(session.metadata.album).toBe('Dune');
    expect(session.metadata.artist).toBe('Narrator');
    delete globalThis.MediaMetadata;
  });

  it('reports the playback state', () => {
    const session = stubMediaSession();
    setPlaybackState(true);
    setPlaybackState(false);
    expect(session.playbackState).toBe('paused');
  });

  it('clamps the position into the duration and skips invalid states', () => {
    const session = stubMediaSession();
    setPositionState({ duration: 10, position: 42, rate: 1.5 });
    expect(session.setPositionState).toHaveBeenCalledWith({
      duration: 10,
      position: 10,
      playbackRate: 1.5,
    });
    session.setPositionState.mockClear();
    setPositionState({ duration: 0, position: 5 });
    setPositionState({});
    expect(session.setPositionState).not.toHaveBeenCalled();
  });

  it('registers handlers for known actions and clears them all', () => {
    const session = stubMediaSession();
    const play = () => {};
    setActionHandlers({
      play,
      pause: () => {},
      stop: () => {},
      previoustrack: () => {},
      nexttrack: () => {},
      seekbackward: () => {},
      seekforward: () => {},
    });
    const registered = Object.fromEntries(
      session.setActionHandler.mock.calls.map(([action, handler]) => [action, handler]),
    );
    expect(registered.play).toBe(play);
    expect(registered.pause).toEqual(expect.any(Function));

    setActionHandlers(null);
    for (const [, handler] of session.setActionHandler.mock.calls.slice(-7)) {
      expect(handler).toBeNull();
    }
  });

  it('clearMediaSession drops metadata and resets state', () => {
    const session = stubMediaSession();
    setActionHandlers({ play: () => {} });
    clearMediaSession();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
    const lastCall = session.setActionHandler.mock.calls.at(-1);
    expect(lastCall[1]).toBeNull();
  });
});
