/**
 * Threshold ECDSA through the extension's message layer, on the real WASM:
 * offscreen WebRTCManagers whose data channels reach each other (frames
 * delivered asynchronously with jitter), each running its ceremonies in a
 * real Web Worker (`ceremony.worker.ts`), exactly as in the offscreen
 * document. Fixture primes (INSECURE, test-only — starlab-core testdata)
 * skip minutes of safe-prime generation; aux info still runs for real
 * (~2 min of wasm per party, the parties in parallel workers).
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    hashMessage,
    keccak256,
    parseTransaction,
    recoverAddress,
    recoverTransactionAddress,
    serializeTransaction,
    type TransactionSerializableEIP1559,
} from "viem";
import { WebRTCManager } from "../../src/entrypoints/offscreen/webrtc";
import type { WorkerLike } from "../../src/ecdsa/protocol";
import { assembleSignedEvmTx } from "../../src/services/txBroadcast";
import { signatureParts } from "../../src/ecdsa/signature";
import { initializeWasmIfNeeded } from "../entrypoints/offscreen/test-utils";
import { ECDSA_WALLET } from "../helpers/ecdsaFixture";

const PRIMES: { primes: unknown[] }[] = JSON.parse(
    readFileSync(join(import.meta.dir, "../fixtures/ecdsa/insecure-test-primes.json"), "utf8"),
);

let wasm: typeof import("@stars-labs/core-wasm");
let originalLog: typeof console.log;
beforeAll(async () => {
    await initializeWasmIfNeeded();
    wasm = await import("@stars-labs/core-wasm");
    originalLog = console.log;
    console.log = jest.fn();
});
afterAll(() => {
    console.log = originalLog;
});

const realWorker = (): WorkerLike =>
    new Worker(new URL("../../src/ecdsa/ceremony.worker.ts", import.meta.url).href, {
        type: "module",
    }) as unknown as WorkerLike;

interface Wallet {
    managers: Map<string, WebRTCManager>;
    frames: { from: string; to: string; text: string }[];
    shares: string[];
    participants: string[];
    threshold: number;
    group: string;
}

/** Managers whose data channels reach each other (async, jittered). */
function mesh(ids: string[]) {
    const managers = new Map<string, WebRTCManager>();
    let seed = 42;
    const jitter = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 5;
    const frames: { from: string; to: string; text: string }[] = [];
    for (const id of ids) {
        const m = new WebRTCManager(id, () => {});
        m.spawnEcdsaWorker = realWorker;
        m.sendWebRTCAppMessage = (to: string, msg: any) => {
            frames.push({ from: id, to, text: msg.text });
            setTimeout(() => managers.get(to)?.handleWebRTCAppMessage(id, msg), jitter());
        };
        managers.set(id, m);
    }
    return { managers, frames };
}

const primesFor = (i: number) => wasm.ecdsa_primes_from_parts(JSON.stringify(PRIMES[i % PRIMES.length].primes));

async function dkg(ids: string[], threshold: number, sessionId: string): Promise<Wallet> {
    const { managers, frames } = mesh(ids);
    const shares = await Promise.all(
        ids.map((id, i) => managers.get(id)!.ecdsa.runDkg(sessionId, ids, threshold, primesFor(i))),
    );
    const info = JSON.parse(wasm.ecdsa_share_info(shares[0]));
    const sorted = [...ids].sort();
    return {
        managers,
        frames,
        shares: sorted.map((id) => shares[ids.indexOf(id)]),
        participants: info.participants,
        threshold,
        group: info.group_public_key,
    };
}

/** One signing proposed by `proposer`; every joined node gets the signature. */
async function sign(w: Wallet, joined: string[], proposer: string, messageHex: string, account = 0) {
    const sessionId = `sign_${crypto.randomUUID()}`;
    const results = joined.map(
        (id) =>
            new Promise<string>((resolve, reject) => {
                const m = w.managers.get(id)!;
                m.onSigningComplete = (p) => resolve(p.signature);
                m.onSigningFailed = (p) => reject(new Error(p.error));
            }),
    );
    // The proposer starts on its announce; co-signers join a bit later.
    for (const id of [proposer, ...joined.filter((j) => j !== proposer)]) {
        const session = { session_id: sessionId, proposer_id: proposer, threshold: w.threshold, participants: w.participants } as any;
        const share = w.shares[w.participants.indexOf(id)];
        expect(w.managers.get(id)!.initiateEcdsaSigning(session, messageHex, share, account)).toBe(true);
        await new Promise((r) => setTimeout(r, 20));
    }
    return Promise.all(results);
}

