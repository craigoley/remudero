import assert from "node:assert/strict";
import { test } from "node:test";

import { acceptanceAuthorTimeCheck } from "../src/lib/review.js";

// ── A GATE PASSED A BODY WHOSE CRITERIA IT COULD NOT READ ───────────────────────────────────────
//
// `acceptanceAuthorTimeCheck` returns ok on ANY `Remudero-Task:` trailer, with the message
// "criteria resolve from plan/tasks.yaml". That warrant is real when the trailer names a task the
// plan declares — the body's block is then decoration and need not be judgeable. It is FALSE when
// the trailer resolves to nothing: the reviewer falls back to the body, and a body the gate never
// looked at ships with whatever its block happens to parse to.
//
// MEASURED on #2908: `Remudero-Task: RETRO-1787714349337` matched zero ids across `plan/tasks.yaml`
// and every `plan/tasks.d/` shard, the gate read `success`, and the block gave 5 bullets written /
// 1 criterion parsed. Four criteria were invisible to the reviewer, and the verdict named the only
// one it could see.
//
// THE NEGATIVE ASSERTIONS ARE THE POINT. Each arm below asserts what the OTHER arm would have
// produced is absent, so a change that collapses the two into one verdict cannot pass by producing
// the right string for the wrong reason.

const TRUNCATED_BODY = [
  "## Acceptance",
  "",
  "- first claim | some prose proof that wraps",
  "  onto a second line, which terminates the block",
  "- second claim | unit test: test/x.test.ts",
  "- third claim | unit test: test/x.test.ts",
  "",
  "Remudero-Task: RETRO-1787714349337",
].join("\n");

const CLEAN_BODY = [
  "## Acceptance",
  "",
  "- first claim | unit test: test/x.test.ts",
  "- second claim | unit test: test/x.test.ts",
  "",
  "Remudero-Task: W1-T2244",
].join("\n");

const resolvesNothing = () => false;
const resolvesEverything = () => true;
const realPlan = (id: string) => id === "W1-T2244";

// ── THE DEFECT ARM ──────────────────────────────────────────────────────────────────────────────

test("a trailer that resolves to nothing no longer exempts a truncated body", () => {
  const r = acceptanceAuthorTimeCheck(TRUNCATED_BODY, { trailerResolves: realPlan });
  assert.equal(r.ok, false);
  assert.equal(r.defect, "unparseable");
  assert.match(r.message, /3 bullet\(s\) written but only 1 parsed/);
});

test("the refusal names the TRUNCATION, and says nothing about a resolving trailer", () => {
  const r = acceptanceAuthorTimeCheck(TRUNCATED_BODY, { trailerResolves: realPlan });
  assert.match(r.message, /the block ends before bullet 2/);
  assert.doesNotMatch(r.message, /criteria resolve from plan\/tasks\.yaml/, "must not also claim the exemption it just declined");
  assert.doesNotMatch(r.message, /RETRO-1787714349337/, "the trailer is not the defect; the unreadable block is");
});

test("the message is the one the diagnostics already own — not a second spelling of the same fact", () => {
  // Falling through re-uses the existing arm verbatim. If a parallel message were ever written for
  // this path, these two would drift; asserting the shared wording is what pins them together.
  const viaTrailer = acceptanceAuthorTimeCheck(TRUNCATED_BODY, { trailerResolves: resolvesNothing });
  const viaNoTrailer = acceptanceAuthorTimeCheck(TRUNCATED_BODY.replace(/^Remudero-Task:.*$/m, ""));
  assert.equal(viaTrailer.message, viaNoTrailer.message);
  assert.equal(viaTrailer.defect, viaNoTrailer.defect);
});

// ── THE HEALTHY ARM ─────────────────────────────────────────────────────────────────────────────

test("a trailer that DOES resolve still exempts the body, truncated or not", () => {
  const r = acceptanceAuthorTimeCheck(TRUNCATED_BODY, { trailerResolves: resolvesEverything });
  assert.equal(r.ok, true);
  assert.match(r.message, /criteria resolve from plan\/tasks\.yaml/);
  assert.equal(r.defect, undefined, "an exempt body carries no defect");
});

test("the exemption verdict says nothing about truncation — the other arm's wording must not leak in", () => {
  const r = acceptanceAuthorTimeCheck(TRUNCATED_BODY, { trailerResolves: resolvesEverything });
  assert.doesNotMatch(r.message, /bullet\(s\) written/);
  assert.doesNotMatch(r.message, /ends before bullet/);
});

test("a clean body with a resolving trailer is ok, exactly as before", () => {
  const r = acceptanceAuthorTimeCheck(CLEAN_BODY, { trailerResolves: realPlan });
  assert.equal(r.ok, true);
  assert.equal(r.defect, undefined);
});

// ── THE FAIL-OPEN CONTRACT ──────────────────────────────────────────────────────────────────────

test("NO resolver is today's behaviour byte for byte — a caller that cannot read the plan trusts the trailer", () => {
  const r = acceptanceAuthorTimeCheck(TRUNCATED_BODY);
  assert.equal(r.ok, true, "an unreadable plan must never start refusing bodies the gate used to accept");
  assert.match(r.message, /criteria resolve from plan\/tasks\.yaml/);
});

test("the resolver is consulted with the trailer's own id, not a normalised or guessed one", () => {
  const seen: string[] = [];
  acceptanceAuthorTimeCheck(TRUNCATED_BODY, {
    trailerResolves: (id) => {
      seen.push(id);
      return false;
    },
  });
  assert.deepEqual(seen, ["RETRO-1787714349337"]);
});

test("expectedTaskId keeps precedence — the resolver never reaches that arm", () => {
  let consulted = false;
  const r = acceptanceAuthorTimeCheck(CLEAN_BODY, {
    expectedTaskId: "W1-T9999",
    trailerResolves: () => {
      consulted = true;
      return false;
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.defect, "no-trailer", "the caller asked for a SPECIFIC id; that refusal is unchanged");
  assert.equal(consulted, false, "the resolver belongs to the bare-trailer arm only");
});

test("a body with no trailer at all is unaffected by the resolver", () => {
  const noTrailer = CLEAN_BODY.replace(/^Remudero-Task:.*$/m, "").trimEnd();
  const withResolver = acceptanceAuthorTimeCheck(noTrailer, { trailerResolves: resolvesNothing });
  const without = acceptanceAuthorTimeCheck(noTrailer);
  assert.deepEqual(withResolver, without);
  assert.equal(withResolver.ok, true, "a clean body-level block needs no trailer");
});

// ── THE RETROFIT THIS CHANGE WAS SIZED AGAINST ──────────────────────────────────────────────────

test("RETROFIT: a resolving trailer over a defective block stays ok — the 19 merged bodies this must not refuse", () => {
  // Measured 2026-08-26 across 99 recent merged PRs: 19 carry a RESOLVING trailer over a block the
  // diagnostics call defective (mostly a one-line summary with no executable proof). Every one
  // merged and shipped good work. Refusing them was the broad rule this change deliberately did
  // NOT take; the shipped rule fired on 1 open PR and 0 of those 99.
  const summaryStyle = ["## Acceptance", "", "- the change is covered by its own suite | see the tests", "", "Remudero-Task: W1-T2244"].join("\n");
  const r = acceptanceAuthorTimeCheck(summaryStyle, { trailerResolves: realPlan });
  assert.equal(r.ok, true, "a resolving trailer is exactly the case the exemption exists for");
});
