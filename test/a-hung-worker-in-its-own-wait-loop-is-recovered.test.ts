// W1-T7807: W1-T7734's implement worker polled `until grep -q "^ℹ duration_ms" <out>; do sleep 15; done` for a reporter
// line its finished test output never printed, sat quiet ~55 min and held a restart. These tests replay that shape: a
// fixture output file ending `tests 179 / pass 179 / fail 0` and `[exited with code 0]`, a leaf `sleep 15` under the
// `until grep ...` shell, and the worker quiet past its bound.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IMPLEMENT_WAIT_TARGET_CONTRACT } from "../src/run-task.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import {
  classifyProcessTree,
  deriveQuietBound,
  parseQuietJudgement,
  QUIET_BASIS_LEDGER_STEP,
  QUIET_JUDGED_LEDGER_STEP,
  runQuietWorkerWatchdog,
  type AwaitedRead,
  type ProcRow,
  type QuietEvidence,
  type QuietJudgement,
} from "../src/lib/quiet-worker-watchdog.js";

const FINISHED_OUTPUT = [
  "✔ some test (1.2ms)",
  "ℹ tests 179",
  "ℹ suites 0",
  "ℹ pass 179",
  "ℹ fail 0",
  "[exited with code 0]",
  "",
].join("\n");

const ROOT = 100;
const POLL = 102;

/** The 10-10 process tree: the worker root, a bwrap wrapper carrying the same command text, the `until grep` shell, and its
 * `sleep 15` leaf. */
function tree(outputPath: string, cpu: { root?: number; leaf?: number } = {}): ProcRow[] {
  const loop = `until grep -q "^ℹ duration_ms" ${outputPath}; do sleep 15; done`;
  return [
    { pid: 1, ppid: 0, cpuMs: 0, args: "/sbin/init" },
    { pid: ROOT, ppid: 1, cpuMs: cpu.root ?? 5000, args: "claude --output-format stream-json" },
    { pid: 101, ppid: ROOT, cpuMs: 0, args: `bwrap --unshare-all /bin/bash -c ${loop}` },
    { pid: POLL, ppid: 101, cpuMs: 10, args: `/bin/bash -c ${loop}` },
    { pid: 103, ppid: POLL, cpuMs: cpu.leaf ?? 0, args: "sleep 15" },
  ];
}

