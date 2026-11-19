/**
 * W1-T13712: runFixRung traces its held head through the sweep's async repair-history reader. Before, it passed no
 * archive reader, so conflictRoundHeldHead fell back to a synchronous union read of every rotation: six loop stalls
 * of 89 s to 212 s on 2026-11-18, with 1,531 ledger files.
 */
import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { systemClock } from "#src/lib/clock.js";
import type { Config } from "#src/lib/config.js";
import type { FixProgressJudge } from "#src/lib/fix-progress-judge.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import type { Mount } from "#src/lib/mounts.js";
import { conflictRoundHeldHead, fixRoundArchiveRows, readSweepRepairHistory } from "#src/lib/sweep.js";
import type { SpawnWorkerArgs, WorkerResult } from "#src/lib/worker.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { buildFixRungDispatchArgs, runFixRung } from "#test/helpers/run-task-test.js";

type Row = Record<string, unknown>;
const TASK = "W1-T13712";
const HEAD_A = "a1".repeat(20);
const HEAD_B = "b2".repeat(20);
const HEAD_C = "c3".repeat(20);
const HEAD_D = "d4".repeat(20);
const OUTSIDE = "e5".repeat(20);
const PR_NUMBER = 19439;
const PR_URL = `https://github.com/o/r/pull/${PR_NUMBER}`;
const DESIGN_REASON = "the task contract names two incompatible ledger shapes";
const EVIDENCE = { files: [{ path: "src/lib/example.ts", oursDeleted: 0, theirsDeleted: 0 }], oursLog: "branch changes", theirsLog: "main changes" };
const FIVE = ["fix.dispatch", "fix.retrigger", "fix.done", "fix.needs_design", "sweep.conflict_regenerated"];

const ts = (offsetMs: number): string => new Date(systemClock.now() - 3_600_000 + offsetMs).toISOString();
/** A worker round at `head` that ended NEEDS_DESIGN, as the fix rung writes it. */
const designRows = (head: string): Row[] => {
  const common = { task_id: TASK, head_sha: head, run_id: "DESIGN-ROUND", host: "fixture-host", actor_pid: 777 };
  const round = { ...common, round_id: "DESIGN-ROUND:1", repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: ts(1000), mode: "ci-log" },
    { ...common, step: "fix.needs_design", ts: ts(2000), reason: DESIGN_REASON },
    { ...round, step: "fix.done", ts: ts(3000), fix_outcome: "NEEDS_DESIGN", subtype: "success" },
  ];
};
/** The conflict round at `from` that pushed `to`. */
const conflictRows = (from: string, to: string): Row[] => {
  const round = { task_id: TASK, head_sha: from, run_id: `CONFLICT-${from}`, host: "fixture-host", actor_pid: 778,
    round_id: `CONFLICT-${from}:1`, repair_pr_url: PR_URL };
  return [
    { ...round, step: "fix.dispatch", ts: ts(5000), mode: "merge-conflict" },
    { ...round, step: "fix.done", ts: ts(6000), fix_outcome: "FIXED", subtype: "success", pushed_head_sha: to },
  ];
};
const syncArchive = (dir: string) => {
  const read = readLedgerUnionRecordsSync(dir, { step: FIVE, refuseIncomplete: true });
  return read.ok ? read.rows : undefined;
};

