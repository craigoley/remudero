// scripts/pool-run-marker.mjs — a preload (`--import`) that records, synchronously, every test as it
// starts, so a judged test run that dies part-way still names where it was.
//
// WHY SYNCHRONOUS: a test that calls the real `process.exit(0)` inside the shared pool process ends
// it on the spot. A reporter consumes its events asynchronously, so the events of the last few tests
// are still queued when the process goes and are never seen (2026-10-11: shard 1's pool stopped after
// `resolveCommitsBehind: ... rev-list --count test-sha..HEAD` with no summary and exit 0). One
// `writeSync` per test start survives that exit.
//
// THE EXIT CALL SITE TOO: serve's stale-code exit fires after its test has PASSED, from a drain that
// settles a few tests later, so the last test started is a bystander. The real `process.exit` is
// wrapped to write its own stack (and the file of the last test this process started) first, then
// called unchanged: this preload records, it never decides.
//
// `t.filePath` is the test FILE that created the test, even when a helper module calls `test()` on its
// behalf, which is what lets scripts/pure-test-pool.mjs count the files that reported. Inert unless
// the env var names a marker file, so loading it outside a judged run changes nothing.
//
// WHICH PROCESSES RECORD: the one that runs tests — a pool (`--experimental-test-isolation=none`) or
// one file's own child of an isolated run. An isolated run's PARENT runs no test and must keep the
// env var for the children it spawns, so it records nothing. A recording process then DELETES the
// env var: a test that spawns node again (with `process.execArgv`, which carries this preload) must
// not have its child record into this run's marker, and a non-test child that registered a hook would
// print a test summary into the output its test reads.

import { openSync, writeSync } from "node:fs";
import { beforeEach } from "node:test";
import { isMainThread } from "node:worker_threads";
import { POOL_RUN_MARKER_ENV } from "./pure-test-pool.mjs";

// The env var names the file this preload appends `start\t<file>\t<test>` and
// `exit\t<code>\t<stack>\t<file of the last test started>` lines to.

const isolatedRunnerParent =
  process.execArgv.includes("--test") && !process.execArgv.some((arg) => /^--(?:experimental-)?test-isolation=none$/.test(arg));

// The main thread only: `--import` also loads in every worker thread a test starts, and a worker's
// `process.exit` ends that worker, not the run.
const markerPath = isMainThread && !isolatedRunnerParent ? process.env[POOL_RUN_MARKER_ENV] : undefined;
if (markerPath) {
  delete process.env[POOL_RUN_MARKER_ENV];
  const fd = openSync(markerPath, "a");
  let lastFile = "";
  beforeEach((t) => {
    const name = String(t.fullName ?? t.name ?? "").replace(/[\t\r\n]+/g, " ");
    lastFile = String(t.filePath ?? "").replace(/[\t\r\n]+/g, " ");
    writeSync(fd, `start\t${lastFile}\t${name}\n`);
  });
  const realExit = process.exit;
  process.exit = function exitRecorded(code) {
    const frames = (new Error().stack ?? "").split("\n").slice(2, 10).map((frame) => frame.trim().replace(/^at /, ""));
    try {
      writeSync(fd, `exit\t${code ?? process.exitCode ?? 0}\t${frames.join(" <- ").replace(/[\t\r\n]+/g, " ")}\t${lastFile}\n`);
    } catch {
      // Recording is best-effort; the exit itself must still happen.
    }
    return realExit.call(process, code);
  };
}
