import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { writeMutantModule } from "./helpers/mutant-module.js";
import { mutateTriageProofSource } from "./helpers/triage-proof-needle.js";
import {
  COMMIT_BODY_MAX_LINE,
  acceptanceCriterionLines,
  triageAcceptanceProof,
  triageCommitMessage,
} from "../src/lib/triage.js";
import {
  execWhitelistedProof,
  judgeCriterion,
  parseAcceptanceBlock,
  parseWhitelistedProof,
} from "../src/lib/review.js";
import { feedbackEntryRepoPath } from "../src/lib/feedback.js";
import type { FeedbackStatus } from "../src/lib/feedback.js";

// ── impl-GZ: every triage PR used to post CAPPED — 0/1 proofs executed ─────────────────────────
//
// `triageCommitMessage` hard-coded three fixed English phrases as its Acceptance proof —
// "feedback yaml flips to rejected", "in-diff provenance; status proposed",
// "needs-human issue; grilling". Each named a true, checkable fact and none could be parsed, so
// EVERY triage PR was capped: 25 of the 28 capped verdicts in the two days after `capped_reason`
// was introduced were exactly this, one per triage fire (state/recon-GY-no-dialect-caps.md).
//
// These tests drive the REAL emitter and the REAL parser — `triageCommitMessage` in,
// `parseAcceptanceBlock` + `parseWhitelistedProof` out, no seam, no fixture body. That matters
// here specifically: the defect was invisible for weeks because nothing ever fed the emitter's
// own output back through the parser that judges it.
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** The longest feedback id observed in production — a GitHub code-scanning alert id (44 chars). */
const LONGEST_REAL_ID = "fb-alert-craigoley-remudero-code-scanning-17";
/** The ordinary generated shape, `fb-<epoch-ms>-<6 hex>` (23 chars). */
const GENERATED_ID = "fb-1784766956423-6635d1";

type Case = { label: string; decision: Parameters<typeof triageCommitMessage>[0]["decision"]; status: FeedbackStatus };

function cases(id: string): Case[] {
  return [
    {
      label: "no_task",
      status: "rejected",
      decision: { action: "no_task", status: "rejected", detail: "already answered in DECISIONS §4" },
    },
    {
      label: "grill",
      status: "grilling",
      decision: {
        action: "grill",
        status: "grilling",
        detail: "two defensible readings",
        options: [
          { label: "A", detail: "a" },
          { label: "B", detail: "b" },
        ],
        recommendation: "A",
      } as Case["decision"],
    },
    {
      label: "propose",
      status: "proposed",
      decision: { action: "propose", status: "proposed", detail: "adds W1-T300", files: ["plan/tasks.d/x.yaml"] },
    },
  ];
}

function messageFor(c: Case, id: string): string {
  return triageCommitMessage({
    decision: c.decision,
    feedbackId: id,
    taskId: `TRIAGE-${id}`,
    grillIssueUrl: "https://github.com/o/r/issues/1",
  });
}

test("every triage decision emits an Acceptance proof the REAL parser accepts as executable", () => {
  for (const id of [GENERATED_ID, LONGEST_REAL_ID]) {
    for (const c of cases(id)) {
      const criteria = parseAcceptanceBlock(messageFor(c, id));
      assert.equal(criteria.length, 1, `${c.label}/${id}: exactly one criterion must survive the block parser`);
      const proof = criteria[0]!.proof;
      assert.ok(proof.length > 0, `${c.label}: the proof must not be empty`);
      const parsed = parseWhitelistedProof(proof);
      assert.ok(parsed, `${c.label}: parseWhitelistedProof REFUSED ${JSON.stringify(proof)} — this is the whole defect`);
      assert.equal(parsed!.kind, "grep");
    }
  }
});

test("the proof asserts the SAME status the decision writes — it cannot drift from setFeedbackStatus", () => {
  for (const c of cases(GENERATED_ID)) {
    const proof = parseAcceptanceBlock(messageFor(c, GENERATED_ID))[0]!.proof;
    assert.equal(
      proof,
      `grep: status: ${c.status} in plan/feedback/${GENERATED_ID}.yaml`,
      `${c.label}: the proof must name the status the harness actually writes`,
    );
    assert.equal(triageAcceptanceProof(GENERATED_ID, c.status), proof, "the shared renderer and the emitter must agree");
  }
});

