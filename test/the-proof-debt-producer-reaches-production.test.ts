import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  buildMeasurementCadenceDaemonHooks,
  defaultProofDebtCadenceInput,
  type ProofDebtCadenceInputDeps,
} from "../src/run-task.js";
import { buildMeasurementCadenceRow, measurementCadenceMarkerPath, runMeasurementCadenceReport } from "../src/lib/measurement-cadence.js";
import { resolveNameFilteredCandidates } from "../src/lib/review.js";
import { proofQueueAudit } from "../src/lib/proof-queue-audit.js";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { parseProposalRegistry } from "../src/lib/inbox.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T2641 — `MeasurementCadenceReportOpts.proofDebt` (W1-T2477) had ZERO production
// suppliers: its one production call site (`buildMeasurementCadenceDaemonHooks`'s `run`,
// src/run-task.ts) passed four keys and none of them was `proofDebt`, so the seventy-nine
// unresolvable proofs `rmd proof-queue-audit` already finds only ever reached the minter when a
// human typed the verb by hand. This file proves the nine acceptance criteria on this task's own
// shard, in that order (criterion 1 — the live call site itself — is proven by grep, not here:
// `grep -n 'defaultProofDebtCadenceInput(' src/run-task.ts` finds it inside `run`'s own body).
//
// Every test below builds its own SYNTHETIC fixture checkout — never this host's live plan/git
// state — the same discipline test/adoption-report-has-a-producer.test.ts and
// test/the-verb-census-reaches-a-reader.test.ts already use for this same producer spine.

/** W1-T2773: the mkdtemp prefix must be a statically-sanctioned literal at THIS call site, so
 *  the boot sweep (`src/lib/tmp.ts`'s `sweepStaleTempDirs`) can reap it — `${RMD_TMP_PREFIX}`
 *  spelled directly in the template, never threaded through a variable. */
