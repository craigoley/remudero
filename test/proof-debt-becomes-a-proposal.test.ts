import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ADOPTION_MINT_CEILING,
  mintProofDebtProposals,
  proofDebtProposalId,
  runMeasurementCadenceReport,
  type ProofDebtMintCadenceResult,
} from "../src/lib/measurement-cadence.js";
import { proofQueueAudit, type ProofQueueAuditOffender } from "../src/lib/proof-queue-audit.js";
import {
  anchorFingerprint,
  classifyProposal,
  parseProposalRegistry,
  type DraftedCandidate,
  type EvidenceAnchor,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, type MergedResolver, type Plan } from "../src/lib/plan.js";

// ── W1-T2477 — SEVENTY-NINE UNRESOLVABLE PROOFS ACROSS TWENTY-ONE OPEN TASKS AND NOTHING HAS
// EVER REPORTED THEM ON A SCHEDULE. proofQueueAudit (lib/proof-queue-audit.ts) already resolves
// every open task's proof against the checkout and names every offender, but it was reachable only
// through `src/run-task.ts`'s CLI dispatch — a report a human had to remember to type. This file
// proves mintProofDebtProposals (lib/measurement-cadence.ts) mints a bounded, exactly-deduped
// proposal per offender — a SECOND PRODUCER into the SAME W1-T2473 minter, never a second rung —
// keyed on task id plus criterion index, that runMeasurementCadenceReport wires proofQueueAudit's
// own offenders into it, and that nothing here files a task, approves a proposal, or bypasses
// classifyProposal's readiness gate — the ten acceptance criteria on this task's own shard, in
// that order.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function offender(overrides: Partial<ProofQueueAuditOffender> = {}): ProofQueueAuditOffender {
  return {
    taskId: "W1-T900",
    criterionIndex: 0,
    cause: "grep-path-absent",
    claim: "the thing is true",
    proof: "grep: someSymbol in src/lib/gone.ts",
    ...overrides,
  };
}

function readRegistry(registryPath: string) {
  return parseProposalRegistry(existsSync(registryPath) ? readFileSync(registryPath, "utf8") : undefined);
}

// A fixed lookup table stands in for `lib/plan.ts`'s own `taskRecordPath` — this file never
// re-derives shard-path resolution, it only proves the mint reads the injected result verbatim.
function shardPathFor(table: Record<string, string>): (taskId: string) => string | undefined {
  return (taskId) => table[taskId];
}

// ── A minimal, always-satisfiable plan/draft pair — reused across the criterion-3/10 tests below
// so classifyProposal's ordinary AND-clauses (deps/lint) run for real rather than being stubbed
// out, proving the mint never bypasses them. Mirrors adoption-debt-becomes-a-proposal.test.ts. ──

function basePlan(): Plan {
  return loadPlanFromYaml("[]\n", "fixture");
}

const yamlIsMerged: MergedResolver = () => true;

const CLEAN_FRAGMENT = `
- id: W1-T950
  title: "candidate task drafted from a proof-debt proposal"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  files: [src/lib/example.ts]
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;

function draftFor(proposalId: string, anchors: EvidenceAnchor[]): DraftedCandidate {
  return {
    proposalId,
    fragmentYaml: CLEAN_FRAGMENT,
    stampLine: `- ${proposalId} (plan) — RATIFIED 2026-08-30 -> W1-T950.`,
    anchorFingerprint: anchorFingerprint(anchors),
  };
}

function baseCtx(overrides: Partial<ReadinessContext> = {}): ReadinessContext {
  return {
    plan: basePlan(),
    isMerged: yamlIsMerged,
    grepAnchorTrue: () => true,
    openProposalIds: new Set(),
    isRatified: () => false,
    ...overrides,
  };
}

// ── acceptance 1: the cadence runs the proof audit and hands its offenders to the minter ───────

test("runMeasurementCadenceReport calls proofQueueAudit and mints its offenders through the SAME registry writer", () => {
  const root = tmp("rmd-proofdebt-cadence-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const registryPath = join(stateDir, "inbox-proposals.json");

    const planYaml = `
