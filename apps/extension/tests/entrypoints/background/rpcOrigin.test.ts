import { describe, expect, it } from "bun:test";
import { isInternalSender } from "../../../src/entrypoints/background/rpcOrigin";

describe("RPC sender classification", () => {
    const id = "our-extension";
    it("recognizes both toolbar and tab-hosted popup pages", () => {
        expect(isInternalSender({ id, url: `chrome-extension://${id}/popup.html` }, id)).toBe(true);
        expect(isInternalSender({ id, url: `chrome-extension://${id}/popup.html`, tab: { id: 1 } as chrome.tabs.Tab }, id)).toBe(true);
    });
    it("requires approval for content scripts and other extensions", () => {
        expect(isInternalSender({ id, url: "https://dapp.example/", tab: { id: 1 } as chrome.tabs.Tab }, id)).toBe(false);
        expect(isInternalSender({ id: "other", url: "chrome-extension://other/popup.html" }, id)).toBe(false);
        expect(isInternalSender({ id, url: "chrome-extension://other/popup.html" }, id)).toBe(false);
    });
    it("does not trust missing or malformed metadata", () => {
        expect(isInternalSender({ id }, id)).toBe(false);
        expect(isInternalSender({ id, url: "invalid" }, id)).toBe(false);
    });
});
