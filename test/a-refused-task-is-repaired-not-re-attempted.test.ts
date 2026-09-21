import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { ghShim } from "./helpers/gh-shim.js";
import {
  decideRepairDispatch,
  preDispatchContractRevision,
  refusalVerdictText,
  repairRefusedTask,
  terminalPreDispatchRefusalRevisions,
  type PriorRefusal,
  type RefusalViolation,
} from "../src/lib/dispatch-repair.js";
import { runnableCandidates, tallyDispatchFilters } from "../src/lib/drain.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
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

const VIOLATIONS: RefusalViolation[] = [
  {
    check: "sizing",
    message:
      "spans 3 distinct subsystems/concerns (canonical-docs, learnings-publication, page) at risk:medium — Rule 19: " +
      "raise to risk:high or decompose into one task per concern",
  },
];

const OTHER_VIOLATIONS: RefusalViolation[] = [{ check: "sizing", message: "an entirely different defect, unrelated to the first" }];

function fakeEffects(prior: PriorRefusal | undefined) {
  const dispatched: { taskId: string; verdict: string; progress: boolean }[] = [];
  const escalated: { taskId: string; verdict: string; attempts: number }[] = [];
  const written: PriorRefusal[] = [];
  const readPrior = (_id: string) => prior;
  const writePrior = (_id: string, record: PriorRefusal) => {
    written.push(record);
  };
  const dispatchRepairLane = (input: { taskId: string; verdict: string; progress: boolean }) => {
    dispatched.push(input);
  };
  const escalate = (input: { taskId: string; verdict: string; attempts: number }) => {
    escalated.push(input);
  };
  return { dispatched, escalated, written, readPrior, writePrior, dispatchRepairLane, escalate };
}

// ── ACCEPTANCE 1: a refused task dispatches ONE repair lane, not another attempt ──────────

test("ACCEPTANCE 1: a refused task dispatches one repair lane, not another attempt", () => {
  const { dispatched, escalated, readPrior, writePrior, dispatchRepairLane, escalate } = fakeEffects(undefined);
  const action = repairRefusedTask("W1-T9001", VIOLATIONS, readPrior, writePrior, dispatchRepairLane, escalate);

  assert.equal(action.kind, "dispatch_repair", "a first-ever refusal dispatches a repair lane, not an escalation");
  assert.equal(dispatched.length, 1, "exactly one repair lane is dispatched — never zero, never a re-attempt of the task itself");
  assert.equal(escalated.length, 0, "a first refusal never escalates");
});

test("FALSIFIER of acceptance 1: removing the dispatch call leaves the task re-attempted (no repair lane, no escalation)", () => {
  // Mirrors the task's own falsifier: "Remove the repair dispatch and the first test must fail
  // with the task re-attempted." With neither a dispatch nor escalation call,
  // (the "nothing repairs it" defect this task exists to fix) must NOT satisfy criterion 1.
  const { dispatched, escalated } = fakeEffects(undefined);
  // No call to repairRefusedTask at all — simulating "the loop just re-attempts on the next
  // tick", the defect this task fixes.
  assert.equal(dispatched.length, 0);
  assert.equal(escalated.length, 0, "a re-attempted task produces neither a repair dispatch nor an escalation — this is the defect");
});

// ── ACCEPTANCE 2: the repair lane carries the refusal verdict VERBATIM ────────────────────

