/**
 * The `plan-only`/`data-only` house shorthands need a SUBJECT before they can contradict a diff.
 *
 * MEASURED, ON A REAL PR RATHER THAN IMAGINED. `bodyContradictsDiff` tested `/\bplan-only\b/i`
 * against the whole body, with no subject — so the word fired wherever it appeared, INCLUDING
 * INSIDE A PATH. W1-T413's own acceptance criteria name `test/trailer-credit-plan-only.test.ts`,
 * and `\b` matches around `plan-only` between the `-` and the `.`; merely quoting the required
 * proof made a src-touching PR "claim" it was plan scope only, and `changesetContradictions`
 * forces `state: "failure"`. Writing ABOUT the concept did the same. That is the
 * guess-at-natural-language `bodyContradictsDiff`'s own doc forbids: "ANYTHING THIS CANNOT DECIDE
 * IS SILENCE, NOT A VERDICT".
 *
 * BOTH DIRECTIONS ARE ASSERTED. An anchor that only silenced things would silence the check
 * itself — the shorthand exists to catch a body that misdescribes its own changeset, and #1025's
 * shape (`data-only: no code` over a src-reverting diff) must still fire.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyContradictsDiff } from "../src/lib/review.js";
import { writeMutantModule } from "./helpers/mutant-module.js";

/** A diff that is NOT plan scope only and NOT data only — so any true claim contradicts it. */
const SRC_DIFF = ["src/lib/status.ts", "test/trailer-credit-plan-only.test.ts"];

function fires(body: string): boolean {
  return bodyContradictsDiff(body, SRC_DIFF).length > 0;
}

// ── SILENCE WHERE THERE IS NO CLAIM ──────────────────────────────────────────────────────────

test("a path containing plan-only is not a claim about the changeset", () => {
  // The exact line every W1-T413 body must carry.
  assert.equal(fires("proof: unit test: test/trailer-credit-plan-only.test.ts"), false);
  assert.equal(fires("See `test/trailer-credit-plan-only.test.ts` for the fixtures."), false);
});

test("discussing the concept is not a claim about the changeset", () => {
  assert.equal(fires("The refusal fires when a merged PR is plan-only in the sense the predicate means."), false);
  assert.equal(fires("see fixtures/data-only-corpus.json"), false);
});

// ── AND THE CHECK STILL CATCHES A BODY THAT MISDESCRIBES ITS DIFF ────────────────────────────

test("the predicate form still fires, so the anchor did not silence the check", () => {
  assert.equal(fires("This PR is plan-only."), true);
  assert.equal(fires("The diff is data-only."), true);
  // THE BARE COPULAR SUBJECT, with no changeset word anywhere for the backward anchor to find —
  // "This is …" is the shape gate-properties.test.ts asserts, and the only one that reaches the
  // linking-verb arm rather than being caught earlier by `claimsChangesetContext`.
  assert.equal(fires("This is plan-only."), true);
  assert.equal(fires("It was data-only."), true);
});

test("a linking verb after a GENERIC subject is explanation, not a claim about this diff", () => {
  // The distinction the arm turns on: predicating the shorthand of `this`/`the diff` claims it;
  // explaining what the predicate MEANS does not. Without this the anchor would re-create the
  // false positive it exists to remove, one grammatical step further along.
  assert.equal(fires("A merged PR is plan-only when its whole file list sits under the plan directory."), false);

  // THE RESIDUAL LIMIT, ASSERTED RATHER THAN LEFT FOR SOMEONE TO DISCOVER. The forward arm reads
  // the rest of the sentence, so a GENERIC explanation that also happens to use a changeset word
  // still fires. That is narrower than the old anywhere-match but it is not zero, and the honest
  // repair is to write such a sentence without the word — not to widen the anchor further, which
  // is the guess-at-natural-language `bodyContradictsDiff`'s own contract forbids.
  assert.equal(fires("A merged PR is plan-only when its whole changeset sits under plan/."), true);
});

test("the LABEL form still fires — the shape the house style actually writes", () => {
  // A colon makes the shorthand the subject of the line even when the elaboration carries no
  // changeset verb at all, which is why the label is recognised separately from the prose forms.
  assert.equal(fires("**Plan-only**: one shard added."), true);
  assert.equal(fires("data-only: no code. Reverts stale exports."), true);
});

test("a true claim is still silent — the contradiction is about the DIFF, not the wording", () => {
  // Same body, a genuinely plan-scope-only changeset: nothing to contradict.
  assert.equal(bodyContradictsDiff("This PR is plan-only.", ["plan/tasks.d/W1-T413-x.yaml"]).length, 0);
});

// ── FALSIFIER ────────────────────────────────────────────────────────────────────────────────

test("MUTANT: dropping the anchor makes the required proof path contradict the diff again", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  const target = "    if (!shorthandIsAboutChangeset(scan, m.index ?? 0, m[0].length)) continue;\n    const violators = diffFiles.filter((f) => !isInPlanScope(f));";
  assert.equal(src.split(target).length - 1, 1, "the substitution target must be UNIQUE or the mutant proves nothing");

  // The copy goes under `test/`, NOT `os.tmpdir()` — a mutant outside the project root re-enters
  // the real src/lib graph and destroys the coverage record of modules this suite never mentions.
  // The whole measurement is in test/helpers/mutant-module.ts; do not inline this back to tmpdir.
  const mutantPath = writeMutantModule(
    "review.ts",
    src.replace(target, "    const violators = diffFiles.filter((f) => !isInPlanScope(f));"),
  );
  const mutant = (await import(mutantPath)) as typeof import("../src/lib/review.js");

  const proofLine = "proof: unit test: test/trailer-credit-plan-only.test.ts";
  assert.equal(
    mutant.bodyContradictsDiff(proofLine, SRC_DIFF).length > 0,
    true,
    "the mutant must reach the bad state — the unanchored word firing on a path",
  );
  assert.equal(fires(proofLine), false, "and the real module must not");
});