- id: W1-T910
  title: "a task whose proof can never resolve"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  acceptance:
    - claim: "the symbol exists"
      proof: "grep: aVanishedSymbol in src/lib/does-not-exist.ts"
`;
    const plan = loadPlanFromYaml(planYaml, "fixture");

    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: process.cwd(),
      escalate: true,
      gitLog: () => ({ dump: "", ref: "test" }),
      registryPath,
      proofDebt: {
        tasks: plan.tasks,
        pathExists: () => false, // "src/lib/does-not-exist.ts" really doesn't exist for this run
        shardPathFor: shardPathFor({ "W1-T910": "plan/tasks.d/W1-T910-fixture.yaml" }),
      },
    });

    assert.ok(result.proofDebtReport, "the report must be attached when opts.proofDebt is supplied");
    assert.equal(result.proofDebtReport!.offenders.length, 1, "proofQueueAudit must actually find the offender");
    assert.equal(result.proofDebtReport!.offenders[0].cause, "grep-path-absent");

    assert.ok(result.proofDebtMint, "the mint outcome must be attached alongside the report");
    assert.equal(result.proofDebtMint!.status, "backlog");
    assert.equal(result.proofDebtMint!.mintedProposalIds.length, 1, "the offender must reach a mint, not be dropped at the seam");

    const registry = readRegistry(registryPath);
    assert.deepEqual(
      registry.map((p) => p.id),
      [proofDebtProposalId(result.proofDebtReport!.offenders[0])],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 2: the anchor's pattern is the proof text, its path is the task's own shard ─────

test("each minted proposal's evidence anchor carries pattern=proof (verbatim), path=the task's own shard — no invented fact", () => {
  const root = tmp("rmd-proofdebt-anchor-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const o = offender({ taskId: "W1-T229", proof: "unit test: case added to test/review.test.ts" });
    mintProofDebtProposals([o], shardPathFor({ "W1-T229": "plan/tasks.d/W1-T229-fixture.yaml" }), registryPath);
    const registry = readRegistry(registryPath);
    assert.equal(registry.length, 1);
    assert.equal(registry[0].evidenceAnchors.length, 1);
    const anchor = registry[0].evidenceAnchors[0];
    assert.equal(anchor.pattern, o.proof, "the anchor's pattern must be the proof text, verbatim, without invention");
    assert.equal(anchor.path, "plan/tasks.d/W1-T229-fixture.yaml", "the anchor's path must be the task's own shard");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 3: a rewritten proof drifts the anchor false, and classifyProposal — never
// re-implemented, never bypassed — classifies the proposal not-ready ───────────────────────────

test("once the minted anchor stops matching (the proof text was rewritten), classifyProposal reports NOT_READY/evidence-drifted", () => {
  const root = tmp("rmd-proofdebt-drift-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const o = offender();
    mintProofDebtProposals([o], shardPathFor({ [o.taskId]: "plan/tasks.d/W1-T900-fixture.yaml" }), registryPath);
    const proposal = readRegistry(registryPath)[0];
    const draft = draftFor(proposal.id, proposal.evidenceAnchors);

    // Still true: the proof text is still there verbatim — the one AND-clause classifyProposal's
    // evidence arm checks, and nothing else here is stubbed away, so a real READY requires it.
    const stillReady = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => true }));
    assert.equal(stillReady.state, "ready", "with every anchor grep-true, the proposal is a real READY");

    // The proof gets rewritten (fixed, or merely reworded): the anchor this proposal cites stops
    // matching (drift is read from the SAME grepAnchorTrue seam every other proposal family
    // already uses — this task adds no new classifier, per its own scope).
    const drifted = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => false }));
    assert.equal(drifted.state, "not_ready");
    assert.ok(
      drifted.reasons.some((r) => r.predicate === "evidence_anchors" && /evidence-drifted/.test(r.detail)),
      "the drifted anchor must be named as evidence-drifted, the same predicate every other proposal family uses",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 4: two fires over an unchanged offender set mint exactly one proposal ────────────

test("two fires over an unchanged offender set mint exactly one proposal (idempotent by id)", () => {
  const root = tmp("rmd-proofdebt-idem-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const o = offender();
    const resolve = shardPathFor({ [o.taskId]: "plan/tasks.d/W1-T900-fixture.yaml" });

    const first = mintProofDebtProposals([o], resolve, registryPath);
    assert.equal(first.mintedProposalIds.length, 1);

    const second = mintProofDebtProposals([o], resolve, registryPath);
    assert.equal(second.mintedProposalIds.length, 0, "the second fire over the same offender must mint nothing new");
    assert.equal(second.status, "backlog", "the offender still exists — it is a backlog, not a clear");

    const registry = readRegistry(registryPath);
    assert.equal(registry.length, 1, "across BOTH fires, exactly one proposal exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 5: dedup keys on task id plus criterion index, never a similarity score ──────────

test("dedup is keyed on taskId+criterionIndex — a textually different cause/claim/proof still dedupes, a different criterionIndex does not", () => {
  const root = tmp("rmd-proofdebt-dedup-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const resolve = shardPathFor({ "W1-T900": "plan/tasks.d/W1-T900-fixture.yaml" });

    // Same (taskId, criterionIndex), wildly different cause/claim/proof text — must still dedupe
    // to ONE, because the id is derived from the pair alone, never a similarity score over prose.
    const original = offender({ criterionIndex: 2, cause: "grep-path-absent", proof: "grep: a in src/lib/a.ts" });
    const rewordedSamePair = offender({
      criterionIndex: 2,
      cause: "name-filtered-zero-match",
      claim: "an entirely different claim",
      proof: "unit test: an entirely different scenario",
    });
    const first = mintProofDebtProposals([original], resolve, registryPath);
    assert.equal(first.mintedProposalIds.length, 1);
    const second = mintProofDebtProposals([rewordedSamePair], resolve, registryPath);
    assert.equal(second.mintedProposalIds.length, 0, "same taskId+criterionIndex must dedupe regardless of prose");

    // A DIFFERENT criterionIndex on the SAME task is a DIFFERENT offender by this key, and must
    // mint separately.
    const differentCriterion = offender({ criterionIndex: 3 });
    const third = mintProofDebtProposals([differentCriterion], resolve, registryPath);
    assert.equal(third.mintedProposalIds.length, 1, "a different criterion index is a different offender by the natural key");

    const registry = readRegistry(registryPath);
    assert.equal(registry.length, 2, "exactly two distinct (taskId, criterionIndex) pairs ever minted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 6 + 7: the INHERITED per-fire ceiling (never a second one) holds at three; every
// excluded offender is named, oldest-filed-first, so a newer finding can never starve the head ──

test("the per-fire ceiling is the SAME ADOPTION_MINT_CEILING (never a second governor); the rest are named as excluded, oldest-filed-first", () => {
  const root = tmp("rmd-proofdebt-ceiling-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    assert.equal(ADOPTION_MINT_CEILING, 3, "this task's own inherited bound — Q3 of the shard's rationale");

    const table: Record<string, string> = {
      "W1-T5": "plan/tasks.d/W1-T5-fixture.yaml",
      "W1-T1": "plan/tasks.d/W1-T1-fixture.yaml",
      "W1-T4": "plan/tasks.d/W1-T4-fixture.yaml",
      "W1-T2": "plan/tasks.d/W1-T2-fixture.yaml",
      "W1-T3": "plan/tasks.d/W1-T3-fixture.yaml",
    };
    // Filed out of order on purpose — encounter order over the plan is NOT filing order (this
    // task's own rationale), so this proves the mint re-sorts by id rather than trusting array order.
    const offenders = [
      offender({ taskId: "W1-T5", criterionIndex: 0 }),
      offender({ taskId: "W1-T1", criterionIndex: 0 }), // oldest-filed
      offender({ taskId: "W1-T4", criterionIndex: 0 }),
      offender({ taskId: "W1-T2", criterionIndex: 0 }),
      offender({ taskId: "W1-T3", criterionIndex: 0 }),
    ];

    const result = mintProofDebtProposals(offenders, shardPathFor(table), registryPath);

    assert.equal(result.mintedProposalIds.length, 3, "the inherited ceiling holds at three, however many offenders exist");
    assert.equal(result.excludedOffenders.length, 2, "the two over the ceiling are EXCLUDED, never dropped silently");

    // acceptance 7: the three MINTED are the three OLDEST-FILED (T1, T2, T3) — a newer finding
    // (T4, T5) can never starve the head of the queue.
    const mintedTaskIds = result.mintedProposalIds
      .map((id) => offenders.find((o) => proofDebtProposalId(o) === id)!.taskId)
      .sort();
    assert.deepEqual(mintedTaskIds, ["W1-T1", "W1-T2", "W1-T3"]);

    // The excluded set is itself named oldest-filed-first (T4 before T5).
    assert.deepEqual(result.excludedOffenders, ["W1-T4:0", "W1-T5:0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 8: the audit still exits zero unconditionally and gates nothing ──────────────────

test("proofQueueAudit (unchanged) never throws and never gates, however many offenders it names — the mint call never turns a report into a verdict", () => {
  const manyOffendingTasks = Array.from({ length: 25 }, (_, i) => ({
    id: `W1-T${1000 + i}`,
    title: "always-unresolvable",
    repo: "remudero",
    depends_on: [],
    type: "implement" as const,
    verify: "auto" as const,
    risk: "medium" as const,
    status: "queued" as const,
    attempts: 0,
    acceptance: [{ claim: "x", proof: `grep: symbol${i} in src/lib/nowhere${i}.ts` }],
  }));

  // Twenty-five unresolvable proofs — proofQueueAudit must still just RETURN a report, never throw
  // and never expose a pass/fail field, exactly as its own module doc contracts (proof-queue-audit.ts).
  const report = proofQueueAudit(manyOffendingTasks, { pathExists: () => false });
  assert.equal(report.offenders.length, 25);
  assert.ok(!("passed" in report) && !("failed" in report) && !("exitCode" in report), "a report carries no pass/fail field to gate on");

  // And feeding all 25 into the mint (well past the ceiling) still completes normally — no throw.
  const root = tmp("rmd-proofdebt-nogate-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const table: Record<string, string> = {};
    for (const t of manyOffendingTasks) table[t.id] = `plan/tasks.d/${t.id}-fixture.yaml`;
    let result: ProofDebtMintCadenceResult | undefined;
    assert.doesNotThrow(() => {
      result = mintProofDebtProposals(report.offenders, shardPathFor(table), registryPath);
    });
    assert.equal(result!.mintedProposalIds.length, ADOPTION_MINT_CEILING);
    assert.equal(result!.excludedOffenders.length, 25 - ADOPTION_MINT_CEILING);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 9: an empty offender set mints nothing and reports a MEASURED clear ──────────────

test("an empty offender set mints nothing and reports status 'clear' — a measured absence, never a bare zero", () => {
  const root = tmp("rmd-proofdebt-clear-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const result = mintProofDebtProposals([], shardPathFor({}), registryPath);
    assert.equal(result.status, "clear");
    assert.deepEqual(result.mintedProposalIds, []);
    assert.deepEqual(result.excludedOffenders, []);
    assert.equal(existsSync(registryPath), false, "an empty offender set must never touch the registry at all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Also a measured "clear" (never invented) when every offender names a task whose shard cannot be
// resolved — the "no predicate, no opinion" contract, never a false minted fact.
test("an offender whose task has no resolvable shard path is never minted — no invented anchor", () => {
  const root = tmp("rmd-proofdebt-unresolvable-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const o = offender({ taskId: "W1-T-ghost" });
    const result = mintProofDebtProposals([o], shardPathFor({}), registryPath);
    assert.equal(result.status, "clear", "no resolvable shard path means nothing can be minted honestly");
    assert.deepEqual(result.mintedProposalIds, []);
    assert.equal(existsSync(registryPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 10: no path here files a task, approves a proposal, or edits any acceptance
// criterion ───────────────────────────────────────────────────────────────────────────────────

test("minting a proposal files no task, edits no acceptance criterion, and approves nothing — the registry is the ONLY write, and classifyProposal's ordinary gate still runs", () => {
  const root = tmp("rmd-proofdebt-law5-");
  try {
    mkdirSync(root, { recursive: true });
    const registryPath = join(root, "inbox-proposals.json");
    const o = offender();
    mintProofDebtProposals([o], shardPathFor({ [o.taskId]: "plan/tasks.d/W1-T900-fixture.yaml" }), registryPath);

    // LAW 5, DIRECTLY: nothing under `root` besides the registry itself — no minted task shard,
    // no feedback entry, no second write path (mirrors adoption-debt-becomes-a-proposal.test.ts's
    // own assertion of the same shape). W1-T2490: `inbox-proposals.d/` is the newly minted
    // proposal's OWN shard mirror — part of the registry's own footprint, not a second write
    // path — updateProposalRegistry writes it alongside, never instead of, the blob.
    assert.deepEqual(readdirSync(root).sort(), ["inbox-proposals.d", "inbox-proposals.json"]);

    const proposal = readRegistry(registryPath)[0];

    // Never auto-ratified: classifyProposal (never re-implemented, never short-circuited) still
    // requires a draft before anything can render READY.
    const undrafted = classifyProposal(proposal, undefined, baseCtx());
    assert.equal(undrafted.state, "not_ready");
    assert.ok(undrafted.reasons.some((r) => r.predicate === "drafted"));

    // classifyProposal's ordinary AND-clauses still run over a real draft — an unmet dependency
    // still refuses readiness exactly as it would for any other proposal family; the mint neither
    // bypasses nor special-cases classifyProposal's evaluation.
    const depUnmetFragment = `