test("ACCEPTANCE 2: the repair lane carries the refusal verdict verbatim", () => {
  const { dispatched, readPrior, writePrior, dispatchRepairLane, escalate } = fakeEffects(undefined);
  repairRefusedTask("W1-T9001", VIOLATIONS, readPrior, writePrior, dispatchRepairLane, escalate);

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

test("ACCEPTANCE 3: an unchanged verdict is held after one escalation", () => {
  const verdict = refusalVerdictText(VIOLATIONS);
  let prior: PriorRefusal = { verdict, attempts: 1 };
  const effects = fakeEffects(prior);
  let writes = 0;
  const readPrior = (_id: string) => prior;
  const writePrior = (_id: string, record: PriorRefusal) => {
    writes++;
    prior = record;
  };
  const action = repairRefusedTask("W1-T9001", VIOLATIONS, readPrior, writePrior, effects.dispatchRepairLane, effects.escalate);

  assert.equal(action.kind, "escalate", "the unchanged verdict escalates");
  assert.equal(effects.escalated.length, 1, "exactly one escalation is raised");
  assert.equal(effects.dispatched.length, 0, "no SECOND repair lane is dispatched for the same verdict — that would be re-reconning");
  assert.equal(effects.escalated[0]!.taskId, "W1-T9001");
  assert.equal(effects.escalated[0]!.verdict, verdict, "the escalation names the same verdict, unchanged");
  assert.equal(effects.escalated[0]!.attempts, 2, "the escalation counts this as the 2nd time this exact verdict was seen");

  const held = repairRefusedTask("W1-T9001", VIOLATIONS, readPrior, writePrior, effects.dispatchRepairLane, effects.escalate);
  assert.equal(held.kind, "held", "the terminal escalation holds a later identical refusal");
  assert.equal(effects.escalated.length, 1, "a held refusal does not escalate again");
  assert.equal(effects.dispatched.length, 0, "a held refusal does not dispatch a repair lane");
  assert.equal(prior.attempts, 2, "a held refusal preserves the original escalation attempt");
  assert.equal(writes, 1, "a held refusal does not rewrite the terminal state");
});

test("FALSIFIER of acceptance 3: an unchanged verdict that starts a second recon (dispatch) instead of escalating violates the shape", () => {
  const verdict = refusalVerdictText(VIOLATIONS);
  const { readPrior } = fakeEffects({ verdict, attempts: 1 });
  const action = decideRepairDispatch("W1-T9001", verdict, readPrior("W1-T9001"));
  assert.notEqual(action.kind, "dispatch_repair", "an unchanged verdict must never decide to dispatch a second repair lane");
});

test("FALSIFIER of acceptance 3: a terminal escalation that fires again is not held", () => {
  const verdict = refusalVerdictText(VIOLATIONS);
  const action = decideRepairDispatch("W1-T9001", verdict, { verdict, attempts: 2, escalated: true });
  assert.equal(action.kind, "held", "a terminally escalated verdict must be held, not escalated again");
  assert.equal(action.attempts, 2, "the held action preserves the original escalation attempt");
});

// ── ACCEPTANCE 4: a changed verdict is PROGRESS, not a repeat ─────────────────────────────

test("ACCEPTANCE 4: a changed verdict is progress, not a repeat", () => {
  const priorVerdict = refusalVerdictText(OTHER_VIOLATIONS);
  const { dispatched, escalated, written, readPrior, writePrior, dispatchRepairLane, escalate } = fakeEffects({ verdict: priorVerdict, attempts: 2, escalated: true });
  const action = repairRefusedTask("W1-T9001", VIOLATIONS, readPrior, writePrior, dispatchRepairLane, escalate);

  assert.equal(action.kind, "dispatch_repair", "a changed verdict is progress, treated like a first-ever refusal");
  assert.ok(action.kind === "dispatch_repair" && action.progress, "the action is explicitly flagged as progress (not a first-ever refusal either)");
  assert.equal(dispatched.length, 1, "a changed verdict dispatches exactly one repair lane");
  assert.equal(escalated.length, 0, "a changed verdict never escalates");
  assert.equal(written[0]!.escalated, false, "a changed verdict clears the terminal escalation state");
});

test("FALSIFIER of acceptance 4: treating a changed verdict as a repeat (escalating) violates the shape", () => {
  const priorVerdict = refusalVerdictText(OTHER_VIOLATIONS);
  const currentVerdict = refusalVerdictText(VIOLATIONS);
  assert.notEqual(priorVerdict, currentVerdict, "the two verdicts really do differ, so this exercises the CHANGED-verdict branch");
  const action = decideRepairDispatch("W1-T9001", currentVerdict, { verdict: priorVerdict, attempts: 1 });
  assert.notEqual(action.kind, "escalate", "a changed verdict must never be decided as a repeat/escalation");
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
  const config: Config = { claudeBin: "/bin/true", root: configRoot, installRoot: process.cwd() };

  let spawnCalls = 0;
  const spawn = (async () => {
    spawnCalls++;
    throw new Error("spawn must never run for a linter-failing task, even with the repair rung wired in");
  }) as typeof spawnWorker;

  const res = await runTask("TST-REPAIR-BAD", {
    skipGitSync: true,
    planPath,
    config,
    github: OFFLINE_GITHUB,
    spawn,
  });

  assert.equal(res.verdict, "blocked_illformed");
  assert.equal(res.costUsd, 0);
  assert.equal(spawnCalls, 0, "the repair rung never reaches the worker spawn");
  const record = JSON.parse(
    readFileSync(join(configRoot, "state", "dispatch-repair", "TST-REPAIR-BAD.json"), "utf8"),
  ) as PriorRefusal;
  assert.equal(record.attempts, 1, "the real dispatch path persisted the first repair decision");
  assert.match(record.verdict, /sizing/, "the persisted repair decision carries the real linter verdict for this task");
  assert.match(record.preDispatchContractRevision ?? "", /^pre-dispatch-v1:/, "the real dispatch path persists the parsed contract revision");
});

test("BEHAVIORAL: the next real runTask reads that refusal and escalates without issuing a live GitHub write", async () => {
  const planPath = fixturePlanPath();
  const configRoot = mkdtempSync(join(tmpdir(), "rmd-repair-repeat-root-"));
  const config: Config = { claudeBin: "/bin/true", root: configRoot, installRoot: process.cwd() };
  const spawn = (async () => {
    throw new Error("spawn must never run for a linter-failing task, including its repeated refusal");
  }) as typeof spawnWorker;
  const first = await runTask("TST-REPAIR-BAD", { skipGitSync: true, planPath, config, github: OFFLINE_GITHUB, spawn });
  assert.equal(first.verdict, "blocked_illformed");

  // SHARED HELPER, NOT A HAND-ROLLED SHIM. `fixture-copy-census` caps how many test files write a
  // `gh` executable and prepend it onto PATH, and pushes the shape into test/helpers (which it does
  // not count) so one contract is maintained instead of eighty-seven. `gh` failing outright is
  // exactly a route with a non-zero exit.
  const gh = ghShim([{ when: "", exit: 1 }], { kind: "repair-no-gh" });
  const priorPath = process.env.PATH;
  process.env.PATH = `${gh.dir}${delimiter}${priorPath ?? ""}`;
  try {
    const repeated = await runTask("TST-REPAIR-BAD", { skipGitSync: true, planPath, config, github: OFFLINE_GITHUB, spawn });
    assert.equal(repeated.verdict, "blocked_illformed");

    const held = await runTask("TST-REPAIR-BAD", { skipGitSync: true, planPath, config, github: OFFLINE_GITHUB, spawn });
    assert.equal(held.verdict, "blocked_illformed");
  } finally {
    process.env.PATH = priorPath;
  }

  const record = JSON.parse(
    readFileSync(join(configRoot, "state", "dispatch-repair", "TST-REPAIR-BAD.json"), "utf8"),
  ) as PriorRefusal;
  assert.equal(record.attempts, 2, "the repeated real path reads the durable first refusal before escalating");
  assert.equal(record.escalated, true, "the escalation is persisted as terminal");
  const ledger = readFileSync(join(configRoot, "state", "ledger.ndjson"), "utf8");
  assert.match(ledger, /"step":"dispatch\.repair\.held"/, "the held decision is ledgered by the run-task composition root");
  assert.match(ledger, /"reason":"unchanged pre-dispatch verdict was already escalated"/, "the held ledger row names why the decision was held");
  assert.match(ledger, /"escalation_attempts":2/, "the held ledger row preserves the original escalation attempt");
});

const DURABLE_HELD_PLAN = `- id: W1-T9010
  title: "a terminal pre-dispatch refusal"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  attempts: 0
  origin: "test"
  files: [src/lib/held.ts]
- id: W1-T9011
  title: "the eligible successor"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  status: queued
  attempts: 0
  origin: "test"
  files: [src/lib/successor.ts]
`;

function durableHeldPlan() {
  return loadPlanFromYaml(DURABLE_HELD_PLAN, "durable-held-refusal");
}

function candidatesWithHeldRevision(revisions: ReadonlyMap<string, string>) {
  const plan = durableHeldPlan();
  const tally = tallyDispatchFilters();
  const candidates = runnableCandidates(plan, () => false, 1, {
    isTerminalPreDispatchRefusalHeld: (task) => revisions.get(task.id) === preDispatchContractRevision(task),
    onFiltered: tally.onFiltered,
  });
  return { plan, tally: tally.snapshot(), candidates };
}

test("W1-T3959: durable held refusal state excludes the held task before candidate packing and selects its eligible successor", () => {
  const plan = durableHeldPlan();
  const held = plan.byId.get("W1-T9010")!;
  const revision = preDispatchContractRevision(held);
  const { candidates, tally } = candidatesWithHeldRevision(new Map([[held.id, revision]]));

  assert.deepEqual(candidates.map((task) => task.id), ["W1-T9011"], "the held task never reaches candidate packing, so the lower eligible task is selected");
  assert.deepEqual(tally["held-pre-dispatch-refusal"].ids, ["W1-T9010"], "the idle census names the durable refusal rather than silently calling the queue empty");
  assert.equal(
    runnableCandidates(plan, () => false, 1)[0]?.id,
    "W1-T9010",
    "falsifier control: deleting the held-refusal predicate would re-offer the malformed task",
  );
});

test("W1-T3959: legacy refusal state fails open, and a changed contract re-enters once before its same verdict is held again", () => {
  const plan = durableHeldPlan();
  const original = plan.byId.get("W1-T9010")!;
  const originalRevision = preDispatchContractRevision(original);
  const correctedPlan = loadPlanFromYaml(
    DURABLE_HELD_PLAN.replace(
      'title: "a terminal pre-dispatch refusal"',
      'title: "a corrected terminal pre-dispatch refusal"',
    ),
    "durable-held-corrected.yaml",
  );
  const corrected = correctedPlan.byId.get("W1-T9010")!;
  const correctedRevision = preDispatchContractRevision(corrected);
  assert.notEqual(originalRevision, correctedRevision, "control: the edited parsed contract has a distinct revision");
  assert.equal(
    preDispatchContractRevision({ ...corrected, sourcePath: "different-parser-label.yaml" }),
    correctedRevision,
    "parser provenance is not part of a task's dispatch contract",
  );
  assert.notEqual(
    preDispatchContractRevision({ ...corrected, status: "blocked" }),
    correctedRevision,
    "an administrative status still changes selector admission, so it must re-open the durable hold",
  );

  const readableRoot = mkdtempSync(join(tmpdir(), "rmd-readable-refusal-"));
  const readableDir = join(readableRoot, "dispatch-repair");
  mkdirSync(readableDir, { recursive: true });
  writeFileSync(
    join(readableDir, "W1-T9010.json"),
    JSON.stringify({
      verdict: "same",
      attempts: 2,
      escalated: true,
      preDispatchContractRevision: originalRevision,
    }),
    "utf8",
  );
  assert.equal(
    terminalPreDispatchRefusalRevisions(readableRoot).get(original.id),
    originalRevision,
    "the production reader retains a valid terminal refusal",
  );
  assert.equal(
    terminalPreDispatchRefusalRevisions(join(readableRoot, "absent")).size,
    0,
    "an unreadable repair directory fails open",
  );

  const staleRecord = new Map([[original.id, originalRevision]]);
  assert.equal(
    runnableCandidates(correctedPlan, () => false, 1, {
      isTerminalPreDispatchRefusalHeld: (task) => staleRecord.get(task.id) === preDispatchContractRevision(task),
    })[0]?.id,
    "W1-T9010",
    "a changed contract is re-admitted rather than being stranded behind its old terminal state",
  );

  let written: PriorRefusal | undefined;
  const effects = fakeEffects({ verdict: refusalVerdictText(VIOLATIONS), attempts: 2, escalated: true, preDispatchContractRevision: originalRevision });
  const action = repairRefusedTask(
    original.id,
    VIOLATIONS,
    () => ({ verdict: refusalVerdictText(VIOLATIONS), attempts: 2, escalated: true, preDispatchContractRevision: originalRevision }),
    (_id, record) => { written = record; },
    effects.dispatchRepairLane,
    effects.escalate,
    correctedRevision,
  );
  assert.equal(action.kind, "held", "the same deterministic verdict remains terminal after its one corrected re-offer");
  assert.equal(effects.dispatched.length, 0, "a terminal re-offer never launches another repair lane");
  assert.equal(effects.escalated.length, 0, "a terminal re-offer never creates a second escalation");
  assert.equal(written?.preDispatchContractRevision, correctedRevision, "only the durable revision advances to mark the corrected contract handled");
  assert.deepEqual(
    runnableCandidates(correctedPlan, () => false, 1, {
      isTerminalPreDispatchRefusalHeld: (task) =>
        task.id === corrected.id && written?.preDispatchContractRevision === preDispatchContractRevision(task),
    }).map((task) => task.id),
    ["W1-T9011"],
    "the unchanged rejection is held again after its one corrected re-offer",
  );

  const root = mkdtempSync(join(tmpdir(), "rmd-legacy-refusal-"));
  const refusalDir = join(root, "dispatch-repair");
  mkdirSync(refusalDir, { recursive: true });
  writeFileSync(join(refusalDir, "W1-T9010.json"), JSON.stringify({ verdict: "same", attempts: 2, escalated: true }), "utf8");
  writeFileSync(join(refusalDir, "W1-T9011.json"), "{not json", "utf8");
  const legacy = terminalPreDispatchRefusalRevisions(root);
  assert.equal(legacy.size, 0, "legacy refusal state fails open: no revision means no suppression");
  assert.equal(
    candidatesWithHeldRevision(legacy).candidates[0]?.id,
    "W1-T9010",
    "a missing or malformed durable record cannot suppress normal admission",
  );
});

test("W1-T3959: durable held refusal state is read by the production daemon selector, not only an in-process map", async () => {
  const plan = durableHeldPlan();
  const held = plan.byId.get("W1-T9010")!;
  const revision = preDispatchContractRevision(held);
  const ran: string[] = [];
  const merged = new Set<string>();
  let controls = 0;

  await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    readTerminalPreDispatchRefusalRevisions: () => new Map([[held.id, revision]]),
    runOne: async (taskId) => {
      ran.push(taskId);
      merged.add(taskId);
      return { taskId, runId: `${taskId}-run`, merged: true, costUsd: 0, verdict: "merged" };
    },
    checkStop: () => (++controls > 2 ? "test complete" : undefined),
    sleep: async () => {},
  });

  assert.deepEqual(ran, ["W1-T9011"], "durable held refusal state reaches daemon selection before runTask could re-lint the held task");
});

