/**
 * EIP-712 (eth_signTypedData_v4) regression tests for RpcHandler.
 *
 * The whole point of typed-data support is that the digest is the EIP-712
 * hash (domainSeparator ⊕ hashStruct), NOT the EIP-191 personal_sign hash —
 * get that wrong and every dApp permit / order signature is invalid. So the
 * key assertion is: the digest stashed for the gated FROST ceremony equals
 * viem's `hashTypedData` over the same payload. After that, typed data reuses
 * the exact personal_sign approval pipeline (covered by dappSignatureApproval).
 */
import { describe, it, expect, jest, mock } from "bun:test";

import * as mockImports from "../../wxt-imports-mock";
mock.module("#imports", () => mockImports);

const TEST_ADDR = "0x1111111111111111111111111111111111111111";

// The handler does `await import('../../services/keystoreManager')`; stub it so
// the address → wallet lookup resolves to a known FROST wallet.
mock.module("../../../src/services/keystoreManager", () => ({
    KeystoreManager: {
        getInstance: () => ({
            getWallets: () => [
                {
                    id: "w1",
                    name: "Treasury",
                    address: TEST_ADDR,
                    blockchain: "ethereum",
                },
            ],
            getKeyShareData: () => ({
                group_public_key: "02cafe",
                threshold: 2,
                total_participants: 3,
            }),
        }),
    },
}));

import { RpcHandler } from "../../../src/entrypoints/background/rpcHandler";
import { hashTypedData } from "viem";

// The canonical EIP-712 "Mail" example.
const TYPED_DATA = {
    domain: {
        name: "Ether Mail",
        version: "1",
        chainId: 1,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
    },
    types: {
        EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
        ],
        Person: [
            { name: "name", type: "string" },
            { name: "wallet", type: "address" },
        ],
        Mail: [
            { name: "from", type: "Person" },
            { name: "to", type: "Person" },
            { name: "contents", type: "string" },
        ],
    },
    primaryType: "Mail",
    message: {
        from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
        to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
        contents: "Hello, Bob!",
    },
} as const;

function makeRpc() {
    const chromeGlobal = (global as any).chrome ?? {};
    chromeGlobal.notifications = { create: jest.fn(), clear: jest.fn() };
    const captured: any[] = [];
    chromeGlobal.runtime = {
        ...(chromeGlobal.runtime ?? {}),
        sendMessage: jest.fn((m: any) => captured.push(m)),
    };
    (global as any).chrome = chromeGlobal;

    const rpc = new RpcHandler();
    (rpc as any).setSessionManager({
        createSigningSession: jest.fn(async () => ({
            success: true,
            sessionId: "sign_x",
        })),
    });
    return { rpc, captured };
}

describe("RpcHandler eth_signTypedData_v4 (EIP-712)", () => {
    it("stashes the EIP-712 digest (not the EIP-191 hash) as messageHex", async () => {
        const { rpc, captured } = makeRpc();

        // handleSignTypedDataRequest returns a Promise that only settles when
        // the (gated) ceremony completes; we just inspect the stash it creates.
        const pending = (rpc as any).handleSignTypedDataRequest([
            TEST_ADDR,
            JSON.stringify(TYPED_DATA),
        ]);
        pending.catch(() => {});
        await new Promise((r) => setTimeout(r, 20)); // let the dynamic imports settle

        const reqMsg = captured.find((m) => m.type === "signatureRequest");
        expect(reqMsg).toBeTruthy();
        // Decoded by txDecoder (#33): primaryType + domain, human-readable.
        expect(reqMsg.message).toBe("Sign Mail for Ether Mail");

        const stash = (rpc as any).pendingDappRequests.get(reqMsg.signingId);
        expect(stash).toBeTruthy();
        expect(stash.blockchain).toBe("ethereum");
        expect(stash.walletId).toBe("w1");

        const expected = hashTypedData({
            domain: TYPED_DATA.domain,
            types: TYPED_DATA.types,
            primaryType: TYPED_DATA.primaryType,
            message: TYPED_DATA.message,
        } as any).slice(2);
        expect(stash.messageHex).toBe(expected);
    });

    it("accepts an already-parsed typed-data object too", async () => {
        const { rpc, captured } = makeRpc();
        const pending = (rpc as any).handleSignTypedDataRequest([
            TEST_ADDR,
            TYPED_DATA,
        ]);
        pending.catch(() => {});
        await new Promise((r) => setTimeout(r, 20));

        const reqMsg = captured.find((m) => m.type === "signatureRequest");
        const stash = (rpc as any).pendingDappRequests.get(reqMsg.signingId);
        const expected = hashTypedData({
            domain: TYPED_DATA.domain,
            types: TYPED_DATA.types,
            primaryType: TYPED_DATA.primaryType,
            message: TYPED_DATA.message,
        } as any).slice(2);
        expect(stash.messageHex).toBe(expected);
    });

    it("rejects a malformed typed-data payload", async () => {
        const { rpc } = makeRpc();
        await expect(
            (rpc as any).handleSignTypedDataRequest([TEST_ADDR, "not json {"]),
        ).rejects.toThrow();
    });
});
