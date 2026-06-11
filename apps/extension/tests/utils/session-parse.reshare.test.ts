/**
 * M3 reshare (#23): wire round-trip for reshare sessions.
 */
import { describe, it, expect } from "bun:test";
import {
    parseSessionInfoFromWire,
    buildWireSessionInfo,
} from "../../src/utils/session-parse";
import type { SessionInfo } from "@stars-labs/types/session";

describe("session-parse: reshare wire format", () => {
    const reshare: SessionInfo = {
        session_id: "reshare_aabbcc",
        proposer_id: "ext-alice",
        total: 2,
        threshold: 2,
        participants: ["ext-alice"],
        session_type: "reshare",
        curve_type: "secp256k1",
        coordination_type: "Network",
        wallet_name: "wallet-xyz",
        group_public_key: "02cafe",
        blockchain: "ethereum",
        reshare_old_participants: ["ext-alice", "ext-bob", "ext-carol"],
        accepted_devices: ["ext-alice"],
    };

    it("build → parse round-trips the reshare fields", () => {
        const wire = buildWireSessionInfo(reshare);
        expect(wire.session_type).toBe("reshare");
        expect(wire.wallet_name).toBe("wallet-xyz");
        expect(wire.group_public_key).toBe("02cafe");
        expect(wire.blockchain).toBe("ethereum");
        expect(wire.reshare_old_participants).toEqual([
            "ext-alice",
            "ext-bob",
            "ext-carol",
        ]);
        // signing-only field never appears on reshare announces
        expect("signing_message_hex" in wire).toBe(false);
        // extension-local bookkeeping stays off the wire
        expect("accepted_devices" in wire).toBe(false);

        const parsed = parseSessionInfoFromWire(wire);
        expect(parsed).not.toBeNull();
        expect(parsed!.session_type).toBe("reshare");
        expect(parsed!.reshare_old_participants).toEqual([
            "ext-alice",
            "ext-bob",
            "ext-carol",
        ]);
        expect(parsed!.wallet_name).toBe("wallet-xyz");
        expect(parsed!.accepted_devices).toEqual([]);
    });

    it("parses a reshare payload with malformed old-participants tolerantly", () => {
        const parsed = parseSessionInfoFromWire({
            session_id: "reshare_x",
            total: 2,
            threshold: 2,
            session_type: "reshare",
            reshare_old_participants: ["a", 42, null, "b"],
        });
        expect(parsed).not.toBeNull();
        expect(parsed!.reshare_old_participants).toEqual(["a", "b"]);
    });

    it("non-reshare sessions don't grow reshare fields on the wire", () => {
        const dkg: SessionInfo = {
            ...reshare,
            session_type: "dkg",
        };
        const wire = buildWireSessionInfo(dkg);
        expect("reshare_old_participants" in wire).toBe(false);
        expect("wallet_name" in wire).toBe(false);
    });
});
