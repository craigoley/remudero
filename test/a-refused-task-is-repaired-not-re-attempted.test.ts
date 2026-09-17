import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  decideRepairDispatch,
  refusalVerdictText,
  repairRefusedTask,
  type PriorRefusal,
  type RefusalViolation,
  type RepairDispatchDeps,
} from "../src/lib/dispatch-repair.js";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { spawnWorker } from "../src/lib/worker.js";

// A TASK THE PRE-DISPATCH LINTER REFUSES IS REPAIRED, NOT RE-ATTEMPTED FOREVER (W1-T3657).
//
// MEASURED (rationale): 1,232 refusals of one already-shipped task in 10.4 hours, and a second
// fleet with ZERO dispatchable tasks for the same reason — the pre-dispatch linter is
// deterministic, so re-attempting a refused task reaches the IDENTICAL verdict every tick,
// forever, with no strike spent and no operator told. THE SHAPE this file falsifies: dispatch
// ONE repair lane carrying the linter's OWN verdict text; a second refusal of the SAME verdict
// escalates rather than re-reconning; a CHANGED verdict is progress, not a repeat.

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

const VIOLATIONS: RefusalViolation[] = [
  {
    check: "sizing",
    message:
      "spans 3 distinct subsystems/concerns (canonical-docs, learnings-publication, page) at risk:medium — Rule 19: " +
      "raise to risk:high or decompose into one task per concern",
  },
];

const OTHER_VIOLATIONS: RefusalViolation[] = [{ check: "sizing", message: "an entirely different defect, unrelated to the first" }];

function fakeDeps(prior: PriorRefusal | undefined) {
  const dispatched: { taskId: string; verdict: string; progress: boolean }[] = [];
  const escalated: { taskId: string; verdict: string; attempts: number }[] = [];
  const written: PriorRefusal[] = [];
  const deps: RepairDispatchDeps = {
    readPrior: () => prior,
    writePrior: (_id, p) => {
      written.push(p);
    },
    dispatchRepairLane: (input) => {
      dispatched.push(input);
    },
    escalate: (input) => {
      escalated.push(input);
    },
  };
  return { dispatched, escalated, written, deps };
}

// ── ACCEPTANCE 1: a refused task dispatches ONE repair lane, not another attempt ──────────

test("ACCEPTANCE 1: a first refusal dispatches exactly one repair lane, never an escalation", () => {
  const { dispatched, escalated, deps } = fakeDeps(undefined);
  const action = repairRefusedTask("W1-T9001", VIOLATIONS, deps);

  assert.equal(action.kind, "dispatch_repair", "a first-ever refusal dispatches a repair lane, not an escalation");
  assert.equal(dispatched.length, 1, "exactly one repair lane is dispatched — never zero, never a re-attempt of the task itself");
  assert.equal(escalated.length, 0, "a first refusal never escalates");
});

test("FALSIFIER of acceptance 1: removing the dispatch call leaves the task re-attempted (no repair lane, no escalation)", () => {
  // Mirrors the task's own falsifier: "Remove the repair dispatch and the first test must fail
  // with the task re-attempted." A deps object that services NEITHER dispatch nor escalation
  // (the "nothing repairs it" defect this task exists to fix) must NOT satisfy criterion 1.
  const { dispatched, escalated } = fakeDeps(undefined);
  // No call to repairRefusedTask at all — simulating "the loop just re-attempts on the next
  // tick", the defect this task fixes.
  assert.equal(dispatched.length, 0);
  assert.equal(escalated.length, 0, "a re-attempted task produces neither a repair dispatch nor an escalation — this is the defect");
});

// ── ACCEPTANCE 2: the repair lane carries the refusal verdict VERBATIM ────────────────────

test("ACCEPTANCE 2: the repair lane carries the linter's own refusal verdict text verbatim", () => {
  const { dispatched, deps } = fakeDeps(undefined);
  repairRefusedTask("W1-T9001", VIOLATIONS, deps);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0]!.verdict, refusalVerdictText(VIOLATIONS), "the dispatched verdict is EXACTLY refusalVerdictText's output");
  assert.match(
    dispatched[0]!.verdict,
    /spans 3 distinct subsystems\/concerns \(canonical-docs, learnings-publication, page\) at risk:medium — Rule 19: raise to risk:high or decompose into one task per concern/,
    "the linter's own remedy text survives verbatim, not a paraphrase",
  );
});

test("FALSIFIER of acceptance 2: a generic prompt instead of the verdict does not equal refusalVerdictText's output", () => {
  const generic = "the linter refused this task — please investigate";
  assert.notEqual(generic, refusalVerdictText(VIOLATIONS), "a generic prompt is not the same string as the verdict — it would fail the verbatim check");
});

// ── ACCEPTANCE 3: an unchanged verdict escalates rather than re-reconning ─────────────────

test("ACCEPTANCE 3: a second refusal carrying the SAME verdict escalates instead of dispatching a second repair lane", () => {
  const verdict = refusalVerdictText(VIOLATIONS);
  const { dispatched, escalated, deps } = fakeDeps({ verdict, attempts: 1 });
  const action = repairRefusedTask("W1-T9001", VIOLATIONS, deps);

  assert.equal(action.kind, "escalate", "the unchanged verdict escalates");
  assert.equal(escalated.length, 1, "exactly one escalation is raised");
  assert.equal(dispatched.length, 0, "no SECOND repair lane is dispatched for the same verdict — that would be re-reconning");
  assert.equal(escalated[0]!.taskId, "W1-T9001");
  assert.equal(escalated[0]!.verdict, verdict, "the escalation names the same verdict, unchanged");
  assert.equal(escalated[0]!.attempts, 2, "the escalation counts this as the 2nd time this exact verdict was seen");
});