/** One fix round on the PR at `from` with captured conflict evidence: the conflict worker pushes `to`, then CI is red. */
async function round(ledgerPath: string, from: string, to: string) {
  const root = join(ledgerPath, "..");
  const mount: Mount = { model: "sonnet", effort: "medium", maxTurns: 20, contextBudget: 120000 };
  const spawned: SpawnWorkerArgs[] = [], rows: Row[] = [];
  const judged: string[] = [];
  const judge: FixProgressJudge = async input => {
    judged.push(input.headSha);
    return { verdict: "continue", reason: "fixture permits code only after the hold check" };
  };
  let pushedHead = from, ciReads = 0;
  const args = buildFixRungDispatchArgs({
    task: { id: TASK, title: "held head trace" }, runId: `ROUND-${from}`, prUrl: PR_URL,
    branch: `run-${TASK}-1795025430000`, worktreePath: join(root, "wt"), mount,
    settingsFile: join(root, "settings.json"), config: { root } as Config, budgetUsd: 5, strikeCap: 3,
    evidence: { unmetCriteria: [], mergeConflict: EVIDENCE, baseSha: OUTSIDE }, pr: { headSha: from },
    reviewBase: { owner: "o", repo: "r", headCheckoutDir: join(root, "wt"), reviewerMount: mount },
  });
  const outcome = await runFixRung({ ...args,
    escalationJudge: async () => ({ decision: "deliver", reason: "fixture" }),
    deps: {
      fixProgressJudge: judge,
      spawn: async (workerArgs: SpawnWorkerArgs): Promise<WorkerResult> => {
        spawned.push(workerArgs);
        return { sessionId: "session", costUsd: 0, numTurns: 1,
          text: "REPORT\nresolved the conflict\nFIX_OUTCOME: FIXED\nPR_URL: (unchanged)", blocks: [], stderr: "",
          subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [],
          model: "default", effort: "default", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
          modelUsage: {}, compactionEvents: [], qualitySuspect: false };
      },
      push: () => { pushedHead = to; return { fixRoundPushedHead: to }; },
      readRemoteBranchHead: async () => pushedHead,
      readHeadShaForProvenance: async () => pushedHead,
      waitForCiGreen: async () => (++ciReads === 1 ? { state: "red" as const, sha: pushedHead } : "green" as const),
      fetchCiFailures: async () => [{ name: "ci-shard (1/8)", logTail: "not ok 1 - fixture behavior" }],
      fetchPrBody: async () => "PR body",
      runReview: async () => ({ ...args.initialReview, headSha: pushedHead, state: "success" as const,
        criteria: [{ claim: "fixture", met: true, reason: "fixture" }] }),
      issues: { listOpen: () => [], create: () => "https://github.com/o/r/issues/1", comment: () => {}, closeWithComment: () => {} },
      ledgerPath,
      log: (step: string, extra?: Record<string, unknown>) => {
        const row = { ts: new Date().toISOString(), run_id: `ROUND-${from}`, task_id: TASK, step, ...extra };
        rows.push(row);
        appendFileSync(ledgerPath, JSON.stringify(row) + "\n");
      },
      say: () => {}, account: (result: WorkerResult) => result,
      readLiveState: async () => ({ ok: true as const, state: "OPEN" as const }),
    },
  } as never);
  return { outcome, spawned, rows, judged };
}

/** A rotated ledger file's name; the live file is `ledger.ndjson`. */
const isRotation = (path: unknown): boolean => /^ledger\.\d{4}-.*\.ndjson(\.gz)?$/.test(basename(String(path)));

/**
 * Records, on this thread, each synchronous read of a rotated ledger file and each read stream opened on one, with
 * the loop turn at which the stream opened and closed. A self-scheduling setImmediate counts the turns, so the proof
 * counts turns, not milliseconds, and holds on a loaded host.
 */
function recordRotationReads(): {
  sync: string[]; streams: Array<{ name: string; opened: number; closed?: number }>; restore: () => void;
} {
  const fs = createRequire(import.meta.url)("node:fs") as Record<string, (...args: unknown[]) => unknown>;
  const sync: string[] = [];
  const streams: Array<{ name: string; opened: number; closed?: number }> = [];
  let turns = 0, spinning = true;
  const spin = (): void => { turns++; if (spinning) setImmediate(spin); };
  setImmediate(spin);
  const originals = new Map<string, (...args: unknown[]) => unknown>();
  for (const name of ["readFileSync", "openSync", "createReadStream"]) {
    const original = fs[name]!;
    originals.set(name, original);
    fs[name] = (...args: unknown[]) => {
      if (!isRotation(args[0])) return original(...args);
      if (name !== "createReadStream") {
        sync.push(`${name} ${basename(String(args[0]))}`);
        return original(...args);
      }
      const entry: { name: string; opened: number; closed?: number } = { name: basename(String(args[0])), opened: turns };
      streams.push(entry);
      const stream = original(...args) as NodeJS.ReadableStream;
      stream.once("close", () => { entry.closed = turns; });
      return stream;
    };
  }
  syncBuiltinESMExports();
  return { sync, streams, restore: () => {
    spinning = false;
    for (const [name, original] of originals) fs[name] = original;
    syncBuiltinESMExports();
  } };
}