test("the proof pattern DISCRIMINATES — it matches the flipped entry and misses the merge base's `status: new`", () => {
  // A grep matching BOTH head and base is downgraded to `executed_stale` (W1-T273) and leaves the
  // verdict capped exactly as before, so "it parses" is not sufficient.
  const parsed = parseWhitelistedProof(triageAcceptanceProof(GENERATED_ID, "rejected"))!;
  const pattern = parsed.args[parsed.args.indexOf("--") + 1]!;
  assert.equal(pattern, "status: rejected");
  const base = "id: x\nstatus: new\nproposal_pr: null\n";
  const head = "id: x\nstatus: rejected\nproposal_pr: null\n";
  assert.ok(new RegExp(pattern).test(head), "must match the head");
  assert.ok(!new RegExp(pattern).test(base), "must MISS the base — otherwise executed_stale, still capped");
});

test("no ACCEPTANCE line exceeds commitlint's body-max-line-length, for the longest real feedback id", () => {
  // commitlint's body-max-line-length (100) is a REQUIRED check; a naive single-line bullet
  // carrying this proof is ~170 chars and would red it. Scoped to the block THIS emitter owns:
  // the `grill` HEADER is 102 chars for a 44-char alert id, byte-identically on origin/main —
  // a pre-existing overflow on a different rule (header-max-length), deliberately not touched here.
  for (const id of [GENERATED_ID, LONGEST_REAL_ID]) {
    for (const c of cases(id)) {
      const lines = messageFor(c, id).split("\n");
      const start = lines.indexOf("Acceptance:");
      assert.ok(start >= 0, `${c.label}: an Acceptance block must be emitted`);
      const block = lines.slice(start, start + 3);
      const over = block.filter((l) => l.length > COMMIT_BODY_MAX_LINE);
      assert.deepEqual(over, [], `${c.label}/${id}: these Acceptance lines would fail commitlint`);
    }
  }
});

test("the CLAIM is elided when long, the PROOF never is", () => {
  const lines = acceptanceCriterionLines("x".repeat(400), "grep: status: rejected in plan/feedback/a.yaml");
  assert.equal(lines[0]!.length, COMMIT_BODY_MAX_LINE, "the claim line is capped");
  assert.ok(lines[0]!.endsWith("…"), "and elided");
  assert.equal(lines[1], " proof: grep: status: rejected in plan/feedback/a.yaml", "the proof line is untouched");
  assert.ok(!lines[1]!.includes("…"), "a truncated proof is a silent cap — the defect being fixed");
});

test("the id-length budget is pinned, so a longer future id fails HERE and not in CI", () => {
  // proof line = " proof: " (8) + "grep: status: " (14) + status (8) + " in plan/feedback/" (18)
  //            + id + ".yaml" (5)  =  53 + id.length
  const lineFor = (n: number) => acceptanceCriterionLines("c", triageAcceptanceProof("x".repeat(n), "rejected"))[1]!.length;
  assert.equal(lineFor(LONGEST_REAL_ID.length), 53 + LONGEST_REAL_ID.length);
  assert.ok(lineFor(LONGEST_REAL_ID.length) <= COMMIT_BODY_MAX_LINE, "today's longest real id fits");
  assert.equal(lineFor(47), COMMIT_BODY_MAX_LINE, "47 chars is the exact ceiling");
  assert.ok(lineFor(48) > COMMIT_BODY_MAX_LINE, "48 would not fit — this assertion is the early warning");
});

test("the three unparseable prose phrases are gone from every emitted message", () => {
  const dead = ["feedback yaml flips to rejected", "in-diff provenance; status proposed", "needs-human issue; grilling"];
  for (const c of cases(GENERATED_ID)) {
    const msg = messageFor(c, GENERATED_ID);
    for (const phrase of dead) {
      assert.ok(!msg.includes(phrase), `${c.label}: the emitter still ships the unparseable phrase ${JSON.stringify(phrase)}`);
    }
  }
});

