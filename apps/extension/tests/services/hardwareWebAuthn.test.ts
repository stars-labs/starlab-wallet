import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { REAL_WEBCRYPTO, mockCrypto } from '../setup-bun';
import { createHardwareCredential, getHardwareAssertion } from '../../src/services/hardwareWebAuthn';
import { encodeBytes } from '../../src/services/hardwareVault';
const random = () => crypto.getRandomValues(new Uint8Array(32));
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
describe('extension-origin WebAuthn PRF', () => {
    beforeEach(() => { (globalThis as any).crypto = REAL_WEBCRYPTO; Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true }); });
    afterEach(() => {
        (globalThis as any).crypto = mockCrypto;
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete (globalThis as any).navigator;
        if (originalSecure) Object.defineProperty(globalThis, 'isSecureContext', originalSecure); else delete (globalThis as any).isSecureContext;
    });
    it('uses extension default RP, roaming UV and forwards cancellation through both ceremonies', async () => {
        const id = random(), output = random(), controller = new AbortController();
        let created = false;
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: {
            create: async (options: any) => {
                expect(options.signal).toBe(controller.signal);
                expect(options.publicKey.rp.id).toBeUndefined();
                expect(options.publicKey.authenticatorSelection.authenticatorAttachment).toBe('cross-platform');
                expect(options.publicKey.authenticatorSelection.userVerification).toBe('required');
                created = true; return { rawId: id.buffer };
            },
            get: async (options: any) => {
                expect(created).toBe(true); expect(options.signal).toBe(controller.signal);
                expect(options.publicKey.rpId).toBeUndefined();
                expect(options.publicKey.userVerification).toBe('required');
                expect(options.publicKey.extensions.prf.eval.first.byteLength).toBe(32);
                return { rawId: id.buffer, getClientExtensionResults: () => ({ prf: { results: { first: output.buffer } } }) };
            },
        } } });
        const auth = await createHardwareCredential(controller.signal);
        expect(auth.credentialId).toBe(encodeBytes(id)); expect(auth.prfOutput).toBe(encodeBytes(output));
    });
    it('rejects enabled-only PRF, wrong credential, null and cancelled authentication', async () => {
        const id = random(), record = { credentialId: encodeBytes(id), prfSalt: encodeBytes(random()) };
        for (const result of [null, { rawId: id.buffer, getClientExtensionResults: () => ({ prf: { enabled: true } }) }, { rawId: random().buffer, getClientExtensionResults: () => ({}) }]) {
            Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { get: async () => result } } });
            await expect(getHardwareAssertion(record)).rejects.toThrow();
        }
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials: { get: async () => { throw new DOMException('Cancelled', 'NotAllowedError'); } } } });
        await expect(getHardwareAssertion(record)).rejects.toThrow('Cancelled');
    });
});
