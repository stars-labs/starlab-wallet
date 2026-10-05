/**
 * The extension's threshold-ECDSA engine (Ethereum key) — the browser twin
 * of starlab-mpc's `apps/tui/src/protocal/ecdsa/{mod,dkg,signing}.rs`,
 * speaking the same data-channel frames (`wire.ts`).
 *
 * - DKG: after the FROST ceremony of a secp256k1 wallet, the same
 *   participants run aux info then keygen. Keygen index = position in the
 *   sorted participant list.
 * - Signing: an Ethereum account signs with exactly `threshold` signers,
 *   fixed by the proposer: every joined node sends ECDSA_SIGN_READY to the
 *   proposer; it takes itself + the first `threshold - 1` READY senders,
 *   sends ECDSA_SIGN_SET to every participant and starts; a listed node
 *   starts on receipt; the proposer sends the signature to the nodes left
 *   out (ECDSA_SIGN_DONE), who check it recovers to the account address.
 *
 * Ceremonies run in Web Workers (one per job, `spawnWorker`), never on this
 * thread. Payloads that arrive while no worker runs are buffered (capped)
 * and replayed into the next one, which drops other executions'.
 */
import type { EcdsaJob, JobStatus } from "./driver";
import type { FromWorker, WorkerLike } from "./protocol";
import {
    FRAME_PREFIX,
    SIGN_DONE_PREFIX,
    SIGN_READY_PREFIX,
    SIGN_SET_PREFIX,
    Reassembler,
    decodeControl,
    encodeControl,
    encodeFrames,
    parseChunk,
    type Control,
    type ControlPrefix,
} from "./wire";

const MAX_PENDING = 1024;
const MAX_PENDING_CONTROL = 64;

/** DKG ceremony bound once primes are in hand (engine: 10 min). */
export const DKG_TIMEOUT_MS = 10 * 60_000;
/** Signing bound (engine: the FROST signing timeout, 120 s). */
export const SIGNING_TIMEOUT_MS = 120_000;

export interface EcdsaEngineIO {
    selfId: string;
    /** Send one data-channel text frame to `peer` (queued if its channel isn't open). */
    sendText(peer: string, text: string): void;
    spawnWorker(): WorkerLike;
    /** `ecrecover`: the address a 65-byte r‖s‖v over `prehash` recovers to. */
    recoverAddress(prehash: Uint8Array, signature: Uint8Array): string;
    log(message: string): void;
    dkgTimeoutMs?: number;
    signingTimeoutMs?: number;
}

export interface EcdsaSignRequest {
    /** Fresh `sign_<…>` id of the signing session (also the execution id input). */
    sessionId: string;
    proposerId: string;
    /** The wallet's ECDSA key share JSON (secret). */
    shareJson: string;
    /** Device ids in keygen order (`ecdsa_share_info`). */
    participants: string[];
    threshold: number;
    /** HD path of the account, e.g. m/44'/60'/0'/0/0. */
    path: string;
    /** The account's address — a DONE signature must recover to it. */
    address: string;
    /** 32 bytes: EIP-191 hash or a transaction sighash. */
    prehash: Uint8Array;
}

interface Running {
    worker: WorkerLike;
    /** Device ids by keygen index. */
    participants: string[];
}

