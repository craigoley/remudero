// GOLDEN-VERDICT SUITE (W1-T423) — MASTER-PLAN's Self-improvement section: "Golden-task eval
// suite … including planted violations (TDD skip, scope creep, test theater, provenance-free
// prompt) … Regressions in the harness's judgment become red CI, not vibes. This is
// mutation-testing discipline applied to the orchestrator." No golden suite existed before this
// task: the reviewer's PARTS were unit-tested, but nothing pinned the END-TO-END verdict a
// canned PR should receive.
//
// Each case under test/fixtures/golden-verdicts/<case>/ holds the judge's REAL inputs (a unified
// diff, the implement worker's report, the task's acceptance criteria, and — for two cases — a
// real checkout/ directory a whitelisted proof executes against) plus a golden.yaml naming the
// REQUIRED verdict facts. This driver reads those fixtures and calls the REAL judges
// (judgeReview, which folds in detectTestTheater, criterionFieldTampered, bodyContradictsDiff,
// the scope advisories, and — via judgeCriterion — the whitelisted proof executor) — it never
// reimplements any of that logic. See test/fixtures/golden-verdicts/README.md for the corpus's
// growth rule and per-case violation summary.
//
// RUNTIME BUDGET: every case is in-process and offline. Five of six never touch the filesystem
// beyond reading their own fixture files (no headCheckoutDir ⇒ the keyword floor only). Two
// (`scope-creep`, `healthy-control`) run one real `grep` against a handful of bytes in their own
// checkout/ directory; `dead-proof` resolves its name-filtered proof via one real `grep` that
// fast-fails on zero candidates (see execWhitelistedProof's fast path) and never spawns `node
// --test` at all. The whole suite is expected to complete in well under a second.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { AcceptanceCriterion } from "../src/lib/plan.js";
import { decideAutoMergeArm, judgeReview, type ReviewEvidence, type ReviewVerdict } from "../src/lib/review.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(HERE, "fixtures", "golden-verdicts");

interface GoldenCriterionFacts {
  met?: boolean;
  floorMet?: boolean;
  proof_exec?: string;
}

interface GoldenFacts {
  violation: string;
  rule: string;
  verdict?: Record<string, unknown>;
  arm?: boolean;
  changesetContradictions?: { claim: string; files: string[] }[];
  unwiredAdvisories?: { reasonCode: string; symbols: string[] }[];
  criteria?: GoldenCriterionFacts[];
}

interface Fixture {
  evidence: ReviewEvidence;
  criteria: AcceptanceCriterion[];
  golden: GoldenFacts;
}

/** Load one case directory's real judge inputs plus its golden.yaml — the ONLY place this
 *  driver reaches into the filesystem itself; everything after this is real `judgeReview`. */
function loadFixture(caseDir: string): Fixture {
  const dir = join(FIXTURES_ROOT, caseDir);
  const diff = readFileSync(join(dir, "diff.patch"), "utf8");
  const report = readFileSync(join(dir, "report.md"), "utf8");
  const criteria = parseYaml(readFileSync(join(dir, "criteria.yaml"), "utf8")) as AcceptanceCriterion[];
  const golden = parseYaml(readFileSync(join(dir, "golden.yaml"), "utf8")) as GoldenFacts;

  const declaredFilesPath = join(dir, "declared-files.yaml");
  const taskDeclaredFiles = existsSync(declaredFilesPath)
    ? (parseYaml(readFileSync(declaredFilesPath, "utf8")) as string[])
    : undefined;

  // W1-T458 — ReviewEvidence.openTaskDeclaredFiles: an OPTIONAL id → declared-files map for open
  // tasks OTHER than this fixture's own (see scope-creep/open-task-declared-files.yaml). Absent
  // for every case that predates this task, matching the fail-closed default.
  const openTaskFilesPath = join(dir, "open-task-declared-files.yaml");
  const openTaskDeclaredFiles = existsSync(openTaskFilesPath)
    ? new Map(Object.entries(parseYaml(readFileSync(openTaskFilesPath, "utf8")) as Record<string, string[]>))
    : undefined;

  const checkoutDir = join(dir, "checkout");
  const headCheckoutDir = existsSync(checkoutDir) ? checkoutDir : undefined;

  return { evidence: { diff, report, taskDeclaredFiles, openTaskDeclaredFiles, headCheckoutDir }, criteria, golden };
}

/** Assert the verdict `judgeReview` actually computed against every fact `golden.yaml` named —
 *  never the other way around: a fact golden.yaml does not mention is simply not checked, so a
 *  case's golden stays a short, legible list of what THAT catch is actually about. */
