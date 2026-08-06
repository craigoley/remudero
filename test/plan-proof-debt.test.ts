/**
 * test/plan-proof-debt.test.ts — W1-T369.
 *
 * THE DEBT: 39 OPEN, UNMERGED tasks in plan/tasks.yaml (the pre-shard monolith) carried a
 * `proof:` that could not execute — free prose, a near-miss dialect prefix ("integration test:"),
 * or a `unit test:`/`grep:` prefix naming no resolvable artifact. RE-DERIVED at implementation
 * time (design note (vi) — the population is computed, not filed), the population had already
 * moved to 11 open+unmerged tasks carrying a proof-dialect/proof-resolvability BLOCKING
 * violation: 6 verify:auto (rewritten by this PR — see plan/tasks.yaml's diff) and 5
 * verify:human (left untouched per design note (iv); reported below, never forced into a
 * dialect the harness will never execute).
 *
 * THIS FILE IS THE LOCK, not a one-off audit. It proves the SAME thing three ways:
 *
 *   (i)   FIXTURE-DRIVEN MECHANISM TESTS (no git, no live plan) — deterministic, always run
 *         regardless of CI checkout depth. These prove {@link deriveProofDebtPopulation} and
 *         {@link evaluateProofDebtRatchet} do what they claim: open+unmerged+verify:auto debt is
 *         caught; a MERGED-elsewhere task (W1-T370's population) is excluded; a non-open
 *         (blocked/merged/done) record is excluded; a verify:human task is excluded from the
 *         must-fix set and reported instead; a synthetic regression above the recorded ceiling
 *         is REJECTED.
 *   (ii)  A CANDIDATE-RESOLUTION CHECK against the REAL fixed proofs — {@link
 *         proofResolvesToCandidate} runs the SAME parseWhitelistedProof/resolveNameFilteredCandidates
 *         the reviewer's own executor runs (never a reimplementation), so "resolves to at least
 *         one candidate" is checked by filesystem fact, not by lint-shape alone.
 *   (iii) A LIVE-PLAN RATCHET against this repo's own plan/tasks.yaml, git-log merge evidence
 *         supplied by {@link defaultMergeEvidenceLog} (src/run-task.ts — the SAME offline,
 *         no-network reader `rmd lint-plan`'s whole-plan mode uses to print its own
 *         "N with a merged implementation, M with none" split). FAILS OPEN on a shallow checkout
 *         (this repo's `ci` job's default `fetch-depth`, unlike `coverage-ratchet`'s `fetch-depth:
 *         0`) — exactly the posture `lintPlanCommand` itself already takes (`statusResolvable`),
 *         and the same branch `test/lint-plan-merge-evidence.test.ts`'s own real-reader test
 *         already takes on this repo. A shallow checkout cannot tell open+unmerged debt apart
 *         from the 136-task merged-elsewhere population (W1-T370's, not this task's), so asserting
 *         on the undifferentiated set would fail this job on debt this task never claimed.
 *
 * NO NEW SOURCE FILE. This task's declared `files:` are `[plan/tasks.yaml,
 * test/plan-proof-debt.test.ts]` only — the ratchet (a pure function mirroring the house
 * `scripts/*-ratchet.mjs` convention) is inlined here rather than split into its own
 * scripts/*.mjs + baseline.json pair, because there is no second declared file to hold it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlan, type Task, type TaskStatus } from "../src/lib/plan.js";
import { proofDialectViolations, proofResolvabilityViolations, type LintViolation } from "../src/lib/task-linter.js";
import { parseWhitelistedProof, resolveNameFilteredCandidates } from "../src/lib/review.js";
import { classifyFailingMergeEvidence, defaultMergeEvidenceLog } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHIPPED_PLAN_PATH = join(REPO_ROOT, "plan", "tasks.yaml");

// ── the pure mechanism, mirroring the house scripts/*-ratchet.mjs shape ─────────────────────

/** W1-T324's own open/closed line: a `blocked`/`merged`/`done` record is retired or landed, not
 *  live queue debt. Deliberately re-declared here (three literals) rather than imported: the
 *  real `isOpenLintTask` is unexported and local to src/run-task.ts, and duplicating a 3-value
 *  Set carries none of the drift risk a re-implemented ALGORITHM would. */
