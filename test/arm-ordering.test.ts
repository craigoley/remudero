import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import { armAutoMerge, armIfVerdictPermits, armOutcomeReason, type ArmDeps, type ArmOutcome } from "../src/run-task.js";

// ── THE DEFECT ───────────────────────────────────────────────────────────────────────
// `armIfVerdictPermits` ran 35 lines ABOVE the `log("review.posted", …)` call in the same
// function. W1-T230's gate — armAutoMerge → priorReviewVerdictFromLedger →
// decideArmFromLedgerVerdict — requires exactly that line, matched on taskId AND headSha, and
// fails CLOSED when it finds none. It was not there yet, so the gate refused EVERY time this
// path ran. The ledger shows each refused arm preceding its own review.posted by 0-1ms
// (PR-977: 00:57:06.808 vs .809; same millisecond for PR-981/982/984, W1-T226, W1-T221).
//
// The comment justifying the ordering claimed `postReviewStatusGuarded` "just wrote" that line.
// It writes only `review.post_refused` and `review.post_failed`.
//
// These tests drive the REAL gate against a REAL ledger file written by the REAL appendLedger,
// so what is under test is the ORDER of the write and the read — not a mock of it.

const SRC = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
const HEAD = "5596ab04802a916c740858e75bc950774d38c504";
const PR = "https://github.com/craigoley/remudero/pull/977";

type Verdict = Parameters<typeof armIfVerdictPermits>[0];
const PASS: Verdict = { state: "success", capped: false, planOnly: false };
const CAPPED_PROOF_FAILURE: Verdict = { state: "success", capped: true, planOnly: false };
const CAPPED_PLAN_ONLY: Verdict = { state: "success", capped: true, planOnly: true };

