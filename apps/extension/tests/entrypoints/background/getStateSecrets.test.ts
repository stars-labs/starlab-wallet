/**
 * The popup's getState request returns the background state. The DKG
 * keystore JSON (secret share included) waits there until the wallet is
 * saved; it must never be part of the response.
 */
import { describe, it, expect, mock } from "bun:test";
import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);
import { PopupMessageHandler } from "../../../src/entrypoints/background/messageHandlers";

describe("PopupMessageHandler getState", () => {
    it("omits the pending keystore JSON", async () => {
        const state = { deviceId: "ext-a", pendingKeystoreJson: '{"key_package":"SECRET_SHARE"}', pendingKeystoreReady: true };
        const handler = new PopupMessageHandler(
            { getState: () => ({ ...state }) } as any,
            {} as any, {} as any, {} as any, {} as any, {} as any,
        );
        const response = await new Promise<any>((resolve) =>
            handler.handlePopupMessage({ type: "getState" } as any, resolve),
        );
        expect(response).toEqual({ deviceId: "ext-a", pendingKeystoreReady: true });
    });
});
