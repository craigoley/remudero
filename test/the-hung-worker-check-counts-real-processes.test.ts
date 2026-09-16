/**
 * `lane-less-workers` — THE ARM WAS WIRED TO A LITERAL ZERO (W1-T3628).
 *
 * WHY THIS FILE EXISTS. `buildDoctorReport` had exactly one call site in src/, and it passed
 * `workerCount: 0`; `oldestWorkerEtimeS` was declared on DoctorInputs, read by the judge, and
 * never assigned anywhere in the tree. So the arm always took `judgeLaneLessWorkers(undefined, 0)`
 * and returned OK, and `HUNG_WORKER_AGE_S` was compared against nothing. During the 2026-09-16
 * outage `rmd doctor` read `[OK] lane-less-workers 0 worker process(es)` on a host holding two
 * `npm ci` stuck 80 and 71 minutes, with load 221 on 8 cores.
 *
 * IT SURVIVED BECAUSE EVERY EXISTING TEST DRIVES THE PURE JUDGE with fabricated counts. The judge
 * was correct and well covered; the one line feeding it was the defect. So the first test here
 * drives `doctorCommand` — the WIRING — rather than the judge, because that is the seam a
 * pure-function test cannot reach.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { doctorCommand } from "../src/lib/report-commands.js";
import {
  HUNG_WORKER_AGE_S,
  matchesWorkerPattern,
  judgeLaneLessWorkers,
  parseEtime,
  parseWorkerProcesses,
  readWorkerProcesses,
} from "../src/lib/doctor.js";

function fakeConfig(root: string): Config {
  return { claudeBin: "/bin/true", root } as Config;
}

/** Every other reader stubbed to an empty, deterministic state so only the worker arm varies. */
async function doctorLine(readWorkers: () => ReturnType<typeof readWorkerProcesses>): Promise<string> {
  const printed: string[] = [];
  await doctorCommand([], {
    out: (l) => printed.push(l),
    loadConfig: () => fakeConfig("/nonexistent/root/for/tests"),
    nowMs: Date.parse("2026-09-16T12:00:00Z"),
    readLedgerLines: () => [],
    loadPlan: () => undefined,
    liveInflightRuns: () => [],
    readLockFiles: () => ({ locks: [] }),
    readMemInfo: () => ({}),
    readDiskFreeBytes: () => undefined,
    readDiskTotalBytes: () => undefined,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
    readCheckoutDepth: () => undefined,
    readNvmrcVersion: () => undefined,
    readWorkerProcesses: readWorkers,
  });
  assert.equal(printed.length, 1, "doctor prints one report");
  // THE CHECK LINE, not the summary. The header ("rmd doctor: FAIL — 1 fail, 7 warn: ...,
  // lane-less-workers, ...") also contains the name but carries the report's WORST verdict, so
  // matching it would assert against a different check's result entirely.
  const line = printed[0]!.split("\n").find((l) => /^\s*\[(OK|WARN|FAIL)\s*\]\s*lane-less-workers\b/.test(l));
  assert.ok(line, `the report must carry a lane-less-workers CHECK line; got:\n${printed[0]}`);
  return line;
}

test("the doctor collects worker processes instead of passing a literal zero", async () => {
  // THE WIRING IS THE SUBJECT. A reading of two workers must REACH the report. Before this task the
  // caller passed 0 and no injected reading could change the printed line at all.
  const twoWorkers = await doctorLine(() => ({ count: 2, oldestEtimeS: 30, processes: [] }));
  assert.match(twoWorkers, /2 worker\(s\)/, "the injected count must reach the printed report");

  // And the discriminating half: a DIFFERENT reading must print a DIFFERENT line, or the arm could
  // still be ignoring its input and merely happen to match above.
  const none = await doctorLine(() => ({ count: 0, processes: [] }));
  assert.match(none, /0 worker process\(es\)/);
  assert.notEqual(twoWorkers, none, "the printed line must vary with the reading — otherwise it is still a constant");
});

