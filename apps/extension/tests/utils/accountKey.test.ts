/**
 * The signing announce's group_public_key is the ACCOUNT child's key (as the
 * engine announces it), i.e. the key the ceremony aggregates under.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { initializeWasmIfNeeded, isWasmInitialized } from "../entrypoints/offscreen/test-utils";
import { deriveAccountGroupKey } from "../../src/utils/accountKey";
import { keyShareCoreFromEngine } from "../../src/utils/engineKeystore";
import { segwitV1Program } from "../helpers/bip340";

beforeAll(async () => {
    await initializeWasmIfNeeded();
});

async function share() {
    const wasm = await import("@stars-labs/core-wasm");
    const d = [1, 2, 3].map((i) => {
        const p = new wasm.FrostDkgSecp256k1();
        p.init_dkg(i, 3, 2);
        return p;
    });
    const r1 = d.map((p) => p.generate_round1());
    d.forEach((p, i) => r1.forEach((k, j) => i !== j && p.add_round1_package(j + 1, k)));
    const r2 = d.map((p) => JSON.parse(Buffer.from(p.generate_round2(), "hex").toString()));
    r2.forEach((m, s) => d.forEach((p, r) => s !== r && p.add_round2_package(s + 1, m[String(r + 1)])));
    d.forEach((p) => p.finalize_dkg());
    const root = d[0].get_group_public_key();
    const shares = d.map((p, i) => ({
        ...keyShareCoreFromEngine(p.export_keystore(), root, { a: 1, b: 2, c: 3 }),
        session_id: "s",
        device_id: "abc"[i],
        blockchains: [],
        created_at: 0,
    }));
    d.forEach((p) => p.free());
    return { wasm, root, ks: shares[0], shares };
}

describe("deriveAccountGroupKey", () => {
    it("is the account child's key, not the root", async () => {
        if (!isWasmInitialized()) return;
        const { root, ks } = await share();
        const eth = await deriveAccountGroupKey(ks, { chain: "ethereum", account: 0 });
        expect(eth).toMatch(/^0[23][0-9a-f]{64}$/);
        expect(eth).not.toBe(root);
        expect(await deriveAccountGroupKey(ks, { chain: "ethereum", account: 1 })).not.toBe(eth);
    });

    it("for bitcoin is the bc1p output key", async () => {
        if (!isWasmInitialized()) return;
        const { wasm, root, ks } = await share();
        const btc = await deriveAccountGroupKey(ks, { chain: "bitcoin", account: 0 });
        const addr = JSON.parse(wasm.derive_account_addresses("secp256k1", root, 0)).find((a: any) => a.chain === "Bitcoin").address;
        expect(btc.slice(2)).toBe(Buffer.from(segwitV1Program(addr)).toString("hex"));
    });

    it("is the same key from every shareholder's share", async () => {
        if (!isWasmInitialized()) return;
        const { shares } = await share();
        const keys = await Promise.all(shares.map((k) => deriveAccountGroupKey(k, { chain: "ethereum", account: 0 })));
        expect(new Set(keys).size).toBe(1);
    });
});
