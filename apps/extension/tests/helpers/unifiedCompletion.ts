/** Event-boundary fixture, not cryptographic key material. */
export function unifiedCompletion(overrides: Record<string, unknown> = {}) {
    return {
        type: 'dkgComplete', curveType: 'unified', sessionId: 'dkg_x', threshold: 2, total: 3,
        participants: ['a', 'b', 'c'], participantIndex: 1, participantIdentifiers: {a: 1, b: 2, c: 3},
        frost: {
            ed25519: {keystoreJson: '{"key_package":"SECRET_ED"}', groupPublicKey: 'edabcd'},
            secp256k1: {keystoreJson: '{"key_package":"SECRET_SECP"}', groupPublicKey: '02cafebabe'},
        },
        ecdsa: {shareJson: 'SECRET_ECDSA', groupPublicKey: '03abcdef'},
        addresses: {ethereum: '0xAbCd1234', bitcoin: 'bc1ptest', solana: 'soltest', sui: '0xsuitest'},
        ...overrides,
    };
}
