import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppMode, setAppMode } from './appSession';

describe('appSession', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('defaults a new device to the PDF reader', () => {
        expect(getAppMode()).toBe('pdf');
    });

    it('remembers the selected workspace on this device', () => {
        setAppMode('studio');
        expect(getAppMode()).toBe('studio');
    });

    it('ignores invalid or unavailable local storage', () => {
        localStorage.setItem('bookvoice.app.mode', 'teleport');
        expect(getAppMode()).toBe('pdf');

        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('storage disabled');
        });
        expect(getAppMode()).toBe('pdf');
    });
});
