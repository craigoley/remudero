/**
 * W1-T1029: "a task the operator completes by hand can never satisfy a credit-based
 * depends_on, so it parks every task behind it forever."
 *
 * Four records are structurally uncreditable through today's precedence rungs: W1-T12d
 * and W1-T13 (a same-repo `pr:` field would credit them, they simply don't carry one —
 * the operator's existing workaround, not this task's concern) and W1-T12e/W12-T1, which
 * CANNOT use `task.pr` at all — W1-T12e never produces a PR (a live commissioning drill,
 * not a diff), and W12-T1's PR lives in `remudero-site`, unreachable by a bare number
 * through a gateway scoped to one repo.
 *
 * The fix widens the EXISTING hand-execution rung (source `"pr-field"`, `task.pr`) rather
 * than inventing a new channel: `deriveStatus` now also reads a `manual.completed` ledger
 * line (`latestManualCompletion`, src/lib/status.ts), which can name a PR in ANY repository
 * (a full URL, self-describing its own owner/repo) or name none at all — both DECLARED
 * credit, like the correction rung, never re-verified against GitHub, because there is no
 * live read this rung could perform even if it wanted to.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Plan, Task } from "../src/lib/plan.js";
import { nextRunnable } from "../src/lib/drain.js";
import { deriveStatus, type GitHub } from "../src/lib/status.js";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger, rotateLedger } from "../src/lib/ledger.js";

/** A minimal task; fields not under test get sensible defaults. */
function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-T-MANUAL",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "manual",
    risk: "medium",
    verify: "auto",
    status: "queued",
    attempts: 0,
    ...over,
  };
}

function planOf(...tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "manual-completion-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

/**
 * A gateway that THROWS on every method — the SAME structural proof
 * correction-supremacy.test.ts uses for the correction rung: a task credited through this
 * rung must derive `merged` with the gateway never even consulted, which is the whole point
 * for a cross-repo PR (there is no in-repo call that could resolve it) and a no-PR
 * completion (there is nothing to look up at all).
 */
function throwingGithub(): GitHub {
  const boom = (name: string): never => {
    throw new Error(`gateway must never be consulted for a manual-completion-credited task (called ${name})`);
  };
  return {
    prByRef: () => boom("prByRef"),
    findMergedByTrailer: () => boom("findMergedByTrailer"),
    headRefName: () => boom("headRefName"),
    prBody: () => boom("prBody"),
  };
}

/** A HEALTHY gateway that finds no evidence anywhere — the ordinary "nothing to report" case,
 *  never throttled. Used for the negative-control task, which must fall through to
 *  `source: "none"` rather than throwing or reading indeterminate. */
function emptyGithub(): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

test("W1-T1029: a completion pr in another repo satisfies a credit based dependency", () => {
  const t = task({ id: "W12-T1", repo: "remudero-site" });
  const other = task({ id: "W1-T-DOWNSTREAM", repo: "remudero", type: "implement", depends_on: [t.id] });
  const crossRepoUrl = "https://github.com/craigoley/remudero-site/pull/45";
  const ledgerPath = ledgerFile([
    { step: "manual.completed", task_id: t.id, actor: "operator:craig", ts: "2026-08-19T09:00:00.000Z", pr_url: crossRepoUrl },
  ]);
  const github = throwingGithub();

  const proj = deriveStatus(t, { ledgerPath, github });
  assert.equal(proj.merged, true, "a completion PR named in ANOTHER repo must credit the task");
  assert.equal(proj.source, "manual-completion");
  assert.equal(proj.prUrl, crossRepoUrl);
  assert.equal(proj.prNumber, 45);

  // THE ACTUAL DEPENDENCY-GATING PROOF: a sibling task depending on W12-T1 was parked behind
  // it before this credit existed (structurally uncreditable via `task.pr`, a bare number that
  // resolves only against THIS gateway's own repo) — it is now dispatchable. The DOWNSTREAM
  // task's own (legitimate, non-crediting) reads use a healthy empty gateway — only W12-T1
  // itself must resolve with zero gateway calls, already proven by `proj` above.
  const plan = planOf(t, other);
  const isMerged = (id: string) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github: id === t.id ? github : emptyGithub() }).merged;
  const runnable = nextRunnable(plan, isMerged);
  assert.equal(runnable?.id, other.id, "the cross-repo credit must unpark the task depending on it");
});

