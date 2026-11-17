/**
 * W1-T13333 — THE DAEMON'S LEDGER COMPACTION PASS RUNS HERE, IN A WORKER THREAD, NEVER ON THE DAEMON LOOP.
 * A pass reads and writes archives with synchronous zlib. The daemon sends the arguments and awaits the exit
 * code and the lines. A worker that fails rejects with its cause, so it never reads as a completed pass.
 */
import { SHARE_ENV, isMainThread, parentPort, workerData } from "node:worker_threads";
import { startWorker } from "./child-entry-argv.js";
import { ledgerCompactCommand } from "./ledger-compact.js";

const KIND = "remudero-ledger-compact";
/** BACKSTOP: the longest one pass may take. The longest in-place pass measured on 2026-11-17 was 173.2 s. */
const LEDGER_COMPACT_WORKER_BOUND_MS = 900_000;

/** What ledgerCompactCommand gave: its exit code, its last report line and its error lines. */
export interface LedgerCompactPassResult { code: number; report?: string; errors: string[] }
type WorkerInput = { kind: typeof KIND; rest: string[]; stateDir: string };
/** `started` comes before the pass, so startWorker never takes a pass stopped at its bound for a bundle that cannot load. */
type WorkerMessage = { kind: "started" } | ({ kind: "result" } & LedgerCompactPassResult);

/** One thread per pass, which exits when it has reported. A worker that throws, exits with no report or passes its bound rejects. */
export function compactLedgerInWorker(
  rest: string[],
  stateDir: string,
  options: { workerUrl?: URL; boundMs?: number } = {},
): Promise<LedgerCompactPassResult> {
  const boundMs = options.boundMs ?? LEDGER_COMPACT_WORKER_BOUND_MS;
  return new Promise((resolve, reject) => {
    // A start that throws rejects this promise with its cause.
    const thread = startWorker(import.meta.url, { workerData: { kind: KIND, rest, stateDir } satisfies WorkerInput, env: SHARE_ENV }, { override: options.workerUrl });
    let crash: Error | undefined;
    // Every later settle is a no-op: the first report, exit or bound decides.
    const timer = setTimeout(() => {
      reject(new Error(`the ledger compaction worker passed its ${boundMs} ms bound`));
      void thread.terminate();
    }, boundMs);
    thread.on("message", (message: WorkerMessage) => {
      if (message.kind === "result") resolve({ code: message.code, report: message.report, errors: message.errors });
    });
    // 'exit' follows 'error': a throw rejects with the error the pass threw, as the in-process path does.
    thread.on("error", (error) => void (crash = error));
    thread.on("exit", (code) => {
      clearTimeout(timer);
      reject(crash ?? new Error(`the ledger compaction worker exited with code ${code} before it reported`));
    });
  });
}

if (!isMainThread && (workerData as { kind?: string } | undefined)?.kind === KIND && parentPort) {
  const { rest, stateDir } = workerData as WorkerInput;
  parentPort.postMessage({ kind: "started" } satisfies WorkerMessage);
  let report: string | undefined;
  const errors: string[] = [];
  const code = ledgerCompactCommand(rest, { stateDir, out: (line) => void (report = line), error: (line) => void errors.push(line) });
  parentPort.postMessage({ kind: "result", code, report, errors } satisfies WorkerMessage);
}