test("a worker past the hung-worker age makes lane-less-workers WARN", async () => {
  // The verdict the arm could never reach while its input was a literal zero.
  const old = await doctorLine(() => ({ count: 1, oldestEtimeS: HUNG_WORKER_AGE_S + 60, processes: [] }));
  assert.match(old, /WARN/, "a worker past HUNG_WORKER_AGE_S must WARN");

  const young = await doctorLine(() => ({ count: 1, oldestEtimeS: HUNG_WORKER_AGE_S - 60, processes: [] }));
  assert.match(young, /OK/, "a worker inside the bound must not warn — the threshold must discriminate");

  // Boundary, in both directions, on the pure judge.
  assert.equal(judgeLaneLessWorkers(HUNG_WORKER_AGE_S, 1).verdict, "OK", "exactly at the bound is not past it");
  assert.equal(judgeLaneLessWorkers(HUNG_WORKER_AGE_S + 1, 1).verdict, "WARN");
});

test("an unreadable process table does not read as zero workers", async () => {
  // A FAILED READ MUST NEVER LOOK LIKE A HEALTHY HOST. This is the same discipline
  // judgeCheckoutDepth's "unreadable" arm carries, and the reason the old literal 0 was so
  // dangerous: absence of evidence was printed as evidence of absence.
  const line = await doctorLine(() => ({ unreadableReason: "EACCES" }));
  assert.match(line, /UNKNOWN/, "an unreadable table must say UNKNOWN");
  assert.doesNotMatch(line, /0 worker process\(es\)/, "it must NOT borrow the healthy 'no workers' answer");
  assert.match(line, /WARN/, "and it must not be OK");
});

test("a dispatched worker is counted but an operator's own claude session is not", () => {
  // MEASURED WHILE WRITING THIS: matching `claude` alone returned `oldest 11.5 days` on the
  // developer machine — the editor running the change. The daemon spawns workers with
  // `--output-format stream-json`; an interactive session never does.
  const fleet = parseWorkerProcesses("  4242 900  8884 /usr/local/bin/claude --output-format stream-json --verbose --effort high");
  assert.equal(fleet.count, 1, "a dispatched worker must be counted");
  assert.equal(fleet.oldestEtimeS, 8884);
  // The PID reaches the reading, because the reaper (W1-T3629) must act on the SAME reading the
  // doctor judges rather than shelling out to `ps` a second time and racing it.
  assert.deepEqual(fleet.processes, [
    { pid: 4242, ppid: 900, etimeS: 8884, args: "/usr/local/bin/claude --output-format stream-json --verbose --effort high" },
  ]);

  const interactive = parseWorkerProcesses("  4243 900  999254 /usr/local/bin/claude");
  assert.equal(interactive.count, 0, "an operator's own session is not a hung worker");

  const install = parseWorkerProcesses("  4244 1  4846 npm ci");
  assert.equal(install.count, 1, "the worktree install is the shape that actually wedged");

  // MATCHING IS ANCHORED ON argv[0]'s BASENAME, not a substring of the command line. Both of these
  // were measured as real false positives while writing this, and the second is the dangerous one:
  // for a counter it over-counts, but W1-T3629's reaper sends a SIGNAL, and this shell was the
  // editor making this very change.
  assert.equal(matchesWorkerPattern("/usr/local/bin/claude --output-format stream-json"), true);
  assert.equal(
    matchesWorkerPattern("/bin/zsh -c \"...--output-format stream-json...\""),
    false,
    "a shell whose argv merely CONTAINS the flag is not a worker — signalling it would hit an operator",
  );
  assert.equal(
    matchesWorkerPattern("grep --output-format stream-json src/"),
    false,
    "nor is a grep for the flag",
  );
  assert.equal(matchesWorkerPattern("/usr/local/bin/claude"), false, "nor an interactive session");
});

test("elapsed time parses from both ps dialects, so the arm is not UNKNOWN on every mac", () => {
  // procps (Linux, the fleet) prints `etimes` in seconds; BSD ps (macOS) REJECTS that keyword and
  // prints `etime` as [[DD-]HH:]MM:SS. Reading only one dialect would make this arm permanently
  // UNKNOWN on every developer machine — and a check that always warns is one everyone ignores.
  assert.equal(parseEtime("7260"), 7260);
  assert.equal(parseEtime("01:30"), 90);
  assert.equal(parseEtime("2:03:04"), 7384);
  assert.equal(parseEtime("1-00:00:01"), 86401);
  assert.equal(parseEtime("garbage"), undefined);

  // And the real table on THIS host reads, whichever dialect it speaks.
  const live = readWorkerProcesses();
  assert.ok(!("unreadableReason" in live), `the live process table must be readable here: ${JSON.stringify(live)}`);
});