test("W1-T1029: a manual task with no pr at all can be asserted complete", () => {
  const t = task({ id: "W1-T12E", type: "manual" });
  const other = task({ id: "W1-T-DOWNSTREAM-2", type: "implement", depends_on: [t.id] });
  const ledgerPath = ledgerFile([
    { step: "manual.completed", task_id: t.id, actor: "operator:craig", ts: "2026-08-19T10:00:00.000Z" },
  ]);
  const github = throwingGithub();

  const proj = deriveStatus(t, { ledgerPath, github });
  assert.equal(proj.merged, true, "an actor+time assertion with no PR at all must still credit the task");
  assert.equal(proj.source, "manual-completion");
  assert.equal(proj.prUrl, undefined, "there is no PR to name — the field stays absent, never fabricated");
  assert.equal(proj.prNumber, undefined);

  const plan = planOf(t, other);
  const isMerged = (id: string) => deriveStatus(plan.byId.get(id)!, { ledgerPath, github: id === t.id ? github : emptyGithub() }).merged;
  const runnable = nextRunnable(plan, isMerged);
  assert.equal(runnable?.id, other.id, "a no-PR completion must unpark the task depending on it");
});

test("W1-T1029: a task with no assertion still reads unmerged in the same run", () => {
  const asserted = task({ id: "W1-T-ASSERTED" });
  const unasserted = task({ id: "W1-T-UNASSERTED" });
  // Both tasks share ONE ledger/run — the falsifier the acceptance criterion names: an
  // implementation that credits every task once ANY assertion exists in the ledger would
  // pass every other test here and still be wrong.
  const ledgerPath = ledgerFile([
    { step: "manual.completed", task_id: asserted.id, actor: "operator:craig", ts: "2026-08-19T11:00:00.000Z" },
  ]);
  const github = emptyGithub();

  const creditedProj = deriveStatus(asserted, { ledgerPath, github });
  assert.equal(creditedProj.merged, true);
  assert.equal(creditedProj.source, "manual-completion");

  const uncreditedProj = deriveStatus(unasserted, { ledgerPath, github });
  assert.equal(uncreditedProj.merged, false, "no assertion for THIS task id — must not be credited");
  assert.equal(uncreditedProj.source, "none", "resolves its own source, distinct from the credited task's");
});

test("W1-T1029: the completion step survives a ledger rotation", () => {
  const dir = mkdtempSync(join(tmpdir(), "manual-completion-rotation-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const t = task({ id: "W1-T-ROTATION-SURVIVES" });

  // Registered so a rotation cannot silently re-park every task behind it — the grep-checkable
  // half of this same claim.
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("manual.completed"),
    "the completion step must be registered in DECISION_RELEVANT_LEDGER_STEPS",
  );

  appendLedger(ledgerPath, { run_id: "r1", task_id: t.id, step: "manual.completed", actor: "operator:craig" });
  // Pad well past a small ceiling with ordinary noise (unrelated, non-decision-relevant polling
  // lines) so the rotation actually has something to archive — mirrors
  // test/breaker-survives-rotation.test.ts's own shape.
  for (let i = 0; i < 40; i++) {
    appendLedger(ledgerPath, { run_id: "r1", task_id: "W1-NOISE", step: "ci.polling", detail: "x".repeat(64) });
  }

  const result = rotateLedger(ledgerPath, { ceilingBytes: 512 });
  assert.equal(result.rotated, true, "sanity: the padded ledger actually crossed the tiny ceiling");

  const proj = deriveStatus(t, { ledgerPath, github: throwingGithub() });
  assert.equal(proj.merged, true, "the completion assertion must survive rotation intact");
  assert.equal(proj.source, "manual-completion");
});