async function withOutputFile<T>(content: string, run: (path: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "rmd-quiet-watchdog-"));
  try {
    const path = join(dir, "task.output");
    writeFileSync(path, content);
    return await run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A ledger history: one run per entry, with a `worker.assignment` for `provider` and quiet episodes of `gapsMs`. */
function history(provider: string, gapsMs: number[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let t = Date.parse("2026-10-01T00:00:00Z");
  gapsMs.forEach((gap, index) => {
    const runId = `R${provider}${index}`;
    rows.push({ ts: new Date(t).toISOString(), run_id: runId, step: "worker.assignment", worker_assignment: { selected: { provider } } });
    rows.push({ ts: new Date(t + 1000).toISOString(), run_id: runId, step: "worker.state", state: "working" });
    rows.push({ ts: new Date(t + 2000).toISOString(), run_id: runId, step: "worker.state", state: "quiet" });
    rows.push({ ts: new Date(t + 2000 + gap).toISOString(), run_id: runId, step: "worker.state", state: "working" });
    t += 3_600_000;
  });
  return rows;
}

const FALLBACK_MS = 3_600_000;

test("W1-T7807: the quiet bound follows the provider observed quiet gaps", () => {
  const fast = deriveQuietBound(history("claude", [40_000, 50_000, 60_000, 70_000, 80_000]), "claude", FALLBACK_MS);
  const slow = deriveQuietBound(history("claude", [400_000, 500_000, 600_000, 700_000, 800_000]), "claude", FALLBACK_MS);
  assert.equal(fast.source, "observed_quiet_gaps");
  assert.equal(fast.samples, 5);
  assert.equal(fast.boundMs, 80_000);
  assert.equal(slow.boundMs, 800_000);
  assert.notEqual(fast.boundMs, slow.boundMs, "two histories give two bounds");

  // Another provider's gaps never move this provider's bound.
  const mixed = [...history("claude", [60_000, 60_000]), ...history("codex", [900_000])];
  assert.equal(deriveQuietBound(mixed, "claude", FALLBACK_MS).boundMs, 60_000);
  assert.equal(deriveQuietBound(mixed, "codex", FALLBACK_MS).boundMs, 900_000);

  // No history: the policy row, and the source says so.
  const none = deriveQuietBound(history("claude", [60_000]), "codex", FALLBACK_MS);
  assert.deepEqual(
    { boundMs: none.boundMs, source: none.source, samples: none.samples },
    { boundMs: FALLBACK_MS, source: "no_history_fallback", samples: 0 },
  );

  // An episode still open (the worker never spoke again) is not a gap, and history never lifts the bound past the policy row.
  const open = [...history("claude", []), { ts: "2026-10-02T00:00:00Z", run_id: "RX", step: "worker.state", state: "quiet" }];
  assert.equal(deriveQuietBound(open, "claude", FALLBACK_MS).source, "no_history_fallback");
  assert.equal(deriveQuietBound(history("claude", [9_000_000]), "claude", FALLBACK_MS).boundMs, FALLBACK_MS);
});

test("W1-T7807: a poll loop waiting on a finished file is a dead wait", async () => {
  await withOutputFile(FINISHED_OUTPUT, (path) => {
    // One read is enough when the awaited file already shows a finished run that never printed the awaited line.
    const finished = classifyProcessTree(ROOT, tree(path), undefined);
    assert.equal(finished.kind, "dead_wait");
    assert.ok(finished.kind === "dead_wait");
    assert.equal(finished.basis, "finished_run");
    assert.equal(finished.pollPid, POLL, "the deepest poll shell, not the bwrap wrapper carrying the same text");
    assert.equal(finished.awaitedPath, path);
    assert.equal(finished.awaitedPattern, "^ℹ duration_ms");
    assert.equal(finished.awaitedPatternPresent, false);
    assert.equal(finished.exitMarker, "[exited with code 0]");
    assert.match(finished.runnerSummary ?? "", /tests 179 \/ pass 179 \/ fail 0/);
  });

  // A progressing process is NOT a dead wait: the awaited file grows between two reads.
  const reads: AwaitedRead[] = [
    { signature: "100:1", tail: "running...\n" },
    { signature: "180:2", tail: "running...\nmore output\n" },
  ];
  let n = 0;
  const growing = (): AwaitedRead => reads[Math.min(n++, reads.length - 1)];
  const first = classifyProcessTree(ROOT, tree("/x/out"), undefined, growing);
  assert.equal(first.kind, "first_read", "an unfinished run on a first read is not judged");
  const second = classifyProcessTree(ROOT, tree("/x/out"), first.sample, growing);
  assert.equal(second.kind, "progressing");

  // An unfinished file that did not change across two reads IS a dead wait (no progress).
  const frozen = (): AwaitedRead => ({ signature: "100:1", tail: "running...\n" });
  const f1 = classifyProcessTree(ROOT, tree("/x/out"), undefined, frozen);
  const f2 = classifyProcessTree(ROOT, tree("/x/out"), f1.sample, frozen);
  assert.ok(f2.kind === "dead_wait");
  assert.equal(f2.basis, "no_progress");

  // Another process in the tree gaining CPU time is progress, even with the awaited file frozen.
  const busy = classifyProcessTree(ROOT, [...tree("/x/out"), { pid: 200, ppid: ROOT, cpuMs: 9000, args: "node --test" }], {
    ...f1.sample, cpuByPid: { ...f1.sample.cpuByPid, 200: 1000 },
  }, frozen);
  assert.equal(busy.kind, "progressing");

  // No poll loop at all: never a dead wait.
  const noLoop = classifyProcessTree(ROOT, [
    { pid: ROOT, ppid: 1, cpuMs: 1, args: "claude" },
    { pid: 300, ppid: ROOT, cpuMs: 50, args: "node --test test/x.test.ts" },
  ], undefined);
  assert.notEqual(noLoop.kind, "dead_wait");
});

interface Rig {
  rows: Array<{ step: string; extra: Record<string, unknown> }>;
  kills: Array<[number, string]>;
  nudges: string[];
  judged: QuietEvidence[];
  clock: { ms: number };
  dog: ReturnType<typeof runQuietWorkerWatchdog>;
}

/** The watchdog on a fake clock: quiet floor 30 s, bound 60 s (from the history), the 10-10 tree. */
function rig(path: string, judge: (e: QuietEvidence) => Promise<QuietJudgement | undefined>, extra: { nudge?: boolean } = {}): Rig {
  const clock = { ms: 0 };
  const rows: Rig["rows"] = [];
  const kills: Rig["kills"] = [];
  const nudges: string[] = [];
  const judged: QuietEvidence[] = [];
  const dog = runQuietWorkerWatchdog({
    taskId: "W1-T7734",
    runId: "W1-T7734-1791660796008",
    rootPid: () => ROOT,
    provider: () => "claude",
    history: () => history("claude", [40_000, 50_000, 60_000]),
    fallbackBoundMs: FALLBACK_MS,
    quietFloorMs: 30_000,
    clock: clockFromMillisFn(() => clock.ms),
    ledger: (step, fields) => rows.push({ step, extra: fields }),
    judge: async (evidence) => {
      judged.push(evidence);
      return judge(evidence);
    },
    listProcesses: () => tree(path),
    kill: (pid, signal) => kills.push([pid, signal]),
    ...(extra.nudge ? { nudge: (message: string) => { nudges.push(message); return "delivered" as const; } } : {}),
  });
  return { rows, kills, nudges, judged, clock, dog };
}

test("W1-T7807: the judge kill verdict signals only the poll child", async () => {
  await withOutputFile(FINISHED_OUTPUT, async (path) => {
    const r = rig(path, async () => ({ verdict: "kill_poll_child", reason: "the run finished; the awaited line cannot appear" }));
    r.dog.observer({ kind: "working", tsMs: 0 });
    r.clock.ms = 60_000; // quiet 30 s past the floor: under the 60 s bound
    await r.dog.tick();
    assert.deepEqual(r.kills, [], "nothing is signalled before the bound");
    assert.equal(r.judged.length, 0);

    r.clock.ms = 100_000; // 70 s of quiet: past the bound
    await r.dog.tick();
    assert.equal(r.judged.length, 1);
    assert.deepEqual(r.kills, [[POLL, "SIGTERM"]], "exactly the poll shell, never the worker root, the wrapper or the sleep");
    const row = r.rows.find((x) => x.step === QUIET_JUDGED_LEDGER_STEP);
    assert.equal(row?.extra.verdict, "kill_poll_child");
    assert.equal(row?.extra.signalled_pid, POLL);

    // The worker resumes with the tool result: a new episode, nothing further is signalled.
    r.dog.observer({ kind: "working", tsMs: 100_500 });
    r.clock.ms = 110_000;
    await r.dog.tick();
    assert.equal(r.kills.length, 1);
  });

});

test("W1-T7807: every quiet-worker decision is ledgered with its evidence", async () => {
  await withOutputFile(FINISHED_OUTPUT, async (path) => {
    // 1. a judge that cannot answer: no action, and the row says so.
    const unavailable = rig(path, async () => undefined);
    unavailable.dog.observer({ kind: "tool-executing", tsMs: 0, toolName: "Bash", text: "until grep" });
    unavailable.clock.ms = 100_000;
    await unavailable.dog.tick();
    assert.deepEqual(unavailable.kills, []);
    const bound = unavailable.rows.find((x) => x.step === QUIET_BASIS_LEDGER_STEP);
    assert.deepEqual(
      { provider: bound?.extra.provider, source: bound?.extra.bound_source, samples: bound?.extra.samples, bound: bound?.extra.bound_ms },
      { provider: "claude", source: "observed_quiet_gaps", samples: 3, bound: 60_000 },
    );
    const row = unavailable.rows.find((x) => x.step === QUIET_JUDGED_LEDGER_STEP)?.extra;
    assert.equal(row?.decision, "judge_unavailable");
    assert.equal(row?.action, "none");
    assert.equal(row?.poll_pid, POLL);
    assert.equal(row?.awaited_path, path);
    assert.equal(row?.exit_marker, "[exited with code 0]");
    assert.equal(row?.awaited_pattern_present, false);
    assert.match(String(row?.awaited_tail), /pass 179/);
    assert.equal(row?.quiet_ms, 70_000);
    assert.equal(row?.bound_ms, 60_000);
    assert.equal(row?.bound_source, "observed_quiet_gaps");
    assert.deepEqual(row?.last_activity, { kind: "tool-executing", atMs: 0, toolName: "Bash", text: "until grep" });
    // the judge was shown the same evidence
    assert.equal(unavailable.judged[0].exitMarker, "[exited with code 0]");

    // 2. a judge that throws is also "cannot answer".
    const thrown = rig(path, async () => { throw new Error("judge spawn refused"); });
    thrown.dog.observer({ kind: "working", tsMs: 0 });
    thrown.clock.ms = 100_000;
    await thrown.dog.tick();
    const thrownRow = thrown.rows.find((x) => x.step === QUIET_JUDGED_LEDGER_STEP)?.extra;
    assert.equal(thrownRow?.decision, "judge_unavailable");
    assert.match(String(thrownRow?.detail), /judge spawn refused/);

    // 3. a nudge with no streamed-input path degrades to wait, and says so.
    const noNudge = rig(path, async () => ({ verdict: "nudge", reason: "tell it", message: "the run finished" }));
    noNudge.dog.observer({ kind: "working", tsMs: 0 });
    noNudge.clock.ms = 100_000;
    await noNudge.dog.tick();
    assert.equal(noNudge.rows.find((x) => x.step === QUIET_JUDGED_LEDGER_STEP)?.extra.decision, "degraded_to_wait");
    const nudged = rig(path, async () => ({ verdict: "nudge", reason: "tell it", message: "the run finished" }), { nudge: true });
    nudged.dog.observer({ kind: "working", tsMs: 0 });
    nudged.clock.ms = 100_000;
    await nudged.dog.tick();
    assert.deepEqual(nudged.nudges, ["the run finished"]);
    assert.equal(nudged.rows.find((x) => x.step === QUIET_JUDGED_LEDGER_STEP)?.extra.action, "nudge");

    // 4. a wait verdict, and a progressing tree that never reaches the judge, are ledgered too.
    const wait = rig(path, async () => ({ verdict: "wait", reason: "give it time" }));
    wait.dog.observer({ kind: "working", tsMs: 0 });
    wait.clock.ms = 100_000;
    await wait.dog.tick();
    assert.equal(wait.rows.find((x) => x.step === QUIET_JUDGED_LEDGER_STEP)?.extra.decision, "left_alone");
    assert.deepEqual(wait.kills, []);
  });

  const progressing = rig("/x/out", async () => ({ verdict: "kill_poll_child", reason: "unreachable" }));
  progressing.dog.observer({ kind: "working", tsMs: 0 });
  progressing.clock.ms = 100_000;
  await progressing.dog.tick();
  assert.equal(progressing.judged.length, 0, "a first read of an unfinished wait is not put to the judge");
  const left = progressing.rows.find((x) => x.step === QUIET_JUDGED_LEDGER_STEP)?.extra;
  assert.equal(left?.decision, "left_alone");
  assert.equal(left?.reason, "first_read");
});

test("W1-T7807: the implement prompt names the runner exit as the wait target", () => {
  assert.match(IMPLEMENT_WAIT_TARGET_CONTRACT, /RUNNER'S EXIT/);
  assert.match(IMPLEMENT_WAIT_TARGET_CONTRACT, /\[exited with code N\]/);
  assert.match(IMPLEMENT_WAIT_TARGET_CONTRACT, /never on a reporter-specific line/);
});

test("W1-T7807: the judge answer is parsed strictly", () => {
  assert.deepEqual(parseQuietJudgement('QUIET_JUDGE: {"verdict":"kill_poll_child","reason":"dead loop"}'), {
    verdict: "kill_poll_child", reason: "dead loop",
  });
  assert.equal(parseQuietJudgement('QUIET_JUDGE: {"verdict":"reboot","reason":"x"}'), undefined);
  assert.equal(parseQuietJudgement("not json"), undefined);
  assert.equal(parseQuietJudgement('{"verdict":"wait"}'), undefined);
});
