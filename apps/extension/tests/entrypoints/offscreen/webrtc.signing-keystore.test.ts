/**
 * #64: a DKG-created wallet must be storable in the canonical shape and
 * loadable for signing through the REAL engine (derive_child_keystore_*
 * + import_keystore reject anything but the canonical keystore JSON).
 *
 * Flow per curve: real 3-party DKG → WebRTCManager._finalizeDkg emits
 * onDkgComplete → background boundary (keyShareCoreFromEngine) builds
 * the stored KeyShareData → fresh managers loadKeystoreForSigning and
 * run a 2-of-3 signing ceremony over a queued loopback.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from "bun:test";
import { DkgState, WebRTCManager } from "../../../src/entrypoints/offscreen/webrtc";
import { initializeWasmIfNeeded, isWasmInitialized } from "./test-utils";
import type { KeyShareData } from "@stars-labs/types/keystore";
import {
    keyShareCoreFromEngine,
    toEngineKeystoreJson,
} from "../../../src/utils/engineKeystore";
import { schnorrVerify, segwitV1Program } from "../../helpers/bip340";

let originalLog: any, originalErr: any, originalWarn: any;
beforeAll(async () => {
    await initializeWasmIfNeeded();
    originalLog = console.log;
    originalErr = console.error;
    originalWarn = console.warn;
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
});
afterAll(() => {
    console.log = originalLog;
    console.error = originalErr;
    console.warn = originalWarn;
});

const DEVICES = ["dev-a", "dev-b", "dev-c"]; // sorted → FROST ids 1,2,3

type Chain = "ethereum" | "solana";

/** Run a real DKG and finalize each share through WebRTCManager._finalizeDkg. */
async function dkgThroughManagers(chain: Chain, t = 2): Promise<any[]> {
    const wasm = await import("@stars-labs/core-wasm");
    const Dkg = chain === "ethereum" ? wasm.FrostDkgSecp256k1 : wasm.FrostDkgEd25519;
    const n = 3;
    const dkgs = [1, 2, 3].map((i) => {
        const d = new Dkg();
        d.init_dkg(i, n, t);
        return d;
    });
    const r1 = dkgs.map((d) => d.generate_round1());
    for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
            if (i !== j) dkgs[i].add_round1_package(j + 1, r1[j]);
    const r2 = dkgs.map((d) => JSON.parse(Buffer.from(d.generate_round2(), "hex").toString()));
    for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
            if (i !== j) dkgs[i].add_round2_package(j + 1, r2[j][String(i + 1)]);

    const payloads: any[] = [];
    for (const [i, id] of DEVICES.entries()) {
        const mgr = new WebRTCManager(id, () => {});
        mgr.setBlockchain(chain);
        mgr.sessionInfo = {
            session_id: "dkg-session",
            proposer_id: "dev-a",
            total: 3,
            threshold: t,
            // Join order, unsorted — ids must still follow sorted order.
            participants: ["dev-c", "dev-a", "dev-b"],
            accepted_devices: DEVICES,
        } as any;
        (mgr as any).frostDkg = dkgs[i];
        (mgr as any).participantIndex = i + 1;
        (mgr as any).receivedRound2Packages = new Set(DEVICES);
        mgr.onDkgComplete = (p) => payloads.push(p);
        await (mgr as any)._finalizeDkg();
        expect(mgr.dkgState).toBe(DkgState.Complete);
    }
    dkgs.forEach((d) => d.free());
    return payloads;
}

/** What handleSaveDkgWalletRequest persists (minus address bookkeeping). */
function storedShare(payload: any, deviceId: string): KeyShareData {
    return {
        ...keyShareCoreFromEngine(
            payload.keystoreJson,
            payload.groupPublicKey,
            payload.participantIdentifiers,
        ),
        session_id: "dkg-session",
        device_id: deviceId,
        blockchains: [],
        created_at: 0,
    };
}

