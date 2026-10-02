/**
 * Messages between the offscreen document and an ECDSA Web Worker
 * (`ceremony.worker.ts`). One worker runs one job — a safe prime, a DKG
 * (aux info + keygen) or a signing — and is terminated afterwards.
 */
import type { EcdsaJob, JobStatus } from "./driver";

export type ToWorker =
    | { type: "prime" }
    | { type: "job"; job: EcdsaJob }
    /** A payload from the party with keygen index `from`. */
    | { type: "payload"; from: number; payload: Uint8Array };

export type FromWorker =
    | { type: "prime"; prime: string }
    | { type: "outgoing"; to: number[]; payload: Uint8Array }
    | { type: "status"; status: JobStatus }
    | { type: "warn"; message: string }
    | { type: "done"; output: string }
    | { type: "error"; error: string };

/** What the offscreen side needs from a worker (a real `Worker`, or an
 * in-process stand-in in tests). */
export interface WorkerLike {
    postMessage(msg: ToWorker): void;
    onmessage: ((ev: { data: FromWorker }) => void) | null;
    terminate(): void;
}
