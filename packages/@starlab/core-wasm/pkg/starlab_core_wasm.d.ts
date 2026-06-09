/* tslint:disable */
/* eslint-disable */

export class FrostDkgEd25519 {
    free(): void;
    [Symbol.dispose](): void;
    add_round1_package(participant_index: number, package_hex: string): void;
    add_round2_package(sender_index: number, package_hex: string): void;
    add_signature_share(participant_index: number, share_hex: string): void;
    add_signing_commitment(participant_index: number, commitment_hex: string): void;
    aggregate_signature(message_hex: string): string;
    can_finalize(): boolean;
    can_start_round2(): boolean;
    clear_signing_state(): void;
    export_keystore(): string;
    finalize_dkg(): string;
    generate_round1(): string;
    generate_round2(): string;
    get_address(): string;
    get_group_public_key(): string;
    has_signing_nonces(): boolean;
    import_keystore(keystore_json: string): void;
    init_dkg(participant_index: number, total: number, threshold: number): void;
    is_dkg_complete(): boolean;
    constructor();
    sign(message_hex: string): string;
    signing_commit(): string;
}

export class FrostDkgSecp256k1 {
    free(): void;
    [Symbol.dispose](): void;
    add_round1_package(participant_index: number, package_hex: string): void;
    add_round2_package(sender_index: number, package_hex: string): void;
    add_signature_share(participant_index: number, share_hex: string): void;
    add_signing_commitment(participant_index: number, commitment_hex: string): void;
    aggregate_signature(message_hex: string): string;
    can_finalize(): boolean;
    can_start_round2(): boolean;
    clear_signing_state(): void;
    export_keystore(): string;
    finalize_dkg(): string;
    generate_round1(): string;
    generate_round2(): string;
    get_address(): string;
    get_eth_address(): string;
    get_group_public_key(): string;
    has_signing_nonces(): boolean;
    import_keystore(keystore_json: string): void;
    init_dkg(participant_index: number, total: number, threshold: number): void;
    is_dkg_complete(): boolean;
    constructor();
    sign(message_hex: string): string;
    signing_commit(): string;
}

export class FrostDkgUnified {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add a round 1 package from another participant.
     * package_json is the JSON output from another participant's generate_round1().
     */
    add_round1_package(participant_index: number, package_json: string): void;
    /**
     * Add round 2 packages from another participant for both curves.
     */
    add_round2_package(sender_index: number, ed_hex: string, secp_hex: string): void;
    /**
     * Check if DKG can be finalized.
     */
    can_finalize(): boolean;
    /**
     * Check if round 2 can start.
     */
    can_start_round2(): boolean;
    /**
     * Export the ed25519 keystore data (for use with FrostDkgEd25519 signing).
     * Must be called after finalize_dkg().
     */
    export_ed25519_keystore(): string;
    /**
     * Export the secp256k1 keystore data (for use with FrostDkgSecp256k1 signing).
     * Must be called after finalize_dkg().
     */
    export_secp256k1_keystore(): string;
    /**
     * Finalize DKG, producing a multi-curve keystore.
     * Returns JSON with both ed25519 and secp256k1 keystore data.
     */
    finalize_dkg(): string;
    /**
     * Create a unified DKG from an existing root secret (hex-encoded 32 bytes).
     */
    static from_root_secret(root_secret_hex: string): FrostDkgUnified;
    /**
     * Generate round 1 packages for both curves.
     * Returns JSON: `{ "ed25519": "<hex>", "secp256k1": "<hex>" }`
     */
    generate_round1(): string;
    /**
     * Generate round 2 packages for both curves.
     * Returns JSON: `{ "ed25519": { <participant_index>: "<hex>", ... }, "secp256k1": { ... } }`
     */
    generate_round2(): string;
    /**
     * Get ed25519 group public key (hex).
     */
    get_ed25519_public_key(): string;
    /**
     * Get Ethereum address (secp256k1 keccak256).
     */
    get_eth_address(): string;
    /**
     * Get the root secret as hex (for backup/storage).
     */
    get_root_secret_hex(): string;
    /**
     * Get secp256k1 group public key (hex).
     */
    get_secp256k1_public_key(): string;
    /**
     * Get Solana address (ed25519 base58).
     */
    get_solana_address(): string;
    /**
     * Initialize DKG parameters.
     */
    init_dkg(participant_index: number, total: number, threshold: number): void;
    /**
     * Check if DKG is complete for both curves.
     */
    is_dkg_complete(): boolean;
    /**
     * Create a new unified DKG with a fresh root secret.
     */
    constructor();
}

export class WasmError {
    free(): void;
    [Symbol.dispose](): void;
    constructor(message: string);
    readonly message: string;
}

