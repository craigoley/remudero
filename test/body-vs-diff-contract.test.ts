/**
 * test/body-vs-diff-contract.test.ts — impl-FV.
 *
 * THE GAP (recon-FT). `bodyContradictsDiff` folds into `judgeReview`'s state, so a body that
 * contradicts its own diff is a REQUIRED-check failure with no floor to fall back on — and until
 * this PR NO prompt in the repository mentioned it. Its zero observed failures are its AGE (it
 * landed 2026-07-31), not compliance.
 *
 * WHAT THIS SUITE PROVES, AND WHAT IT CANNOT.
 *
 * It CANNOT prove an LLM will obey the contract. Nothing short of a real dispatch can, and a test
 * asserting the string appears in the prompt would be brittle and would prove nothing about the
 * gate. So instead this asserts the instruction is TRUE OF THE REAL CHECK: every body shape the
 * contract calls SAFE is run through the real `bodyContradictsDiff` and must be accepted, and every
 * shape it calls UNSAFE must be rejected. That makes a prompt verifiable even though compliance is
 * not — if the check's behaviour ever drifts from what the contract claims, these fail.
 *
 * It also pins the two REAL incidents (#974, #1025) as still-rejected, so the contract cannot have
 * taught a workaround that defeats the gate it is explaining.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { bodyVsDiffContractLines, outputContractLines } from "../src/lib/compaction.js";
import { bodyContradictsDiff, claimsChangesetContext, noClaimIsAboutChangeset } from "../src/lib/review.js";

/** A typical implement changeset: two source files and a test. */
const DIFF = ["src/lib/compaction.ts", "src/run-task.ts", "test/body-vs-diff-contract.test.ts"];

const accepted = (body: string, files: string[] = DIFF) => bodyContradictsDiff(body, files);

// ── WHAT THE CONTRACT CALLS SAFE — the real check must ACCEPT all of it ──────

test("SAFE: the same words about something OTHER than the changeset are ignored, as the contract says", () => {
  // This is the contract's central claim — "the identical words about anything else are
  // deliberately ignored" — and it is the reason a word blacklist would have been the wrong rule.
  // Each of these is a real shape a session was forced to reword before the anchoring landed.
  for (const body of [
    "Each unit-test proof resolves to exactly one file and matches exactly 1 test.", // PR #1077, live fixture
    "This change introduces no code duplication anywhere.", // fired six times before the (b) anchor
    "The helper reads exactly one file from the fixture directory.",
    "There are no bugs, no regressions, and no issues outstanding.",
    "The reaper leaves exactly two files behind in the scratch directory.",
  ]) {
    assert.deepEqual(accepted(body), [], `the check must stay silent on: ${body}`);
  }
});

test("SAFE: a TRUE changeset claim passes — an accurate count, an accurate enumeration, an accurate absence", () => {
  assert.deepEqual(accepted("This PR changes exactly three files."), []);
  assert.deepEqual(
    accepted("The diff touches exactly three files: src/lib/compaction.ts, src/run-task.ts, test/body-vs-diff-contract.test.ts"),
    [],
  );
  assert.deepEqual(accepted("This PR changed no docs/ORIENTATION.md and no plan/tasks.yaml."), []);
});

test("SAFE: 'no <bare word>' is never a changeset claim — the contract says 'no bugs' is ignored", () => {
  // A worker made cautious by a word blacklist would avoid these; the contract explicitly frees them.
  assert.deepEqual(accepted("This PR changes no behaviour and no semantics."), []);
  assert.deepEqual(accepted("no regressions"), []);
});

// ── WHAT THE CONTRACT CALLS UNSAFE — the real check must REJECT all of it ────

test("UNSAFE: a count claim tied to the changeset by a changeset word, with the wrong N", () => {
  const hits = accepted("This PR changes exactly one file.");
  assert.equal(hits.length, 1, "a wrong count anchored by 'changes' must be caught");
  assert.match(hits[0].claim, /exactly one file/);
});

test("UNSAFE: a count claim tied by an ENUMERATION, naming a file not in the diff", () => {
  const hits = accepted("exactly three files: src/lib/compaction.ts, src/run-task.ts, docs/ORIENTATION.md");
  assert.equal(hits.length, 1, "the count is right but a named file is absent — still a contradiction");
});

test("UNSAFE: `no <path>` followed by a changeset word, where the path IS in the diff", () => {
  const hits = accepted("This PR touches no src/ changes at all.");
  assert.ok(hits.length >= 1, "the src/ claim is false and anchored");
  assert.ok(hits.some((h) => h.files.some((f) => f.startsWith("src/"))));
});

