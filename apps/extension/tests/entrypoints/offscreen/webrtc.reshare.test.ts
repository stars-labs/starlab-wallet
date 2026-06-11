/**
 * M3 reshare (#23): WebRTCManager reshare state machine.
 *
 * Two layers of coverage:
 *
 * 1. Mocked-WASM unit tests for the state machine itself —
 *    validation, buffering, round progression, completion callback,
 *    and the group-key-unchanged invariant (a mismatch must FAIL the
 *    ceremony, never persist).
 *
 * 2. A real-WASM integration test: run an actual 3-party secp256k1
 *    DKG, export the keystores, then drive three WebRTCManagers over
 *    a loopback transport through a full rotation reshare AND a
 *    replace-device (subset) reshare. Verifies the engine call
 *    contract end-to-end: hex round-1 packages, plain-JSON round-2
 *    recipient map keyed by FROST id, and get_group_public_key()
 *    equality with the pre-reshare key.
 */
import {
    describe,
    it,
    expect,
    beforeAll,
    afterAll,
    beforeEach,
    afterEach,
    jest,
} from "bun:test";
import {
    ReshareState,
    WebRTCManager,
    MeshStatusType,
} from "../../../src/entrypoints/offscreen/webrtc";
import { initializeWasmIfNeeded, isWasmInitialized } from "./test-utils";

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

// ---------------------------------------------------------------
// Mock FROST reshare WASM: deterministic, n-1 package contract like
// the real engine. Group key fixed at "02cafe…" unless overridden.
// ---------------------------------------------------------------
const GROUP_KEY = "02cafe00000000000000000000000000000000000000000000000000000000cafe";

class MockReshare {
    static created: MockReshare[] = [];
    newIds: number[] = [];
    newThreshold = 0;
    r1 = new Set<number>();
    r2 = new Set<number>();
    finalized = false;
    groupKey = GROUP_KEY;
    constructor() {
        MockReshare.created.push(this);
    }
    init_reshare(_json: string, idsCsv: string, t: number) {
        this.newIds = idsCsv.split(",").map(Number);
        this.newThreshold = t;
    }
    reshare_round1(): string {
        return "aa01";
    }
    add_reshare_round1(from: number, _hex: string) {
        if (this.r1.has(from)) throw new Error("duplicate r1");
        this.r1.add(from);
    }
    can_reshare_round2(): boolean {
        return this.r1.size >= this.newIds.length - 1;
    }
    reshare_round2(): string {
        const map: Record<string, string> = {};
        for (const id of this.newIds) map[String(id)] = `bb0${id}`;
        return JSON.stringify(map); // engine emits PLAIN json (probed)
    }
    add_reshare_round2(from: number, _hex: string) {
        this.r2.add(from);
    }
    can_finalize_reshare(): boolean {
        return this.r2.size >= this.newIds.length - 1;
    }
    finalize_reshare(): string {
        this.finalized = true;
        return JSON.stringify({
            key_package: "kp-new",
            public_key_package: "pkp-new",
            min_signers: this.newThreshold,
            max_signers: this.newIds.length,
            participant_index: this.newIds[0],
            participant_indices: this.newIds,
            curve: "secp256k1",
        });
    }
    get_group_public_key(): string {
        return this.groupKey;
    }
    free() {}
}

class MockDkgProbe {
    import_keystore(_json: string) {}
    get_group_public_key(): string {
        return GROUP_KEY;
    }
    free() {}
}

const ENGINE_KEYSTORE_JSON = JSON.stringify({
    key_package: "kp-old",
    public_key_package: "pkp-old",
    min_signers: 2,
    max_signers: 3,
    participant_index: 1,
    participant_indices: [1, 2, 3],
    curve: "secp256k1",
});

function mockKeyShare(participantIndex = 1) {
    return {
        key_package: "kp-old",
        // DKG-created wallets store the full engine keystore JSON here.
        group_public_key: ENGINE_KEYSTORE_JSON,
        session_id: "wallet-1",
        device_id: `dev-${participantIndex}`,
        participant_index: participantIndex,
        threshold: 2,
        total_participants: 3,
        curve: "secp256k1" as const,
    };
}

function reshareSession(participants: string[], threshold = 2, old = ["a", "b", "c"]) {
    return {
        session_id: "reshare_test1",
        proposer_id: participants[0],
        total: participants.length,
        threshold,
        participants,
        session_type: "reshare",
        curve_type: "secp256k1",
        coordination_type: "Network",
        wallet_name: "wallet-1",
        reshare_old_participants: old,
        accepted_devices: [...participants],
    } as any;
}

