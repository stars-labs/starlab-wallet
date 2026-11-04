/**
 * Copy of a message that is safe to log: values under secret-looking keys
 * (passwords, key shares, keystores, mnemonics) are masked at any depth.
 * The background logs every message it routes.
 */
const SECRET_KEY = /password|mnemonic|secret|private_?key|key_?package|keystore|share_?json|ecdsa_?share|primes|prf|vault_?secret|assertion|credential/i;

export function redactForLog(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redactForLog);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redactForLog(v)]),
    );
}