const NON_OPEN_STATUSES = new Set<TaskStatus>(["blocked", "merged", "done"]);
function isOpenTask(t: Pick<Task, "status">): boolean {
  return !NON_OPEN_STATUSES.has(t.status);
}

/** Every BLOCKING proof-dialect/proof-resolvability violation on `task` — the SAME two checks
 *  `rmd lint-plan` runs at their BLOCK default (no `opts` override, matching CI, never the
 *  pre-dispatch call site's warn-demoted knob). */
function proofDebtViolations(task: Task): LintViolation[] {
  return [...proofDialectViolations(task), ...proofResolvabilityViolations(task)].filter(
    (v) => v.severity === "block",
  );
}

export interface ProofDebtPopulation {
  /** Open task ids with NO merge evidence in `gitLogDump` — the population this task owns. */
  openUnmergedIds: string[];
  /** Open+unmerged verify:auto tasks carrying >=1 BLOCKING proof-dialect/resolvability
   *  violation — MUST be empty; this is the ratchet's counted set. */
  autoBlockingIds: string[];
  /** Open+unmerged verify:human tasks carrying the same class of violation — EXCLUDED from the
   *  must-fix set by design (a `verify:human` task's proof is never rewritten into a dialect the
   *  harness will never execute), reported here by id+count rather than silently dropped. */
  humanBlockingIds: string[];
}

/** The population this task's acceptance criteria are ABOUT: open (status not
 *  blocked/merged/done) tasks with no merge evidence in `gitLogDump`, split by whether their
 *  BLOCKING proof-dialect/proof-resolvability violations are on a verify:auto task (must be
 *  fixed) or a verify:human one (excluded, reported). Pure over its inputs — mirrors
 *  `classifyFailingMergeEvidence` (src/run-task.ts), which this function calls rather than
 *  re-implements. */
export function deriveProofDebtPopulation(tasks: readonly Task[], gitLogDump: string): ProofDebtPopulation {
  const openIds = tasks.filter(isOpenTask).map((t) => t.id);
  const { without } = classifyFailingMergeEvidence(openIds, gitLogDump);
  const unmergedIds = new Set(without);
  const autoBlockingIds: string[] = [];
  const humanBlockingIds: string[] = [];
  for (const t of tasks) {
    if (!unmergedIds.has(t.id)) continue;
    if (proofDebtViolations(t).length === 0) continue;
    (t.verify === "human" ? humanBlockingIds : autoBlockingIds).push(t.id);
  }
  return { openUnmergedIds: [...unmergedIds], autoBlockingIds, humanBlockingIds };
}

export interface RatchetVerdict {
  ok: boolean;
  count: number;
  ceiling: number;
  message: string;
}

/** The ratchet: FAILS when `offendingIds.length` rises above `ceiling` — the recorded count of
 *  open+unmerged verify:auto tasks this repo tolerates carrying a proof that cannot execute.
 *  Mirrors the house `scripts/*-ratchet.mjs` `evaluateRatchet` convention (a pure comparison,
 *  never re-measuring anything itself) but inlined per this file's own header — no second
 *  declared file to hold a standalone script. */
export function evaluateProofDebtRatchet(offendingIds: readonly string[], ceiling: number): RatchetVerdict {
  const count = offendingIds.length;
  const ok = count <= ceiling;
  const message = ok
    ? `OK — ${count} open+unmerged verify:auto proof-debt task(s), at or under the ceiling of ${ceiling}`
    : `BLOCKED — ${count} open+unmerged verify:auto proof-debt task(s) exceeds the ceiling of ${ceiling}: ${offendingIds.join(", ")}`;
  return { ok, count, ceiling, message };
}

