/**
 * Paillier safe primes for the ECDSA aux-info ceremony (offscreen side).
 *
 * A set is four safe primes; each takes minutes in wasm, so the pool runs
 * the four in parallel Web Workers and reports progress per finished prime
 * (0 / 25 / 50 / 75 / 100 % — real work done, never a guess). A DKG takes
 * the ready set (waiting if needed) and the pool starts on the next one.
 *
 * The background persists a finished set encrypted with the keystore
 * password (`background/ecdsaPrimes.ts`) and hands it back via `load`
 * after a restart; the pool keeps primes in memory only.
 */
import type { FromWorker, WorkerLike } from "./protocol";

export const PRIME_COUNT = 4;

export interface PrimeProgress {
    state: "idle" | "generating" | "ready";
    /** Primes of the current set finished (0..PRIME_COUNT). */
    done: number;
    total: number;
}

export interface PrimePoolIO {
    spawnWorker(): WorkerLike;
    /** Join prime JSONs into a primes set JSON (`ecdsa_primes_from_parts`). */
    join(parts: string[]): string;
    onProgress(p: PrimeProgress): void;
    /** A freshly generated set (the background encrypts + caches it). */
    onReady(primesJson: string): void;
    log(message: string): void;
}

export class PrimePool {
    private ready: string | null = null;
    private fixed: string | null = null;
    private workers: WorkerLike[] = [];
    private parts: string[] = [];
    private waiters: ((primes: string) => void)[] = [];

    constructor(private readonly io: PrimePoolIO) {}

    progress(): PrimeProgress {
        if (this.fixed || this.ready) return { state: "ready", done: PRIME_COUNT, total: PRIME_COUNT };
        if (this.workers.length > 0) return { state: "generating", done: this.parts.length, total: PRIME_COUNT };
        return { state: "idle", done: 0, total: PRIME_COUNT };
    }

    isReady(): boolean {
        return this.fixed !== null || this.ready !== null;
    }

    /** Start generating unless a set is ready or being generated. */
    ensure(): void {
        if (this.isReady() || this.workers.length > 0) return;
        this.parts = [];
        const started = Date.now();
        this.io.log(`ECDSA: generating ${PRIME_COUNT} Paillier safe primes in parallel workers`);
        for (let i = 0; i < PRIME_COUNT; i++) {
            const w = this.io.spawnWorker();
            w.onmessage = (ev: { data: FromWorker }) => {
                const m = ev.data;
                if (m.type === "prime") {
                    w.terminate();
                    this.workers = this.workers.filter((x) => x !== w);
                    this.parts.push(m.prime);
                    this.io.log(
                        `ECDSA: safe prime ${this.parts.length}/${PRIME_COUNT} after ${Math.round((Date.now() - started) / 1000)}s`,
                    );
                    if (this.parts.length === PRIME_COUNT) this.complete();
                    else this.io.onProgress(this.progress());
                } else if (m.type === "error") {
                    this.io.log(`ECDSA: prime worker failed: ${m.error}`);
                    this.abort();
                }
            };
            this.workers.push(w);
            w.postMessage({ type: "prime" });
        }
        this.io.onProgress(this.progress());
    }

    /** A set persisted earlier (decrypted by the background). */
    load(primesJson: string): void {
        if (this.isReady()) return;
        this.stopWorkers();
        this.ready = primesJson;
        this.io.onProgress(this.progress());
        this.flushWaiters();
    }

    /** INSECURE, TESTS ONLY: hand out these primes to every DKG, forever. */
    setInsecureTestPrimes(primesJson: string): void {
        this.io.log("ECDSA: using INSECURE fixed test primes — never use this wallet for real funds");
        this.stopWorkers();
        this.fixed = primesJson;
        this.io.onProgress(this.progress());
        this.flushWaiters();
    }

    /** Take one set for a DKG (waits for the generator), then start the next. */
    take(): Promise<string> {
        if (this.fixed) return Promise.resolve(this.fixed);
        if (this.ready) {
            const p = this.ready;
            this.ready = null;
            this.ensure();
            return Promise.resolve(p);
        }
        this.ensure();
        return new Promise((resolve) => this.waiters.push(resolve));
    }

    private complete(): void {
        let joined: string;
        try {
            joined = this.io.join(this.parts);
        } catch (e) {
            this.io.log(`ECDSA: joining safe primes failed: ${(e as Error).message ?? e}`);
            this.abort();
            return;
        }
        this.parts = [];
        this.ready = joined;
        this.io.onReady(joined);
        this.io.onProgress(this.progress());
        this.flushWaiters();
    }

    private flushWaiters(): void {
        while (this.waiters.length > 0 && this.isReady()) {
            const resolve = this.waiters.shift()!;
            if (this.fixed) {
                resolve(this.fixed);
                continue;
            }
            const p = this.ready!;
            this.ready = null;
            resolve(p);
            this.ensure();
        }
    }

    private stopWorkers(): void {
        for (const w of this.workers) w.terminate();
        this.workers = [];
        this.parts = [];
    }

    /** A worker failed: drop this attempt; retry if a DKG is waiting. */
    private abort(): void {
        this.stopWorkers();
        if (this.waiters.length > 0) this.ensure();
        else this.io.onProgress(this.progress());
    }
}
