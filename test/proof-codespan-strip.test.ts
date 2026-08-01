import assert from "node:assert/strict";
import test from "node:test";
import { cappedReason, judgeReview, parseWhitelistedProof } from "../src/lib/review.js";
import { reviewPostedDescription } from "../src/run-task.js";

// A dialect proof wrapped in a markdown CODE SPAN is the same proof, and used not to be.
// `parseAcceptanceBlock` extracts bullet text verbatim, so `` `grep: x in y` `` reached the dialect
// matchers with a leading backtick, failed them, and fell through to `not_executable` -- a CAPPED
// 0/N verdict on work whose proofs were perfect. Measured on the real bodies: PR #1037 parsed 0/4,
// PR #1057 0/6, while PR #1038's unwrapped proofs parsed 8/8.

test("a backticked unit test proof parses", () => {
  const p = parseWhitelistedProof("`unit test: the sha is captured at server START`");
  assert.ok(p, "a code-span-wrapped dialect proof must parse");
  assert.equal(p.kind, "test");
});

test("a backticked grep proof parses", () => {
  const p = parseWhitelistedProof("`grep: ownedDir in src/lib/feedback-landing.ts`");
  assert.ok(p);
  assert.equal(p.kind, "grep");
});

test("a double-backtick span and a padded span both parse", () => {
  assert.ok(parseWhitelistedProof("``grep: ownedDir in src/lib/feedback-landing.ts``"));
  assert.ok(parseWhitelistedProof("` grep: ownedDir in src/lib/feedback-landing.ts `"));
});

test("the bare form is unchanged", () => {
  const p = parseWhitelistedProof("grep: ownedDir in src/lib/feedback-landing.ts");
  assert.ok(p);
  assert.equal(p.kind, "grep");
});

test("INTERIOR-BACKTICK LOCK: a grep pattern keeps a backtick that is part of the pattern", () => {
  // Trap 2: a strip that eats interior backticks turns a fix into a defect. A proof may legitimately
  // search for a template literal. Only a WRAPPING pair is removed -- never an interior character.
  const bare = parseWhitelistedProof("grep: const x = `lit` in src/lib/serve.ts");
  assert.ok(bare, "an interior backtick must not prevent parsing");
  assert.match(bare.label ?? "", /`lit`/, "the interior backticks must survive verbatim");

  const wrapped = parseWhitelistedProof("`grep: const x = `lit` in src/lib/serve.ts`");
  assert.ok(wrapped, "a wrapped proof whose pattern also contains backticks must still parse");
  assert.match(wrapped.label ?? "", /`lit`/, "stripping the wrapper must not touch the interior");
});

test("the LEGACY fenced grep shape still parses -- its backticks are load-bearing", () => {
  // `GREP_FENCE_RE` matches a fenced shell command and REQUIRES its backticks. This is why the strip
  // is a fallback rather than an entry-point normalisation: stripping up front would null this.
  const p = parseWhitelistedProof("see `grep -rn ownedDir src/`");
  assert.ok(p, "the legacy fenced shape must be unaffected by the code-span fallback");
  assert.equal(p.kind, "grep");
});

test("a prose proof is STILL not executable -- the gate is not weakened", () => {
  assert.equal(parseWhitelistedProof("the bound is enforced at the call site"), null);
  assert.equal(parseWhitelistedProof("`the bound is enforced at the call site`"), null);
});

// ── capped_reason ────────────────────────────────────────────────────────────
// A CAPPED 0/N was four situations wearing one face. These pin that each names itself.

test("capped_reason: proofs that never parsed report no-dialect", () => {
  assert.equal(cappedReason([{ proof_exec: "not_executable", proof_skip: "no-dialect" }]), "no-dialect:1");
});

test("capped_reason: a prose proof that matched no test reports prose-no-match", () => {
  assert.equal(
    cappedReason([{ proof_exec: "not_executable", proof_skip: "prose-no-match" }]),
    "prose-no-match:1",
  );
});

test("capped_reason: a run with no checkout reports no-exec-context", () => {
  assert.equal(
    cappedReason([{ proof_exec: "not_executable", proof_skip: "no-exec-context" }]),
    "no-exec-context:1",
  );
});

test("capped_reason: an execution error reports exec-error", () => {
  assert.equal(cappedReason([{ proof_exec: "exec_error", proof_skip: "exec-error" }]), "exec-error:1");
});

test("capped_reason: mixed causes are counted and ordered deterministically", () => {
  const mixed = cappedReason([
    { proof_exec: "not_executable", proof_skip: "prose-no-match" },
    { proof_exec: "not_executable", proof_skip: "no-dialect" },
    { proof_exec: "not_executable", proof_skip: "no-dialect" },
  ]);
  assert.equal(mixed, "no-dialect:2,prose-no-match:1", "highest count first, then alphabetical");
});

test("capped_reason is ABSENT when every proof executed", () => {
  assert.equal(cappedReason([{ proof_exec: "executed_pass" }, { proof_exec: "executed_fail" }]), undefined);
});

test("a judged review that could not parse its proofs reports no-dialect end to end", () => {
  // The whole path: a backticked proof under a review with NO exec context still caps, and the
  // reason names why rather than leaving a bare 0/N.
  const verdict = judgeReview(
    [{ claim: "the bound is enforced", proof: "some free prose about the bound" }],
    { report: "the bound is enforced and the call site is covered", diff: "" },
  );
  assert.equal(verdict.capped, true, "an executable-criteria review with nothing executed is capped");
  assert.equal(cappedReason(verdict.criteria), "no-exec-context:1");
});

test("the posted status description NAMES the cap's cause when materialization was fine", () => {
  // run-task.ts's reviewPostedDescription: a capped verdict with a HEALTHY checkout used to render
  // its bare summary, saying nothing about why 0/N executed. That silence is what cost a recon.
  const description = reviewPostedDescription({
    summary: "CAPPED — 0/2 proofs executed",
    capped: true,
    criteria: [
      { proof_exec: "not_executable", proof_skip: "no-dialect" },
      { proof_exec: "not_executable", proof_skip: "no-dialect" },
    ] as never,
  });

  assert.match(description, /capped: no-dialect:2/, "the description must name the cause");
});
