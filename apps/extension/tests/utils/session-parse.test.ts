/** Canonical native session wire contract: unified DKG, explicit concrete signing/refresh. */
import { describe, it, expect } from "bun:test";
import {
    parseSessionInfoFromWire,
    buildWireSessionInfo,
} from "../../src/utils/session-parse";
import type { SessionInfo } from "@stars-labs/types/session";

describe("parseSessionInfoFromWire", () => {
    it("accepts a minimal TUI-shaped DKG announcement", () => {
        const wire = {
            session_id: "dkg_abc",
            proposer_id: "tui-node-1",
            total: 3,
            threshold: 2,
            participants: ["tui-node-1"],
            session_type: "dkg",
            curve_type: "unified",
            coordination_type: "Network",
        };
        const parsed = parseSessionInfoFromWire(wire);
        expect(parsed).not.toBeNull();
        expect(parsed!.session_id).toBe("dkg_abc");
        expect(parsed!.total).toBe(3);
        expect(parsed!.threshold).toBe(2);
        expect(parsed!.session_type).toBe("dkg");
        // Synthesised by the parser, not present on wire
        expect(parsed!.accepted_devices).toEqual([]);
    });

    it("fills only optional bookkeeping for an explicit unified DKG", () => {
        const parsed = parseSessionInfoFromWire({session_id:"minimal",total:2,threshold:2,session_type:"dkg",curve_type:"unified"});
        expect(parsed).not.toBeNull();
        expect(parsed!.proposer_id).toBe("unknown");
        expect(parsed!.participants).toEqual([]);
        expect(parsed!.curve_type).toBe("unified");
        expect(parsed!.coordination_type).toBe("Network");
        expect(parsed!.session_type).toBe("dkg");
        expect(parsed!.accepted_devices).toEqual([]);
    });

    it("rejects missing session type or algorithm and single-algorithm DKG", () => {
        const base={session_id:"strict",total:2,threshold:2};
        expect(parseSessionInfoFromWire(base)).toBeNull();
        expect(parseSessionInfoFromWire({...base,session_type:"dkg"})).toBeNull();
        expect(parseSessionInfoFromWire({...base,curve_type:"unified"})).toBeNull();
        for(const curve_type of ["ed25519","secp256k1","secp256k1-ecdsa"]){
            expect(parseSessionInfoFromWire({...base,session_type:"dkg",curve_type})).toBeNull();
        }
    });

    it("parses a TUI-shaped signing announcement with sibling fields", () => {
        // For signing sessions, TUI emits wallet_name, group_public_key,
        // blockchain, signing_message_hex as TOP-LEVEL siblings (not
        // nested under session_type). Parser must pick them up.
        const wire = {
            session_id: "sig_xyz",
            proposer_id: "alice",
            total: 3,
            threshold: 2,
            participants: ["alice", "bob", "charlie"],
            session_type: "signing",
            curve_type: "secp256k1-ecdsa",
            coordination_type: "Network",
            wallet_name: "wallet-dkg_4a3f",
            group_public_key: "02aabbcc",
            blockchain: "ethereum",
            signing_message_hex: "68656c6c6f",
        };
        const parsed = parseSessionInfoFromWire(wire);
        expect(parsed).not.toBeNull();
        expect(parsed!.session_type).toBe("signing");
        expect(parsed!.wallet_name).toBe("wallet-dkg_4a3f");
        expect(parsed!.group_public_key).toBe("02aabbcc");
        expect(parsed!.blockchain).toBe("ethereum");
        expect(parsed!.signing_message_hex).toBe("68656c6c6f");
    });

    it("does not read the removed message_hex alias", () => {
        const parsed=parseSessionInfoFromWire({session_id:"s",total:2,threshold:2,session_type:"signing",curve_type:"secp256k1-ecdsa",message_hex:"deadbeef"});
        expect(parsed).not.toBeNull();
        expect(parsed!.signing_message_hex).toBeUndefined();
    });

    it("allows only concrete signing algorithms and refreshable FROST algorithms", () => {
        const base={session_id:"algorithm-gate",total:3,threshold:2};
        for(const curve_type of ["ed25519","secp256k1","secp256k1-ecdsa"]){
            expect(parseSessionInfoFromWire({...base,session_type:"signing",curve_type})).not.toBeNull();
        }
        expect(parseSessionInfoFromWire({...base,session_type:"signing",curve_type:"unified"})).toBeNull();
        for(const curve_type of ["ed25519","secp256k1"]){
            expect(parseSessionInfoFromWire({...base,session_type:"reshare",curve_type})).not.toBeNull();
        }
        for(const curve_type of ["unified","secp256k1-ecdsa"]){
            expect(parseSessionInfoFromWire({...base,session_type:"reshare",curve_type})).toBeNull();
        }
    });

    it("rejects payloads missing session_id", () => {
        expect(
            parseSessionInfoFromWire({ total: 3, threshold: 2 }),
        ).toBeNull();
    });

    it("rejects payloads with non-numeric total/threshold", () => {
        expect(
            parseSessionInfoFromWire({
                session_id: "x",
                total: "3",
                threshold: 2,
            }),
        ).toBeNull();
        expect(
            parseSessionInfoFromWire({
                session_id: "x",
                total: 3,
                threshold: "2",
            }),
        ).toBeNull();
    });

    it("rejects non-object inputs", () => {
        expect(parseSessionInfoFromWire(null)).toBeNull();
        expect(parseSessionInfoFromWire("string")).toBeNull();
        expect(parseSessionInfoFromWire(42)).toBeNull();
        expect(parseSessionInfoFromWire(undefined)).toBeNull();
    });

    it("drops non-string entries from participants", () => {
        const parsed = parseSessionInfoFromWire({
            session_id: "x",
            total: 3,
            threshold: 2,
            participants: ["alice", 42, null, "bob", { weird: true }],
            session_type: "dkg", curve_type: "unified",
        });
        expect(parsed!.participants).toEqual(["alice", "bob"]);
    });

    it("rejects an unknown session type instead of routing it as DKG", () => {
        expect(parseSessionInfoFromWire({session_id:"x",total:3,threshold:2,session_type:"future_variant",curve_type:"unified"})).toBeNull();
    });
});