- id: W1-T951
  title: "candidate depending on an unmerged task"
  repo: remudero
  depends_on: [W1-T-does-not-exist]
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  origin: architect
  acceptance:
    - claim: "the candidate does the thing"
      proof: "unit test: fixture X -> observable Y"
`;
    const uncleanDraft: DraftedCandidate = {
      proposalId: proposal.id,
      fragmentYaml: depUnmetFragment,
      stampLine: `- ${proposal.id} (plan) — RATIFIED 2026-08-30 -> W1-T951.`,
      anchorFingerprint: anchorFingerprint(proposal.evidenceAnchors),
    };
    const uncleanResult = classifyProposal(proposal, uncleanDraft, baseCtx({ isMerged: () => false, grepAnchorTrue: () => true }));
    assert.equal(uncleanResult.state, "not_ready");
    assert.ok(uncleanResult.reasons.some((r) => r.predicate === "deps_merged"));

    // And a fully clean draft over a grep-true anchor DOES render READY through the ordinary
    // path — proving the classifier is exercised normally, never bypassed in either direction.
    const cleanDraft = draftFor(proposal.id, proposal.evidenceAnchors);
    const readyResult = classifyProposal(proposal, cleanDraft, baseCtx());
    assert.equal(readyResult.state, "ready");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── THE ESCALATE-OFF ARM IS THE ONE AN OPERATOR MEETS FIRST, AND NOTHING REACHED IT.
// `runMeasurementCadenceReport`'s proof-debt block has two arms: with `escalate` on it calls
// `mintProofDebtProposals` and WRITES; with `escalate` off it must still report whether a backlog
// EXISTS, writing nothing — that is the whole point of the default posture (this module's policy
// block: every verb on the cadence is a pure reader, and a cadence that writes nothing cannot
// launder anything). The suite above supplied `escalate: true` at its only call site, so the off
// arm was never executed and `diff-coverage` named all four of its lines. These two tests execute
// it deliberately, and they pin BEHAVIOUR rather than line numbers: `backlog` must not require a
// write, and `clear` must mean a measured absence rather than "we did not look".
test("with escalate off, a real backlog is REPORTED and nothing is written", () => {
  const root = tmp("rmd-proofdebt-noescalate-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const registryPath = join(stateDir, "inbox-proposals.json");

    const planYaml = `