/** Recorded 2026-08-06 by W1-T369, which drove the open+unmerged verify:auto population to
 *  zero. Raising this is a deliberate, reviewed change — never lower it to make a red PR pass,
 *  and never raise it silently to let new debt back in (mirrors coverage-ratchet's own floor
 *  discipline, MASTER-PLAN §5 TIER 2). */
export const PROOF_DEBT_CEILING = 0;

// ── candidate resolution — the SAME parse+resolve the reviewer's own executor runs ──────────

/** True iff `proofText` parses as the executable dialect AND resolves to a real, ON-DISK
 *  candidate — a literal `unit test:` path, a name-filtered `unit test:` title matching >=1 real
 *  file, or a `grep:` proof's `in <path>` clause naming a real path. Reuses
 *  parseWhitelistedProof/resolveNameFilteredCandidates (src/lib/review.ts) — the SAME functions
 *  `rmd check-proof` and the reviewer's executor call — so this can never disagree with what
 *  actually runs at review time. */
export function proofResolvesToCandidate(repoRoot: string, proofText: string): boolean {
  const w = parseWhitelistedProof(proofText);
  if (!w) return false;
  if (w.kind === "test") {
    if (w.nameFiltered) {
      const r = resolveNameFilteredCandidates(repoRoot, w.label);
      return r.status === "resolved" && r.files.length > 0;
    }
    return existsSync(join(repoRoot, w.label));
  }
  // grep: args = [flags, "--", pattern, path] — the same shape proofScopePath (task-linter.ts)
  // reads to find the path a grep proof names.
  const path = w.args[1] === "--" ? w.args[3] : undefined;
  return path !== undefined && existsSync(join(repoRoot, path));
}

// ── (i) fixture-driven mechanism tests — deterministic, no git, no live plan ────────────────

function fixtureTask(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    title: overrides.id,
    repo: "remudero",
    depends_on: [],
    type: "implement",
    verify: "auto",
    principles: {},
    budget_usd: 10,
    risk: "low",
    origin: "architect",
    status: "queued",
    attempts: 0,
    acceptance: [{ claim: "a fixture claim", proof: "unit test: test/plan-proof-debt.test.ts" }],
    ...overrides,
  } as Task;
}

/** `%s%x00%b%x01` — the exact wire shape `defaultMergeEvidenceLog` produces, so the fixture
 *  tests drive `classifyFailingMergeEvidence` over the real format (mirrors
 *  test/lint-plan-merge-evidence.test.ts's own `dumpOf`). */
function dumpOf(...entries: Array<[subject: string, body?: string]>): string {
  return entries.map(([s, b]) => `${s}\x00${b ?? ""}`).join("\x01") + "\x01";
}

test("deriveProofDebtPopulation: an open, unmerged, verify:auto task with a free-prose proof is caught in autoBlockingIds", () => {
  const bad = fixtureTask({ id: "W9-T1", acceptance: [{ claim: "x", proof: "trust me, it works" }] });
  const population = deriveProofDebtPopulation([bad], dumpOf());
  assert.deepEqual(population.autoBlockingIds, ["W9-T1"]);
  assert.deepEqual(population.humanBlockingIds, []);
});

test("deriveProofDebtPopulation: an open, unmerged, verify:auto task with a CLEAN whole-file proof is NOT flagged", () => {
  const clean = fixtureTask({ id: "W9-T2" }); // default fixture proof is the pure-path form
  const population = deriveProofDebtPopulation([clean], dumpOf());
  assert.deepEqual(population.autoBlockingIds, []);
});

test("deriveProofDebtPopulation: a MERGED-elsewhere task (git-log evidence present) is EXCLUDED even with a bad proof — W1-T370's population, not this task's", () => {
  const bad = fixtureTask({ id: "W9-T3", acceptance: [{ claim: "x", proof: "prose, not a dialect" }] });
  const dump = dumpOf(["feat(x): ship it (#1)", "body\n\nRemudero-Task: W9-T3"]);
  const population = deriveProofDebtPopulation([bad], dump);
  assert.deepEqual(population.autoBlockingIds, [], "merged evidence must remove the task from this population");
  assert.deepEqual(population.openUnmergedIds, []);
});

