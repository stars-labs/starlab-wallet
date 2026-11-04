/** Native-compatible dual-FROST ceremony. Round 2 is confidential per recipient. */
export const UNIFIED_ROUND1 = 'UNIFIED_DKG_ROUND1:';
export const UNIFIED_ROUND2 = 'UNIFIED_DKG_ROUND2:';
export interface UnifiedFrostEngine {
    init_dkg(index: number, total: number, threshold: number): void;
    generate_round1(): string;
    add_round1_package(index: number, json: string): void;
    can_start_round2(): boolean;
    generate_round2(): string;
    add_round2_package(index: number, ed: string, secp: string): void;
    can_finalize(): boolean;
    finalize_dkg(): string;
    get_ed25519_public_key(): string;
    get_secp256k1_public_key(): string;
    free(): void;
}
export interface FrostMaterial { keystoreJson: string; groupPublicKey: string; }
export interface UnifiedFrostResult { ed25519: FrostMaterial; secp256k1: FrostMaterial; }
interface Round1 { ed25519: string; secp256k1: string; }
interface Round2 { from_index: number; ed25519: Record<string, string>; secp256k1: Record<string, string>; }
export class UnifiedDkg {
    readonly participants: string[];
    readonly index: number;
    readonly round1 = new Set<string>();
    readonly round2 = new Set<string>();
    private pendingRound2 = new Map<string, Round2>();
    private round2Started = false;
    private complete = false;
    private disposed = false;
    constructor(private engine: UnifiedFrostEngine, participants: string[], private self: string, threshold: number,
        private send: (peer: string, text: string) => void,
        private progress: (round: 1 | 2) => void,
        private finalized: (result: UnifiedFrostResult) => void) {
        this.participants = [...participants].sort();
        this.index = this.participants.indexOf(self) + 1;
        if (!this.index || new Set(participants).size !== participants.length || participants.length < 2 || !Number.isInteger(threshold) || threshold < 2 || threshold > participants.length) throw new Error('Invalid unified DKG cohort');
        engine.init_dkg(this.index, participants.length, threshold);
    }
    start(): void {
        const round1 = this.engine.generate_round1();
        this.round1.add(this.self);
        this.progress(1);
        for (const peer of this.participants) if (peer !== this.self) this.send(peer, UNIFIED_ROUND1 + round1);
    }
    receive(peer: string, text: string): void {
        if (this.disposed || this.complete) return;
        const index = this.participants.indexOf(peer) + 1;
        if (!index || peer === this.self) throw new Error('Unified DKG frame from a non-participant');
        if (text.startsWith(UNIFIED_ROUND1)) {
            if (this.round1.has(peer)) return;
            const json = text.slice(UNIFIED_ROUND1.length);
            const message = JSON.parse(json) as Round1;
            if (typeof message.ed25519 !== 'string' || typeof message.secp256k1 !== 'string') throw new Error('Invalid unified round 1');
            this.engine.add_round1_package(index, json);
            this.round1.add(peer);
            this.progress(1);
        } else if (text.startsWith(UNIFIED_ROUND2)) {
            if (this.round2.has(peer) || this.pendingRound2.has(peer)) return;
            const message = JSON.parse(text.slice(UNIFIED_ROUND2.length)) as Round2;
            // Bind the claimed index to the authenticated data-channel sender.
            if (message.from_index !== index || typeof message.ed25519?.[this.index] !== 'string' || typeof message.secp256k1?.[this.index] !== 'string' || Object.keys(message.ed25519).length !== 1 || Object.keys(message.secp256k1).length !== 1) throw new Error('Invalid unified round 2 sender or recipient');
            this.pendingRound2.set(peer, message);
        } else throw new Error('Unsupported DKG frame');
        this.advance();
    }
    private advance(): void {
        if (!this.round2Started && this.round1.size === this.participants.length && this.engine.can_start_round2()) {
            const packages = JSON.parse(this.engine.generate_round2()) as Omit<Round2, 'from_index'>;
            this.round2Started = true;
            this.round2.add(this.self);
            this.progress(2);
            for (const peer of this.participants) {
                if (peer === this.self) continue;
                const recipient = this.participants.indexOf(peer) + 1;
                const ed = packages.ed25519[recipient], secp = packages.secp256k1[recipient];
                if (!ed || !secp) throw new Error('Missing unified round 2 recipient');
                // Never broadcast another participant's confidential shares.
                this.send(peer, UNIFIED_ROUND2 + JSON.stringify({ from_index: this.index, ed25519: { [recipient]: ed }, secp256k1: { [recipient]: secp } }));
            }
        }
        if (!this.round2Started) return;
        for (const [peer, message] of this.pendingRound2) {
            this.engine.add_round2_package(this.participants.indexOf(peer) + 1, message.ed25519[this.index]!, message.secp256k1[this.index]!);
            this.round2.add(peer);
            this.pendingRound2.delete(peer);
            this.progress(2);
        }
        if (this.round2.size === this.participants.length && this.engine.can_finalize()) {
            const material = JSON.parse(this.engine.finalize_dkg()) as { ed25519: unknown; secp256k1: unknown };
            this.complete = true;
            const result = { ed25519: { keystoreJson: JSON.stringify(material.ed25519), groupPublicKey: this.engine.get_ed25519_public_key() }, secp256k1: { keystoreJson: JSON.stringify(material.secp256k1), groupPublicKey: this.engine.get_secp256k1_public_key() } };
            this.dispose();
            this.finalized(result);
        }
    }
    dispose(): void { if (!this.disposed) this.engine.free(); this.disposed = true; this.pendingRound2.clear(); }
}