export function main(): void;

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_frostdkged25519_free: (a: number, b: number) => void;
    readonly __wbg_frostdkgsecp256k1_free: (a: number, b: number) => void;
    readonly __wbg_frostdkgunified_free: (a: number, b: number) => void;
    readonly __wbg_wasmerror_free: (a: number, b: number) => void;
    readonly frostdkged25519_add_round1_package: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkged25519_add_round2_package: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkged25519_add_signature_share: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkged25519_add_signing_commitment: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkged25519_aggregate_signature: (a: number, b: number, c: number) => [number, number, number, number];
    readonly frostdkged25519_can_finalize: (a: number) => number;
    readonly frostdkged25519_can_start_round2: (a: number) => number;
    readonly frostdkged25519_clear_signing_state: (a: number) => void;
    readonly frostdkged25519_export_keystore: (a: number) => [number, number, number, number];
    readonly frostdkged25519_finalize_dkg: (a: number) => [number, number, number, number];
    readonly frostdkged25519_generate_round1: (a: number) => [number, number, number, number];
    readonly frostdkged25519_generate_round2: (a: number) => [number, number, number, number];
    readonly frostdkged25519_get_address: (a: number) => [number, number, number, number];
    readonly frostdkged25519_get_group_public_key: (a: number) => [number, number, number, number];
    readonly frostdkged25519_has_signing_nonces: (a: number) => number;
    readonly frostdkged25519_import_keystore: (a: number, b: number, c: number) => [number, number];
    readonly frostdkged25519_init_dkg: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkged25519_is_dkg_complete: (a: number) => number;
    readonly frostdkged25519_new: () => number;
    readonly frostdkged25519_sign: (a: number, b: number, c: number) => [number, number, number, number];
    readonly frostdkged25519_signing_commit: (a: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_add_round1_package: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkgsecp256k1_add_round2_package: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkgsecp256k1_add_signature_share: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkgsecp256k1_add_signing_commitment: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkgsecp256k1_aggregate_signature: (a: number, b: number, c: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_can_finalize: (a: number) => number;
    readonly frostdkgsecp256k1_can_start_round2: (a: number) => number;
    readonly frostdkgsecp256k1_clear_signing_state: (a: number) => void;
    readonly frostdkgsecp256k1_export_keystore: (a: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_finalize_dkg: (a: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_generate_round1: (a: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_generate_round2: (a: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_get_address: (a: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_get_eth_address: (a: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_get_group_public_key: (a: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_has_signing_nonces: (a: number) => number;
    readonly frostdkgsecp256k1_import_keystore: (a: number, b: number, c: number) => [number, number];
    readonly frostdkgsecp256k1_init_dkg: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkgsecp256k1_is_dkg_complete: (a: number) => number;
    readonly frostdkgsecp256k1_new: () => number;
    readonly frostdkgsecp256k1_sign: (a: number, b: number, c: number) => [number, number, number, number];
    readonly frostdkgsecp256k1_signing_commit: (a: number) => [number, number, number, number];
    readonly frostdkgunified_add_round1_package: (a: number, b: number, c: number, d: number) => [number, number];
    readonly frostdkgunified_add_round2_package: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly frostdkgunified_can_finalize: (a: number) => number;
    readonly frostdkgunified_can_start_round2: (a: number) => number;
    readonly frostdkgunified_export_ed25519_keystore: (a: number) => [number, number, number, number];
    readonly frostdkgunified_export_secp256k1_keystore: (a: number) => [number, number, number, number];
    readonly frostdkgunified_finalize_dkg: (a: number) => [number, number, number, number];
    readonly frostdkgunified_from_root_secret: (a: number, b: number) => [number, number, number];
    readonly frostdkgunified_generate_round1: (a: number) => [number, number, number, number];
    readonly frostdkgunified_generate_round2: (a: number) => [number, number, number, number];
    readonly frostdkgunified_get_ed25519_public_key: (a: number) => [number, number, number, number];
    readonly frostdkgunified_get_eth_address: (a: number) => [number, number, number, number];
    readonly frostdkgunified_get_root_secret_hex: (a: number) => [number, number];
    readonly frostdkgunified_get_secp256k1_public_key: (a: number) => [number, number, number, number];
    readonly frostdkgunified_get_solana_address: (a: number) => [number, number, number, number];
    readonly frostdkgunified_init_dkg: (a: number, b: number, c: number, d: number) => void;
    readonly frostdkgunified_is_dkg_complete: (a: number) => number;
    readonly frostdkgunified_new: () => number;
    readonly main: () => void;
    readonly wasmerror_message: (a: number) => [number, number];
    readonly wasmerror_new: (a: number, b: number) => number;
    readonly start: () => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