// ── W1-T963: THE PROOF ACTUALLY DISCRIMINATES, DRIVEN THROUGH THE REAL EXECUTOR ────────────────
//
// The empty-diff-triage-merge incident (#2075/#2077/#2078 merged and passed review despite
// changing nothing): the prior test above ("the proof pattern DISCRIMINATES…") only regex-tests
// the pattern in isolation. This drives the SAME `triageAcceptanceProof` output through the REAL
// pipeline `remudero-review` uses — {@link judgeCriterion} + {@link execWhitelistedProof} — against
// two REAL on-disk checkouts (a "base" carrying `status: new`, a "head" carrying `status:
// rejected`), in ONE run, so a positive control (passes at head) and its refusal (fails at base)
// can never pass vacuously in isolation from each other (design note (vi)).
function writeFeedbackEntry(root: string, relPath: string, status: string): void {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `id: x\nstatus: ${status}\nproposal_pr: null\n`);
}

test("W1-T963: the triage proof fails at base and passes at head", () => {
  const feedbackId = GENERATED_ID;
  const relPath = feedbackEntryRepoPath(feedbackId);
  const proof = triageAcceptanceProof(feedbackId, "rejected");
  const whitelisted = parseWhitelistedProof(proof);
  assert.ok(whitelisted, "sanity: the proof must parse as an executable grep dialect");
  assert.equal(whitelisted!.kind, "grep");

  const baseDir = mkdtempSync(join(tmpdir(), "w1-t963-base-"));
  const headDir = mkdtempSync(join(tmpdir(), "w1-t963-head-"));
  try {
    writeFeedbackEntry(baseDir, relPath, "new"); // the merge base — pre-flip
    writeFeedbackEntry(headDir, relPath, "rejected"); // the PR head — post-flip

    // ONE RUN carries both directions: baseCwd wired exactly like buildBaseProofDir wires it for
    // the real gate (run-task.ts:8044), so `classifyBaseProofOutcome`'s own base re-run is what
    // proves "fails at base" here — never a second, independent assertion that could drift.
    const criterion = { claim: "the feedback entry is closed out", proof };
    const verdict = judgeCriterion(criterion, new Set<string>(), undefined, {
      cwd: headDir,
      exec: execWhitelistedProof,
      baseCwd: baseDir,
    });
    assert.equal(verdict.met, true, "the proof must be MET at the head");
    assert.equal(
      verdict.proof_exec,
      "executed_pass",
      `must be executed_pass, discriminating from the base (got ${verdict.proof_exec}): ${verdict.reason}`,
    );

    // The base-side half of the SAME claim, executed directly (not merely inferred from
    // `executed_pass` above): the whitelisted grep genuinely exits non-matching on the base tree.
    assert.equal(execWhitelistedProof(whitelisted!, baseDir), "fail", "the proof must FAIL at the merge base, directly");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }
});

