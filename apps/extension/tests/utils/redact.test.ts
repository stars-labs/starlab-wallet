import { describe, it, expect } from "bun:test";
import { redactForLog } from "../../src/utils/redact";

describe("redactForLog", () => {
    it("masks passwords", () => {
        expect(redactForLog({ type: "saveDkgWallet", password: "hunter22" })).toEqual({
            type: "saveDkgWallet",
            password: "[redacted]",
        });
    });

    it("masks key material nested in payloads", () => {
        const msg = { type: "importKeystore", keystore: { key_package: "SECRET", threshold: 2 } };
        expect(JSON.stringify(redactForLog(msg))).not.toContain("SECRET");
    });

    it("leaves the original message untouched", () => {
        const msg = { password: "hunter22" };
        redactForLog(msg);
        expect(msg.password).toBe("hunter22");
    });

    it("passes non-objects through", () => {
        expect(redactForLog("ping")).toBe("ping");
    });
});
