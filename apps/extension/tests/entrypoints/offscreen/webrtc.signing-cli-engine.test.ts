/**
 * The extension co-signing a CLI/TUI-proposed ceremony, end to end on the
 * real engine. The CLI/TUI peers are simulated with core-wasm (the same
 * Rust core) speaking the CLI wire protocol (protocol/signing.rs):
 * SIGN_COMMIT / SIGN_SHARE carry FROST `serialize()` bytes, the proposer
 * commits on announce and fixes the set (itself + first threshold-1
 * commitments, in ARRIVAL order) with SIGN_SET, and every shareholder
 * aggregates — the CLI's aggregate rejects an invalid share
 * (InvalidSignatureShare), which is how the live bug surfaced.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from "bun:test";
import { WebRTCManager, encodeSignerSet, decodeSignerSet } from "../../../src/entrypoints/offscreen/webrtc";
import { initializeWasmIfNeeded, isWasmInitialized } from "./test-utils";
import { keyShareCoreFromEngine } from "../../../src/utils/engineKeystore";
import { schnorrVerify, segwitV1Program } from "../../helpers/bip340";

let originalLog: any;
beforeAll(async () => {
    await initializeWasmIfNeeded();
    originalLog = console.log;
    console.log = jest.fn();
});
afterAll(() => {
    console.log = originalLog;
});

const EXT = "ext-3c2c7652";
const COHORT = ["desktop", EXT, "tui"]; // sorted → FROST ids 1, 2, 3
const IDS: Record<string, number> = { desktop: 1, [EXT]: 2, tui: 3 };

const b64 = (hex: string) => btoa(String.fromCharCode(...hex.match(/.{2}/g)!.map((h) => parseInt(h, 16))));
const unb64 = (s: string) => Buffer.from(s, "base64").toString("hex");

type Frame = { from: string; to: string; text: string };

/** A CLI/TUI peer: core-wasm + the CLI signing protocol. */
class CliPeer {
    commits = new Map<string, string>();
    shares = new Map<string, string>();
    set: string[] | null = null;
    signed = false;
    signature: string | null = null;
    error: string | null = null;
    constructor(
        public id: string,
        private frost: any,
        private wasm: any,
        private proposer: string,
        private threshold: number,
        private msg: string,
        private out: Frame[],
    ) {}
    private wire(kind: string, hex: string) {
        return b64(this.wasm.to_frost_wire("secp256k1", kind, hex));
    }
    private send(text: string) {
        for (const to of COHORT) if (to !== this.id) this.out.push({ from: this.id, to, text });
    }
    start() {
        const c = this.frost.signing_commit();
        this.commits.set(this.id, c);
        this.send(`SIGN_COMMIT:${this.wire("commitment", c)}`);
        this.maybeFix();
    }
    receive(from: string, text: string) {
        if (text.startsWith("SIGN_COMMIT:")) {
            if (!this.commits.has(from)) this.commits.set(from, unb64(text.slice(12)));
            this.maybeFix();
            this.maybeSign();
        } else if (text.startsWith("SIGN_SET:")) {
            if (from === this.proposer && !this.set) this.set = decodeSignerSet(text);
            this.maybeSign();
        } else if (text.startsWith("SIGN_SHARE:")) {
            this.shares.set(from, unb64(text.slice(11)));
            this.maybeAggregate();
        }
    }
    private maybeFix() {
        if (this.id !== this.proposer || this.set || this.commits.size < this.threshold) return;
        this.set = [...this.commits.keys()].slice(0, this.threshold);
        this.send(encodeSignerSet(this.set));
        this.maybeSign();
    }
    private maybeSign() {
        if (!this.set || this.signed || !this.set.every((p) => this.commits.has(p))) return;
        this.signed = true;
        for (const p of this.set) if (p !== this.id) this.frost.add_signing_commitment(IDS[p], this.commits.get(p));
        const share = this.frost.sign(this.msg);
        this.shares.set(this.id, share);
        this.send(`SIGN_SHARE:${this.wire("share", share)}`);
        this.maybeAggregate();
    }
    private maybeAggregate() {
        if (!this.set || this.signature || this.error || !this.set.every((p) => this.shares.has(p))) return;
        try {
            for (const p of this.set) if (p !== this.id) this.frost.add_signature_share(IDS[p], this.shares.get(p));
            this.signature = this.frost.aggregate_signature(this.msg);
        } catch (e) {
            this.error = String((e as any)?.message ?? e);
        }
    }
}

async function wallet(threshold: number) {
    const wasm = await import("@stars-labs/core-wasm");
    const dkgs = [1, 2, 3].map((i) => {
        const d = new wasm.FrostDkgSecp256k1();
        d.init_dkg(i, 3, threshold);
        return d;
    });
    const r1 = dkgs.map((d) => d.generate_round1());
    dkgs.forEach((d, i) => r1.forEach((p, j) => i !== j && d.add_round1_package(j + 1, p)));
    const r2 = dkgs.map((d) => JSON.parse(Buffer.from(d.generate_round2(), "hex").toString()));
    r2.forEach((m, s) => dkgs.forEach((d, r) => s !== r && d.add_round2_package(s + 1, m[String(r + 1)])));
    dkgs.forEach((d) => d.finalize_dkg());
    const groupKey = dkgs[0].get_group_public_key();
    const exports = dkgs.map((d) => d.export_keystore());
    dkgs.forEach((d) => d.free());
    return { wasm, groupKey, exports };
}

