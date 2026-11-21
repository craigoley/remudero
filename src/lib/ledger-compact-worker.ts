/**
 * W1-T13333 — THE DAEMON'S LEDGER COMPACTION PASS RUNS HERE, IN A WORKER THREAD, NEVER ON THE DAEMON LOOP.
 * A pass reads and writes archives with synchronous zlib. The daemon sends the arguments and awaits the exit
 * code and the lines. A worker that fails rejects with its cause, so it never reads as a completed pass.
 */
import { SHARE_ENV, isMainThread, parentPort, workerData } from "node:worker_threads";
import { startWorker } from "./child-entry-argv.js";
import { threadName } from "./thread-names.js";
import { ledgerCompactCommand, takeCompactionRotationLock } from "./ledger-compact.js";

const KIND = "remudero-ledger-compact";

/** What ledgerCompactCommand gave: its exit code, its last report line and its error lines. */
export interface LedgerCompactPassResult { code: number; report?: string; errors: string[] }
type WorkerInput = { kind: typeof KIND; rest: string[]; stateDir: string; rotationLockHeld: boolean };
/** `started` comes before the pass, so startWorker never takes a pass that ended early for a bundle that cannot load. */
type WorkerMessage = { kind: "started" } | ({ kind: "result" } & LedgerCompactPassResult);

/** One thread per pass, which exits when it has reported. A worker that throws or exits with no report rejects. A pass has no time bound. */
export function compactLedgerInWorker(
  rest: string[],
  stateDir: string,
  options: { workerUrl?: URL } = {},
): Promise<LedgerCompactPassResult> {
  // W1-T13859: this thread holds the rotation lock for the pass and frees it when the pass reports or the worker
  // exits, however it exits. A lock taken inside the worker would stay held under this live pid if it were ended.
  const lock = rest.includes("--dry-run") ? undefined : takeCompactionRotationLock(stateDir);
  if (lock && "refused" in lock) return Promise.resolve({ code: 1, errors: [lock.refused] });
  // Freed once: at the report, after the pass's last file operation, or at an exit with no report.
  let held = lock;
  const free = (): void => {
    const owned = held;
    held = undefined;
    owned?.release();
  };
  return new Promise((resolve, reject) => {
    let thread: ReturnType<typeof startWorker>;
    try {
      const input: WorkerInput = { kind: KIND, rest, stateDir, rotationLockHeld: lock !== undefined };
      thread = startWorker(import.meta.url, { name: threadName("ledgerCompact"), workerData: input, env: SHARE_ENV }, { override: options.workerUrl });
    } catch (error) {
      free();
      // A start that throws rejects this promise with its cause.
      throw error;
    }
    let crash: Error | undefined;
    // Every later settle is a no-op: the first report or exit decides.
    thread.on("message", (message: WorkerMessage) => {
      if (message.kind !== "result") return;
      free();
      resolve({ code: message.code, report: message.report, errors: message.errors });
    });
    // 'exit' follows 'error': a throw rejects with the error the pass threw, as the in-process path does.
    thread.on("error", (error) => void (crash = error));
    thread.on("exit", (code) => {
      free();
      reject(crash ?? new Error(`the ledger compaction worker exited with code ${code} before it reported`));
    });
  });
}

if (!isMainThread && (workerData as { kind?: string } | undefined)?.kind === KIND && parentPort) {
  const { rest, stateDir, rotationLockHeld } = workerData as WorkerInput;
  parentPort.postMessage({ kind: "started" } satisfies WorkerMessage);
  let report: string | undefined;
  const errors: string[] = [];
  const code = ledgerCompactCommand(rest, { stateDir, rotationLockHeld, out: (line) => void (report = line), error: (line) => void errors.push(line) });
  parentPort.postMessage({ kind: "result", code, report, errors } satisfies WorkerMessage);
}
