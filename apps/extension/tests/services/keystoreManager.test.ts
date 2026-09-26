/**
 * isInitialized() drives the popup's first-run "Get started" (set a password)
 * screen. The background calls initialize() on every startup, which writes a
 * locked session — that alone must not count as "set up", or a fresh install
 * skips the password step whenever the background wins the startup race.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { KeystoreService } from "../../src/services/keystoreService";

// Other test files mock.module() keystoreManager process-wide; the query
// suffix loads a separate, real instance of the module.
const realModule = "../../src/services/keystoreManager.ts?real";
const { KeystoreManager } = (await import(realModule)) as typeof import("../../src/services/keystoreManager");

describe("KeystoreManager.isInitialized", () => {
    beforeEach(async () => {
        await chrome.storage.local.clear();
        // The shared chrome mock has no storage.session; KeystoreManager
        // keeps its lock session there.
        let session: Record<string, unknown> = {};
        (chrome.storage as any).session = {
            get: async () => session,
            set: async (items: Record<string, unknown>) => { session = { ...session, ...items }; },
            remove: async () => { session = {}; },
        };
        (KeystoreManager as any).instance = null;
        KeystoreService.resetInstance();
    });

    it("is false on a fresh install after the background's startup initialize()", async () => {
        const km = KeystoreManager.getInstance();
        await km.initialize("ext-00000001");
        expect(await km.isInitialized()).toBe(false);
    });

    it("is true once a password has been set", async () => {
        const km = KeystoreManager.getInstance();
        await km.initialize("ext-00000001");
        await km.createKeystore("pw", "ext-00000001");
        expect(await km.isInitialized()).toBe(true);
    });
});
