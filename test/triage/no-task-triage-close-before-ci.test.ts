import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffEmptyAgainstScope } from "#src/lib/review.js";
import { triageDeclaredScope, triageEmptyScopeDisposition } from "#src/lib/triage.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { withGhShim } from "#test/helpers/gh-shim.js";


// ── W1-T963: THE EMPTY-DIFF-TRIAGE-MERGE INCIDENT ────────────────────────────────────────────────
//
// Three triage PRs for the SAME feedback entry (#2075/#2077/#2078) merged and PASSED REVIEW
// despite changing nothing: `bodyContradictsDiff` (lib/review.js) is vacuously satisfied when
// there is no diff to contradict, and nothing else downstream ever asks "is this PR's diff empty
// against its own declared scope". `diffEmptyAgainstScope` + `triageEmptyScopeDisposition` are the
// fix — a purely structural check with no report/prose involved, wired ahead of the ordinary
// review/arm gate in run-task.ts's triageCommandLocked. For no_task/grill empty scopes, the
// live decision now runs after provenance checks and before CI, with an exact head/base re-read
// immediately before close. The post-CI check remains to catch sibling landings during the wait;
// both use a fresh git diff --name-only origin/main HEAD -- <scope>, never the PR's frozen gh pr diff.
//
// "A refusal test alone proves nothing… An implementation that refuses EVERY PR satisfies 'an
// empty-diff PR is refused' perfectly." (design note (vi)) — so EVERY test below carries its own
// positive AND negative control in the SAME test body, never relying on a sibling test to supply
// the other direction.
// ────────────────────────────────────────────────────────────────────────────────────────────────

const SCOPE = ["plan/feedback/fb-1787140000000-abcdef.yaml"];

test("W1-T963: an empty-diff PR is refused", () => {
  // The empty case: the LIVE diff (against origin/main, fetched fresh) touches NONE of this PR's
  // declared scope — a sibling already landed the same change. Must be refused.
  assert.equal(diffEmptyAgainstScope([], SCOPE), true, "an empty diff list must be refused");
  assert.equal(diffEmptyAgainstScope(["plan/feedback/some-other-entry.yaml"], SCOPE), true, "a diff touching only UNRELATED paths must be refused");

  // The control, in the SAME test: a diff that DOES touch the declared scope must NOT be refused
  // — otherwise this "refuses empty diffs" claim is satisfied by an implementation that refuses
  // everything, which is exactly the trap design note (vi) warns about.
  assert.equal(diffEmptyAgainstScope(SCOPE, SCOPE), false, "a diff touching the declared scope must NOT be refused");
});

test("W1-T963: a non-empty diff still passes in the same run", () => {
  // The positive control: a real diff against the declared scope passes.
  assert.equal(diffEmptyAgainstScope(SCOPE, SCOPE), false);
  assert.equal(
    diffEmptyAgainstScope([...SCOPE, "plan/feedback/an-unrelated-entry.yaml"], SCOPE),
    false,
    "extra, unrelated touched files must not spoil a real touch of the declared scope",
  );

  // Its own refusal, in the SAME run: an implementation that always answers "not empty" would
  // pass this test vacuously without ever refusing anything — assert the refusal case too.
  assert.equal(diffEmptyAgainstScope([], SCOPE), true, "an empty diff must still be refused in this same run");

  // No declared scope at all ⇒ nothing to check ⇒ never a false refusal (an ordinary PR with no
  // declared scope must never be caught by this mechanism).
  assert.equal(diffEmptyAgainstScope([], []), false, "an undeclared scope must never manufacture a refusal");
});

test("W1-T963: an already-done triage PR is closed not merged", () => {
  const feedbackId = "fb-1787140000000-abcdef";
  const scope = triageDeclaredScope(feedbackId);
  assert.deepEqual(scope, [`plan/feedback/${feedbackId}.yaml`], "sanity: the declared scope is the feedback entry itself");

  // ALREADY DONE — the live diff against origin/main touches none of the declared scope (a
  // sibling triage PR already landed this exact change): the disposition must be CLOSE, never
  // "proceed to the ordinary review/arm gate" — merging an empty PR credits work twice and
  // pollutes history (rationale (4)); leaving it open forever is not a terminal outcome either
  // (design (v)).
  const alreadyDone = triageEmptyScopeDisposition([], scope);
  assert.equal(alreadyDone.action, "close", "already-done work must be CLOSED, not left open or merged");
  assert.ok(alreadyDone.comment && alreadyDone.comment.length > 0, "a close disposition must carry a comment explaining why");
  assert.ok(alreadyDone.comment!.includes(scope[0]!), "the close comment must name the declared scope path");

  // GENUINELY NEW WORK, in the SAME run: the live diff DOES touch the declared scope (this PR
  // itself is the one that flipped it — no sibling raced ahead) — must PROCEED to the ordinary
  // merge gate, never be closed. Without this control, "closes already-done work" would be
  // satisfied by a disposition that closes every triage PR unconditionally.
  const genuinelyNew = triageEmptyScopeDisposition(scope, scope);
  assert.equal(genuinelyNew.action, "proceed", "genuinely new work must PROCEED to the ordinary review/arm gate");
  assert.equal(genuinelyNew.comment, undefined, "a proceed disposition carries no close comment");
});

test("W1-T11781: ghShim reads updated response-file contents at invocation time", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-response-`));
  const response = join(dir, "response.json");
  try {
    writeFileSync(response, '{"head":{"sha":"first"}}');
    await withGhShim([{ when: "api repos/example/pulls/1", stdoutFile: response }], async () => {
      const readResponse = () =>
        execFileSync("gh", ["api", "repos/example/pulls/1"], { encoding: "utf8" });
      assert.equal(readResponse(), '{"head":{"sha":"first"}}');
      writeFileSync(response, '{"head":{"sha":"second"}}');
      assert.equal(readResponse(), '{"head":{"sha":"second"}}');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
