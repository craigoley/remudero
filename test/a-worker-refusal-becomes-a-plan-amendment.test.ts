import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { preDispatchContractRevision, terminalPreDispatchRefusalRevisions } from "../src/lib/dispatch-repair.js";
import type { Config } from "../src/lib/config.js";
import { appendLedger, type LedgerLine } from "../src/lib/ledger.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Plan, Task } from "../src/lib/plan.js";
import {
  REFUSAL_AMENDMENT_STEP,
  draftRefusalAmendment,
  extractRefusal,
  insertRefusalAmendment,
  noPrVerdictRowsFromLedger,
  readTaskShard,
  refusalAmendmentComment,
  type RefusalAmendmentIo,
  type RefusalCandidate,
} from "../src/lib/refusal-amendment.js";
import {
  SWEEP_EFFECT_SURFACE,
  buildSweepEffects,
  runSweep,
  type BuildSweepEffectsDeps,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { buildFixturePlanPrBody } from "./helpers/plan-pr-body-fixture.js";

// W1-T4838 — a worker's REASONED refusal was scored as a failed attempt and re-dispatched until the
// breaker tripped. These tests prove the categorized refusal now HOLDS the task and drafts ONE
// plan-only amendment, and — the falsifier — that an ordinary `no_pr` (no categorized block) does
// neither, so it keeps today's retry path.

const TASK = "W1-T4838-FIXTURE";
const RUN = "RUN-REFUSED-1";

const CATEGORIZED = [
  "I did not build this.",
  "",
  "REFUSED:",
  "1. [premise-rotted] No headline at this checkout meets the task record's required condition",
  "2. [contradicts-another-criterion] criterion 2 needs a seven-day precondition criterion 1 forbids",
].join("\n");

const UNCATEGORIZED = [
  "The worker completed without opening a PR.",
  "I refused to guess at the shape, and the refused approach is described above.",
  "REFUSED: it did not feel right",
  "1. [not-a-real-class] some free prose in the right position",
].join("\n");

function freshLogFile(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-refusal-amend-")), "state", "ledger.ndjson");
}

function verdictRow(over: Partial<LedgerLine> = {}): LedgerLine {
  return { run_id: RUN, task_id: TASK, step: "verdict", verdict: "no_pr", report_excerpt: CATEGORIZED, ...over };
}

function fixtureTask(over: Partial<Task> = {}): Task {
  return { id: TASK, repo: "remudero", status: "queued", attempts: 0, title: "fixture", ...over } as unknown as Task;
}

function planOf(task: Task): Plan {
  return { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan;
}

const SHARD = ["- id: " + TASK, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");

// ── extractRefusal: the grammar ─────────────────────────────────────────────────────────────────

test("W1-T4838: extractRefusal reads only the categorized REFUSED block", () => {
  const found = extractRefusal(CATEGORIZED);
  assert.deepEqual(
    found.map((r) => [r.criterion, r.refusalClass]),
    [
      [1, "premise-rotted"],
      [2, "contradicts-another-criterion"],
    ],
  );
  assert.match(found[0]!.detail, /No headline at this checkout/);
  assert.deepEqual(extractRefusal(UNCATEGORIZED), [], "prose containing 'refused' and an unknown class is not a refusal");
  assert.deepEqual(extractRefusal(undefined), []);
  assert.deepEqual(extractRefusal("worker completed without opening a PR"), []);
});

// ── the ledger fold ─────────────────────────────────────────────────────────────────────────────

test("W1-T4838: only the LATEST recent verdict, not yet handled, is nominated", () => {
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const rows = (lines: LedgerLine[]) => noPrVerdictRowsFromLedger(lines, now);
  assert.equal(rows([{ ...verdictRow(), ts: at(1000) }]).length, 1);
  assert.equal(rows([{ ...verdictRow(), ts: at(10 * 24 * 3600 * 1000) }]).length, 0, "a stale refusal is history");
  assert.equal(rows([verdictRow()]).length, 0, "an undated row never holds a task");
  assert.equal(
    rows([{ ...verdictRow(), ts: at(2000) }, { run_id: "R2", task_id: TASK, step: "verdict", verdict: "merged", ts: at(1000) }]).length,
    0,
    "a later verdict supersedes the refusal",
  );
  assert.equal(
    rows([
      { ...verdictRow(), ts: at(2000) },
      { run_id: "SWEEP", task_id: TASK, step: REFUSAL_AMENDMENT_STEP, source_run_id: RUN, outcome: "drafted" },
    ]).length,
    0,
    "an amendment already recorded for that run is not drafted twice",
  );
});

// ── the shard insertion ─────────────────────────────────────────────────────────────────────────

test("W1-T4838: insertRefusalAmendment adds comments above status and edits no field", () => {
  const refusals = extractRefusal(CATEGORIZED);
  const comment = refusalAmendmentComment(TASK, RUN, refusals, "2026-09-30T00:00:00.000Z");
  const out = insertRefusalAmendment(SHARD, TASK, comment)!;
  const lines = out.split("\n");
  const statusIdx = lines.findIndex((l) => l === "  status: queued");
  assert.ok(statusIdx > 0);
  assert.match(lines[statusIdx - 1]!, /^ {2}# +this task is held from dispatch/);
  assert.match(out, /# refusal-amendment \(W1-T4838-FIXTURE, run RUN-REFUSED-1,/);
  assert.match(out, /proposed close-unbuilt/);
  assert.match(out, /worker evidence: No headline at this checkout/);
  const stripped = lines.filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.equal(stripped, SHARD, "removing the comments returns the original byte-for-byte");
  assert.equal(insertRefusalAmendment("- id: OTHER\n  status: queued\n", TASK, comment), undefined, "no record ⇒ no guess");
  assert.equal(insertRefusalAmendment(`- id: ${TASK}\n  repo: x\n- id: NEXT\n  status: queued\n`, TASK, comment), undefined, "never a neighbour's status");
});

// ── draftRefusalAmendment: one PR, deduped ──────────────────────────────────────────────────────

function candidate(): RefusalCandidate {
  return { taskId: TASK, runId: RUN, reportExcerpt: CATEGORIZED, refusals: extractRefusal(CATEGORIZED) };
}

function fakeIo(over: Partial<RefusalAmendmentIo> = {}): { io: RefusalAmendmentIo; opened: Array<{ branch: string; amendedText: string }> } {
  const opened: Array<{ branch: string; amendedText: string }> = [];
  const io: RefusalAmendmentIo = {
    readShard: () => ({ relPath: `plan/tasks.d/${TASK}-x.yaml`, text: SHARD }),
    probeExisting: () => undefined,
    openAmendmentPr: (input) => {
      opened.push({ branch: input.branch, amendedText: input.amendedText });
      return { prUrl: "https://github.com/acme/remudero/pull/9002" };
    },
    nowIso: () => "2026-09-30T00:00:00.000Z",
    ...over,
  };
  return { io, opened };
}

test("W1-T4838: draftRefusalAmendment opens one plan-only PR and dedupes on the per-task branch", async () => {
  const a = fakeIo();
  const drafted = await draftRefusalAmendment(candidate(), a.io);
  assert.equal(drafted.outcome, "drafted");
  assert.equal(a.opened.length, 1);
  assert.equal(a.opened[0]!.branch, `refusal-amendment/${TASK}`);

  const b = fakeIo({ probeExisting: () => ({ prUrl: "https://github.com/acme/remudero/pull/9001" }) });
  const deduped = await draftRefusalAmendment(candidate(), b.io);
  assert.equal(deduped.outcome, "deduped");
  assert.equal(b.opened.length, 0, "an existing amendment PR is never duplicated");

  const c = fakeIo({ readShard: () => undefined });
  assert.equal((await draftRefusalAmendment(candidate(), c.io)).outcome, "no_shard");
  const d = fakeIo({ readShard: () => ({ relPath: "p.yaml", text: "- id: OTHER\n  status: queued\n" }) });
  assert.equal((await draftRefusalAmendment(candidate(), d.io)).outcome, "text_drift");
  const e = fakeIo({ openAmendmentPr: () => { throw new Error("push refused"); } });
  const failed = await draftRefusalAmendment(candidate(), e.io);
  assert.equal(failed.outcome, "error");
  assert.match(failed.error ?? "", /push refused/);
});

// ── the sweep wiring, real effect over injected git/gh seams ────────────────────────────────────

function effectsFixture(task: Task) {
  const root = mkdtempSync(join(tmpdir(), "rmd-refusal-amend-repo-"));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.d", `${TASK}-fixture.yaml`), SHARD);
  const ghCalls: string[][] = [];
  const worktreeAdds: string[] = [];
  const writes: Array<{ path: string; text: string }> = [];
  const logged: string[] = [];
  const deps: BuildSweepEffectsDeps = {
    owner: "acme",
    repo: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-W1-T4838",
    plan: planOf(task),
    log: (step) => logged.push(step),
    nowMsImpl: () => Date.now(),
    planRepairGitImpl: (_file, args) => (args.includes("rev-parse") ? "amendsha0123\n" : ""),
    worktreeAddImpl: (_repoDir, worktreePath, branch) => {
      worktreeAdds.push(branch);
      mkdirSync(join(worktreePath, "plan", "tasks.d"), { recursive: true });
    },
    gitPushRunBranchImpl: () => {},
    worktreeRemoveImpl: () => {},
    ghJsonImpl: (args) => {
      ghCalls.push(args);
      return args.includes("--method") ? { html_url: "https://github.com/acme/remudero/pull/9003", number: 9003 } : [];
    },
    buildPlanPrBodyImpl: (opts) => {
      writes.push({ path: "body", text: opts.intro + "\n" + JSON.stringify(opts) });
      return buildFixturePlanPrBody(opts);
    },
    reloadPlanForFixImpl: () => undefined,
  } as BuildSweepEffectsDeps;
  return { root, effects: buildSweepEffects(deps), ghCalls, worktreeAdds, writes, logged };
}

function sweepDeps(path: string, extra: Partial<SweepDeps>): SweepDeps {
  return {
    arm: () => "armed",
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: path,
    runId: "SWEEP-W1-T4838",
    ...extra,
  };
}

function logRows(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

test("W1-T4838: a categorized refusal holds the task and drafts one amendment", async () => {
  const task = fixtureTask();
  const path = freshLogFile();
  appendLedger(path, verdictRow());
  const f = effectsFixture(task);
  const deps = sweepDeps(path, { draftRefusalAmendments: f.effects.draftRefusalAmendments });

  await withLiveWritesAllowed(() => runSweep([], deps));

  // ONE amendment PR: a probe then a create, on the stable per-task branch.
  assert.deepEqual(f.worktreeAdds, [`refusal-amendment/${TASK}`]);
  assert.equal(f.ghCalls.filter((c) => c.includes("--method")).length, 1, "exactly one PR is created");
  const body = f.writes.map((w) => w.text).join("\n");
  assert.match(body, /No headline at this checkout/, "the worker's evidence is quoted in the PR");
  assert.doesNotMatch(body, /Remudero-Task: /, "the amendment must not carry a trailer that would mark the task done");

  // THE HOLD: the daemon's existing terminal pre-dispatch record now covers this task's contract.
  const held = terminalPreDispatchRefusalRevisions(join(f.root, "state"));
  assert.equal(held.get(TASK), preDispatchContractRevision(task), "held while the task record is unchanged");
  assert.notEqual(
    held.get(TASK),
    preDispatchContractRevision(fixtureTask({ files: ["src/x.ts"] })),
    "an amended task record is re-offered",
  );

  // Recorded once per source run, so the next pass finds nothing to do.
  const recorded = logRows(path).filter((r) => r.step === REFUSAL_AMENDMENT_STEP);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.outcome, "drafted");
  assert.equal(recorded[0]!.source_run_id, RUN);
  await withLiveWritesAllowed(() => runSweep([], deps));
  assert.equal(f.ghCalls.filter((c) => c.includes("--method")).length, 1, "a second pass drafts nothing more");
  assert.equal(logRows(path).filter((r) => r.step === REFUSAL_AMENDMENT_STEP).length, 1);
});

test("W1-T4838: an uncategorized no_pr keeps the retry path", async () => {
  const task = fixtureTask();
  const path = freshLogFile();
  // Three ordinary failures: prose that says 'refused', an unknown class, and no excerpt at all.
  for (const [i, excerpt] of [UNCATEGORIZED, "worker completed without opening a PR", undefined].entries()) {
    appendLedger(path, verdictRow({ task_id: `${TASK}-${i}`, report_excerpt: excerpt }));
  }
  const f = effectsFixture(task);
  let called = 0;
  const spy: SweepDeps["draftRefusalAmendments"] = async (c) => {
    called++;
    return f.effects.draftRefusalAmendments!(c);
  };

  await withLiveWritesAllowed(() => runSweep([], sweepDeps(path, { draftRefusalAmendments: spy })));

  assert.equal(called, 0, "no candidate is nominated for an ordinary failure");
  assert.equal(f.ghCalls.length, 0, "no amendment PR is probed or opened");
  assert.equal(f.worktreeAdds.length, 0);
  assert.equal(terminalPreDispatchRefusalRevisions(join(f.root, "state")).size, 0, "nothing is held — the task retries");
  assert.equal(logRows(path).filter((r) => r.step === REFUSAL_AMENDMENT_STEP).length, 0);
});

test("W1-T4838: a light pass and a caller that never wires the effect do nothing", async () => {
  const path = freshLogFile();
  appendLedger(path, verdictRow());
  let called = 0;
  const spy: SweepDeps["draftRefusalAmendments"] = async () => { called++; return []; };
  await runSweep([], sweepDeps(path, { draftRefusalAmendments: spy, repairAdmissionSurface: "light" }));
  await runSweep([], sweepDeps(path, {}));
  assert.equal(called, 0);
  await runSweep([], sweepDeps(path, { draftRefusalAmendments: spy }));
  assert.equal(called, 1, "a full pass nominates the categorized refusal");
});

test("W1-T4838: readTaskShard finds a shard file, falls back to the monolith, and reports a miss", () => {
  const sharded = mkdtempSync(join(tmpdir(), "rmd-refusal-shard-"));
  mkdirSync(join(sharded, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(sharded, "plan", "tasks.d", `${TASK}-fixture.yaml`), SHARD);
  assert.equal(readTaskShard(sharded, TASK)?.relPath, `plan/tasks.d/${TASK}-fixture.yaml`);

  // No tasks.d directory at all: the monolith that carries the id is the shard.
  const mono = mkdtempSync(join(tmpdir(), "rmd-refusal-mono-"));
  mkdirSync(join(mono, "plan"), { recursive: true });
  writeFileSync(join(mono, "plan", "tasks.yaml"), SHARD);
  const found = readTaskShard(mono, TASK);
  assert.equal(found?.relPath, "plan/tasks.yaml");
  assert.equal(found?.text, SHARD);

  // A monolith that does not carry the id, and a repo with neither, both miss.
  assert.equal(readTaskShard(mono, "W1-T0000-OTHER"), undefined);
  assert.equal(readTaskShard(mkdtempSync(join(tmpdir(), "rmd-refusal-none-")), TASK), undefined);
});

test("W1-T4838: a hold that cannot be written is logged and the amendment is still drafted", async () => {
  const task = fixtureTask();
  const path = freshLogFile();
  appendLedger(path, verdictRow());
  const f = effectsFixture(task);
  // `state` is a FILE, so the hold record's directory cannot be created — the hold write throws.
  writeFileSync(join(f.root, "state"), "not a directory");

  await withLiveWritesAllowed(() =>
    runSweep([], sweepDeps(path, { draftRefusalAmendments: f.effects.draftRefusalAmendments })),
  );

  assert.ok(f.logged.includes("sweep.refusal_amendment.hold_failed"), "the failed hold is logged, not swallowed");
  assert.equal(f.ghCalls.filter((c) => c.includes("--method")).length, 1, "the amendment PR is still opened");
  assert.equal(logRows(path).filter((r) => r.step === REFUSAL_AMENDMENT_STEP)[0]?.outcome, "drafted");
});

test("W1-T4838: a finished task is neither held nor amended, and the effect is on the recorded surface", async () => {
  const done = fixtureTask({ status: "done" });
  const path = freshLogFile();
  appendLedger(path, verdictRow());
  const f = effectsFixture(done);
  await withLiveWritesAllowed(() => runSweep([], sweepDeps(path, { draftRefusalAmendments: f.effects.draftRefusalAmendments })));
  assert.equal(f.ghCalls.length, 0);
  assert.equal(terminalPreDispatchRefusalRevisions(join(f.root, "state")).size, 0);
  assert.ok((SWEEP_EFFECT_SURFACE as readonly string[]).includes("draftRefusalAmendments"));
  assert.equal(logRows(path).filter((r) => r.step === REFUSAL_AMENDMENT_STEP)[0]?.outcome, "task_closed");
});
