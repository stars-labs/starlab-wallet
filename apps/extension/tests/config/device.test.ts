/**
 * The device id is this extension's identity on the signal server. It used to
 * be hardcoded to "mpc-2", so every extension in a room collided on one id.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { DEVICE_ID_STORAGE_KEY, getDeviceId } from '../../src/config/device';

describe('Device id', () => {
    beforeEach(async () => {
        await chrome.storage.local.clear();
    });

    it('generates an ext- prefixed id on first use', async () => {
        expect(await getDeviceId()).toMatch(/^ext-[0-9a-f]{8}$/);
    });

    it('persists the generated id', async () => {
        const id = await getDeviceId();
        const stored = await chrome.storage.local.get(DEVICE_ID_STORAGE_KEY);
        expect(stored[DEVICE_ID_STORAGE_KEY]).toBe(id);
    });

    it('returns the same id on subsequent calls', async () => {
        const first = await getDeviceId();
        expect(await getDeviceId()).toBe(first);
    });

    it('reuses an id already in storage', async () => {
        await chrome.storage.local.set({ [DEVICE_ID_STORAGE_KEY]: 'ext-deadbeef' });
        expect(await getDeviceId()).toBe('ext-deadbeef');
    });

    it('two fresh installs get different ids', async () => {
        const a = await getDeviceId();
        await chrome.storage.local.clear();
        expect(await getDeviceId()).not.toBe(a);
    });
});
