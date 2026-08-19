import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  COMMIT_BODY_MAX_LINE,
  acceptanceCriterionLines,
  triageAcceptanceProof,
  triageCommitMessage,
} from "../src/lib/triage.js";
import {
  execWhitelistedProof,
  judgeCriterion,
  narrowNameFilteredArgs,
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
test("W1-T963: removing the discrimination fails the base-side test", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const triageTsPath = join(repoRoot, "src", "lib", "triage.ts");
  const targetTestFile = "test/triage-proof-dialect.test.ts";
  const positiveTestName = "W1-T963: the triage proof fails at base and passes at head";

  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

  const original = readFileSync(triageTsPath, "utf8");
  const originalSha = sha256(original);

  const needle = "  return `grep: status: ${status} in ${feedbackEntryRepoPath(feedbackId)}`;\n";
  const occurrences = original.split(needle).length - 1;
  assert.equal(
    occurrences,
    1,
    "sanity: triageAcceptanceProof's return line must appear EXACTLY once, or this mutation is not targeting the real emitter",
  );
  const mutated = original.replace(
    needle,
    "  return `grep: status: in ${feedbackEntryRepoPath(feedbackId)}`; // W1-T963 MUTATION: destination-state interpolation removed\n",
  );

  const whitelisted = parseWhitelistedProof(`unit test: ${positiveTestName}`);
  assert.ok(whitelisted, "sanity: the proof text must parse as a name-filtered `unit test:` dialect proof");
  assert.ok(whitelisted!.nameFiltered, "sanity: it must be the name-filtered shape (carries --test-name-pattern)");
  const args = narrowNameFilteredArgs(whitelisted!.args, [targetTestFile]);

  let childResult: ReturnType<typeof spawnSync> | undefined;
  try {
    writeFileSync(triageTsPath, mutated);
    const mutatedSha = sha256(readFileSync(triageTsPath, "utf8"));
    assert.notEqual(mutatedSha, originalSha, "the mutation must actually change triage.ts's bytes");

    // Strip NODE_TEST_CONTEXT (see test/dispatch-lifetime-breaker.test.ts's W1-T951 mutation
    // check): inherited by default, it makes node's OWN test runner treat this as a recursive
    // `run()` and skip every file — a silent no-op that would pass for the wrong reason.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    childResult = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", timeout: 90_000, env: childEnv });
  } finally {
    // RESTORED REGARDLESS of what the child run did.
    writeFileSync(triageTsPath, original);
    const restoredSha = sha256(readFileSync(triageTsPath, "utf8"));
    assert.equal(restoredSha, originalSha, "triage.ts must be restored byte-for-byte after the mutation check");
  }

  assert.ok(childResult, "sanity: the child process must actually have been spawned");
  assert.notEqual(
    childResult!.status,
    0,
    `the base-side test must FAIL once the discrimination is removed (child stdout: ${childResult!.stdout})`,
  );
});
