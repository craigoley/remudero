import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blastRadiusFactor,
  confidenceFactor,
  decisionHasExplicitReversibilityCaveat,
  decisionRiskBand,
  isAutoChooseAllowed,
  noveltyFactor,
  planRiskGate,
  reversibilityFactor,
  scoreRisk,
  shouldRecordDecision,
  type DiffSummary,
  type RiskTaskMetadata,
} from "../src/lib/risk-score.js";
import { parseDecisionRequest } from "../src/lib/worker.js";

function diffOf(...paths: string[]): DiffSummary {
  return { files: paths.map((path) => ({ path, additions: 1, deletions: 0 })) };
}

// ── Acceptance criterion 1: hooks/deny-floor -> critical -> auto-choose refused, escalate ──

test("scoreRisk: a diff touching hooks/deny-floor.sh scores critical and REFUSES auto-choose (escalate emitted)", () => {
  const diff = diffOf("hooks/deny-floor.sh");
  const verdict = scoreRisk(diff);
  assert.equal(verdict.band, "critical");
  const blastRadius = verdict.factors.find((f) => f.factor === "blast_radius");
  assert.equal(blastRadius?.band, "critical");
  assert.match(blastRadius!.evidence, /hooks\/deny-floor\.sh/);

  const gate = planRiskGate(verdict);
  assert.equal(gate.kind, "hard_stop_escalate");
  assert.notEqual(gate.kind, "auto_choose");
  assert.equal(isAutoChooseAllowed(verdict), false);
});

test("scoreRisk: a diff touching worker sandbox settings also scores critical", () => {
  const verdict = scoreRisk(diffOf(".claude/settings.json"));
  assert.equal(verdict.band, "critical");
});

test("scoreRisk: a diff touching a CI workflow scores critical", () => {
  const verdict = scoreRisk(diffOf(".github/workflows/ci.yml"));
  assert.equal(verdict.band, "critical");
});

test("scoreRisk: a diff touching credentials (.env) scores critical", () => {
  const verdict = scoreRisk(diffOf(".env.production"));
  assert.equal(verdict.band, "critical");
});

// ── Acceptance criterion 2: a one-line docs diff -> low -> auto-choose proceeds ──

test("scoreRisk: a single-line docs-only diff scores low and auto-chooses", () => {
  const diff = diffOf("README.md");
  const verdict = scoreRisk(diff);
  assert.equal(verdict.band, "low");
  for (const f of verdict.factors) assert.equal(f.band, "low");

  const gate = planRiskGate(verdict);
  assert.equal(gate.kind, "auto_choose");
  assert.equal(isAutoChooseAllowed(verdict), true);
});

// ── Acceptance criterion 3: determinism — same diff scored twice is identical ──

test("scoreRisk: scoring the same diff twice returns an identical band + factors (deterministic, no clock/random)", () => {
  const diff = diffOf("src/lib/worker.ts", "package.json");
  const metadata: RiskTaskMetadata = { reviewerScore: 0.9, strikes: 0 };
  const first = scoreRisk(diff, metadata);
  const second = scoreRisk(diff, metadata);
  assert.deepEqual(first, second);
});

test("scoreRisk: scoring is a pure function of its inputs — new object instances with equal content still match", () => {
  const a = scoreRisk({ files: [{ path: "a.ts", additions: 3, deletions: 1 }] }, { strikes: 1 });
  const b = scoreRisk({ files: [{ path: "a.ts", additions: 3, deletions: 1 }] }, { strikes: 1 });
  assert.deepEqual(a, b);
});

// ── blast_radius: high (not critical) for new-dependency manifests ────────

test("blastRadiusFactor: package.json is high, not critical (mirrors dep-review's major-bump-escalates, not hard-stop)", () => {
  const verdict = blastRadiusFactor(diffOf("package.json"));
  assert.equal(verdict.band, "high");
});