test("FALSIFIER of acceptance 3: an unchanged verdict that starts a second recon (dispatch) instead of escalating violates the shape", () => {
  const verdict = refusalVerdictText(VIOLATIONS);
  const { deps } = fakeDeps({ verdict, attempts: 1 });
  const action = decideRepairDispatch("W1-T9001", verdict, deps.readPrior("W1-T9001"));
  assert.notEqual(action.kind, "dispatch_repair", "an unchanged verdict must never decide to dispatch a second repair lane");
});

// ── ACCEPTANCE 4: a changed verdict is PROGRESS, not a repeat ─────────────────────────────

test("ACCEPTANCE 4: a changed verdict is treated as progress and dispatches a repair lane, not an escalation", () => {
  const priorVerdict = refusalVerdictText(OTHER_VIOLATIONS);
  const { dispatched, escalated, deps } = fakeDeps({ verdict: priorVerdict, attempts: 1 });
  const action = repairRefusedTask("W1-T9001", VIOLATIONS, deps);

  assert.equal(action.kind, "dispatch_repair", "a changed verdict is progress, treated like a first-ever refusal");
  assert.ok(action.kind === "dispatch_repair" && action.progress, "the action is explicitly flagged as progress (not a first-ever refusal either)");
  assert.equal(dispatched.length, 1, "a changed verdict dispatches exactly one repair lane");
  assert.equal(escalated.length, 0, "a changed verdict never escalates");
});

test("FALSIFIER of acceptance 4: treating a changed verdict as a repeat (escalating) violates the shape", () => {
  const priorVerdict = refusalVerdictText(OTHER_VIOLATIONS);
  const currentVerdict = refusalVerdictText(VIOLATIONS);
  assert.notEqual(priorVerdict, currentVerdict, "the two verdicts really do differ, so this exercises the CHANGED-verdict branch");
  const action = decideRepairDispatch("W1-T9001", currentVerdict, { verdict: priorVerdict, attempts: 1 });
  assert.notEqual(action.kind, "escalate", "a changed verdict must never be decided as a repeat/escalation");
});

// ── ACCEPTANCE 5: reachable from the dispatch path that prints the refusal today ──────────

test("ACCEPTANCE 5 (grep): repairRefusedTask( is called from src/run-task.ts, not only from its own tests", () => {
  assert.match(runTaskSrc, /repairRefusedTask\(/, "src/run-task.ts must call repairRefusedTask");
  const blockedIllformedIdx = runTaskSrc.indexOf('log("lint.blocked"');
  const repairIdx = runTaskSrc.indexOf("repairRefusedTask(");
  assert.ok(blockedIllformedIdx >= 0 && repairIdx >= 0);
  assert.ok(repairIdx > blockedIllformedIdx, "the repair call sits inside the SAME TaskLintError catch that prints the refusal today");
});

// ── BEHAVIORAL: the real dispatch path (runTask) drives repairRefusedTask, never a spawn ──

const FIXTURE_PLAN = `- id: TST-REPAIR-BAD
  title: "malformed — spans three subsystems at medium risk (sizing block)"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: architect
  files: [src/lib/daemon.ts, src/lib/launchd.ts, src/lib/review.ts]
  acceptance:
    - claim: "does the thing"
      proof: "unit test test/foo.test.ts asserts the thing"
  status: queued
  attempts: 0
`;

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

function fixturePlanPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-repair-wiring-"));
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN);
  return planPath;
}

test("BEHAVIORAL: a real runTask dispatch of a linter-refused task drives repairRefusedTask's dispatch action, and never spawns", async () => {
  const planPath = fixturePlanPath();
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-repair-root-"));
  const config: Config = { claudeBin: "/bin/true", root: configRoot };

  let spawnCalls = 0;
  const spawn = (async () => {
    spawnCalls++;
    throw new Error("spawn must never run for a linter-failing task, even with the repair rung wired in");
  }) as typeof spawnWorker;

  const dispatched: { taskId: string; verdict: string; progress: boolean }[] = [];
  const escalated: { taskId: string; verdict: string; attempts: number }[] = [];
  const dispatchRepairDeps: RepairDispatchDeps = {
    readPrior: () => undefined,
    writePrior: () => {},
    dispatchRepairLane: (input) => {
      dispatched.push(input);
    },
    escalate: (input) => {
      escalated.push(input);
    },
  };

  const res = await runTask("TST-REPAIR-BAD", {
    skipGitSync: true,
    planPath,
    config,
    github: OFFLINE_GITHUB,
    spawn,
    dispatchRepairDeps,
  });

  assert.equal(res.verdict, "blocked_illformed");
  assert.equal(res.costUsd, 0);
  assert.equal(spawnCalls, 0, "the repair rung never reaches the worker spawn");
  assert.equal(dispatched.length, 1, "the real dispatch path drove exactly one repair lane");
  assert.equal(escalated.length, 0);
  assert.equal(dispatched[0]!.taskId, "TST-REPAIR-BAD");
  assert.match(dispatched[0]!.verdict, /sizing/, "the repair lane carries the real linter verdict for this task");
});
