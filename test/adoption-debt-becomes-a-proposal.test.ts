import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ADOPTION_MINT_CEILING,
  adoptionProposalId,
  mintAdoptionProposals,
  type AdoptionFinding,
} from "../src/lib/measurement-cadence.js";
import {
  anchorFingerprint,
  classifyProposal,
  parseProposalRegistry,
  type DraftedCandidate,
  type EvidenceAnchor,
  type ReadinessContext,
} from "../src/lib/inbox.js";
import { loadPlanFromYaml, type MergedResolver, type Plan } from "../src/lib/plan.js";

// ── W1-T2473 — THE ADOPTION REPORT IS COMPUTED EVERY TICK AND READ BY NOTHING. runAdoptionReport
// (lib/measurement-cadence.ts) already scans the checkout for symbol-no-caller/field-no-writer/
// script-no-invoker findings, and every finding already carries mechanism/definedIn/shippedAt/
// detail — but the daemon's measurement_cadence.ran row only ever logged rule_efficacy,
// verdict_calibration and autonomy_rate, so the report was dropped at the seam. This file proves
// mintAdoptionProposals (measurement-cadence.ts) mints a bounded, exactly-deduped proposal per
// unadopted mechanism, that daemon.ts names the outcome on the ledger, and that nothing here
// files a task, approves a proposal, or bypasses classifyProposal's readiness gate — the ten
// acceptance criteria on this task's own shard, in that order.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function finding(overrides: Partial<AdoptionFinding> = {}): AdoptionFinding {
  return {
    shape: "symbol-no-caller",
    mechanism: "orphanMechanism",
    definedIn: "src/lib/mechanism.ts",
    shippedAt: "2026-08-01T00:00:00.000Z",
    detail: "no reference to `orphanMechanism` outside its own definition in src/lib/mechanism.ts",
    ...overrides,
  };
}

function readRegistry(registryPath: string) {
  return parseProposalRegistry(existsSync(registryPath) ? readFileSync(registryPath, "utf8") : undefined);
}

// ── A minimal, always-satisfiable plan/draft pair — reused across the criterion-3/10 tests below
// so classifyProposal's ordinary AND-clauses (deps/lint) run for real rather than being stubbed
// out, proving the mint never bypasses them. ──────────────────────────────────────────────────

function basePlan(): Plan {
  return loadPlanFromYaml("[]\n", "fixture");
}

const yamlIsMerged: MergedResolver = () => true;