- id: W1-T910
  title: "a task whose proof can never resolve"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  acceptance:
    - claim: "the symbol exists"
      proof: "grep: aVanishedSymbol in src/lib/does-not-exist.ts"
`;
    const plan = loadPlanFromYaml(planYaml, "fixture");

    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: process.cwd(),
      escalate: false,
      gitLog: () => ({ dump: "", ref: "test" }),
      registryPath,
      proofDebt: {
        tasks: plan.tasks,
        pathExists: () => false,
        shardPathFor: shardPathFor({ "W1-T910": "plan/tasks.d/W1-T910-fixture.yaml" }),
      },
    });

    assert.ok(result.proofDebtReport, "the report is attached whether or not escalate is on");
    assert.equal(result.proofDebtReport!.offenders.length, 1, "the audit still runs with escalate off");

    assert.ok(result.proofDebtMint, "the mint OUTCOME is attached even when nothing is minted");
    assert.equal(
      result.proofDebtMint!.status,
      "backlog",
      "a real offender must read `backlog` with escalate off — an operator has to be able to see the backlog exists BEFORE opting into writes",
    );
    assert.deepEqual(result.proofDebtMint!.mintedProposalIds, [], "escalate off mints nothing");
    assert.deepEqual(result.proofDebtMint!.excludedOffenders, [], "and excludes nothing on this arm");

    assert.equal(
      existsSync(registryPath),
      false,
      "THE LOAD-BEARING ASSERTION: the escalate-off arm must not touch the registry at all",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with escalate off, an empty offender set reads `clear` — a measured absence, never an unlooked-at zero", () => {
  const root = tmp("rmd-proofdebt-noescalate-clear-");
  try {
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const registryPath = join(stateDir, "inbox-proposals.json");

    const planYaml = `
- id: W1-T911
  title: "a task whose proof resolves cleanly"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  status: queued
  attempts: 0
  acceptance:
    - claim: "the symbol exists"
      proof: "grep: aPresentSymbol in src/lib/measurement-cadence.ts"
`;
    const plan = loadPlanFromYaml(planYaml, "fixture");

    const result = runMeasurementCadenceReport({
      stateDir,
      cwd: process.cwd(),
      escalate: false,
      gitLog: () => ({ dump: "", ref: "test" }),
      registryPath,
      proofDebt: {
        tasks: plan.tasks,
        pathExists: () => true, // the grep path resolves, so nothing is an offender
        symbolFoundAt: () => true,
        shardPathFor: shardPathFor({ "W1-T911": "plan/tasks.d/W1-T911-fixture.yaml" }),
      },
    });

    assert.ok(result.proofDebtReport, "the report is attached even when it names nobody");
    assert.equal(result.proofDebtReport!.offenders.length, 0, "control: this fixture really has no offender");
    assert.ok(result.proofDebtMint, "the mint outcome is attached for an empty set too");
    assert.equal(result.proofDebtMint!.status, "clear", "no offenders reads `clear`, the other side of the same arm");
    assert.equal(existsSync(registryPath), false, "still no write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