test("UNSAFE: the two hyphenated shorthands fire ANYWHERE, whatever the subject — exactly as the contract warns", () => {
  // THE PART A WORKER MOST NEEDS. Unlike the other two shapes these are UNANCHORED: a bare
  // /\bplan-only\b/i over the whole body. A session had to RENAME a test to avoid quoting one.
  const a = accepted("The lane's scope guard is what makes a triage PR plan-only by construction.");
  assert.ok(a.length >= 1, "no subject anchoring — it fires on a sentence about the LANE, not this diff");

  const b = accepted("Prior art: PR #1025 described its revert as data-only.");
  assert.ok(b.length >= 1, "and on a sentence about ANOTHER PR");
});

// ── (6) THE REPLAY: the two real incidents are still rejected ────────────────

test("REPLAY #974: 'exactly one file: MASTER-PLAN.md' over a 3-file diff is still caught", () => {
  const body = "git show --stat listed exactly one file: MASTER-PLAN.md. No src/, no test/, no docs/ORIENTATION.md.";
  const hits = bodyContradictsDiff(body, ["MASTER-PLAN.md", "docs/ORIENTATION.md", "src/lib/review.ts"]);
  assert.ok(hits.length >= 1, "the PR this check was built for must still fail");
  assert.ok(hits.some((h) => /exactly one file/.test(h.claim)), `got ${JSON.stringify(hits.map((h) => h.claim))}`);
});

test("REPLAY #1025: a non-source claim over a source revert is still caught", () => {
  // The one that silently reverted three merged PRs, caught only because a deleted export failed
  // to compile. Six src/ + two test/ files.
  const files = ["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts", "src/lib/d.ts", "src/lib/e.ts", "src/lib/f.ts", "test/a.test.ts", "test/b.test.ts"];
  const hits = bodyContradictsDiff("data-only: this revert changes no code.", files);
  assert.ok(hits.length >= 1, "the shorthand must still fire");
  assert.ok(hits.some((h) => h.files.some((f) => f.startsWith("src/"))));
});

// ── the contract is actually WIRED into both body-writing prompts ────────────

test("the contract reaches the implement worker's prompt, and is one shared literal", async () => {
  const contract = bodyVsDiffContractLines();
  assert.ok(contract.length > 0);
  const implement = outputContractLines("W1-T1").join("\n");
  assert.ok(implement.includes(contract.join("\n")), "the implement contract carries it verbatim");

  // And the fix rung — the prompt most prone to a stale body, because it amends an existing PR.
  const { renderFixPrompt } = await import("../src/run-task.js");
  const fix = renderFixPrompt({
    task: { id: "W1-T1", title: "t", acceptance: [] } as never,
    branch: "run-W1-T1-1",
    mode: "review",
    evidence: {} as never,
  } as never);
  assert.ok(fix.includes(contract.join("\n")), "the fix rung carries the SAME literal, not a paraphrase");
});

test("the contract's own claims about anchoring match the real anchoring helpers", () => {
  // The contract says a count claim needs a changeset word EARLIER IN THE SAME SENTENCE, and a
  // `no <path>` claim needs one as the NEXT WORD. Assert both against the real helpers, so a
  // change to either direction fails here rather than silently making the prompt a lie.
  const sentence = "This PR changes exactly one file";
  assert.equal(claimsChangesetContext(sentence, sentence.indexOf("exactly")), true);
  // A changeset word in the PREVIOUS sentence does not carry over.
  const twoSentences = "This PR changed a lot. Each proof resolves to exactly one file";
  assert.equal(claimsChangesetContext(twoSentences, twoSentences.indexOf("exactly")), false);

  assert.equal(noClaimIsAboutChangeset(" changes at all"), true, "next word IS a changeset word");
  assert.equal(noClaimIsAboutChangeset(" duplication anywhere"), false, "next word is not");
  // THE CASE THAT CORRECTED THE CONTRACT'S OWN WORDING. An end-of-line `no <path>` has no next
  // word, so the helper FAILS CLOSED and reads it as a claim (review.ts: "the token IS the
  // claim"). My first draft said "read only when the next word ... is a changeset word", which
  // would have taught a worker that a trailing `no src/` is safe. It is not:
  assert.equal(noClaimIsAboutChangeset(""), true, "end of input — the token IS the claim");
  assert.equal(noClaimIsAboutChangeset("\n  more prose"), true, "end of LINE — still the claim");
  assert.equal(noClaimIsAboutChangeset("."), true, "punctuation — still the claim");
  assert.deepEqual(
    bodyContradictsDiff("This PR is small.\nIt touches no src/\nMore prose.", ["src/lib/a.ts"]),
    [{ claim: "no src/", files: ["src/lib/a.ts"] }],
    "and end-to-end: a trailing `no src/` over a src-touching diff IS rejected",
  );
});