function fixtureWallet(): Wallet {
    const { managers, frames } = mesh(ECDSA_WALLET.participants);
    return { managers, frames, ...ECDSA_WALLET, participants: ECDSA_WALLET.participants, group: ECDSA_WALLET.group_public_key };
}

describe("threshold ECDSA over the extension message layer (real WASM, workers)", () => {
    it(
        "2-of-3 DKG (one extension, two engine-style peers): one group key and Ethereum address",
        async () => {
            const t = performance.now();
            const w = await dkg(["cli-a", "cli-b", "ext-c"], 2, "dkg_ecdsa_2of3");
            originalLog(`ECDSA 2-of-3 DKG through the message layer: ${((performance.now() - t) / 1000).toFixed(1)}s`);
            const infos = w.shares.map((s) => JSON.parse(wasm.ecdsa_share_info(s)));
            expect(new Set(infos.map((x) => x.group_public_key)).size).toBe(1);
            expect(infos.map((x) => x.index)).toEqual([0, 1, 2]);
            // Aux-info messages exceed one 16 KiB chunk: they were really chunked.
            expect(w.frames.some((f) => /^ECDSA:[0-9a-f]{16}:\d+:([2-9]|\d\d):/.test(f.text))).toBe(true);
            const listed = JSON.parse(wasm.derive_account_addresses("secp256k1-ecdsa", w.group, 0));
            expect(listed[0].address).toBe(wasm.ecdsa_ethereum_address(w.group, 0));
            // The new key signs.
            const digest = hashMessage("fresh key");
            const [sig] = await sign(w, ["cli-a", "ext-c"], "ext-c", digest.slice(2));
            expect((await recoverAddress({ hash: digest, signature: `0x${sig}` })).toLowerCase()).toBe(
                wasm.ecdsa_ethereum_address(w.group, 0),
            );
        },
        15 * 60_000,
    );

    it(
        "2-of-3 with all three joined: proposer + first READY sign, the third gets the signature via DONE",
        async () => {
            const w = fixtureWallet();
            const digest = hashMessage("hello from the extension");
            const sigs = await sign(w, w.participants, "device-c", digest.slice(2));
            expect(new Set(sigs).size).toBe(1);
            expect((await recoverAddress({ hash: digest, signature: `0x${sigs[0]}` })).toLowerCase()).toBe(
                wasm.ecdsa_ethereum_address(w.group, 0),
            );
            const done = w.frames.filter((f) => f.text.startsWith("ECDSA_SIGN_DONE:"));
            expect(done.map((f) => f.from)).toEqual(["device-c"]);
        },
        5 * 60_000,
    );

    it(
        "co-signs a peer-proposed signing for account 2",
        async () => {
            const w = fixtureWallet();
            const digest = hashMessage("peer proposes");
            const sigs = await sign(w, ["device-b", "device-a"], "device-b", digest.slice(2), 2);
            expect((await recoverAddress({ hash: digest, signature: `0x${sigs[1]}` })).toLowerCase()).toBe(
                wasm.ecdsa_ethereum_address(w.group, 2),
            );
        },
        5 * 60_000,
    );

    it(
        "an EIP-1559 transaction signed over its sighash recovers to the account address",
        async () => {
            const w = fixtureWallet();
            const tx: TransactionSerializableEIP1559 = {
                type: "eip1559",
                chainId: 11155111,
                nonce: 3,
                to: "0x000000000000000000000000000000000000dEaD",
                value: 12345n,
                gas: 21000n,
                maxFeePerGas: 30_000_000_000n,
                maxPriorityFeePerGas: 1_000_000_000n,
            };
            const sighash = keccak256(serializeTransaction(tx));
            const [sig] = await sign(w, ["device-a", "device-c"], "device-a", sighash.slice(2));
            const raw = assembleSignedEvmTx(tx, signatureParts(sig));
            expect(parseTransaction(raw).type).toBe("eip1559");
            const from = await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` });
            expect(from.toLowerCase()).toBe(wasm.ecdsa_ethereum_address(w.group, 0));
        },
        5 * 60_000,
    );

    it(
        "3-of-3 DKG, then two consecutive signings with different proposers",
        async () => {
            const w = await dkg(["cli-a", "cli-b", "ext-c"], 3, "dkg_ecdsa_3of3");
            for (const proposer of ["cli-a", "ext-c"]) {
                const digest = hashMessage(`3-of-3 by ${proposer}`);
                const sigs = await sign(w, w.participants, proposer, digest.slice(2));
                expect(new Set(sigs).size).toBe(1);
                expect((await recoverAddress({ hash: digest, signature: `0x${sigs[0]}` })).toLowerCase()).toBe(
                    wasm.ecdsa_ethereum_address(w.group, 0),
                );
            }
        },
        20 * 60_000,
    );
});