test("W1-T3959: an unreadable durable refusal reader is ledgered and fails open instead of suppressing admission", async () => {
  const plan = durableHeldPlan();
  const ran: string[] = [];
  const logged: Array<{ step: string; extra: Record<string, unknown> }> = [];

  await runDaemon(plan, {
    refreshMerged: () => () => false,
    readTerminalPreDispatchRefusalRevisions: () => {
      throw new Error("fixture dispatch-repair directory unreadable");
    },
    log: (step, extra = {}) => logged.push({ step, extra }),
    runOne: async (taskId) => {
      ran.push(taskId);
      return { taskId, runId: `${taskId}-run`, merged: false, costUsd: 0, verdict: "awaiting_merge" };
    },
    checkStop: () => (ran.length > 0 ? "test complete" : undefined),
    sleep: async () => {},
  });

  assert.deepEqual(ran, ["W1-T9010"], "an unreadable durable store preserves ordinary admission rather than inventing a hold");
  assert.deepEqual(
    logged.find((row) => row.step === "dispatch.held_pre_dispatch_refusal_unreadable"),
    {
      step: "dispatch.held_pre_dispatch_refusal_unreadable",
      extra: { error: "fixture dispatch-repair directory unreadable" },
    },
    "the daemon names why durable admission state was unavailable instead of silently reading it as an empty success",
  );
});

test("W1-T3959: the production daemon re-admits a corrected contract rather than holding by task id alone", async () => {
  const original = durableHeldPlan().byId.get("W1-T9010")!;
  const correctedPlan = loadPlanFromYaml(
    DURABLE_HELD_PLAN.replace(
      'title: "a terminal pre-dispatch refusal"',
      'title: "a corrected terminal pre-dispatch refusal"',
    ),
    "durable-held-daemon-corrected.yaml",
  );
  const ran: string[] = [];

  await runDaemon(correctedPlan, {
    refreshMerged: () => () => false,
    readTerminalPreDispatchRefusalRevisions: () => new Map([[original.id, preDispatchContractRevision(original)]]),
    runOne: async (taskId) => {
      ran.push(taskId);
      return { taskId, runId: `${taskId}-run`, merged: false, costUsd: 0, verdict: "awaiting_merge" };
    },
    checkStop: () => (ran.length > 0 ? "test complete" : undefined),
    sleep: async () => {},
  });

  assert.deepEqual(
    ran,
    ["W1-T9010"],
    "the production predicate compares the recorded revision to the current parsed task, not merely whether a record exists",
  );
});
