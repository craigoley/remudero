// W1-T206 fixture: a standalone OS PROCESS that appends exactly one ledger line, then exits.
//
// Node's fs sync calls make a SINGLE process's own appendLedger calls trivially serialized
// (JS is single-threaded) — that alone proves nothing about cross-process interleaving, which
// is the actual production hazard (multiple `rmd` invocations sharing one ledger file). This
// script is spawned N times CONCURRENTLY (via node:child_process `spawn`, never `spawnSync`)
// by test/ledger-atomic.test.ts to get genuine OS-level concurrency against the same file.
//
// argv: [ledgerPath, workerIndex, payloadSize?]
// payloadSize (optional): pads the line with a `filler` field of that many "x" characters,
// so a single worker can simulate a record large enough to exceed one write(2) syscall.
import { appendLedger } from "../../../src/lib/ledger.js";

const [, , ledgerPath, workerIndex, payloadSizeArg] = process.argv;
if (!ledgerPath || !workerIndex) {
  console.error("usage: append-worker.ts <ledgerPath> <workerIndex> [payloadSize]");
  process.exit(2);
}
const payloadSize = payloadSizeArg ? Number(payloadSizeArg) : 0;

appendLedger(ledgerPath, {
  run_id: `worker-${workerIndex}`,
  task_id: `W1-CONC-${workerIndex}`,
  step: "run.start",
  worker_index: Number(workerIndex),
  ...(payloadSize > 0 ? { filler: "x".repeat(payloadSize) } : {}),
});
