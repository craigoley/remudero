// test/orphan-sweep-names-the-third-party.test.ts — W1-T2407: name the competing process
// instead of leaving it to inference.
//
// THE DEFECT (plan/tasks.yaml W1-T2407 rationale). `sweepOrphanWorkers` kills on `readMarkers`
// plus `isRunActive` alone and does not care which fixture spawned the process; `isRunActive`
// consults the CALLER's own inflight directory, so a stray belonging to a DIFFERENT fixture is
// always read as not-active; `defaultListCandidates` walks every pid on the machine. When the
// "W1-T356 wiring" tests in test/daemon.test.ts and test/worker-containment.test.ts fail because
// a third fixture's stray was killed instead of the one under test, the CI log names only a
// vanished pid — never the process that actually died. `withRealSweepLock` (defined once in each
// of those two files) already serialises the two REAL, machine-wide sweeps against each other;
// this file does not touch that lock or widen its scope (design part v/vi: that widening is
// deferred, filed as a follow-up below) — it closes the SEPARATE, in-scope gap: even with the
// lock held, a misattribution killed the WRONG process silently.
//
// THE FIX. `OrphanSweepReport.killed` already carries `cmdline` for every process the sweep
// terminated (design part ii) — `describeOrphanSweepKills` (src/lib/worker-containment.ts) reads
// that list and nothing else: no new `ps`, no new signal, no pacing. Wiring it into the two
// wiring tests' own failure output is a one-line follow-up (see below); what this file proves is
// that the diagnostic itself is correct, pure, and total (including the empty case).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  describeOrphanSweepKills,
  sweepOrphanWorkers,
  type OrphanSweepDeps,
  type OrphanCandidate,
} from "../src/lib/worker-containment.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function fakeDeps(overrides: Partial<OrphanSweepDeps> = {}): OrphanSweepDeps {
  return {
    listCandidates: () => [],
    readMarkers: () => undefined,
    isRunActive: () => false,
    kill: () => {},
    ledger: () => {},
    ...overrides,
  };
}

test("describeOrphanSweepKills names the third party by cmdline, pid, run_id and task_id — not left to inference", () => {
  const candidates: OrphanCandidate[] = [
    { pid: 4242, cmdline: "node other-fixtures-worker.js --marker" },
  ];
  const killCalls: number[] = [];
  const deps = fakeDeps({
    listCandidates: () => candidates,
    readMarkers: (pid) => (pid === 4242 ? { runId: "run-other-fixture", taskId: "T-other" } : undefined),
    isRunActive: () => false, // read (wrongly, from the killer's OWN inflight dir) as ended
    kill: (pid) => killCalls.push(pid),
  });

  const report = sweepOrphanWorkers(deps);
  const table = describeOrphanSweepKills(report);

  assert.deepEqual(killCalls, [4242], "precondition: the third-party stray really was killed");
  assert.match(table, /pid=4242/, "the table names the pid a bare ESRCH assertion would not");
  assert.match(table, /cmdline=node other-fixtures-worker\.js --marker/, "and the command line that identifies WHICH fixture it belonged to");
  assert.match(table, /run_id=run-other-fixture/);
  assert.match(table, /task_id=T-other/);
});

test("describeOrphanSweepKills reads only the report sweepOrphanWorkers already computed — no new fetch, no new signal", () => {
  // Built ENTIRELY BY HAND — no sweepOrphanWorkers call, no listCandidates, no ps, no live
  // process anywhere in this test. If the diagnostic needed anything beyond the report it claims
  // to read, this call would have nothing to read it from.
  const table = describeOrphanSweepKills({
    killed: [{ pid: 1, run_id: "run-x", task_id: "T-x", cmdline: "sleep 300" }],
  });
  assert.match(table, /pid=1/);
  assert.match(table, /sleep 300/);

  // Purity, checked structurally: one parameter (the report), and synchronous — a diagnostic that
  // paced, throttled, or fetched anything would need either more inputs or to return a Promise.
  assert.equal(describeOrphanSweepKills.length, 1, "takes only the report — nothing else to read from");
  const result = describeOrphanSweepKills({ killed: [] });
  assert.equal(typeof result, "string", "synchronous — a string, never a Promise; nothing awaited, nothing paced");
});