/** A real ledger file on disk plus the real armAutoMerge wired to read it. */
function harness(over: { taskId?: string; headRefName?: string; liveHead?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rmd-bl-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const taskId = over.taskId ?? "W1-T977";
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const said: string[] = [];
  let armCalls = 0;

  // The ledger `log` runReview itself uses — the REAL appendLedger, same as production.
  const log = (step: string, extra: Record<string, unknown> = {}) => {
    logged.push({ step, extra });
    appendLedger(ledgerPath, { run_id: "review-PR977-1", task_id: taskId, step, ...extra });
  };
  const writeReviewPosted = () => log("review.posted", { context: "remudero-review", state: "success", head_sha: HEAD });

  const armDeps: ArmDeps = {
    headSha: () => over.liveHead ?? HEAD, // armAutoMerge re-reads the LIVE head; head drift still refuses
    ledgerLines: () => readLedgerLines(ledgerPath),
    armAuto: () => void armCalls++,
    mergeDirect: () => assert.fail("no direct merge in these fixtures"),
    disableAuto: () => assert.fail("nothing is disarmed here"),
    say: (m) => void said.push(m),
  };

  return {
    dir, ledgerPath, taskId, logged, said,
    armCount: () => armCalls,
    writeReviewPosted,
    run: (verdict: Verdict) =>
      armIfVerdictPermits(
        verdict,
        { prUrl: PR, taskId, headSha: HEAD, ledgerPath, headRefName: over.headRefName, log },
        { arm: (prUrl, tid) => armAutoMerge(prUrl, tid, armDeps) },
      ),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ── 3: the fix, proven as a flip on one identical fixture ───────────────────────────
test("a PASSING verdict arms once the review.posted line exists, and is ledger-refused before it", () => {
  const before = harness();
  const after = harness();

  // BEFORE — the shipped ordering: arm first, ledger line written afterwards.
  const outcomeBefore = before.run(PASS);
  before.writeReviewPosted();
  // AFTER — the fixed ordering: the ledger line is written first, then the arm reads it.
  after.writeReviewPosted();
  const outcomeAfter = after.run(PASS);

  assert.equal(outcomeBefore, "ledger-refused", "the old order: the gate finds no verdict for this head and fails closed");
  assert.equal(before.armCount(), 0, "and no arm was ever issued to GitHub — this is every arm on this path, ever");
  assert.match(before.said[0], /no ledgered review\.posted verdict found/, "the real reason reached stdout only");

  assert.equal(outcomeAfter, "armed", "the new order: the evidence exists at the moment of the check");
  assert.equal(after.armCount(), 1, "exactly one arm issued — asserting the CALL, not that the code ran");
  before.cleanup();
  after.cleanup();
});

// ── 4: THE SAFETY LOCK ──────────────────────────────────────────────────────────────
test("SAFETY LOCK: a proof-failure CAPPED verdict still does NOT arm, even with the evidence present", () => {
  const h = harness();
  h.writeReviewPosted(); // the gate would now PASS — so only decideAutoMergeArm can refuse

  const outcome = h.run(CAPPED_PROOF_FAILURE);

  assert.equal(outcome, "skipped", "refused by the semantic gate before any arm was attempted");
  assert.equal(h.armCount(), 0, "NO arm reached GitHub — fixing the ordering must not widen WHAT may arm");
  assert.equal(h.logged.filter((l) => l.step === "automerge.armed").length, 0, "and nothing is ledgered as armed");
  h.cleanup();
});

// ── 5: the W1-T205 carve-out survives ───────────────────────────────────────────────
test("CARVE-OUT: a plan-only capped verdict DOES arm, with no operator override", () => {
  const h = harness();
  h.writeReviewPosted();

  const outcome = h.run(CAPPED_PLAN_ONLY);

  assert.equal(outcome, "armed", "a plan-only cap is structural, not a proof failure (W1-T205)");
  assert.equal(h.armCount(), 1);
  h.cleanup();
});

// ── 6: dependabot stays excluded ────────────────────────────────────────────────────
test("a dependabot PR is still excluded from the post-verdict arm", () => {
  const h = harness({ headRefName: "dependabot/npm_and_yarn/typescript-5.9.3" });
  h.writeReviewPosted();

  const outcome = h.run(PASS);

  assert.equal(outcome, "skipped", "excluded before the decision is consulted — the dep-review lane owns these");
  assert.equal(h.armCount(), 0);
  const line = h.logged.find((l) => l.step === "automerge.arm_skipped");
  assert.match(String(line?.extra?.reason), /dep-review lane/);
  h.cleanup();
});

// ── head drift: the gate is NOT tautological now that its evidence exists ───────────
test("head drift still refuses: a verdict written for one head does not arm a different live head", () => {
  const h = harness({ liveHead: "0000000deadbeef0000000deadbeef0000000dead" });
  h.writeReviewPosted(); // written against HEAD, but the PR's live head has moved

  const outcome = h.run(PASS);

  assert.equal(outcome, "ledger-refused", "moving the arm below the write did not make the gate a no-op");
  assert.equal(h.armCount(), 0, "a push landing after the verdict must not arm the new head");
  h.cleanup();
});

// ── 7: the ledger line no longer contradicts itself ─────────────────────────────────
test("a refusal's ledgered reason describes the refusal, never the semantic gate's approval", () => {
  const h = harness();
  // No review.posted written -> the ledger gate refuses while the semantic gate approves.
  const outcome = h.run(PASS);

  const line = h.logged.find((l) => l.step === "automerge.arm_skipped");
  assert.equal(outcome, "ledger-refused");
  assert.ok(line, "the refusal is ledgered");
  assert.notEqual(line?.extra?.reason, "verdict is a full PASS", "THE BUG: outcome and reason answered different questions");
  assert.match(String(line?.extra?.reason), /W1-T230 ledger gate refused/, "reason now describes the OUTCOME");
  assert.equal(line?.extra?.decision_reason, "verdict is a full PASS", "the semantic verdict is kept under its own name, not lost");
  h.cleanup();
});

test("armOutcomeReason maps every outcome to a reason about that outcome", () => {
  const all: Array<ArmOutcome | "skipped"> = [
    "armed", "direct-merged", "ledger-refused", "no-task-id",
    "head-unavailable", "direct-merge-failed", "arm-error-ignored", "skipped",
  ];

  const reasons = all.map((o) => armOutcomeReason(o, "verdict is a full PASS"));

  assert.equal(reasons[0], "verdict is a full PASS", "an ARM legitimately carries the semantic reason — that is why it armed");
  for (const [i, o] of all.entries()) {
    if (o === "armed" || o === "direct-merged") continue;
    assert.notEqual(reasons[i], "verdict is a full PASS", `${o}: a non-arming outcome must not read as an approval`);
    assert.ok(reasons[i].length > 20, `${o}: says something specific`);
  }
});

// ── 8: TRAP 2 — the withdrawal still beats the post; the arm still follows it ───────
// W1-T2232 MOVED THIS FROM SOURCE TEXT TO BEHAVIOUR: this used to slice `runReview`'s body out
// of `run-task.ts` and order four call-site literals (`withdrawArmIfVerdictRefuses(`, `await
// postReviewStatusGuarded({`, `log("review.posted", {`, `armIfVerdictPermits(`) by `indexOf` —
// a lock on where each call's TEXT sits, not on what it DOES. `runReview`'s own args already
// expose an injectable observer for both effects this test protected (`disarm`, `arm`, plus the
// real ledger file `ledgerPath` points at), so TRAP 2 (withdrawal beats the post) and THE FIX
// (the arm follows the `review.posted` ledger write) are now proven by driving `runReview`
// end-to-end and observing the injected `disarm`/`arm` calls and the real `gh` argv/ledger file
// — see test/wiring-ordering-behaviour.test.ts.

test("the comment above the arm no longer claims postReviewStatusGuarded writes review.posted", () => {
  const guarded = readFileSync(new URL("../src/lib/review.ts", import.meta.url), "utf8");
  const i = guarded.indexOf("export async function postReviewStatusGuarded");
  const body = guarded.slice(i, guarded.indexOf("\n}\n", i));

  assert.ok(i > 0, "the function exists");
  assert.equal(body.includes('"review.posted"'), false, "it genuinely never writes review.posted — only the two refusal steps");
  assert.ok(body.includes('"review.post_refused"') && body.includes('"review.post_failed"'), "those are its only ledger writes");
  assert.equal(
    SRC.includes("`review.posted` line `postReviewStatusGuarded` just wrote"),
    false,
    "the false comment that justified the broken ordering is gone",
  );
});