for (const chain of ["ethereum", "solana"] as const) {
    describe(`DKG wallet → signing keystore load (${chain}, real WASM)`, () => {
        it("stores a real hex group key and no secret material under group_public_key", async () => {
            if (!isWasmInitialized()) return;
            const payloads = await dkgThroughManagers(chain);
            const share = storedShare(payloads[0], "dev-a");

            expect(payloads[0].groupPublicKey).toMatch(/^[0-9a-f]+$/);
            expect(share.group_public_key).toBe(payloads[0].groupPublicKey);
            expect(share.group_public_key).not.toContain(share.key_package);
            expect(share.public_key_package.length).toBeGreaterThan(0);
            expect(share.participant_identifiers).toEqual({ "dev-a": 1, "dev-b": 2, "dev-c": 3 });
            // Lossless: rebuilding the engine JSON reproduces finalize_dkg's output.
            expect(JSON.parse(toEngineKeystoreJson(share))).toEqual(
                JSON.parse(payloads[0].keystoreJson),
            );
        }, 30000);

        it("loads the stored share for signing (derive child + import) and signs 2-of-3", async () => {
            if (!isWasmInitialized()) return;
            const payloads = await dkgThroughManagers(chain);
            const signers = ["dev-b", "dev-c"]; // not the lowest ids on purpose
            const managers = new Map<string, WebRTCManager>();
            const queue: Array<{ from: string; to: string; msg: any }> = [];
            const signatures = new Map<string, string>();
            for (const id of signers) {
                const mgr = new WebRTCManager(id, () => {});
                mgr.sendWebRTCAppMessage = (to: string, msg: any) => {
                    queue.push({ from: id, to, msg });
                };
                mgr.onSigningComplete = (p) => signatures.set(id, p.signature);
                const share = storedShare(payloads[DEVICES.indexOf(id)], id);
                expect(await mgr.loadKeystoreForSigning(share, { chain, account: 0 })).toBe(true);
                expect(mgr.getDkgStatus().address).toBeTruthy();
                managers.set(id, mgr);
            }

            const messageHex = "ab".repeat(32);
            const session = {
                session_id: "sign_dkg_wallet",
                proposer_id: "dev-b",
                total: 3,
                threshold: 2,
                participants: ["dev-c", "dev-b"],
                session_type: "signing",
                signing_message_hex: messageHex,
                accepted_devices: ["dev-c", "dev-b"],
            } as any;
            for (const id of signers) {
                expect(await managers.get(id)!.initiateSigningCeremony(session, messageHex)).toBe(true);
            }
            while (queue.length > 0) {
                const { from, to, msg } = queue.shift()!;
                managers.get(to)?.handleWebRTCAppMessage(from, msg);
            }
            expect(signatures.get("dev-b")).toMatch(/^[0-9a-f]+$/);
            expect(signatures.get("dev-c")).toBe(signatures.get("dev-b"));
        }, 30000);
    });
}

/**
 * TUI-initiated BITCOIN signing: wallet_name `{root}-bitcoin-0`, the
 * message is the raw 32-byte sighash. The co-signers must sign with the
 * BIP-86 child (m/86'/0'/0'/0/0), so the aggregate is a BIP-340 signature
 * for the wallet's bc1p address — not with the ethereum account.
 */
async function coSign(
    payloads: any[],
    signers: string[],
    target: { chain: string; account: number },
    messageHex: string,
): Promise<Map<string, string>> {
    const managers = new Map<string, WebRTCManager>();
    const queue: Array<{ from: string; to: string; msg: any }> = [];
    const signatures = new Map<string, string>();
    for (const id of signers) {
        const mgr = new WebRTCManager(id, () => {});
        mgr.sendWebRTCAppMessage = (to: string, msg: any) => queue.push({ from: id, to, msg });
        mgr.onSigningComplete = (p) => signatures.set(id, p.signature);
        expect(await mgr.loadKeystoreForSigning(storedShare(payloads[DEVICES.indexOf(id)], id), target)).toBe(true);
        managers.set(id, mgr);
    }
    const session = {
        session_id: "tui-sign",
        proposer_id: signers[0],
        total: 3,
        threshold: signers.length,
        participants: signers,
        session_type: "signing",
        wallet_name: `root-${target.chain}-${target.account}`,
        signing_message_hex: messageHex,
    } as any;
    for (const id of signers) {
        expect(await managers.get(id)!.initiateSigningCeremony(session, messageHex)).toBe(true);
    }
    while (queue.length > 0) {
        const { from, to, msg } = queue.shift()!;
        managers.get(to)?.handleWebRTCAppMessage(from, msg);
    }
    return signatures;
}