test("W1-T13712 criterion 1: the held-head trace streams every rotation through the async reader, never a synchronous read, and the loop turns during each read", async (scope: TestContext) => {
  // A few rotations, gzip and plain, with other tasks' fix rounds: the synchronous union read would parse each one.
  const rotations = [0, 1, 2].map(r => ({
    at: `2026-10-0${r + 1}T00:00:00.000Z`, gz: r !== 1,
    rows: Array.from({ length: 200 }, (_, i): Row => i % 2 === 0
      ? { ts: ts(r * 1000 + i), task_id: `W1-T${20000 + r}`, step: "fix.dispatch", round_id: `round-${r}-${i}`, head_sha: HEAD_A, mode: "ci-log" }
      : { ts: ts(r * 1000 + i), step: "sweep.disposed", pr_number: i }),
  }));
  const ledger = writeLedger([], { scope, rotations });
  const names = readdirSync(ledger.dir).filter(isRotation).sort();
  assert.equal(names.length, 3, "control: the ledger directory holds three rotations");

  const reads = recordRotationReads();
  let r;
  try {
    r = await round(ledger.path, OUTSIDE, HEAD_D);
  } finally {
    reads.restore();
  }
  assert.deepEqual(r.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict", "ci-log"],
    "no conflict round pushed this head, so no hold: a code round follows the conflict round");
  assert.equal(reads.sync.length, 0, `no synchronous read of a rotation on the loop: ${reads.sync.join(", ")}`);
  assert.deepEqual([...new Set(reads.streams.map(s => s.name))].sort(), names, "the async reader streamed each rotation");
  for (const stream of reads.streams) {
    assert.ok(stream.closed !== undefined && stream.closed > stream.opened,
      `the loop turned while ${stream.name} was read (opened at turn ${stream.opened}, closed at ${stream.closed})`);
  }
});