function assertGolden(verdict: ReviewVerdict, golden: GoldenFacts): void {
  assert.ok(golden.violation, "golden.yaml must name the violation this case plants (or 'none' for the control)");
  assert.ok(golden.rule, "golden.yaml must cite the rule/task that makes this case's verdict the intended one");

  for (const [key, expected] of Object.entries(golden.verdict ?? {})) {
    assert.deepEqual(
      (verdict as unknown as Record<string, unknown>)[key],
      expected,
      `verdict.${key} — golden: ${golden.violation}`,
    );
  }

  if (golden.arm !== undefined) {
    const arm = decideAutoMergeArm(verdict, true);
    assert.equal(arm.arm, golden.arm, `arm decision — golden: ${golden.violation} — reason: ${arm.reason}`);
  }

  if (golden.changesetContradictions !== undefined) {
    assert.deepEqual(
      (verdict.changesetContradictions ?? []).map((c) => ({ claim: c.claim, files: c.files })),
      golden.changesetContradictions,
      `changesetContradictions — golden: ${golden.violation}`,
    );
  }

  if (golden.unwiredAdvisories !== undefined) {
    for (const expected of golden.unwiredAdvisories) {
      const actual = verdict.unwiredAdvisories?.find((a) => a.reasonCode === expected.reasonCode);
      assert.ok(actual, `unwiredAdvisories missing reasonCode ${expected.reasonCode} — golden: ${golden.violation}`);
      assert.deepEqual(
        [...(actual?.symbols ?? [])].sort(),
        [...expected.symbols].sort(),
        `unwiredAdvisories[${expected.reasonCode}].symbols — golden: ${golden.violation}`,
      );
    }
  }

  if (golden.criteria !== undefined) {
    assert.equal(verdict.criteria.length, golden.criteria.length, `criteria count — golden: ${golden.violation}`);
    golden.criteria.forEach((expected, i) => {
      const actual = verdict.criteria[i];
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(
          (actual as unknown as Record<string, unknown>)[key],
          value,
          `criteria[${i}].${key} — golden: ${golden.violation}`,
        );
      }
    });
  }
}

/** Judge one case exactly as `judgeReview` would judge a real PR: its own diff, its own report,
 *  its own criteria, over its own declared-scope/checkout evidence. */
function judgeCase(caseDir: string): { verdict: ReviewVerdict; golden: GoldenFacts } {
  const { evidence, criteria, golden } = loadFixture(caseDir);
  return { verdict: judgeReview(criteria, evidence), golden };
}

test("GOLDEN — TEST THEATER: a tautological assertion added to a test file fails review even though its criterion's keyword floor is met", () => {
  const { verdict, golden } = judgeCase("test-theater");
  assert.equal(golden.violation, "test-theater");
  assertGolden(verdict, golden);
});

test("GOLDEN — SCOPE CREEP: a diff touching a file outside the task's declared scope is flagged as an advisory, but still arms", () => {
  const { verdict, golden } = judgeCase("scope-creep");
  assert.equal(golden.violation, "scope-creep");
  assertGolden(verdict, golden);

  // W1-T458 (acceptance #3): this fixture's task IS resolved (declared-files.yaml is non-empty)
  // AND its report carries no `Remudero-Task:` trailer at all (design (iii)'s own example) AND
  // (via open-task-declared-files.yaml) a DIFFERENT open task declares the very file this diff
  // touches — three conditions that, keyed on "no trailer in the body" instead of "no task
  // resolved", would together mis-fire the new advisory and shift this golden case. Keyed
  // correctly, it must stay silent: the golden fixture does not shift.
  assert.doesNotMatch(readFileSync(join(FIXTURES_ROOT, "scope-creep", "report.md"), "utf8"), /Remudero-Task:/);
  assert.equal(
    verdict.unwiredAdvisories?.filter((a) => a.reasonCode === "unresolved_task_scope").length ?? 0,
    0,
    "a resolved task must never trip unresolved_task_scope, trailer or no trailer",
  );
});

test("GOLDEN — PROVENANCE-FREE: a report claiming a path was untouched while the diff touches it fails review", () => {
  const { verdict, golden } = judgeCase("provenance-free");
  assert.equal(golden.violation, "provenance-free");
  assertGolden(verdict, golden);
});

test("GOLDEN — TAMPERED CRITERION: a diff that appends a new claim/proof to its own task's plan shard fails review", () => {
  const { verdict, golden } = judgeCase("tampered-criterion");
  assert.equal(golden.violation, "tampered-criterion");
  assertGolden(verdict, golden);
});

test("GOLDEN — DEAD PROOF: a unit-test proof naming a fabricated test title that matches nothing on the checkout fails review, overriding a keyword floor that would otherwise pass", () => {
  const { verdict, golden } = judgeCase("dead-proof");
  assert.equal(golden.violation, "dead-proof");
  assertGolden(verdict, golden);
});

test("GOLDEN — HEALTHY CONTROL: a correct PR with no planted violation arms — the suite rewards acceptance, not blanket refusal", () => {
  const { verdict, golden } = judgeCase("healthy-control");
  assert.equal(golden.violation, "none");
  assertGolden(verdict, golden);
});