/** The extension's offscreen WebRTCManager — ONE instance across ceremonies, as live. */
async function extension(threshold: number) {
    const w = await wallet(threshold);
    const out: Frame[] = [];
    const ext = new WebRTCManager(EXT, () => {});
    // CLI peers only understand the text frames; anything else the
    // extension sends (e.g. its own AggregatedSignature) is ignored.
    ext.sendWebRTCAppMessage = (to: string, m: any) => {
        if (typeof m.text === "string") out.push({ from: EXT, to, text: m.text });
    };
    const sigs: string[] = [];
    ext.onSigningComplete = (p) => sigs.push(p.signature);
    return { ...w, ext, out, sigs, threshold };
}

/** One CLI-proposed ceremony that the extension user approves after the CLI peers committed. */
async function ceremony(
    env: Awaited<ReturnType<typeof extension>>,
    opts: { chain: "ethereum" | "bitcoin"; cliSigners: string[]; msg: string; sessionId?: string },
) {
    const { wasm, exports, groupKey, ext, out, threshold } = env;
    const path = wasm.standard_account_path(opts.chain, 0)!;
    const proposer = opts.cliSigners[0];
    const clis = new Map<string, CliPeer>();
    for (const id of opts.cliSigners) {
        const child = new wasm.FrostDkgSecp256k1();
        child.import_keystore(wasm.derive_child_keystore_secp256k1(exports[IDS[id] - 1], path));
        clis.set(id, new CliPeer(id, child, wasm, proposer, threshold, opts.msg, out));
    }
    const deliver = () => {
        while (out.length) {
            const f = out.shift()!;
            if (f.to === EXT) ext.handleWebRTCAppMessage(f.from, { webrtc_msg_type: "SimpleMessage", text: f.text } as any);
            else clis.get(f.to)?.receive(f.from, f.text);
        }
    };

    // The CLI proposer (and CLI co-signers) commit on announce; the
    // extension user approves later, so its frames arrive last.
    for (const c of clis.values()) c.start();
    deliver();
    // sessionReadyForSigning: reload the wallet, start the ceremony.
    await ext.loadKeystoreForSigning(
        {
            ...keyShareCoreFromEngine(exports[IDS[EXT] - 1], groupKey, IDS),
            session_id: "dkg",
            device_id: EXT,
            blockchains: [],
            created_at: 0,
        },
        { chain: opts.chain, account: 0 },
    );
    const session = {
        session_id: opts.sessionId ?? "sign_x",
        proposer_id: proposer,
        total: 3,
        threshold,
        participants: [...COHORT],
        session_type: "signing",
        wallet_name: `4919c5d281e2-${opts.chain}-0`,
        signing_message_hex: opts.msg,
    } as any;
    expect(await ext.initiateSigningCeremony(session, opts.msg)).toBe(true);
    deliver();
    return { clis, deliver };
}

const MSG = "f1f6ac47".padEnd(64, "7");

describe("extension co-signs a CLI-proposed ceremony (real engine)", () => {
    for (const [t, cliSigners] of [
        [3, ["tui", "desktop"]],
        [2, ["tui"]],
    ] as const) {
        for (const chain of ["bitcoin"] as const) {
            it(`${t}-of-3 ${chain}-0: the CLI aggregates a valid signature`, async () => {
                if (!isWasmInitialized()) return;
                const env = await extension(t);
                const r = await ceremony(env, { chain, cliSigners: [...cliSigners], msg: MSG });
                const tui = r.clis.get("tui")!;
                expect(tui.set).toContain(EXT);
                expect(tui.error).toBeNull();
                expect(tui.signature).toMatch(/^[0-9a-f]{128}$/);
                expect(env.sigs).toEqual([tui.signature!]);
                if (chain === "bitcoin") {
                    const btc = JSON.parse(env.wasm.derive_account_addresses("secp256k1", env.groupKey, 0)).find(
                        (a: any) => a.chain === "Bitcoin",
                    ).address;
                    expect(
                        schnorrVerify(segwitV1Program(btc), Buffer.from(MSG, "hex"), Buffer.from(tui.signature!, "hex")),
                    ).toBe(true);
                }
            }, 30000);
        }
    }
});

describe("a second ceremony after the first finished", () => {
    it("ignores the previous ceremony's resent SIGN_COMMIT (live: InvalidSignatureShare from the extension)", async () => {
        if (!isWasmInitialized()) return;
        const env = await extension(3);
        const first = await ceremony(env, { chain: "bitcoin", cliSigners: ["tui", "desktop"], msg: MSG, sessionId: "sign_1" });
        expect(first.clis.get("tui")!.signature).toBeTruthy();

        // The CLI resends unacked ceremony frames (#117); one lands after
        // the extension's ceremony already completed.
        const staleTui = first.clis.get("tui")!;
        env.ext.handleWebRTCAppMessage("tui", {
            webrtc_msg_type: "SimpleMessage",
            text: `SIGN_COMMIT:${b64(env.wasm.to_frost_wire("secp256k1", "commitment", staleTui.commits.get("tui")!))}`,
        } as any);

        const second = await ceremony(env, {
            chain: "bitcoin",
            cliSigners: ["tui", "desktop"],
            msg: "ab".repeat(32),
            sessionId: "sign_2",
        });
        const tui = second.clis.get("tui")!;
        expect(tui.error).toBeNull();
        expect(tui.signature).toMatch(/^[0-9a-f]{128}$/);
    }, 30000);
});
