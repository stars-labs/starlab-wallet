/**
 * Runs one threshold-ECDSA job (DKG = aux info then keygen, or one signing)
 * over core-wasm's ceremony classes — the browser twin of starlab-mpc's
 * `protocal::ecdsa::worker::run`. Transport-free: payloads come in through
 * `receive`, go out through the `emit` callback; parties are addressed by
 * keygen index. `proceed()` is CPU-heavy, so production drives this inside
 * a Web Worker (`ceremony.worker.ts`).
 */

/** The slice of `@stars-labs/core-wasm` a job needs (injected for tests). */
export interface EcdsaWasm {
    EcdsaAuxInfo: new (sessionId: string, participants: string[], index: number, primesJson: string) => WasmCeremony;
    EcdsaKeygen: new (sessionId: string, participants: string[], index: number, threshold: number) => WasmCeremony;
    EcdsaSigning: new (
        sessionId: string,
        shareJson: string,
        signers: Uint16Array,
        path: string,
        prehash: Uint8Array,
    ) => WasmCeremony;
    ecdsa_key_share_from_parts(participants: string[], keygenJson: string, auxJson: string): string;
    ecdsa_execution_id(sessionId: string, protocol: string, participants: string[]): string;
    ecdsa_payload_execution_id(payload: Uint8Array): string | undefined;
}

export interface WasmCeremony {
    receive(sender: number, payload: Uint8Array): void;
    take_outgoing(): { recipient: "broadcast" | number; payload: Uint8Array }[];
    proceed(): string | undefined;
    execution_id(): string;
    index(): number;
    parties(): Uint16Array;
    free?(): void;
}

export type EcdsaJob =
    | {
          kind: "dkg";
          sessionId: string;
          /** Sorted device ids; position = keygen index. */
          participants: string[];
          index: number;
          threshold: number;
          primesJson: string;
      }
    | {
          kind: "sign";
          sessionId: string;
          shareJson: string;
          /** Keygen indices of the signer set (us included). */
          signers: number[];
          path: string;
          prehash: Uint8Array;
      };

/** One payload for the transport: deliver verbatim to each keygen index in `to`. */
export interface Emitted {
    to: number[];
    payload: Uint8Array;
}

export type JobStatus = "aux-info" | "keygen" | "signing";

export class CeremonyJob {
    private current: WasmCeremony | null = null;
    private currentEid = "";
    /** Executions of a later ceremony of this job (keygen during aux info). */
    private later = new Set<string>();
    private stash: [number, Uint8Array][] = [];
    private auxJson: string | null = null;
    private finish: ((out: string) => void) | null = null;
    private fail: ((e: Error) => void) | null = null;
    private done = false;
    readonly result: Promise<string>;

    constructor(
        private readonly wasm: EcdsaWasm,
        private readonly job: EcdsaJob,
        private readonly emit: (m: Emitted) => void,
        private readonly status: (s: JobStatus) => void = () => {},
        private readonly warn: (msg: string) => void = () => {},
    ) {
        this.result = new Promise((resolve, reject) => {
            this.finish = resolve;
            this.fail = reject;
        });
        this.result.catch(() => {}); // observed by callers
    }

    /** Build the first ceremony and send its opening messages. The DKG
     * output is the joined key share JSON; the signing output the hex
     * r ‖ s ‖ v (v = 27 + recovery id). */
    start(): void {
        try {
            if (this.job.kind === "dkg") {
                const j = this.job;
                this.later.add(this.wasm.ecdsa_execution_id(j.sessionId, "keygen", j.participants));
                this.status("aux-info");
                this.install(new this.wasm.EcdsaAuxInfo(j.sessionId, j.participants, j.index, j.primesJson));
            } else {
                const j = this.job;
                this.status("signing");
                this.install(
                    new this.wasm.EcdsaSigning(j.sessionId, j.shareJson, Uint16Array.from(j.signers), j.path, j.prehash),
                );
            }
            this.pump();
        } catch (e) {
            this.abort(e);
        }
    }

    /** A payload from the party with keygen index `from`. */
    receive(from: number, payload: Uint8Array): void {
        if (this.done) return;
        const eid = this.wasm.ecdsa_payload_execution_id(payload);
        if (this.current && eid === this.currentEid) {
            try {
                this.current.receive(from, payload);
            } catch (e) {
                // Invalid input leaves the ceremony unchanged; a missing
                // message ends in the caller's timeout instead.
                this.warn(`ECDSA payload from party ${from} refused: ${errText(e)}`);
                return;
            }
            this.pump();
        } else if (eid && this.later.has(eid)) {
            this.stash.push([from, payload]);
        }
        // Anything else belongs to another execution: dropped.
    }

    private install(c: WasmCeremony): void {
        this.current = c;
        this.currentEid = c.execution_id();
        this.later.delete(this.currentEid);
        const mine = this.stash.filter(([, p]) => this.wasm.ecdsa_payload_execution_id(p) === this.currentEid);
        this.stash = this.stash.filter(([, p]) => this.wasm.ecdsa_payload_execution_id(p) !== this.currentEid);
        for (const [from, p] of mine) {
            try {
                c.receive(from, p);
            } catch (e) {
                this.warn(`ECDSA payload from party ${from} refused: ${errText(e)}`);
            }
        }
    }

    private pump(): void {
        try {
            for (;;) {
                const c = this.current!;
                const out = c.proceed();
                this.flush(c);
                if (out === undefined) return;
                if (this.job.kind === "dkg" && this.auxJson === null) {
                    const j = this.job;
                    this.auxJson = out;
                    c.free?.();
                    this.status("keygen");
                    this.install(new this.wasm.EcdsaKeygen(j.sessionId, j.participants, j.index, j.threshold));
                    continue;
                }
                const result =
                    this.job.kind === "dkg"
                        ? this.wasm.ecdsa_key_share_from_parts(this.job.participants, out, this.auxJson!)
                        : out;
                this.done = true;
                c.free?.();
                this.current = null;
                this.finish?.(result);
                return;
            }
        } catch (e) {
            this.abort(e);
        }
    }

    private flush(c: WasmCeremony): void {
        const me = c.index();
        const parties = [...c.parties()];
        for (const m of c.take_outgoing()) {
            const to = m.recipient === "broadcast" ? parties.filter((p) => p !== me) : [m.recipient];
            this.emit({ to, payload: m.payload });
        }
    }

    private abort(e: unknown): void {
        if (this.done) return;
        this.done = true;
        this.current?.free?.();
        this.current = null;
        this.fail?.(e instanceof Error ? e : new Error(errText(e)));
    }
}

export function errText(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
    return String(e);
}