describe("WebRTCManager reshare (mock WASM)", () => {
    let savedGlobals: Record<string, any> = {};
    beforeEach(() => {
        MockReshare.created = [];
        savedGlobals = {
            FrostReshareSecp256k1: (globalThis as any).FrostReshareSecp256k1,
            FrostReshareEd25519: (globalThis as any).FrostReshareEd25519,
            FrostDkgSecp256k1: (globalThis as any).FrostDkgSecp256k1,
        };
        (globalThis as any).FrostReshareSecp256k1 = MockReshare;
        (globalThis as any).FrostReshareEd25519 = MockReshare;
        (globalThis as any).FrostDkgSecp256k1 = MockDkgProbe;
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(savedGlobals)) {
            if (v === undefined) delete (globalThis as any)[k];
            else (globalThis as any)[k] = v;
        }
    });

    function makeManager(id: string) {
        const mgr = new WebRTCManager(id, () => {});
        const sent: Array<{ to: string; msg: any }> = [];
        mgr.sendWebRTCAppMessage = (to: string, msg: any) => {
            sent.push({ to, msg });
        };
        return { mgr, sent };
    }

    it("rejects a session without reshare_old_participants", () => {
        const { mgr } = makeManager("a");
        const session = reshareSession(["a", "b", "c"]);
        delete session.reshare_old_participants;
        expect(mgr.startReshare(session, "wallet-1", mockKeyShare(), "ethereum")).toBe(false);
        expect(mgr.reshareState).toBe(ReshareState.Idle);
    });

    it("rejects a new cohort containing a device with no old share", () => {
        const { mgr } = makeManager("a");
        const session = reshareSession(["a", "b", "intruder"], 2, ["a", "b", "c"]);
        expect(mgr.startReshare(session, "wallet-1", mockKeyShare(), "ethereum")).toBe(false);
    });

    it("waits for the mesh before initializing", () => {
        const { mgr, sent } = makeManager("a");
        const ok = mgr.startReshare(reshareSession(["a", "b", "c"]), "wallet-1", mockKeyShare(), "ethereum");
        expect(ok).toBe(true);
        expect(mgr.reshareState).toBe(ReshareState.WaitingForMesh);
        expect(sent.length).toBe(0);

        // Mesh becomes ready → round 1 broadcast to the other two.
        (mgr as any)._updateMeshStatus({ type: MeshStatusType.Ready });
        expect(mgr.reshareState).toBe(ReshareState.Round1InProgress);
        const r1 = sent.filter((s) => s.msg.webrtc_msg_type === "ReshareRound1Package");
        expect(r1.map((s) => s.to).sort()).toEqual(["b", "c"]);
        expect(r1[0].msg.session_id).toBe("reshare_test1");
        expect(typeof r1[0].msg.package).toBe("string");
    });

    it("runs the full happy path: r1 → r2 → complete with new keystore", () => {
        const { mgr, sent } = makeManager("a");
        const completions: any[] = [];
        mgr.onReshareComplete = (p) => completions.push(p);
        mgr.startReshare(reshareSession(["a", "b", "c"]), "wallet-1", mockKeyShare(), "ethereum");
        (mgr as any)._updateMeshStatus({ type: MeshStatusType.Ready });

        // Peer round-1 packages (b = old id 2, c = old id 3).
        mgr.handleWebRTCAppMessage("b", { webrtc_msg_type: "ReshareRound1Package", session_id: "reshare_test1", package: "aa01" } as any);
        expect(mgr.reshareState).toBe(ReshareState.Round1InProgress);
        mgr.handleWebRTCAppMessage("c", { webrtc_msg_type: "ReshareRound1Package", session_id: "reshare_test1", package: "aa01" } as any);
        expect(mgr.reshareState).toBe(ReshareState.Round2InProgress);

        // Our round-2 packages went out per-recipient.
        const r2sent = sent.filter((s) => s.msg.webrtc_msg_type === "ReshareRound2Package");
        expect(r2sent.map((s) => s.to).sort()).toEqual(["b", "c"]);

        // Peer round-2 packages complete the ceremony.
        mgr.handleWebRTCAppMessage("b", { webrtc_msg_type: "ReshareRound2Package", session_id: "reshare_test1", package: "bb01" } as any);
        mgr.handleWebRTCAppMessage("c", { webrtc_msg_type: "ReshareRound2Package", session_id: "reshare_test1", package: "bb01" } as any);

        expect(mgr.reshareState).toBe(ReshareState.Complete);
        expect(completions.length).toBe(1);
        const done = completions[0];
        expect(done.walletId).toBe("wallet-1");
        expect(done.sessionId).toBe("reshare_test1");
        expect(done.groupPublicKey).toBe(GROUP_KEY);
        expect(done.total).toBe(3);
        expect(done.threshold).toBe(2);
        expect(JSON.parse(done.newKeystoreJson).key_package).toBe("kp-new");
        // The FROST identifiers passed to the engine are the OLD
        // sorted-cohort positions.
        expect(MockReshare.created[0].newIds).toEqual([1, 2, 3]);
    });

    it("buffers round-1 packages that arrive before initialization", () => {
        const { mgr } = makeManager("a");
        const session = reshareSession(["a", "b", "c"]);
        // Packages land BEFORE startReshare (peers were faster).
        mgr.handleWebRTCAppMessage("b", { webrtc_msg_type: "ReshareRound1Package", session_id: "reshare_test1", package: "aa01" } as any);
        mgr.handleWebRTCAppMessage("c", { webrtc_msg_type: "ReshareRound1Package", session_id: "reshare_test1", package: "aa01" } as any);
        expect(mgr.reshareState).toBe(ReshareState.Idle);

        // Arming the reshare consumes the buffer even though our
        // mesh bookkeeping never reached Ready (the buffered packages
        // prove the channels are open).
        mgr.startReshare(session, "wallet-1", mockKeyShare(), "ethereum");
        expect(mgr.reshareState).toBe(ReshareState.Round2InProgress);
        expect((mgr as any).receivedReshareRound1.size).toBe(3);
    });

    it("fails (and never completes) when the group key changes", () => {
        const { mgr } = makeManager("a");
        const completions: any[] = [];
        const states: string[] = [];
        mgr.onReshareComplete = (p) => completions.push(p);
        mgr.onReshareStateUpdate = (p) => states.push(p.state);
        mgr.startReshare(reshareSession(["a", "b", "c"]), "wallet-1", mockKeyShare(), "ethereum");
        (mgr as any)._updateMeshStatus({ type: MeshStatusType.Ready });
        // Sabotage: the engine instance reports a DIFFERENT group key.
        MockReshare.created[0].groupKey = "03deadbeef";

        mgr.handleWebRTCAppMessage("b", { webrtc_msg_type: "ReshareRound1Package", session_id: "reshare_test1", package: "aa01" } as any);
        mgr.handleWebRTCAppMessage("c", { webrtc_msg_type: "ReshareRound1Package", session_id: "reshare_test1", package: "aa01" } as any);
        mgr.handleWebRTCAppMessage("b", { webrtc_msg_type: "ReshareRound2Package", session_id: "reshare_test1", package: "bb01" } as any);
        mgr.handleWebRTCAppMessage("c", { webrtc_msg_type: "ReshareRound2Package", session_id: "reshare_test1", package: "bb01" } as any);

        expect(mgr.reshareState).toBe(ReshareState.Failed);
        expect(completions.length).toBe(0);
        expect(states).toContain("Failed");
    });

    it("ignores packages from devices outside the old cohort", () => {
        const { mgr } = makeManager("a");
        mgr.startReshare(reshareSession(["a", "b", "c"]), "wallet-1", mockKeyShare(), "ethereum");
        (mgr as any)._updateMeshStatus({ type: MeshStatusType.Ready });
        mgr.handleWebRTCAppMessage("evil", { webrtc_msg_type: "ReshareRound1Package", session_id: "reshare_test1", package: "aa01" } as any);
        expect((mgr as any).receivedReshareRound1.has("evil")).toBe(false);
        expect(mgr.reshareState).toBe(ReshareState.Round1InProgress);
    });

    it("subset cohort (replace device): identifiers keep old positions", () => {
        const { mgr, sent } = makeManager("a");
        const completions: any[] = [];
        mgr.onReshareComplete = (p) => completions.push(p);
        // Device "b" was lost: new cohort [a, c] of old [a, b, c].
        mgr.startReshare(reshareSession(["a", "c"], 2), "wallet-1", mockKeyShare(), "ethereum");
        (mgr as any)._updateMeshStatus({ type: MeshStatusType.Ready });
        expect(MockReshare.created[0].newIds).toEqual([1, 3]); // a=1, c=3 (b's slot 2 retired)

        mgr.handleWebRTCAppMessage("c", { webrtc_msg_type: "ReshareRound1Package", session_id: "reshare_test1", package: "aa01" } as any);
        expect(mgr.reshareState).toBe(ReshareState.Round2InProgress);
        const r2 = sent.filter((s) => s.msg.webrtc_msg_type === "ReshareRound2Package");
        expect(r2.map((s) => s.to)).toEqual(["c"]);
        mgr.handleWebRTCAppMessage("c", { webrtc_msg_type: "ReshareRound2Package", session_id: "reshare_test1", package: "bb03" } as any);
        expect(mgr.reshareState).toBe(ReshareState.Complete);
        expect(completions[0].total).toBe(2);
        expect(completions[0].participants).toEqual(["a", "c"]);
    });

    it("resetSession clears in-flight reshare state", () => {
        const { mgr } = makeManager("a");
        mgr.startReshare(reshareSession(["a", "b", "c"]), "wallet-1", mockKeyShare(), "ethereum");
        (mgr as any)._updateMeshStatus({ type: MeshStatusType.Ready });
        expect(mgr.reshareState).toBe(ReshareState.Round1InProgress);
        mgr.resetSession();
        expect(mgr.reshareState).toBe(ReshareState.Idle);
        expect(mgr.reshareInfo).toBeNull();
    });
});

