import { REAL_WEBCRYPTO, mockCrypto } from '../setup-bun';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { encodeBytes, sealHardwareVault, openHardwareVault, type HardwareAssertion } from '../../src/services/hardwareVault';
const random = () => encodeBytes(crypto.getRandomValues(new Uint8Array(32)));
const assertion = (): HardwareAssertion => ({ credentialId: random(), prfSalt: random(), prfOutput: random() });
describe('hardware vault actual WebCrypto envelope', () => {
    beforeEach(() => { (globalThis as any).crypto = REAL_WEBCRYPTO; });
    afterEach(() => { (globalThis as any).crypto = mockCrypto; });
    it('restores random secret after JSON persistence without storing PRF or plaintext', async () => {
        const auth = assertion(), secret = random();
        const record = await sealHardwareVault(auth, secret);
        const persisted = JSON.stringify(record);
        expect(persisted).not.toContain(secret);
        expect(persisted).not.toContain(auth.prfOutput);
        expect(await openHardwareVault(JSON.parse(persisted), auth)).toBe(secret);
    });
    it('fails closed for wrong key, salt, credential, missing PRF and tampering', async () => {
        const auth = assertion(), record = await sealHardwareVault(auth, random());
        for (const wrong of [{ ...auth, prfOutput: random() }, { ...auth, prfSalt: random() }, { ...auth, credentialId: random() }, { ...auth, prfOutput: '' }]) await expect(openHardwareVault(record, wrong)).rejects.toThrow();
        await expect(openHardwareVault({ ...record, ciphertext: random() }, auth)).rejects.toThrow();
        await expect(openHardwareVault({ ...record, hkdfSalt: random() }, auth)).rejects.toThrow();
    });
});