const CLEAN_FRAGMENT = `
- id: W1-T900
  title: "candidate task drafted from an adoption-debt proposal"
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
    stampLine: `- ${proposalId} (plan) — RATIFIED 2026-08-30 -> W1-T900.`,
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

// ── acceptance 1: every adoption finding reaches a proposal mint ──────────────────────────────

test("every mintable adoption finding (within the ceiling) reaches a proposal mint, not a drop", () => {
  const root = tmp("rmd-adopt-mint-basic-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const findings = [
      finding({ mechanism: "orphanA", definedIn: "src/lib/a.ts" }),
      finding({ mechanism: "orphanB", definedIn: "src/lib/b.ts" }),
    ];
    const result = mintAdoptionProposals(findings, registryPath);
    assert.equal(result.status, "backlog");
    assert.equal(result.mintedProposalIds.length, 2, "both findings must reach a mint, not be dropped at the seam");
    const registry = readRegistry(registryPath);
    assert.deepEqual(
      registry.map((p) => p.id).sort(),
      [adoptionProposalId(findings[0]), adoptionProposalId(findings[1])].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 2: the anchor's pattern is the mechanism, its path is the defining file ─────────

test("each minted proposal's evidence anchor carries pattern=mechanism, path=definedIn — no invented fact", () => {
  const root = tmp("rmd-adopt-anchor-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const f = finding({ mechanism: "unusedHelper", definedIn: "src/lib/helper.ts" });
    mintAdoptionProposals([f], registryPath);
    const registry = readRegistry(registryPath);
    assert.equal(registry.length, 1);
    assert.equal(registry[0].evidenceAnchors.length, 1);
    const anchor = registry[0].evidenceAnchors[0];
    assert.equal(anchor.pattern, f.mechanism, "the anchor's pattern must be the mechanism, without invention");
    assert.equal(anchor.path, f.definedIn, "the anchor's path must be the mechanism's own defining file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 3: a mechanism that acquires a consumer drifts its anchor false, and
// classifyProposal — never re-implemented, never bypassed — classifies the proposal not-ready ──

test("once the minted anchor stops matching (mechanism acquired a consumer), classifyProposal reports NOT_READY/evidence-drifted", () => {
  const root = tmp("rmd-adopt-drift-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const f = finding({ mechanism: "stillOrphan", definedIn: "src/lib/still-orphan.ts" });
    mintAdoptionProposals([f], registryPath);
    const proposal = readRegistry(registryPath)[0];
    const draft = draftFor(proposal.id, proposal.evidenceAnchors);

    // Still true: no consumer yet — this is the one AND-clause classifyProposal's evidence arm
    // checks, and nothing else here is stubbed away, so a real READY requires it to hold.
    const stillReady = classifyProposal(proposal, draft, baseCtx({ grepAnchorTrue: () => true }));
    assert.equal(stillReady.state, "ready", "with every anchor grep-true, the proposal is a real READY");

    // The mechanism acquires a consumer: the anchor this proposal cites stops matching (drift is
    // read from the SAME grepAnchorTrue seam every other proposal family already uses — this
    // task adds no new classifier, per its own scope).
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

// ── acceptance 4: two fires over an unchanged finding set mint exactly one proposal ────────────

test("two fires over an unchanged finding set mint exactly one proposal (idempotent by id)", () => {
  const root = tmp("rmd-adopt-idem-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const f = finding();

    const first = mintAdoptionProposals([f], registryPath);
    assert.equal(first.mintedProposalIds.length, 1);

    const second = mintAdoptionProposals([f], registryPath);
    assert.equal(second.mintedProposalIds.length, 0, "the second fire over the same finding must mint nothing new");
    assert.equal(second.status, "backlog", "the finding still exists — it is a backlog, not a clear");

    const registry = readRegistry(registryPath);
    assert.equal(registry.length, 1, "across BOTH fires, exactly one proposal exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 5: dedup keys on shape+mechanism+definedIn, never a similarity score ────────────

test("dedup is keyed on shape+mechanism+definedIn — a textually near-identical detail still dedupes, a different definedIn does not", () => {
  const root = tmp("rmd-adopt-dedup-");
  try {
    const registryPath = join(root, "inbox-proposals.json");

    // Same triple, wildly different `detail`/`shippedAt` text — must still dedupe to ONE, because
    // the id is derived from the triple alone, never a Jaccard/lexical score over the prose.
    const original = finding({ detail: "no reference to `dupMechanism` outside its own definition in src/lib/dup.ts" });
    const rewordedSameTriple = finding({
      mechanism: original.mechanism,
      definedIn: original.definedIn,
      shippedAt: "2026-08-15T00:00:00.000Z",
      detail: "an entirely different sentence describing the SAME mechanism in the SAME file, worded differently",
    });
    const first = mintAdoptionProposals([original], registryPath);
    assert.equal(first.mintedProposalIds.length, 1);
    const second = mintAdoptionProposals([rewordedSameTriple], registryPath);
    assert.equal(second.mintedProposalIds.length, 0, "same shape+mechanism+definedIn must dedupe regardless of prose");

    // A DIFFERENT definedIn (same mechanism name, e.g. two files that happen to export the same
    // identifier) is a DIFFERENT mechanism by this key, and must mint separately.
    const sameNameDifferentFile = finding({ mechanism: original.mechanism, definedIn: "src/lib/other.ts" });
    const third = mintAdoptionProposals([sameNameDifferentFile], registryPath);
    assert.equal(third.mintedProposalIds.length, 1, "a different defining file is a different mechanism by the natural key");

    const registry = readRegistry(registryPath);
    assert.equal(registry.length, 2, "exactly two distinct (shape, mechanism, definedIn) triples ever minted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 6 + 7: the per-fire ceiling holds at three; every excluded finding is named,
// oldest-shipped-first, so a newer finding can never starve the head of the queue ──────────────

test("the per-fire ceiling holds at three; the rest are named as excluded, not silently dropped", () => {
  const root = tmp("rmd-adopt-ceiling-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    assert.equal(ADOPTION_MINT_CEILING, 3, "this task's own bound — Q3 of the shard's rationale");

    const findings = [
      finding({ mechanism: "m5", definedIn: "src/lib/m5.ts", shippedAt: "2026-08-05T00:00:00.000Z" }),
      finding({ mechanism: "m1", definedIn: "src/lib/m1.ts", shippedAt: "2026-08-01T00:00:00.000Z" }), // oldest
      finding({ mechanism: "m4", definedIn: "src/lib/m4.ts", shippedAt: "2026-08-04T00:00:00.000Z" }),
      finding({ mechanism: "m2", definedIn: "src/lib/m2.ts", shippedAt: "2026-08-02T00:00:00.000Z" }),
      finding({ mechanism: "m3", definedIn: "src/lib/m3.ts", shippedAt: "2026-08-03T00:00:00.000Z" }),
    ];

    const result = mintAdoptionProposals(findings, registryPath);

    assert.equal(result.mintedProposalIds.length, 3, "the ceiling holds at three, however many findings exist");
    assert.equal(result.excludedMechanisms.length, 2, "the two over the ceiling are EXCLUDED, never dropped silently");

    // acceptance 7: the three MINTED are the three OLDEST by shippedAt (m1, m2, m3) — a newer
    // finding (m4, m5) can never starve the head of the queue.
    const mintedMechanisms = result.mintedProposalIds.map((id) => findings.find((f) => adoptionProposalId(f) === id)!.mechanism).sort();
    assert.deepEqual(mintedMechanisms, ["m1", "m2", "m3"]);

    // The excluded set is itself named oldest-shipped-first (m4 before m5).
    assert.deepEqual(result.excludedMechanisms, [
      `${findings[2].shape}:${findings[2].definedIn}:${findings[2].mechanism}`, // m4
      `${findings[0].shape}:${findings[0].definedIn}:${findings[0].mechanism}`, // m5
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 8: the daemon's own cadence ledger row names the adoption outcome ───────────────

test("runDaemon's measurement_cadence.ran row names the adoption mint outcome, not just the three prior verbs", async () => {
  const { runDaemon } = await import("../src/lib/daemon.js");
  const { loadPlan } = await import("../src/lib/plan.js");
  const dir = tmp("rmd-adopt-ledger-");
  try {
    const f = join(dir, "tasks.yaml");
    writeFileSync(f, "- id: T1\n  title: t\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n");
    const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
    let stopChecks = 0;
    await runDaemon(loadPlan(f), {
      refreshMerged: () => () => true,
      runOne: async () => {
        throw new Error("never");
      },
      checkStop: () => {
        stopChecks++;
        return stopChecks > 1 ? "bound" : undefined;
      },
      sleep: async () => {},
      log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
      checkMeasurementCadence: () => ({ fire: true, reason: "first run" }),
      runMeasurementCadence: async () => ({
        ruleEfficacy: { status: "refused", refusedReason: "nothing measured", measurableCount: 0, repeatingCount: 0, repeatIncidentRate: null, escalated: false, escalatedProposalIds: [] },
        verdictCalibration: { status: "refused", refusedReason: "nothing measured", classes: [] },
        autonomyRate: { status: "refused", refusedReason: "nothing measured", totalMerges: 0, zeroTouchRate: null },
        adoptionMint: { status: "backlog", mintedProposalIds: ["adoption:symbol-no-caller:src/lib/x.ts:orphanX"], excludedMechanisms: [] },
      }),
    });
    const ran = lines.find((l) => l.step === "measurement_cadence.ran");
    assert.ok(ran, "the cadence must still log a .ran row");
    assert.deepEqual(ran!.extra.adoption_mint, {
      status: "backlog",
      mintedProposalIds: ["adoption:symbol-no-caller:src/lib/x.ts:orphanX"],
      excludedMechanisms: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance 9: an empty finding set mints nothing and reports a MEASURED clear ──────────────

test("an empty finding set mints nothing and reports status 'clear' — a measured absence, never a bare zero", () => {
  const root = tmp("rmd-adopt-clear-");
  try {
    const registryPath = join(root, "inbox-proposals.json");
    const result = mintAdoptionProposals([], registryPath);
    assert.equal(result.status, "clear");
    assert.deepEqual(result.mintedProposalIds, []);
    assert.deepEqual(result.excludedMechanisms, []);
    assert.equal(existsSync(registryPath), false, "an empty finding set must never touch the registry at all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── acceptance 10: no path here files a task, approves a proposal, or bypasses classifyProposal
// ─────────────────────────────────────────────────────────────────────────────────────────────

test("minting a proposal files no task and approves nothing — the registry is the ONLY write, and classifyProposal's ordinary gate still runs", () => {
  const root = tmp("rmd-adopt-law5-");
  try {
    mkdirSync(root, { recursive: true });
    const registryPath = join(root, "inbox-proposals.json");
    const f = finding();
    mintAdoptionProposals([f], registryPath);

    // LAW 5, DIRECTLY: nothing under `root` besides the registry itself — no minted task shard,
    // no feedback entry, no second write path (mirrors measurement-cadence.test.ts's own
    // rule-efficacy assertion of the same shape). W1-T2490: `inbox-proposals.d/` is the newly
    // minted proposal's OWN shard mirror — part of the registry's own footprint, not a second
    // write path — updateProposalRegistry writes it alongside, never instead of, the blob.
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
- id: W1-T901
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
      stampLine: `- ${proposal.id} (plan) — RATIFIED 2026-08-30 -> W1-T901.`,
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