test("a sweep that terminated nothing prints an explicit empty table — an absence is distinguishable from an unread diagnostic", () => {
  const empty = describeOrphanSweepKills({ killed: [] });
  assert.notEqual(empty, "", "never silent — '' is indistinguishable from a diagnostic nobody called");
  assert.match(empty, /none/i);
  const nonEmpty = describeOrphanSweepKills({
    killed: [{ pid: 9, run_id: "r", task_id: "t", cmdline: "x" }],
  });
  assert.notEqual(empty, nonEmpty, "the empty case reads differently from a real kill, not just a shorter version of it");
});

test("attribution still precedes every signal: an unattributable process is reported, never killed, and never named in the kills table", () => {
  const candidates: OrphanCandidate[] = [
    { pid: 7777, cmdline: "some-unmarked-process --do-things" },
  ];
  const killCalls: number[] = [];
  const deps = fakeDeps({
    listCandidates: () => candidates,
    readMarkers: () => undefined, // never guesses — undefined means "never signalled"
    kill: (pid) => killCalls.push(pid),
  });

  const report = sweepOrphanWorkers(deps);
  assert.deepEqual(killCalls, [], "an unattributable process must never be signalled, no matter how suspicious it looks");
  assert.deepEqual(report.killed, []);
  assert.equal(report.leftAlone.length, 1);
  assert.equal(report.leftAlone[0]!.reason, "unattributable");
  const table = describeOrphanSweepKills(report);
  assert.doesNotMatch(table, /7777/, "an unattributable process is never named in the KILLS table — it was never killed");
});

test("nothing added paces, throttles, or sleeps a call — describeOrphanSweepKills's own source carries no setTimeout/await", () => {
  const src = readFileSync(join(TEST_DIR, "..", "src", "lib", "worker-containment.ts"), "utf8");
  const start = src.indexOf("export function describeOrphanSweepKills");
  assert.ok(start >= 0, "precondition: the function exists in the module this test names");
  const end = src.indexOf("\nexport function", start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);
  assert.doesNotMatch(body, /setTimeout|await |sleep\(/, "a diagnostic must read, never wait");
});

// ── W1-T2407 acceptance: "checked rather than listed" ──────────────────────────────────────
//
// The rationale that motivated this task HAND-LISTED four fixtures that spawn a marked process
// without holding `withRealSweepLock` (a real, separately-scoped gap this task does not close —
// see the follow-up filed alongside this suite). What THIS task's own two fixtures claim is
// narrower and is checked here by reading test/ itself, not by trusting a comment: every fixture
// that spawns a stray attributed to an ENDED run specifically so a REAL, machine-wide
// `daemonCommand` sweep can kill it (the shape the two-file lock exists to serialise) is exactly
// the set of fixtures that define `withRealSweepLock`. A hand-authored list can silently drift
// (a third such fixture added tomorrow, forgetting the lock, reintroduces W1-T2350's flake); a
// computed one cannot.
test("every fixture that spawns an ended-run stray into a real machine-wide sweep is exactly the set that holds withRealSweepLock — computed, not hand-listed", () => {
  const SELF = "orphan-sweep-names-the-third-party.test.ts"; // excluded: this file's OWN prose
  // names `withRealSweepLock` repeatedly while explaining the check below, which would otherwise
  // self-match the very pattern it is computing — this file spawns nothing and holds no lock.
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts") && f !== SELF);
  assert.ok(files.length > 10, "precondition: this really scanned the test directory, not an empty one");

  const spawnsEndedRunStrayIntoRealSweep = new Set<string>();
  const holdsTheRealSweepLock = new Set<string>();
  for (const file of files) {
    const src = readFileSync(join(TEST_DIR, file), "utf8");
    if (/\[RUN_ID_ENV\]:\s*"run-ended/.test(src)) spawnsEndedRunStrayIntoRealSweep.add(file);
    if (/withRealSweepLock/.test(src)) holdsTheRealSweepLock.add(file);
  }

  const sortedSpawners = [...spawnsEndedRunStrayIntoRealSweep].sort();
  const sortedHolders = [...holdsTheRealSweepLock].sort();
  assert.ok(sortedSpawners.length > 0, "precondition: at least one fixture matches — the pattern is not vacuous");
  assert.deepEqual(
    sortedSpawners,
    sortedHolders,
    "a fixture that spawns an ended-run stray for a real sweep to kill must hold the same lock every such fixture holds",
  );
});
