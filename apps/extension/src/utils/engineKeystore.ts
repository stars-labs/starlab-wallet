/**
 * The single boundary between the engine's keystore JSON (what
 * @stars-labs/core-wasm's export_keystore / finalize_dkg /
 * finalize_reshare emit and import_keystore / derive_child_keystore_* /
 * init_reshare accept) and the extension's stored KeyShareData.
 *
 * Engine shape (verified against the vendored wasm — no aliasing):
 *   {key_package, public_key_package, min_signers, max_signers,
 *    participant_index, participant_indices, curve}
 *
 * KeyShareData stores those fields individually (plus the hex group
 * key and an explicit device-id → FROST-identifier map), so the engine
 * JSON is rebuilt losslessly here and nowhere else.
 */
import type { KeyShareData } from "@stars-labs/types/keystore";

export interface EngineKeystore {
    key_package: string;
    public_key_package: string;
    min_signers: number;
    max_signers: number;
    participant_index: number;
    participant_indices: number[];
    curve: "secp256k1" | "ed25519";
}

/** The canonical-key-share fields that are derived from the engine keystore. */
export type KeyShareCore = Pick<
    KeyShareData,
    | "key_package"
    | "public_key_package"
    | "group_public_key"
    | "participant_index"
    | "threshold"
    | "total_participants"
    | "participants"
    | "participant_identifiers"
    | "curve"
>;

/** Parse + validate engine keystore JSON. Throws with context on any shape mismatch. */
export function parseEngineKeystore(json: string): EngineKeystore {
    let parsed: any;
    try {
        parsed = JSON.parse(json);
    } catch (e) {
        throw new Error(`Engine keystore is not valid JSON: ${(e as Error).message}`);
    }
    const missing = [
        ["key_package", "string"],
        ["public_key_package", "string"],
        ["min_signers", "number"],
        ["max_signers", "number"],
        ["participant_index", "number"],
    ].filter(([k, t]) => typeof parsed?.[k] !== t).map(([k]) => k);
    if (!Array.isArray(parsed?.participant_indices)) {
        missing.push("participant_indices");
    }
    if (missing.length > 0) {
        throw new Error(`Engine keystore missing/mistyped fields: ${missing.join(", ")}`);
    }
    if (parsed.curve !== "secp256k1" && parsed.curve !== "ed25519") {
        throw new Error(`Engine keystore has unsupported curve: ${String(parsed.curve)}`);
    }
    return parsed as EngineKeystore;
}

/**
 * Build the stored key-share fields from a freshly produced engine
 * keystore (DKG finalize or reshare finalize).
 *
 * @param groupPublicKeyHex  get_group_public_key() — the real hex group
 *                           key, never the keystore JSON.
 * @param participantIdentifiers  device id → FROST identifier for the
 *                           cohort that holds this keystore. Must cover
 *                           exactly the engine's participant_indices.
 */
export function keyShareCoreFromEngine(
    engineJson: string,
    groupPublicKeyHex: string,
    participantIdentifiers: Record<string, number>,
): KeyShareCore {
    const ks = parseEngineKeystore(engineJson);
    if (!/^[0-9a-fA-F]+$/.test(groupPublicKeyHex)) {
        throw new Error("group public key must be hex (got a non-hex value)");
    }
    const mappedIds = Object.values(participantIdentifiers).sort((a, b) => a - b);
    const engineIds = [...ks.participant_indices].sort((a, b) => a - b);
    if (mappedIds.join(",") !== engineIds.join(",")) {
        throw new Error(
            `Participant identifier map [${mappedIds.join(",")}] doesn't match the engine keystore's participant_indices [${engineIds.join(",")}]`,
        );
    }
    if (!engineIds.includes(ks.participant_index)) {
        throw new Error(
            `Engine keystore participant_index ${ks.participant_index} is not among its participant_indices`,
        );
    }
    return {
        key_package: ks.key_package,
        public_key_package: ks.public_key_package,
        group_public_key: groupPublicKeyHex.toLowerCase(),
        participant_index: ks.participant_index,
        threshold: ks.min_signers,
        total_participants: ks.max_signers,
        participants: Object.keys(participantIdentifiers).sort(),
        participant_identifiers: { ...participantIdentifiers },
        curve: ks.curve,
    };
}

/** Rebuild the canonical engine keystore JSON from a stored key share. */
export function toEngineKeystoreJson(ks: KeyShareCore): string {
    if (typeof ks.key_package !== "string" || !ks.key_package) {
        throw new Error("Key share has no key_package");
    }
    if (typeof ks.public_key_package !== "string" || !ks.public_key_package) {
        throw new Error(
            "Key share has no public_key_package — it can't be loaded into the FROST engine",
        );
    }
    const ids = Object.values(ks.participant_identifiers ?? {}).sort((a, b) => a - b);
    if (!ids.includes(ks.participant_index)) {
        throw new Error(
            `Key share's participant_index ${ks.participant_index} is missing from its participant_identifiers`,
        );
    }
    const engine: EngineKeystore = {
        key_package: ks.key_package,
        public_key_package: ks.public_key_package,
        min_signers: ks.threshold,
        max_signers: ks.total_participants,
        participant_index: ks.participant_index,
        participant_indices: ids,
        curve: ks.curve,
    };
    return JSON.stringify(engine);
}

/**
 * DKG identifier assignment: sorted device-id position, 1-based. MUST
 * match the Rust core's canonical_identifier (sort, then position + 1)
 * — see WebRTCManager._withSortedParticipants. Only valid for a FRESH
 * DKG cohort; after a removal reshare ids are gapped and must come from
 * the stored participant_identifiers.
 */
export function dkgParticipantIdentifiers(participants: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    [...participants].sort().forEach((p, i) => {
        out[p] = i + 1;
    });
    return out;
}