test("deriveProofDebtPopulation: a non-open (blocked/merged/done) record is EXCLUDED even with a bad proof and no merge evidence", () => {
  for (const status of ["blocked", "merged", "done"] as const) {
    const bad = fixtureTask({ id: `W9-T4-${status}`, status, acceptance: [{ claim: "x", proof: "prose" }] });
    const population = deriveProofDebtPopulation([bad], dumpOf());
    assert.deepEqual(population.autoBlockingIds, [], `status:${status} must not enter the population`);
  }
});

test("deriveProofDebtPopulation: an open, unmerged, verify:human task with a bad proof is EXCLUDED from autoBlockingIds and reported in humanBlockingIds", () => {
  const human = fixtureTask({
    id: "W9-T5",
    verify: "human",
    acceptance: [{ claim: "an operator watches a live demo", proof: "operator eyeballs the console" }],
  });
  const population = deriveProofDebtPopulation([human], dumpOf());
  assert.deepEqual(population.autoBlockingIds, [], "verify:human debt must never enter the must-fix set");
  assert.deepEqual(population.humanBlockingIds, ["W9-T5"]);
});

test("deriveProofDebtPopulation: a `demonstration:` proof on verify:human lints clean (not counted at all) — the legal escape hatch stays legal", () => {
  const human = fixtureTask({
    id: "W9-T6",
    verify: "human",
    acceptance: [{ claim: "a chaos drill", proof: "demonstration: kill -9 the live daemon and observe recovery" }],
  });
  const population = deriveProofDebtPopulation([human], dumpOf());
  assert.deepEqual(population.autoBlockingIds, []);
  assert.deepEqual(population.humanBlockingIds, []);
});

test("evaluateProofDebtRatchet: zero offenders at ceiling 0 -> OK", () => {
  const v = evaluateProofDebtRatchet([], 0);
  assert.equal(v.ok, true);
  assert.match(v.message, /^OK/);
});

test("evaluateProofDebtRatchet: a REGRESSION above the ceiling -> BLOCKED, naming every offending id", () => {
  const v = evaluateProofDebtRatchet(["W9-T1", "W9-T2"], 0);
  assert.equal(v.ok, false);
  assert.equal(v.count, 2);
  assert.match(v.message, /^BLOCKED/);
  assert.match(v.message, /W9-T1/);
  assert.match(v.message, /W9-T2/);
});

test("evaluateProofDebtRatchet: exactly AT the ceiling -> OK (a ceiling of 0 is the strict case; a raised ceiling must still accept its own count)", () => {
  const v = evaluateProofDebtRatchet(["W9-T1"], 1);
  assert.equal(v.ok, true);
});

// ── (ii) candidate resolution over the REAL fixed proofs this PR wrote ──────────────────────

test("proofResolvesToCandidate: the six rewritten proofs each resolve to a real, on-disk file", () => {
  for (const path of [
    "test/review.test.ts",
    "test/containment.test.ts",
    "test/run-task.test.ts",
    "test/proof-execution.test.ts",
    "test/worker.test.ts",
    "test/daemon.test.ts",
    "test/operator-notes.test.ts",
  ]) {
    assert.ok(
      proofResolvesToCandidate(REPO_ROOT, `unit test: ${path}`),
      `unit test: ${path} must resolve to a real candidate`,
    );
  }
});

test("proofResolvesToCandidate: free prose and an unparseable dialect body resolve to nothing", () => {
  assert.equal(proofResolvesToCandidate(REPO_ROOT, "trust me, it works"), false);
  assert.equal(proofResolvesToCandidate(REPO_ROOT, "grep: no in-path clause here"), false);
});

// ── (iii) live-plan ratchet against this repo's own plan/tasks.yaml ─────────────────────────