// "A refusal test alone proves nothing… An implementation that refuses EVERY PR satisfies 'an
// empty-diff PR is refused' perfectly, and a proof-checker that fails every proof satisfies 'the
// proof fails at base' perfectly." (design note (vi)) — and "the mutation check must be
// file-sha-bracketed… read the sha256 of the edited file, remove the discrimination, read it
// again and require it to DIFFER, run the suite and require the base-side test to FAIL, restore,
// and require the sha to return to the original." (design note (vii), verbatim shape mirrored
// from test/dispatch-lifetime-breaker.test.ts's W1-T951 mutation check.)
//
// This mutates the REAL, checked-out `src/lib/triage.ts` on disk (restored in a `finally`,
// verified byte-identical by its own sha256 afterward), dropping the ONE thing that makes
// `triageAcceptanceProof`'s pattern destination-specific — the `${status}` interpolation — so the
// pattern becomes the bare, always-present `status:` and matches the base fixture too. A REAL
// child `node --test` process, narrowed to ONLY the test above by name, must then FAIL: the
// base-side "must FAIL at the merge base" assertion observes a match it should not.
//
// W1-T2587: the needle is `TRIAGE_PROOF_NEEDLE` — the template-literal EXPRESSION alone, not the
// full `return ...;` STATEMENT — because inside Stryker's mutation sandbox `src/lib/triage.ts` is
// instrumented and the statement's exact text is gone even though the expression's own text is
// not. See `test/helpers/triage-proof-needle.ts` and
// `test/a-hand-rolled-mutation-test-collides-with-the-real-harness.test.ts` for the mechanism and
// the proof that this survives an instrumented copy.
test("W1-T963: removing the discrimination makes the proof match the BASE too", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const triageTsPath = join(repoRoot, "src", "lib", "triage.ts");
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  const original = readFileSync(triageTsPath, "utf8");
  const originalSha = sha256(original);

  const { matchCount, mutated } = mutateTriageProofSource(original);
  assert.equal(
    matchCount,
    1,
    "sanity: triageAcceptanceProof's discriminating template literal must appear EXACTLY once, or " +
      "this mutation is not targeting the real emitter (W1-T2587: must hold on an instrumented copy too)",
  );
  assert.notEqual(sha256(mutated), originalSha, "the mutation must actually change the bytes it is applied to");

  // THE COPY, NEVER THE CHECKED-OUT FILE. This check used to `writeFileSync` the mutant over the
  // real `src/lib/triage.ts` and run a child `node --test` against it. Node runs test FILES in
  // parallel, so for the width of that window every OTHER file importing `src/lib/triage.js` — in
  // practice `test/triage.test.ts` — loaded the mutated emitter and saw a proof with no
  // destination state. MEASURED: four assertions in that sibling file (`/grilling/`, `/proposed/`,
  // `/rejected/`, and the seeded ambiguous case) failed on PRs whose diffs touched neither triage
  // nor tests at all, including one carrying only three workflow-YAML version bumps. The failures
  // read as flake because the race is timing-dependent — the same head passed `ci` and failed
  // `coverage-ratchet`. `writeMutantModule` writes the copy under `test/` and rewrites its sibling
  // specifiers to the REAL modules, so the falsifier still exercises the real collaborators while
  // no other suite can ever observe a mutated source file.
  const mutantPath = writeMutantModule("triage.ts", mutated);
  const mutant = (await import(mutantPath)) as typeof import("../src/lib/triage.js");

  const feedbackId = GENERATED_ID;
  const relPath = feedbackEntryRepoPath(feedbackId);
  const baseDir = mkdtempSync(join(tmpdir(), "w1-t963-mut-base-"));
  const headDir = mkdtempSync(join(tmpdir(), "w1-t963-mut-head-"));
  try {
    writeFeedbackEntry(baseDir, relPath, "new"); // the merge base — pre-flip
    writeFeedbackEntry(headDir, relPath, "rejected"); // the PR head — post-flip

    const mutantProof = parseWhitelistedProof(mutant.triageAcceptanceProof(feedbackId, "rejected"));
    assert.ok(mutantProof, "sanity: the mutant's proof must still parse — otherwise this proves only that it is malformed");
    assert.equal(
      execWhitelistedProof(mutantProof!, headDir),
      "pass",
      "the mutant is not simply broken: it still matches at the head",
    );
    assert.equal(
      execWhitelistedProof(mutantProof!, baseDir),
      "pass",
      "THE DEFECT the interpolation exists to prevent: with no destination state the pattern is the " +
        "always-present bare `status:`, so it matches the merge base too and discriminates nothing",
    );

    // THE PAIRED CONTROL, same fixtures and same executor: the COMMITTED emitter refuses the base.
    // Without it the assertion above would hold just as well against a base fixture that matched
    // everything, or an executor that returned "pass" unconditionally.
    const realProof = parseWhitelistedProof(triageAcceptanceProof(feedbackId, "rejected"));
    assert.ok(realProof);
    assert.equal(
      execWhitelistedProof(realProof!, baseDir),
      "fail",
      "the committed emitter DOES discriminate — the mutant's base-side pass is the mutation, not the fixture",
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(headDir, { recursive: true, force: true });
  }

  // The real source was never written at all — asserted rather than assumed, since the whole point
  // of this rewrite is that no other suite can observe a mutated `src/lib/triage.ts`.
  assert.equal(sha256(readFileSync(triageTsPath, "utf8")), originalSha, "the checked-out source must be byte-identical");
});
