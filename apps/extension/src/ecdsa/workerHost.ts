/**
 * The message loop of an ECDSA worker, separate from the Worker global so
 * it is testable; `ceremony.worker.ts` binds it to `self`.
 */
import { CeremonyJob, errText, type EcdsaWasm } from "./driver";
import type { FromWorker, ToWorker } from "./protocol";

export interface HostWasm extends EcdsaWasm {
    ecdsa_generate_safe_prime(): string;
}

/** Returns the handler for messages posted to the worker. */
export function workerHost(wasm: () => Promise<HostWasm>, post: (m: FromWorker) => void): (m: ToWorker) => void {
    let job: CeremonyJob | null = null;
    const early: { from: number; payload: Uint8Array }[] = [];
    let ready: Promise<HostWasm> | null = null;
    const load = () => (ready ??= wasm());

    return (msg: ToWorker) => {
        switch (msg.type) {
            case "prime":
                load()
                    .then((w) => post({ type: "prime", prime: w.ecdsa_generate_safe_prime() }))
                    .catch((e) => post({ type: "error", error: errText(e) }));
                return;
            case "job":
                load()
                    .then((w) => {
                        job = new CeremonyJob(
                            w,
                            msg.job,
                            (m) => post({ type: "outgoing", to: m.to, payload: m.payload }),
                            (status) => post({ type: "status", status }),
                            (message) => post({ type: "warn", message }),
                        );
                        job.result.then(
                            (output) => post({ type: "done", output }),
                            (e) => post({ type: "error", error: errText(e) }),
                        );
                        job.start();
                        for (const p of early.splice(0)) job.receive(p.from, p.payload);
                    })
                    .catch((e) => post({ type: "error", error: errText(e) }));
                return;
            case "payload":
                if (job) job.receive(msg.from, msg.payload);
                else early.push({ from: msg.from, payload: msg.payload });
                return;
        }
    };
}