test("W1-T13712 criterion 2: the round traces the same held head from the same rows as the synchronous read", async (scope: TestContext) => {
  // The question at A and the A→B conflict push are only in rotations; the rotations also hold repair rows of other steps.
  const rotations = [
    { at: "2026-10-01T00:00:00.000Z", gz: true, rows: [...designRows(HEAD_A), { ts: ts(4000), step: "fix.base_refreshed", pr_number: PR_NUMBER }] },
    { at: "2026-10-02T00:00:00.000Z", rows: [...conflictRows(HEAD_A, HEAD_B), { ts: ts(7000), step: "sweep.disposed", pr_number: PR_NUMBER }] },
  ];
  const ledger = writeLedger([{ ts: ts(8000), step: "review.done", task_id: TASK }], { scope, rotations });
  const pr = { taskId: TASK, prNumber: PR_NUMBER, prUrl: PR_URL, headSha: HEAD_B };
  const seen = (archive: () => ReadonlyArray<Row> | undefined) => {
    const histories: Array<ReadonlyArray<Row>> = [];
    const head = conflictRoundHeldHead(pr, [], undefined, archive, (h, history) => {
      histories.push(history);
      return history.some(row => row.step === "fix.needs_design" && row.head_sha === h);
    });
    return { head, histories };
  };
  const asyncRead = await readSweepRepairHistory(ledger.path);
  assert.equal(asyncRead.ok, true);
  assert.ok(asyncRead.rows.some(row => row.step === "fix.base_refreshed"), "control: the repair history holds more steps");
  const today = seen(() => syncArchive(ledger.dir));
  const now = seen(() => fixRoundArchiveRows(asyncRead));
  assert.equal(today.head, HEAD_A);
  assert.equal(now.head, today.head, "the same held head");
  assert.deepEqual(now.histories, today.histories, "the hold callback sees the same rows in the same order");
  assert.deepEqual(fixRoundArchiveRows(asyncRead), syncArchive(ledger.dir));

  const held = await round(ledger.path, HEAD_B, HEAD_C);
  assert.equal(held.outcome.outcome, "needs_design", "the archived question at A holds the round");
  assert.match(String(held.outcome.reason), new RegExp(DESIGN_REASON));
  assert.deepEqual(held.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict"]);
  assert.deepEqual(held.judged, [], "the hold is found before any code-strike judgment");

  // An incomplete corpus traces from the live rows only, as readFixRoundArchiveRows's refusal did.
  const broken = writeLedger([], { scope, rotations });
  writeFileSync(join(broken.dir, "ledger.2026-10-03T00-00-00-000Z.ndjson.gz"), "not gzip");
  assert.equal(syncArchive(broken.dir), undefined);
  const incomplete = await readSweepRepairHistory(broken.path);
  assert.equal(incomplete.ok, false);
  assert.equal(fixRoundArchiveRows(incomplete), undefined);
  const live = await round(broken.path, HEAD_B, HEAD_C);
  assert.deepEqual(live.rows.filter(row => row.step === "fix.dispatch").map(row => row.mode), ["merge-conflict", "ci-log"],
    "no archive, no walk to A: the round goes on to a code round");
  assert.equal(live.outcome.outcome, "fixed");
});

test("W1-T13712 criterion 3: a second round parses only the live file and the rotation cut since the first", async (scope: TestContext) => {
  const ledger = writeLedger([], { scope, rotations: [{ at: "2026-10-01T00:00:00.000Z", rows: [...designRows(HEAD_A), ...conflictRows(HEAD_A, HEAD_B)] }] });
  const rotation = join(ledger.dir, "ledger.2026-10-01T00-00-00-000Z.ndjson");
  utimesSync(rotation, 1_790_000_000, 1_790_000_000);
  const first = await round(ledger.path, HEAD_B, HEAD_C);
  assert.equal(first.outcome.outcome, "needs_design");
  assert.match(String(first.outcome.reason), new RegExp(DESIGN_REASON));

  // Rewrite the first rotation in place with the same size and time, and drop the durable digests: a round that parsed
  // it again would read the changed question; a kept rotation keeps the old one.
  const size = statSync(rotation).size;
  const changed = "x".repeat(DESIGN_REASON.length);
  writeFileSync(rotation, readFileSync(rotation, "utf8").replace(DESIGN_REASON, changed));
  utimesSync(rotation, 1_790_000_000, 1_790_000_000);
  assert.equal(statSync(rotation).size, size);
  rmSync(join(ledger.dir, "cache"), { recursive: true, force: true });
  // A rotation cut: the first round's live rows (its B→C push) move into a new rotation and the live file starts again.
  const cut = readFileSync(ledger.path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Row);
  assert.ok(cut.some(row => row.step === "fix.done" && row.pushed_head_sha === HEAD_C), "control: the first round pushed C");
  assert.equal(cut.some(row => row.step === "fix.needs_design"), false, "control: the question lives only in the first rotation");
  writeFileSync(ledger.path, "");
  writeLedger([], { dir: ledger.dir, rotations: [{ at: "2026-10-02T00:00:00.000Z", rows: cut }] });

  // The round at C walks C→B through the new rotation and B→A through the kept one.
  const second = await round(ledger.path, HEAD_C, HEAD_D);
  assert.equal(second.outcome.outcome, "needs_design", "the new rotation was read");
  assert.match(String(second.outcome.reason), new RegExp(DESIGN_REASON), "the first rotation was not parsed again");
  assert.doesNotMatch(String(second.outcome.reason), new RegExp(changed));
});