interface SigningCtx {
    req: EcdsaSignRequest;
    ready: string[];
    signerSet: string[] | null;
    workerStarted: boolean;
    resolve: (sigHex: string) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class EcdsaEngine {
    private reassembler = new Reassembler();
    private pending: [string, Uint8Array][] = [];
    private running: Running | null = null;
    private signing: SigningCtx | null = null;
    private pendingControl: [string, ControlPrefix, Control][] = [];
    /** Ceremony progress (aux info / keygen / signing) for the UI. */
    onStatus: (status: JobStatus) => void = () => {};

    constructor(private readonly io: EcdsaEngineIO) {}

    /** Handle one `ECDSA…` data-channel text from `from`. */
    onFrame(from: string, text: string): void {
        if (text.startsWith(FRAME_PREFIX)) {
            try {
                const payload = this.reassembler.push(from, parseChunk(text.slice(FRAME_PREFIX.length)));
                if (payload) this.deliver(from, payload);
            } catch (e) {
                this.io.log(`ECDSA frame from ${from}: ${(e as Error).message}`);
            }
            return;
        }
        for (const prefix of [SIGN_READY_PREFIX, SIGN_SET_PREFIX, SIGN_DONE_PREFIX] as const) {
            if (text.startsWith(prefix)) {
                let control: Control;
                try {
                    control = decodeControl(text.slice(prefix.length));
                } catch (e) {
                    this.io.log(`${prefix} from ${from}: ${(e as Error).message}`);
                    return;
                }
                this.onControl(from, prefix, control);
                return;
            }
        }
    }

    /** A new DKG: forget everything of the last ceremony. */
    resetForNewDkg(): void {
        this.stopWorker();
        this.pending = [];
        this.reassembler = new Reassembler();
    }

    /** Run aux info + keygen among `participants` (any order; sorted here).
     * Resolves with the key share JSON (secret). */
    runDkg(sessionId: string, participants: string[], threshold: number, primesJson: string): Promise<string> {
        const sorted = [...participants].sort();
        const index = sorted.indexOf(this.io.selfId);
        if (index < 0) return Promise.reject(new Error(`ECDSA DKG: ${this.io.selfId} is not a participant`));
        this.io.log(`ECDSA DKG started (party ${index} of ${sorted.length}, threshold ${threshold})`);
        return this.runJob(
            { kind: "dkg", sessionId, participants: sorted, index, threshold, primesJson },
            sorted,
            this.io.dkgTimeoutMs ?? DKG_TIMEOUT_MS,
        );
    }

    /** Sign `req.prehash`; resolves with hex r‖s‖v (v = 27 + recovery id). */
    sign(req: EcdsaSignRequest): Promise<string> {
        this.failSigning("superseded by a new signing");
        this.stopWorker();
        return new Promise((resolve, reject) => {
            const self = this.io.selfId;
            const isProposer = req.proposerId === self;
            const timeoutMs = this.io.signingTimeoutMs ?? SIGNING_TIMEOUT_MS;
            const ctx: SigningCtx = {
                req,
                ready: isProposer ? [self] : [],
                signerSet: null,
                workerStarted: false,
                resolve,
                reject,
                timer: setTimeout(() => {
                    if (this.signing !== ctx) return;
                    const secs = Math.round(timeoutMs / 1000);
                    this.failSigning(
                        ctx.signerSet
                            ? `ECDSA signing timed out after ${secs}s: the signers ${JSON.stringify(ctx.signerSet)} did not finish`
                            : `ECDSA signing timed out after ${secs}s: only ${Math.max(ctx.ready.length, 1)} of threshold ${req.threshold} signers ready`,
                    );
                }, timeoutMs),
            };
            this.signing = ctx;
            this.io.log(`ECDSA signing ${req.sessionId} (proposer ${req.proposerId})`);
            if (!isProposer) {
                this.io.sendText(req.proposerId, encodeControl(SIGN_READY_PREFIX, { session_id: req.sessionId }));
            }
            const mine = this.pendingControl.filter(([, , c]) => c.session_id === req.sessionId);
            this.pendingControl = this.pendingControl.filter(([, , c]) => c.session_id !== req.sessionId);
            for (const [from, prefix, control] of mine) this.onControl(from, prefix, control);
            this.tryFixSet(ctx);
        });
    }

    /** Abort a running signing (e.g. the session was cancelled). */
    cancelSigning(reason: string): void {
        this.failSigning(reason);
    }

    // ---- internals -------------------------------------------------------

    private deliver(from: string, payload: Uint8Array): void {
        if (this.running) {
            const idx = this.running.participants.indexOf(from);
            if (idx < 0) {
                this.io.log(`ECDSA: payload from ${from}, who is not a participant; dropped`);
                return;
            }
            this.running.worker.postMessage({ type: "payload", from: idx, payload });
            return;
        }
        if (this.pending.length >= MAX_PENDING) this.pending.shift();
        this.pending.push([from, payload]);
    }

    private stopWorker(): void {
        this.running?.worker.terminate();
        this.running = null;
    }

    private runJob(job: EcdsaJob, participants: string[], timeoutMs: number): Promise<string> {
        this.stopWorker();
        const worker = this.io.spawnWorker();
        const running: Running = { worker, participants };
        this.running = running;
        return new Promise<string>((resolve, reject) => {
            const end = (err: Error | null, output?: string) => {
                clearTimeout(timer);
                if (this.running === running) this.stopWorker();
                else worker.terminate();
                if (err) reject(err);
                else resolve(output!);
            };
            const timer = setTimeout(
                () => end(new Error(`ECDSA ${job.kind === "dkg" ? "key generation" : "signing"} timed out`)),
                timeoutMs,
            );
            worker.onmessage = (ev: { data: FromWorker }) => {
                if (this.running !== running) return;
                const m = ev.data;
                switch (m.type) {
                    case "outgoing": {
                        const frames = encodeFrames(m.payload);
                        for (const idx of m.to) {
                            const peer = participants[idx];
                            if (peer === undefined || peer === this.io.selfId) continue;
                            for (const f of frames) this.io.sendText(peer, f);
                        }
                        break;
                    }
                    case "status":
                        this.io.log(`ECDSA: ${m.status}`);
                        this.onStatus(m.status);
                        break;
                    case "warn":
                        this.io.log(`ECDSA: ${m.message}`);
                        break;
                    case "done":
                        end(null, m.output);
                        break;
                    case "error":
                        end(new Error(m.error));
                        break;
                    case "prime":
                        break;
                }
            };
            worker.postMessage({ type: "job", job });
            for (const [from, payload] of this.pending.splice(0)) this.deliver(from, payload);
        });
    }

    private onControl(from: string, prefix: ControlPrefix, control: Control): void {
        const ctx = this.signing;
        if (!ctx || ctx.req.sessionId !== control.session_id) {
            if (this.pendingControl.length >= MAX_PENDING_CONTROL) this.pendingControl.shift();
            this.pendingControl.push([from, prefix, control]);
            return;
        }
        const { req } = ctx;
        const self = this.io.selfId;
        switch (prefix) {
            case SIGN_READY_PREFIX:
                if (self !== req.proposerId) {
                    this.io.log(`ECDSA_SIGN_READY from ${from}, but we are not the proposer; ignored`);
                    return;
                }
                if (!req.participants.includes(from)) {
                    this.io.log(`ECDSA_SIGN_READY from non-participant ${from}; ignored`);
                    return;
                }
                if (!ctx.signerSet && !ctx.ready.includes(from)) ctx.ready.push(from);
                this.tryFixSet(ctx);
                return;
            case SIGN_SET_PREFIX: {
                if (from !== req.proposerId) {
                    this.io.log(`ECDSA_SIGN_SET from non-proposer ${from}; ignored`);
                    return;
                }
                const set = control.signers ?? [];
                const bad = validateSet(req, set);
                if (bad) {
                    this.failSigning(`ECDSA_SIGN_SET from ${from}: ${bad}`);
                    return;
                }
                if (ctx.signerSet) {
                    if (!sameSet(ctx.signerSet, set)) {
                        this.failSigning(
                            `ECDSA_SIGN_SET ${JSON.stringify(set)} conflicts with the fixed set ${JSON.stringify(ctx.signerSet)}`,
                        );
                    }
                    return;
                }
                this.io.log(`ECDSA signer set (from ${from}): ${JSON.stringify(set)}`);
                ctx.signerSet = set;
                if (set.includes(self)) this.startWorker(ctx);
                else this.io.log("not in the ECDSA signer set; waiting for the proposer's signature");
                return;
            }
            case SIGN_DONE_PREFIX: {
                if (from !== req.proposerId) {
                    this.io.log(`ECDSA_SIGN_DONE from non-proposer ${from}; ignored`);
                    return;
                }
                const hex = (control.signature ?? "").replace(/^0x/, "");
                let addr: string;
                try {
                    addr = this.io.recoverAddress(req.prehash, hexToBytes(hex));
                } catch (e) {
                    this.failSigning(`ECDSA_SIGN_DONE: ${(e as Error).message ?? e}`);
                    return;
                }
                if (addr.toLowerCase() !== req.address.toLowerCase()) {
                    this.failSigning(`ECDSA_SIGN_DONE: signature recovers to ${addr}, expected ${req.address}`);
                    return;
                }
                this.io.log("ECDSA signature received from the proposer");
                this.finishSigning(ctx, hex);
                return;
            }
        }
    }

    private tryFixSet(ctx: SigningCtx): void {
        const self = this.io.selfId;
        if (this.signing !== ctx || ctx.req.proposerId !== self || ctx.signerSet) return;
        if (ctx.ready.length < ctx.req.threshold) return;
        const set = ctx.ready.slice(0, ctx.req.threshold);
        this.io.log(`ECDSA signer set fixed (proposer): ${JSON.stringify(set)}`);
        ctx.signerSet = set;
        const frame = encodeControl(SIGN_SET_PREFIX, { session_id: ctx.req.sessionId, signers: set });
        for (const peer of ctx.req.participants) if (peer !== self) this.io.sendText(peer, frame);
        this.startWorker(ctx);
    }

    private startWorker(ctx: SigningCtx): void {
        if (ctx.workerStarted || this.signing !== ctx) return;
        ctx.workerStarted = true;
        const { req } = ctx;
        const signers = (ctx.signerSet ?? []).map((d) => req.participants.indexOf(d)).filter((i) => i >= 0);
        this.runJob(
            { kind: "sign", sessionId: req.sessionId, shareJson: req.shareJson, signers, path: req.path, prehash: req.prehash },
            req.participants,
            // The signing's own timer bounds it; this is a backstop.
            (this.io.signingTimeoutMs ?? SIGNING_TIMEOUT_MS) + 5_000,
        ).then(
            (sigHex) => {
                if (this.signing !== ctx) return;
                const self = this.io.selfId;
                if (req.proposerId === self) {
                    const set = ctx.signerSet ?? [];
                    const done = encodeControl(SIGN_DONE_PREFIX, { session_id: req.sessionId, signature: sigHex });
                    for (const p of req.participants) if (!set.includes(p) && p !== self) this.io.sendText(p, done);
                }
                this.io.log(`ECDSA signature for ${req.address}: ${sigHex}`);
                this.finishSigning(ctx, sigHex);
            },
            (e: Error) => {
                if (this.signing === ctx) this.failSigning(`ECDSA signing failed: ${e.message}`);
            },
        );
    }

    private finishSigning(ctx: SigningCtx, sigHex: string): void {
        clearTimeout(ctx.timer);
        this.signing = null;
        this.stopWorker();
        ctx.resolve(sigHex);
    }

    private failSigning(reason: string): void {
        const ctx = this.signing;
        if (!ctx) return;
        clearTimeout(ctx.timer);
        this.signing = null;
        this.stopWorker();
        this.io.log(reason);
        ctx.reject(new Error(reason));
    }
}

function sameSet(a: string[], b: string[]): boolean {
    return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function validateSet(req: EcdsaSignRequest, set: string[]): string | null {
    if (new Set(set).size !== set.length) return `duplicate signer in ${JSON.stringify(set)}`;
    if (set.length !== req.threshold) return `${set.length} signers, the wallet's threshold is ${req.threshold}`;
    if (!set.includes(req.proposerId)) return `set ${JSON.stringify(set)} does not include the proposer`;
    const unknown = set.find((d) => !req.participants.includes(d));
    if (unknown) return `unknown device ${unknown}`;
    return null;
}

export function hexToBytes(hex: string): Uint8Array {
    const clean = hex.replace(/^0x/, "");
    if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) throw new Error("bad hex");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
    return out;
}