function tmp(suffix: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${suffix}`));
}

/** `defaultMergeEvidenceLog`'s own wire shape (`%s%x00%b%x01`, subject NUL body SOH) — built by
 *  hand here rather than imported, since `classifyFailingMergeEvidence` (this producer's own
 *  merge-evidence classifier) is pure over exactly this string. */
function gitDump(commits: { subject: string; body?: string }[]): string {
  return commits.map((c) => `${c.subject}\x00${c.body ?? ""}\x01`).join("");
}

const THROWING_MERGE_EVIDENCE = () => {
  throw new Error("no real git in this test — the fixture checkout is not a git repository");
};

/**
 * One fixture repo root carrying:
 *  - `plan/tasks.yaml` (the monolith) with W1-T100 (open, unmerged, one grep proof that
 *    resolves) and W1-T103 (open, but merge evidence says it already shipped elsewhere).
 *  - `plan/tasks.d/W1-T101-offender.yaml` (a SHARD) with W1-T101 (open, unmerged, one grep
 *    proof pointing at a file that does not exist — the offender this whole family exists to
 *    surface).
 *  - `src/present.ts`, the file W1-T100's proof actually resolves against.
 * W1-T102 (status: merged) is declared inline in the monolith too, to prove the population
 * excludes landed records the same way `isOpenLintTask` already does everywhere else.
 */
function buildFixtureRepo(): string {
  const root = tmp("proofdebt-fixture-");
  mkdirSync(join(root, "plan/tasks.d"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/present.ts"), "export const fooSymbol = 1;\n");
  writeFileSync(
    join(root, "plan/tasks.yaml"),
    [
      "- id: W1-T100",
      "  title: open and unmerged, proof resolves",
      "  repo: remudero",
      "  type: implement",
      "  status: queued",
      "  attempts: 0",
      "  acceptance:",
      "    - claim: present symbol resolves",
      "      proof: 'grep: fooSymbol in src/present.ts'",
      "- id: W1-T102",
      "  title: landed — must never be audited",
      "  repo: remudero",
      "  type: implement",
      "  status: merged",
      "  attempts: 0",
      "  acceptance:",
      "    - claim: a landed record must never be audited",
      "      proof: 'grep: neverChecked in src/nowhere.ts'",
      "- id: W1-T103",
      "  title: open but merge evidence already covers it",
      "  repo: remudero",
      "  type: implement",
      "  status: queued",
      "  attempts: 0",
      "  acceptance:",
      "    - claim: merge evidence already covers this one",
      "      proof: 'grep: neverChecked in src/nowhere.ts'",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "plan/tasks.d/W1-T101-offender.yaml"),
    [
      "- id: W1-T101",
      "  title: open and unmerged, proof can never resolve",
      "  repo: remudero",
      "  type: implement",
      "  status: queued",
      "  attempts: 0",
      "  acceptance:",
      "    - claim: this proof can never resolve",
      "      proof: 'grep: barSymbol in src/missing.ts'",
      "",
    ].join("\n"),
  );
  return root;
}

/** Real merge evidence naming W1-T103 (via a `Remudero-Task:` trailer) as already-implemented —
 *  the one commit `classifyFailingMergeEvidence` must read as `withImpl`, excluding it from the
 *  population even though its plan record still reads `status: queued`. */
const FIXTURE_MERGE_EVIDENCE = () => ({
  dump: gitDump([{ subject: "feat: ship the thing", body: "Remudero-Task: W1-T103" }]),
  ref: "origin/main",
});

// ── acceptance 2: SAME population, SAME two predicates `proofQueueAuditCommand`'s own default
// path binds — the cadence and a human running `rmd proof-queue-audit` by hand can never name
// different offenders on one checkout. ──────────────────────────────────────────────────────────

test("the SAME open+unmerged population, over the SAME two predicates, unbinding creditedIds/symbolFoundAt", () => {
  const root = buildFixtureRepo();
  try {
    const input = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: FIXTURE_MERGE_EVIDENCE });
    assert.ok(input, "a readable plan and readable merge evidence must produce an input, never undefined");
    // W1-T100/W1-T101 are open and unmerged; W1-T102 is merged (excluded by isOpenLintTask);
    // W1-T103 is open but merge-evidence-covered (excluded by classifyFailingMergeEvidence).
    assert.deepEqual(
      input!.tasks.map((t) => t.id).sort(),
      ["W1-T100", "W1-T101"],
      "population must be exactly the open+unmerged intersection, never the unfiltered open set",
    );
    // The two predicates proofQueueAuditCommand's own default path binds, over the SAME
    // repoRoot — cross-checked against the reviewer's own function, not re-derived by hand.
    assert.equal(input!.pathExists!("src/present.ts"), true);
    assert.equal(input!.pathExists!("src/missing.ts"), false);
    assert.deepEqual(
      input!.resolveNameFilteredCandidates!("some raw proof name"),
      resolveNameFilteredCandidates(root, "some raw proof name"),
      "must bind the reviewer's own resolveNameFilteredCandidates over this SAME repoRoot",
    );
    // design (ii): leave creditedIds/symbolFoundAt unbound, exactly as the verb's default path
    // does — a cadence that bound them would report a DIFFERENT offender set than the verb.
    assert.equal(input!.creditedIds, undefined);
    assert.equal(input!.symbolFoundAt, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the resulting offenders are IDENTICAL to calling proofQueueAudit directly over the same population", () => {
  const root = buildFixtureRepo();
  try {
    const input = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: FIXTURE_MERGE_EVIDENCE });
    assert.ok(input);
    const viaWiring = proofQueueAudit(input!.tasks, {
      resolveNameFilteredCandidates: input!.resolveNameFilteredCandidates,
      pathExists: input!.pathExists,
    });
    const viaVerb = proofQueueAudit(input!.tasks, {
      resolveNameFilteredCandidates: (rawName) => resolveNameFilteredCandidates(root, rawName),
      pathExists: (rel) => existsSync(join(root, rel)),
    });
    assert.deepEqual(viaWiring, viaVerb, "the cadence's own audit must never diverge from the verb's own audit");
    assert.ok(
      viaWiring.offenders.some((o) => o.taskId === "W1-T101" && o.cause === "grep-path-absent"),
      "the fixture's one genuine offender must actually be found, or this proves nothing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 3: unavailable merge evidence SKIPS the producer entirely ───────────────────────

test("unreadable merge evidence returns undefined — never falls back to the unfiltered open population", () => {
  const root = buildFixtureRepo();
  try {
    const input = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: THROWING_MERGE_EVIDENCE });
    assert.equal(input, undefined, "cannot-observe-the-merge-evidence must audit nothing, never a wider population");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 4: every anchor path is repo-relative; an unresolvable id is omitted ────────────

test("shardPathFor relativises taskRecordPath's absolute answer against repoRoot, for both a shard and the monolith", () => {
  const root = buildFixtureRepo();
  try {
    const input = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: FIXTURE_MERGE_EVIDENCE });
    assert.ok(input);
    const shardAnswer = input!.shardPathFor("W1-T101");
    assert.equal(shardAnswer, join("plan", "tasks.d", "W1-T101-offender.yaml"));
    assert.ok(!isAbsolute(shardAnswer!), "an EvidenceAnchor.path must be repo-relative, per lib/inbox.ts's own doc");

    const monolithAnswer = input!.shardPathFor("W1-T100");
    assert.equal(monolithAnswer, join("plan", "tasks.yaml"));
    assert.ok(!isAbsolute(monolithAnswer!));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shardPathFor returns undefined for an id taskRecordPath cannot resolve — never invented", () => {
  const root = buildFixtureRepo();
  try {
    const input = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: FIXTURE_MERGE_EVIDENCE });
    assert.ok(input);
    assert.equal(input!.shardPathFor("W1-T999"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 5: a tick that does not fire performs no git/plan/filesystem read — lazy inside
// `run`, never at hook construction. ────────────────────────────────────────────────────────────

test("constructing the daemon hooks alone never fires the run body this producer lives inside", () => {
  // `recordMeasurementCadenceFire` is the FIRST statement inside `run`'s own body, ahead of this
  // producer's own `defaultProofDebtCadenceInput(repoRoot)` call — so proving the marker file was
  // never written proves `run`'s body, and everything inside it, never executed merely from
  // constructing the hooks object. `checkMeasurementCadence`/`runMeasurementCadence` are built as
  // plain closures; assigning them does not invoke them.
  const root = tmp("proofdebt-lazy-");
  try {
    const hooks = buildMeasurementCadenceDaemonHooks({ config: { root } as Config, now: () => new Date("2026-08-25T12:00:00Z") });
    assert.equal(typeof hooks.checkMeasurementCadence, "function");
    assert.equal(typeof hooks.runMeasurementCadence, "function");
    assert.ok(
      !existsSync(measurementCadenceMarkerPath(root)),
      "constructing the hooks must do no read/write at all — the marker only appears once `run` is actually invoked",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultProofDebtCadenceInput itself performs no read until called, and reads exactly once per call", () => {
  let loadPlanCalls = 0;
  let mergeEvidenceCalls = 0;
  const root = buildFixtureRepo();
  try {
    const deps: ProofDebtCadenceInputDeps = {
      loadPlan: (planPath) => {
        loadPlanCalls++;
        return loadPlanFromYaml(readFileSync(planPath, "utf8"), planPath);
      },
      readMergeEvidenceLog: () => {
        mergeEvidenceCalls++;
        return FIXTURE_MERGE_EVIDENCE();
      },
    };
    // Merely REFERENCING the deps object above (and even defining `defaultProofDebtCadenceInput`
    // as a value in scope) reads nothing — only the call below does.
    assert.equal(loadPlanCalls, 0);
    assert.equal(mergeEvidenceCalls, 0);
    defaultProofDebtCadenceInput(root, deps);
    assert.equal(loadPlanCalls, 1, "one call must read the plan exactly once, never eagerly/repeatedly");
    assert.equal(mergeEvidenceCalls, 1, "one call must read merge evidence exactly once, never eagerly/repeatedly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 6: escalate at its shipped `false` ⇒ the fire writes nothing to the registry and
// still reports a MEASURED clear/backlog, never a bare zero. ───────────────────────────────────

test("escalate: false ⇒ backlog is reported but the registry file is never created", () => {
  const root = buildFixtureRepo();
  const stateDir = join(root, "state");
  const registryPath = join(stateDir, "inbox-proposals.json");
  mkdirSync(stateDir, { recursive: true });
  try {
    const proofDebt = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: FIXTURE_MERGE_EVIDENCE });
    assert.ok(proofDebt, "the fixture must actually produce an input, or this test proves nothing");
    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      escalate: false,
      gitLog: FIXTURE_MERGE_EVIDENCE,
      registryPath,
      proofDebt,
    });
    assert.equal(result.proofDebtMint?.status, "backlog", "a real offender exists — this must be a MEASURED backlog, never a bare zero");
    assert.deepEqual(result.proofDebtMint?.mintedProposalIds, []);
    assert.ok(!existsSync(registryPath), "escalate: false must touch the registry ZERO times");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("escalate: false with no offenders ⇒ clear, still measured, still no registry write", () => {
  const root = tmp("proofdebt-clear-");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(
    join(root, "plan/tasks.yaml"),
    "- id: W1-T900\n  title: already landed\n  repo: remudero\n  type: implement\n  status: merged\n  attempts: 0\n",
  );
  const stateDir = join(root, "state");
  const registryPath = join(stateDir, "inbox-proposals.json");
  mkdirSync(stateDir, { recursive: true });
  try {
    const proofDebt = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: () => ({ dump: "", ref: "origin/main" }) });
    assert.ok(proofDebt);
    assert.deepEqual(proofDebt!.tasks, [], "the only declared task is merged — the population must be empty");
    const result = runMeasurementCadenceReport({ stateDir, cwd: root, escalate: false, gitLog: () => ({ dump: "", ref: "x" }), registryPath, proofDebt });
    assert.equal(result.proofDebtMint?.status, "clear");
    assert.ok(!existsSync(registryPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 7: a fired cadence makes the outcome recoverable from the ledger row, named
// exactly once — composed via W1-T2502's `buildMeasurementCadenceRow`, never hand-duplicated. ──

test("the measurement_cadence.ran row names proof_debt_report/proof_debt_mint exactly once each", () => {
  const root = buildFixtureRepo();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  try {
    const proofDebt = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: FIXTURE_MERGE_EVIDENCE });
    assert.ok(proofDebt);
    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      escalate: false,
      gitLog: FIXTURE_MERGE_EVIDENCE,
      proofDebt,
    });
    const row = buildMeasurementCadenceRow(result);
    const proofDebtKeys = Object.keys(row).filter((k) => k.startsWith("proof_debt"));
    assert.deepEqual(
      proofDebtKeys.sort(),
      ["proof_debt_mint", "proof_debt_report"],
      "exactly these two keys, never a third hand-duplicated name for the same outcome",
    );
    assert.equal((row.proof_debt_report as { offenders: unknown[] }).offenders.length, 1);
    assert.equal((row.proof_debt_mint as { status: string }).status, "backlog");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 8: a throw anywhere in this producer costs one logged row and never the
// daemon tick that hosts it, and never the cadence's other verbs. ──────────────────────────────

test("a throw while building the input is caught HERE — never escapes, never aborts the other verbs", () => {
  const root = buildFixtureRepo();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const THROWING_LOAD_PLAN = (): never => {
    throw new Error("simulated: the plan file vanished mid-read");
  };
  try {
    let proofDebt: ReturnType<typeof defaultProofDebtCadenceInput> | undefined;
    assert.doesNotThrow(() => {
      proofDebt = defaultProofDebtCadenceInput(root, { loadPlan: THROWING_LOAD_PLAN });
    });
    assert.equal(proofDebt, undefined, "a throw during construction must degrade to undefined, never propagate");

    // The cadence's other verbs must still run to completion when this producer's own input
    // construction failed — never a tick lost to a producer none of the other verbs depend on.
    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      escalate: false,
      gitLog: () => ({ dump: "", ref: "origin/main" }),
      checkoutDir: root,
      proofDebt,
    });
    assert.equal(result.proofDebtReport, undefined);
    assert.equal(result.proofDebtMint, undefined);
    assert.ok(result.ruleEfficacy, "ruleEfficacy must still run");
    assert.ok(result.verdictCalibration, "verdictCalibration must still run");
    assert.ok(result.autonomyRate, "autonomyRate must still run");
    assert.ok(result.adoptionReport, "adoptionReport must still run");
    assert.ok(result.verbCensus, "verbCensus must still run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 9: no path here files a task, approves a proposal, edits an acceptance
// criterion, or changes what the audit reports. ────────────────────────────────────────────────

test("a fire with a real offender mints exactly one un-approved PROPOSAL and touches nothing else on disk", () => {
  const root = buildFixtureRepo();
  const stateDir = join(root, "state");
  const registryPath = join(stateDir, "inbox-proposals.json");
  mkdirSync(stateDir, { recursive: true });
  const beforeMonolith = readFileSync(join(root, "plan/tasks.yaml"), "utf8");
  const beforeShard = readFileSync(join(root, "plan/tasks.d/W1-T101-offender.yaml"), "utf8");
  try {
    const proofDebt = defaultProofDebtCadenceInput(root, { readMergeEvidenceLog: FIXTURE_MERGE_EVIDENCE });
    assert.ok(proofDebt);
    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: root,
      escalate: true,
      gitLog: FIXTURE_MERGE_EVIDENCE,
      registryPath,
      proofDebt,
    });
    assert.equal(result.proofDebtMint?.status, "backlog");
    assert.equal(result.proofDebtMint?.mintedProposalIds.length, 1);

    // No plan record was touched — no task filed, no criterion edited.
    assert.equal(readFileSync(join(root, "plan/tasks.yaml"), "utf8"), beforeMonolith, "the monolith must be byte-for-byte unchanged");
    assert.equal(readFileSync(join(root, "plan/tasks.d/W1-T101-offender.yaml"), "utf8"), beforeShard, "the offending task's own shard must be byte-for-byte unchanged");

    // The one write is a PROPOSAL, never an approval — Proposal carries no approved/ok field this
    // mint could set, and the registry's own id namespace (`proof-debt:<taskId>:<criterionIndex>`)
    // is distinct from an approved task id.
    const registry = parseProposalRegistry(readFileSync(registryPath, "utf8"));
    assert.equal(registry.length, 1);
    assert.equal(registry[0]?.id, "proof-debt:W1-T101:0");
    assert.deepEqual(Object.keys(registry[0] ?? {}).sort(), ["evidenceAnchors", "id", "summary"].sort());
    assert.equal(registry[0]?.evidenceAnchors[0]?.path, join("plan", "tasks.d", "W1-T101-offender.yaml"));

    // What the audit itself REPORTS is untouched by this wiring — identical to calling the
    // audit directly over the same population and predicates (acceptance-2's own test proves
    // this in full; repeated narrowly here as the "changes what the audit reports" negative).
    assert.equal(result.proofDebtReport?.offenders.length, 1);
    assert.equal(result.proofDebtReport?.offenders[0]?.cause, "grep-path-absent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
