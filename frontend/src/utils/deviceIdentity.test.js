import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEVICE_HEADER,
    getDeviceId,
    resetDeviceIdentityForTests,
    withDeviceIdentity,
} from './deviceIdentity';

describe('deviceIdentity', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        resetDeviceIdentityForTests();
    });

    it('keeps one opaque identity for this browser profile', () => {
        const first = getDeviceId();
        const second = getDeviceId();

        expect(first).toMatch(/^[0-9a-f]{32}$/);
        expect(second).toBe(first);
    });

    it('adds the device identity without dropping existing request headers', () => {
        const options = withDeviceIdentity({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });

        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/json');
        expect(options.headers[DEVICE_HEADER]).toMatch(/^[0-9a-f]{32}$/);
    });

    it('uses one in-memory identity when persistent storage is blocked', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });

        expect(getDeviceId()).toBe(getDeviceId());
    });
});