function shippedPlan() {
  return loadPlan(SHIPPED_PLAN_PATH);
}

test("live plan: the open+unmerged, verify:auto population carries ZERO blocking proof-dialect/proof-resolvability violations", () => {
  let evidence: { dump: string; ref: string };
  try {
    evidence = defaultMergeEvidenceLog(REPO_ROOT);
  } catch (e) {
    // Fail-open on a shallow checkout (this repo's `ci` job's default fetch-depth, unlike
    // `coverage-ratchet`'s `fetch-depth: 0`) — the SAME posture lintPlanCommand's own
    // statusResolvable takes, and the same branch test/lint-plan-merge-evidence.test.ts's
    // real-reader test already takes. Without full history this test cannot tell open+unmerged
    // debt apart from the 136-task merged-elsewhere population W1-T370 owns.
    assert.match((e as Error).message, /shallow/i, "the only expected failure mode is a shallow checkout");
    return;
  }
  const population = deriveProofDebtPopulation(shippedPlan().tasks, evidence.dump);
  const verdict = evaluateProofDebtRatchet(population.autoBlockingIds, PROOF_DEBT_CEILING);
  assert.ok(verdict.ok, verdict.message);
});

test("live plan: every open+unmerged, verify:auto task WITH NO blocking violation still names a resolvable-SHAPE dialect (test-path, ::test-name anchor, or grep-in-path) — the resolvability lint's own promise, confirmed by name, not re-litigated by filesystem existence", () => {
  // Design note (iii): a forward-referencing PATH proof for an unimplemented task's not-yet-written
  // test is LEGITIMATE and deliberately lint-passes without existing on disk yet — so this does not
  // assert filesystem existence for the whole population (only the six proofs this PR itself
  // rewrote get that stronger check, above, since this PR chose to point them at real files). This
  // asserts the weaker, always-true invariant the lint itself enforces: shape-resolvable per
  // parseWhitelistedProof, for every criterion NOT already counted in autoBlockingIds.
  let evidence: { dump: string; ref: string };
  try {
    evidence = defaultMergeEvidenceLog(REPO_ROOT);
  } catch (e) {
    assert.match((e as Error).message, /shallow/i, "the only expected failure mode is a shallow checkout");
    return;
  }
  const plan = shippedPlan();
  const population = deriveProofDebtPopulation(plan.tasks, evidence.dump);
  const unmergedIds = new Set(population.openUnmergedIds);
  const autoBlocking = new Set(population.autoBlockingIds);
  const failures: string[] = [];
  for (const t of plan.tasks) {
    if (!unmergedIds.has(t.id) || t.verify !== "auto" || autoBlocking.has(t.id)) continue;
    for (const c of t.acceptance ?? []) {
      if (c.satisfied_by) continue;
      if (!parseWhitelistedProof(c.proof ?? "")) failures.push(`${t.id}: "${(c.proof ?? "").slice(0, 80)}"`);
    }
  }
  assert.deepEqual(failures, []);
});

test("live plan: verify:human proof debt among open+unmerged tasks is reported (excluded from the ratchet, never silently zero)", () => {
  let evidence: { dump: string; ref: string };
  try {
    evidence = defaultMergeEvidenceLog(REPO_ROOT);
  } catch (e) {
    assert.match((e as Error).message, /shallow/i, "the only expected failure mode is a shallow checkout");
    return;
  }
  const population = deriveProofDebtPopulation(shippedPlan().tasks, evidence.dump);
  // Every reported id must genuinely be verify:human — the invariant claim 3 depends on, not a
  // snapshot of today's exact ids (which drift as tasks merge — design note (vi)).
  const byId = new Map(shippedPlan().tasks.map((t) => [t.id, t] as const));
  for (const id of population.humanBlockingIds) {
    assert.equal(byId.get(id)?.verify, "human", `${id} in humanBlockingIds must be verify:human`);
    assert.ok(!population.autoBlockingIds.includes(id), `${id} must not double-count into the must-fix set`);
  }
});