test("blastRadiusFactor: an empty diff is low with explanatory evidence", () => {
  const verdict = blastRadiusFactor({ files: [] });
  assert.equal(verdict.band, "low");
  assert.match(verdict.evidence, /no files/);
});

// ── reversibility ───────────────────────────────────────────────────────

test("reversibilityFactor: a task-declared irreversible op is critical even with no diff content", () => {
  const verdict = reversibilityFactor(diffOf("src/lib/worker.ts"), { irreversible: true });
  assert.equal(verdict.band, "critical");
});

test("reversibilityFactor: a migration path with a destructive DROP TABLE is critical", () => {
  const diff: DiffSummary = {
    files: [{ path: "migrations/2026_07_16_drop_users.sql", content: "DROP TABLE users;" }],
  };
  const verdict = reversibilityFactor(diff, {});
  assert.equal(verdict.band, "critical");
});

test("reversibilityFactor: a migration path with no destructive content is high, not critical", () => {
  const diff: DiffSummary = {
    files: [{ path: "migrations/2026_07_16_add_column.sql", content: "ALTER TABLE users ADD COLUMN foo text;" }],
  };
  const verdict = reversibilityFactor(diff, {});
  assert.equal(verdict.band, "high");
});

test("reversibilityFactor: an ordinary code diff is low (a git revert is expected to cleanly undo it)", () => {
  const verdict = reversibilityFactor(diffOf("src/lib/worker.ts"), {});
  assert.equal(verdict.band, "low");
});

// ── novelty — never inferred from the diff, only task-declared ────────────

test("noveltyFactor: undeclared defaults to low (well-trodden), never inferred from the diff", () => {
  assert.equal(noveltyFactor({}).band, "low");
});

test("noveltyFactor: task-declared novel is high", () => {
  assert.equal(noveltyFactor({ novel: true }).band, "high");
});

// ── confidence — reviewer score / strikes / flight-judge state ────────────

test("confidenceFactor: flight-judge off_track is critical regardless of everything else", () => {
  const verdict = confidenceFactor({ flightJudgeState: "off_track", reviewerScore: 1, strikes: 0 });
  assert.equal(verdict.band, "critical");
});

test("confidenceFactor: flight-judge spiraling is high", () => {
  assert.equal(confidenceFactor({ flightJudgeState: "spiraling" }).band, "high");
});

test("confidenceFactor: strikes at the DIAGNOSE_AT_STRIKES threshold is high", () => {
  assert.equal(confidenceFactor({ strikes: 2 }).band, "high");
});

test("confidenceFactor: a low reviewer score alone is high", () => {
  assert.equal(confidenceFactor({ reviewerScore: 0.2 }).band, "high");
});

test("confidenceFactor: one strike is only medium", () => {
  assert.equal(confidenceFactor({ strikes: 1 }).band, "medium");
});

test("confidenceFactor: no signals at all is low (full confidence)", () => {
  assert.equal(confidenceFactor({}).band, "low");
});

// ── planRiskGate: the full band -> action mapping ──────────────────────────

test("planRiskGate: covers all four bands with the MASTER-PLAN §4B mapping", () => {
  assert.equal(planRiskGate({ band: "low", factors: [] }).kind, "auto_choose");
  assert.equal(planRiskGate({ band: "medium", factors: [] }).kind, "require_reviewer_pass");
  assert.equal(planRiskGate({ band: "high", factors: [] }).kind, "timeboxed_question");
  assert.equal(planRiskGate({ band: "critical", factors: [] }).kind, "hard_stop_escalate");
});

test("isAutoChooseAllowed: true only for low", () => {
  assert.equal(isAutoChooseAllowed({ band: "low", factors: [] }), true);
  assert.equal(isAutoChooseAllowed({ band: "medium", factors: [] }), false);
  assert.equal(isAutoChooseAllowed({ band: "high", factors: [] }), false);
  assert.equal(isAutoChooseAllowed({ band: "critical", factors: [] }), false);
});