// ---------------------------------------------------------------
// Real-WASM integration: 3 managers, loopback transport, actual
// FROST reshare over keystores produced by an actual DKG.
// ---------------------------------------------------------------
describe("WebRTCManager reshare (real WASM, loopback mesh)", () => {
    async function makeRealKeystores(): Promise<string[] | null> {
        if (!isWasmInitialized()) return null;
        const { FrostDkgSecp256k1 } = await import("@stars-labs/core-wasm");
        const n = 3, t = 2;
        const dkgs = [1, 2, 3].map((i) => {
            const d = new FrostDkgSecp256k1();
            d.init_dkg(i, n, t);
            return d;
        });
        const r1 = dkgs.map((d) => d.generate_round1());
        for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++)
                if (i !== j) dkgs[i].add_round1_package(j + 1, r1[j]);
        const r2 = dkgs.map((d) => {
            const hex = d.generate_round2();
            const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map((b: string) => parseInt(b, 16)));
            return JSON.parse(new TextDecoder().decode(bytes));
        });
        for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++)
                if (i !== j) dkgs[i].add_round2_package(j + 1, r2[j][String(i + 1)]);
        dkgs.forEach((d) => d.finalize_dkg());
        const keystores = dkgs.map((d) => (d as any).export_keystore() as string);
        const groupKey = dkgs[0].get_group_public_key();
        dkgs.forEach((d) => d.free());
        return [groupKey, ...keystores];
    }

    function wireLoopback(managers: Map<string, WebRTCManager>) {
        for (const [id, mgr] of managers) {
            mgr.sendWebRTCAppMessage = (to: string, msg: any) => {
                const peer = managers.get(to);
                if (peer) peer.handleWebRTCAppMessage(id, msg);
            };
        }
    }

    it("rotation: all 3 devices end with fresh shares, group key unchanged", async () => {
        const { FrostReshareSecp256k1, FrostDkgSecp256k1 } = await import("@stars-labs/core-wasm");
        const made = await makeRealKeystores();
        if (!made) {
            console.warn("WASM unavailable — skipping real reshare test");
            return;
        }
        const [groupKey, ...keystores] = made;
        const saved = {
            r: (globalThis as any).FrostReshareSecp256k1,
            d: (globalThis as any).FrostDkgSecp256k1,
        };
        (globalThis as any).FrostReshareSecp256k1 = FrostReshareSecp256k1;
        (globalThis as any).FrostDkgSecp256k1 = FrostDkgSecp256k1;
        try {
            const ids = ["dev-a", "dev-b", "dev-c"]; // sorted
            const managers = new Map<string, WebRTCManager>();
            const completions = new Map<string, any>();
            ids.forEach((id, i) => {
                const mgr = new WebRTCManager(id, () => {});
                mgr.onReshareComplete = (p) => completions.set(id, p);
                managers.set(id, mgr);
                void i;
            });
            wireLoopback(managers);

            const session = {
                session_id: "reshare_real",
                proposer_id: "dev-a",
                total: 3,
                threshold: 2,
                participants: ids,
                session_type: "reshare",
                curve_type: "secp256k1",
                wallet_name: "wallet-real",
                reshare_old_participants: ids,
                accepted_devices: ids,
            } as any;

            // Arm everyone, then flip each mesh Ready (broadcasts
            // cascade synchronously through the loopback transport;
            // earlier-armed managers buffer packets until their own
            // mesh flips).
            ids.forEach((id, i) => {
                const ks = {
                    key_package: JSON.parse(keystores[i]).key_package,
                    group_public_key: keystores[i], // DKG-wallet convention: full engine JSON
                    session_id: "wallet-real",
                    device_id: id,
                    participant_index: i + 1,
                    threshold: 2,
                    total_participants: 3,
                    curve: "secp256k1",
                };
                expect(
                    managers.get(id)!.startReshare(session, "wallet-real", ks, "ethereum"),
                ).toBe(true);
            });
            for (const id of ids) {
                (managers.get(id) as any)._updateMeshStatus({ type: MeshStatusType.Ready });
            }
            // Drain microtasks — _initializeReshare is async.
            for (let i = 0; i < 10; i++) await Promise.resolve();

            for (const id of ids) {
                expect(managers.get(id)!.reshareState).toBe(ReshareState.Complete);
                const done = completions.get(id);
                expect(done).toBeDefined();
                expect(done.groupPublicKey).toBe(groupKey);
                const newKs = JSON.parse(done.newKeystoreJson);
                expect(typeof newKs.key_package).toBe("string");
                expect(newKs.min_signers).toBe(2);
                expect(newKs.max_signers).toBe(3);
                // Fresh share — not byte-identical to the old one.
                expect(newKs.key_package).not.toBe(JSON.parse(keystores[ids.indexOf(id)]).key_package);
            }
        } finally {
            (globalThis as any).FrostReshareSecp256k1 = saved.r;
            (globalThis as any).FrostDkgSecp256k1 = saved.d;
        }
    }, 30000);

    it("replace device: 2-of-2 subset resharing keeps the group key", async () => {
        const { FrostReshareSecp256k1, FrostDkgSecp256k1 } = await import("@stars-labs/core-wasm");
        const made = await makeRealKeystores();
        if (!made) {
            console.warn("WASM unavailable — skipping real subset reshare test");
            return;
        }
        const [groupKey, ...keystores] = made;
        const saved = {
            r: (globalThis as any).FrostReshareSecp256k1,
            d: (globalThis as any).FrostDkgSecp256k1,
        };
        (globalThis as any).FrostReshareSecp256k1 = FrostReshareSecp256k1;
        (globalThis as any).FrostDkgSecp256k1 = FrostDkgSecp256k1;
        try {
            const oldIds = ["dev-a", "dev-b", "dev-c"];
            const newIds = ["dev-a", "dev-c"]; // dev-b lost its phone
            const managers = new Map<string, WebRTCManager>();
            const completions = new Map<string, any>();
            for (const id of newIds) {
                const mgr = new WebRTCManager(id, () => {});
                mgr.onReshareComplete = (p) => completions.set(id, p);
                managers.set(id, mgr);
            }
            wireLoopback(managers);

            const session = {
                session_id: "reshare_subset",
                proposer_id: "dev-a",
                total: 2,
                threshold: 2,
                participants: newIds,
                session_type: "reshare",
                curve_type: "secp256k1",
                wallet_name: "wallet-real",
                reshare_old_participants: oldIds,
                accepted_devices: newIds,
            } as any;

            for (const id of newIds) {
                const i = oldIds.indexOf(id);
                const ks = {
                    key_package: JSON.parse(keystores[i]).key_package,
                    group_public_key: keystores[i],
                    session_id: "wallet-real",
                    device_id: id,
                    participant_index: i + 1,
                    threshold: 2,
                    total_participants: 3,
                    curve: "secp256k1",
                };
                expect(
                    managers.get(id)!.startReshare(session, "wallet-real", ks, "ethereum"),
                ).toBe(true);
            }
            for (const id of newIds) {
                (managers.get(id) as any)._updateMeshStatus({ type: MeshStatusType.Ready });
            }
            for (let i = 0; i < 10; i++) await Promise.resolve();

            for (const id of newIds) {
                expect(managers.get(id)!.reshareState).toBe(ReshareState.Complete);
                const done = completions.get(id);
                expect(done.groupPublicKey).toBe(groupKey);
                expect(done.total).toBe(2);
                expect(done.threshold).toBe(2);
                expect(JSON.parse(done.newKeystoreJson).max_signers).toBe(2);
            }
        } finally {
            (globalThis as any).FrostReshareSecp256k1 = saved.r;
            (globalThis as any).FrostDkgSecp256k1 = saved.d;
        }
    }, 30000);
});