describe("buildWireSessionInfo", () => {
    it("omits signing-only fields on DKG sessions", () => {
        const s: SessionInfo = {
            session_id: "dkg_1",
            proposer_id: "me",
            total: 3,
            threshold: 2,
            participants: ["me"],
            session_type: "dkg",
            curve_type: "unified",
            coordination_type: "Network",
            accepted_devices: [],
        };
        const wire = buildWireSessionInfo(s);
        expect(wire.session_id).toBe("dkg_1");
        expect(wire.session_type).toBe("dkg");
        // These should NOT leak into a DKG wire payload.
        expect("wallet_name" in wire).toBe(false);
        expect("group_public_key" in wire).toBe(false);
        expect("signing_message_hex" in wire).toBe(false);
        // accepted_devices is local-only — must not hit the wire.
        expect("accepted_devices" in wire).toBe(false);
    });

    it("includes signing-only fields on signing sessions", () => {
        const s: SessionInfo = {
            session_id: "sig_1",
            proposer_id: "me",
            total: 3,
            threshold: 2,
            participants: ["me"],
            session_type: "signing",
            curve_type: "secp256k1-ecdsa",
            coordination_type: "Network",
            wallet_name: "w",
            group_public_key: "02aa",
            blockchain: "ethereum",
            signing_message_hex: "deadbeef",
            accepted_devices: [],
        };
        const wire = buildWireSessionInfo(s);
        expect(wire.session_type).toBe("signing");
        expect(wire.wallet_name).toBe("w");
        expect(wire.group_public_key).toBe("02aa");
        expect(wire.blockchain).toBe("ethereum");
        expect(wire.signing_message_hex).toBe("deadbeef");
    });

    it("rejects missing type or algorithm instead of emitting defaults", () => {
        const base:SessionInfo={session_id:"x",proposer_id:"me",total:2,threshold:2,participants:[],accepted_devices:[]};
        expect(()=>buildWireSessionInfo(base)).toThrow();
        expect(()=>buildWireSessionInfo({...base,session_type:"dkg"})).toThrow();
        expect(()=>buildWireSessionInfo({...base,curve_type:"unified"})).toThrow();
        expect(()=>buildWireSessionInfo({...base,session_type:"dkg",curve_type:"ed25519"})).toThrow();
        expect(buildWireSessionInfo({...base,session_type:"dkg",curve_type:"unified"}).coordination_type).toBe("Network");
    });

    it("refuses unified signing and unsupported ECDSA refresh on outbound sessions", () => {
        const base:SessionInfo={session_id:"strict-outbound",proposer_id:"me",total:3,threshold:2,participants:["me"],accepted_devices:[]};
        expect(()=>buildWireSessionInfo({...base,session_type:"signing",curve_type:"unified"})).toThrow();
        for(const curve_type of ["unified","secp256k1-ecdsa"]){
            expect(()=>buildWireSessionInfo({...base,session_type:"reshare",curve_type})).toThrow();
        }
        for(const curve_type of ["ed25519","secp256k1","secp256k1-ecdsa"]){
            expect(buildWireSessionInfo({...base,session_type:"signing",curve_type}).curve_type).toBe(curve_type);
        }
        for(const curve_type of ["ed25519","secp256k1"]){
            expect(buildWireSessionInfo({...base,session_type:"reshare",curve_type}).curve_type).toBe(curve_type);
        }
    });

    it("round-trips parse → build with no semantic loss for DKG", () => {
        // Interop guarantee: if the extension receives a TUI-shaped
        // DKG payload and immediately re-announces it (e.g. a
        // session_status_update flow), the wire bytes should match.
        const tuiWire = {
            session_id: "dkg_round_trip",
            proposer_id: "tui-1",
            total: 3,
            threshold: 2,
            participants: ["tui-1", "tui-2"],
            session_type: "dkg",
            curve_type: "unified",
            coordination_type: "Network",
        };
        const parsed = parseSessionInfoFromWire(tuiWire)!;
        const rebuilt = buildWireSessionInfo(parsed);
        // Compare field-for-field on the keys TUI cares about.
        for (const k of Object.keys(tuiWire)) {
            expect(rebuilt[k]).toEqual((tuiWire as any)[k]);
        }
    });
});
