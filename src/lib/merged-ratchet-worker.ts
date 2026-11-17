/**
 * W1-T13326 — THE MERGE-TIME RATCHET JUDGE COUNTS HERE, IN A WORKER THREAD, NEVER ON THE DAEMON LOOP.
 * The affected-reach gate builds the import graph of the whole merged tree. The caller sends the read
 * inputs as plain data and awaits the verdict. A count that fails is unread, never clean.
 */
import { threadName } from "./thread-names.js";
import { SHARE_ENV, isMainThread, parentPort, workerData, type Worker } from "node:worker_threads";
import { startWorker } from "./child-entry-argv.js";
import { judgeMergedRatchets, mergedRatchetReaders, type MergedRatchetBlobs, type MergedRatchetInputs, type MergedRatchetJudgement } from "./merged-ratchet-verdict.js";

const KIND = "remudero-merged-ratchet-judge";
/** BACKSTOP: the longest one count may take. The largest in-place judgement measured on 2026-11-17 was 23.9 s. */
const MERGED_RATCHET_JUDGE_BOUND_MS = 120_000;

type PlainInputs = Omit<Extract<MergedRatchetInputs, { changed: string[] }>, "readMerged" | "readMain"> & { blobs: MergedRatchetBlobs };
type WorkerInput = { kind: typeof KIND; input: PlainInputs };
/** `started` comes before the count, so startWorker never takes a count stopped at its bound for a bundle that cannot load. */
type WorkerMessage = { kind: "started" } | { kind: "judgement"; judgement: MergedRatchetJudgement };

/** One thread per judgement, which exits when it has answered. A worker that throws, exits with no answer or passes its bound reads as unread. */
export function judgeMergedRatchetsInWorker(
  input: MergedRatchetInputs,
  options: { workerUrl?: URL; boundMs?: number } = {},
): Promise<MergedRatchetJudgement> {
  // An error or an up-to-date head counts nothing: judged in place.
  if (!("changed" in input)) return Promise.resolve(judgeMergedRatchets(input));
  const unread = (cause: string): MergedRatchetJudgement => judgeMergedRatchets({ error: cause, mainSha: input.mainSha, headSha: input.headSha });
  const { readMerged: _readMerged, readMain: _readMain, blobs, ...rest } = input;
  if (blobs === undefined) return Promise.resolve(unread("the read inputs carry no plain data to send the ratchet worker"));
  const boundMs = options.boundMs ?? MERGED_RATCHET_JUDGE_BOUND_MS;
  return new Promise((resolve) => {
    let thread: Worker;
    try {
      thread = startWorker(import.meta.url, { name: threadName("mergedRatchet"), workerData: { kind: KIND, input: { ...rest, blobs } } satisfies WorkerInput, env: SHARE_ENV }, { override: options.workerUrl });
    } catch (error) {
      // the start failure is the reading: unread with its cause.
      resolve(unread(`the ratchet worker could not start: ${String((error as Error)?.message ?? error)}`));
      return;
    }
    let crash = "";
    // Every later call is a no-op: the first answer, exit or bound decides.
    const answer = (judgement: MergedRatchetJudgement): void => {
      clearTimeout(timer);
      resolve(judgement);
    };
    const timer = setTimeout(() => {
      answer(unread(`the ratchet worker passed its ${boundMs} ms bound`));
      void thread.terminate();
    }, boundMs);
    thread.on("message", (message: WorkerMessage) => {
      if (message.kind === "judgement") answer(message.judgement);
    });
    // 'exit' follows 'error' and names the crash.
    thread.on("error", (error) => void (crash = `: ${error.message}`));
    thread.on("exit", (code) => answer(unread(`the ratchet worker exited with code ${code} before it answered${crash}`)));
  });
}

if (!isMainThread && (workerData as { kind?: string } | undefined)?.kind === KIND && parentPort) {
  const { input } = workerData as WorkerInput;
  parentPort.postMessage({ kind: "started" } satisfies WorkerMessage);
  parentPort.postMessage({ kind: "judgement", judgement: judgeMergedRatchets({ ...input, ...mergedRatchetReaders(input.blobs) }) } satisfies WorkerMessage);
}
