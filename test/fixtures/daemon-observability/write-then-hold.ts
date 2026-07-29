// W1-T143 fixture: a standalone OS PROCESS that writes ONE marker line to fd 1 via
// `writeSyncLine` (the synchronous, non-TTY-safe writer run-task.ts now uses for the
// daemon's operator narration), then holds itself alive with a BLOCKING busy-wait (never
// yielding the event loop) for `holdMs` before exiting cleanly.
//
// Spawned by test/daemon-observability.test.ts with its stdout redirected to a real FILE
// (an fd opened via fs.openSync, the same shape launchd's StandardOutPath gives the daemon
// process) — never a pipe back to the test process — so the parent can read that file
// directly, independent of the child, WHILE the child is still confirmed alive (blocked in
// the busy-wait, `child.exitCode === null`). The busy-wait is what makes "before it exits"
// a real assertion rather than a race: nothing about this fixture can flush ANYTHING after
// the marker write except by the write itself already having completed synchronously.
//
// argv: [holdMs]
import { writeSyncLine } from "../../../src/run-task.js";

const holdMs = Number(process.argv[2] ?? "300");

writeSyncLine(1, "W1-T143-MARKER-LINE");

// A deliberately CPU-bound, blocking hold — Atomics.wait on a throwaway buffer, which
// blocks the JS thread (and therefore the event loop) for the full duration. No timer, no
// promise, no I/O callback can run during this window.
const sab = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(sab, 0, 0, holdMs);

process.exit(0);
