import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppView, setAppView, getLastBookId, setLastBookId } from './appSession';

describe('appSession views', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('defaults a new device to Home', () => {
        expect(getAppView()).toBe('home');
    });

    it('remembers the selected view on this device', () => {
        setAppView('library');
        expect(getAppView()).toBe('library');
    });

    it('never persists the reader view', () => {
        setAppView('reader');
        expect(getAppView()).toBe('home');
        localStorage.setItem('bookvoice.app.view', 'reader');
        expect(getAppView()).toBe('home');
    });

    it('migrates the legacy three-mode setting', () => {
        localStorage.setItem('bookvoice.app.mode', 'camera');
        expect(getAppView()).toBe('scan');
        localStorage.setItem('bookvoice.app.mode', 'studio');
        expect(getAppView()).toBe('studio');
        localStorage.setItem('bookvoice.app.mode', 'pdf');
        expect(getAppView()).toBe('home');
    });

    it('ignores invalid or unavailable local storage', () => {
        localStorage.setItem('bookvoice.app.view', 'teleport');
        expect(getAppView()).toBe('home');

        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });
        expect(getAppView()).toBe('home');
    });
});

describe('appSession last book pointer', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('remembers and clears the last opened book', () => {
        expect(getLastBookId()).toBeNull();
        setLastBookId('b7');
        expect(getLastBookId()).toBe('b7');
        setLastBookId(null);
        expect(getLastBookId()).toBeNull();
    });

    it('stays null when storage is unavailable', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });
        setLastBookId('b7');
        expect(getLastBookId()).toBeNull();
    });
});