// ── worst-of-four folding ───────────────────────────────────────────────

test("scoreRisk: overall band is the WORST of the four factors, not an average", () => {
  // blast_radius low (docs file), but confidence critical (off_track) -> overall critical.
  const verdict = scoreRisk(diffOf("README.md"), { flightJudgeState: "off_track" });
  assert.equal(verdict.band, "critical");
  const blastRadius = verdict.factors.find((f) => f.factor === "blast_radius");
  assert.equal(blastRadius?.band, "low"); // the OTHER factor stays low; folding takes the worst, not a blend
});

// ── shouldRecordDecision (W1-T32) — DECISIONS.md hygiene ──────────────────
// Acceptance: a trivial filename auto-choice is ledgered but NOT appended to
// DECISIONS.md; a medium+ (or reversibility-noted) decision IS appended —
// over recorded decision fixtures. Nothing is ever silently dropped, only
// promoted-or-not to the durable record (the caller always logs
// decision.autochoose regardless of this verdict).

const TRIVIAL_FILENAME_DECISION = [
  "DECISION_REQUEST",
  "- docs/spike.md",
  "- docs/spike-hello.md (RECOMMENDED)",
  "Reversibility: single new file, revert the sandbox PR to undo.",
].join("\n");

test("shouldRecordDecision: a trivial filename pick (the real WS-0 fixture) is low-risk and NOT recorded", () => {
  const decision = parseDecisionRequest(TRIVIAL_FILENAME_DECISION);
  assert.ok(decision);
  assert.equal(decisionRiskBand(decision!), "low");
  assert.equal(decisionHasExplicitReversibilityCaveat(decision!), false);
  const verdict = shouldRecordDecision(decision!);
  assert.equal(verdict.record, false);
  assert.equal(verdict.band, "low");
});

const MEDIUM_RISK_DECISION = [
  "DECISION_REQUEST",
  "- gate the PreToolUse hook on a config flag",
  "- rewrite the hook entirely (RECOMMENDED)",
  "Reversibility: revert the PR.",
].join("\n");

test("shouldRecordDecision: a decision touching a hook (blast-radius keyword) is medium-risk and IS recorded", () => {
  const decision = parseDecisionRequest(MEDIUM_RISK_DECISION);
  assert.ok(decision);
  assert.equal(decisionRiskBand(decision!), "medium");
  const verdict = shouldRecordDecision(decision!);
  assert.equal(verdict.record, true);
  assert.equal(verdict.band, "medium");
});

const IRREVERSIBLE_CAVEAT_DECISION = [
  "DECISION_REQUEST",
  "- keep the duplicate rows",
  "- delete the duplicate rows (RECOMMENDED)",
  "Reversibility: this is NOT reversible — the rows cannot be undone once deleted.",
].join("\n");

test("shouldRecordDecision: an explicit irreversibility caveat IS recorded even independent of keyword band", () => {
  const decision = parseDecisionRequest(IRREVERSIBLE_CAVEAT_DECISION);
  assert.ok(decision);
  assert.equal(decisionHasExplicitReversibilityCaveat(decision!), true);
  const verdict = shouldRecordDecision(decision!);
  assert.equal(verdict.record, true);
  assert.equal(verdict.band, "high");
});

test("shouldRecordDecision: the routine 'revert the PR' boilerplate alone is NOT an explicit caveat", () => {
  const decision = parseDecisionRequest(TRIVIAL_FILENAME_DECISION);
  assert.ok(decision);
  assert.equal(decisionHasExplicitReversibilityCaveat(decision!), false);
});

test("shouldRecordDecision: is a pure, deterministic function of the decision text", () => {
  const decision = parseDecisionRequest(MEDIUM_RISK_DECISION);
  assert.ok(decision);
  const first = shouldRecordDecision(decision!);
  const second = shouldRecordDecision(decision!);
  assert.deepEqual(first, second);
});