async function bitcoinOutputKey(groupPublicKey: string): Promise<Uint8Array> {
    const { derive_account_addresses } = await import("@stars-labs/core-wasm");
    const btc = JSON.parse(derive_account_addresses("secp256k1", groupPublicKey, 0)).find(
        (a: any) => a.chain === "Bitcoin",
    );
    expect(btc.address).toStartWith("bc1p");
    return segwitV1Program(btc.address);
}

describe("co-signing a bitcoin account session (real WASM)", () => {
    const sighash = "5a".repeat(32);

    for (const [t, signers] of [
        [2, ["dev-b", "dev-c"]],
        [3, ["dev-a", "dev-b", "dev-c"]],
    ] as const) {
        it(`${t}-of-3 aggregate verifies as BIP-340 for the bc1p address`, async () => {
            if (!isWasmInitialized()) return;
            const payloads = await dkgThroughManagers("ethereum", t);
            const sigs = await coSign(payloads, [...signers], { chain: "bitcoin", account: 0 }, sighash);
            const sig = sigs.get(signers[1])!;
            expect(new Set(sigs.values()).size).toBe(1);
            const key = await bitcoinOutputKey(payloads[0].groupPublicKey);
            expect(schnorrVerify(key, Buffer.from(sighash, "hex"), Buffer.from(sig, "hex"))).toBe(true);
        }, 30000);
    }

    it("the ethereum account's signature does not verify for the bc1p address", async () => {
        if (!isWasmInitialized()) return;
        const payloads = await dkgThroughManagers("ethereum");
        const sigs = await coSign(payloads, ["dev-b", "dev-c"], { chain: "ethereum", account: 0 }, sighash);
        const key = await bitcoinOutputKey(payloads[0].groupPublicKey);
        expect(schnorrVerify(key, Buffer.from(sighash, "hex"), Buffer.from(sigs.get("dev-c")!, "hex"))).toBe(false);
    }, 30000);

    it("refuses a chain on the other curve", async () => {
        if (!isWasmInitialized()) return;
        const payloads = await dkgThroughManagers("ethereum");
        const mgr = new WebRTCManager("dev-a", () => {});
        await expect(
            mgr.loadKeystoreForSigning(storedShare(payloads[0], "dev-a"), { chain: "solana", account: 0 }),
        ).rejects.toThrow("secp256k1");
    }, 30000);
});

describe("engine keystore boundary", () => {
    it("rejects the old mislabeled shape (keystore JSON under group_public_key)", () => {
        const legacy = {
            key_package: "kp",
            group_public_key: JSON.stringify({ key_package: "kp", public_key_package: "pkp" }),
            participant_index: 1,
            threshold: 2,
            total_participants: 3,
            participant_identifiers: { a: 1, b: 2, c: 3 },
            curve: "secp256k1",
        } as any;
        expect(() => toEngineKeystoreJson(legacy)).toThrow("public_key_package");
    });

    it("rejects a non-hex group key at save time", () => {
        const engine = JSON.stringify({
            key_package: "kp",
            public_key_package: "pkp",
            min_signers: 2,
            max_signers: 3,
            participant_index: 1,
            participant_indices: [1, 2, 3],
            curve: "secp256k1",
        });
        expect(() => keyShareCoreFromEngine(engine, engine, { a: 1, b: 2, c: 3 })).toThrow("hex");
    });
});
