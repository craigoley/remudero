import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyGhFailure, type GitHub, type PrRef } from "../src/lib/status.js";
import { resolveAlreadySatisfied, type AlreadySatisfiedClaim } from "../src/run-task.js";

/**
 * W1-T119's law, applied to rung (c). `resolveAlreadySatisfied` collapsed THREE states into one
 * `undefined`: genuinely absent, the read FAILED, and a DIFFERENT PR is credited. So an unreadable
 * gateway was recorded as a FALSE CLAIM.
 *
 * MEASURED: six `already_satisfied.refused` rows exist in the ledger union; replayed later, THREE
 * OF FOUR resolved correctly (W1-T377→#1386, W1-T378→#1391, W1-T412→#1508). The workers were right;
 * the read could not answer. Two of those tasks had already shipped and were re-dispatched anyway:
 * 10 dispatches / $23.34.
 *
 * THE FIXTURES BELOW FAIL FOR REAL. A gateway that simply returns `undefined` is exactly the
 * ambiguity under test, so it could not prove anything: these build the failure the way the
 * production gateway does — `classifyGhFailure` over a real `gh` error shape — and publish it
 * through the SAME `readFailed()`/`readFailureReason()` accessors `buildBatchedGithub` exposes.
 */

const TASK_ID = "T-UNVERIFIABLE";
const CREDITED: PrRef = { number: 42, url: "https://github.com/acme/remudero/pull/42", state: "MERGED" };
const claimOf = (ref: string): AlreadySatisfiedClaim => ({ raw: "", ref });

/**
 * A gateway whose trailer read genuinely FAILED, classified exactly as the real one does.
 * `err` is the shape `execFileSync` throws — the same input `ghGateway`'s own `tryJson` hands
 * to `classifyGhFailure`, never a hand-written reason string.
 */
function failingGithub(err: { status?: number | null; stderr?: string; code?: string }): GitHub {
  let failed = false;
  let reason: ReturnType<typeof classifyGhFailure> | undefined;
  const readThatFails = <T>(): T | null => {
    failed = true;
    reason = classifyGhFailure(err.status, err.stderr, err.code);
    return null;
  };
  return {
    prByRef: () => null,
    findMergedByTrailer: () => readThatFails<PrRef>(),
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => failed,
    readFailureReason: () => reason,
  };
}

/** A gateway that answered fine and genuinely holds nothing (or a rival PR). */
function answeringGithub(credited: PrRef | null): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => credited,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    readFailureReason: () => undefined,
  };
}

// ── Direction 1 of 3: the read FAILED — neither credit nor refusal ───────────

test("UNVERIFIABLE: a transport failure is not a false claim — the outcome is neither credit nor refusal", () => {
  const github = failingGithub({ status: 1, stderr: "dial tcp: connect: network is unreachable" });
  const r = resolveAlreadySatisfied(claimOf("#42"), github, TASK_ID);

  assert.equal(r.outcome, "unverifiable", "a gateway that could not answer has not refuted anything");
  assert.notEqual(r.outcome, "refuted", "this is the conflation that cost $23.34");
  assert.notEqual(r.outcome, "verified", "and it must never credit a claim it could not check");
  assert.equal(r.outcome === "unverifiable" && r.reason, "transport", "the reason is classified, not guessed");
});

test("UNVERIFIABLE: the reason is threaded from classifyGhFailure, never recomputed — each class survives", () => {
  const cases = [
    [{ status: 1, stderr: "API rate limit exceeded" }, "rate_limit"],
    [{ status: 1, stderr: "gh auth login required: bad credentials" }, "auth"],
    [{ status: null, stderr: "", code: "ENOBUFS" }, "buffer_overflow"],
    [{ status: 1, stderr: "something nobody has a pattern for" }, "unknown"],
  ] as const;
  for (const [err, expected] of cases) {
    const r = resolveAlreadySatisfied(claimOf("#42"), failingGithub({ ...err }), TASK_ID);
    assert.equal(r.outcome, "unverifiable");
    assert.equal(r.outcome === "unverifiable" && r.reason, expected, `${expected} must survive to the caller`);
    // The discriminator is the gateway's own, not a second opinion computed here.
    assert.equal(classifyGhFailure(err.status, err.stderr, (err as { code?: string }).code), expected);
  }
});

// ── Direction 2 of 3: genuinely absent — still refuses ──────────────────────

test("REFUTED (not_found): a gateway that answered and holds nothing still refuses — the check keeps working", () => {
  const r = resolveAlreadySatisfied(claimOf("#42"), answeringGithub(null), TASK_ID);
  assert.deepEqual(r, { outcome: "refuted", reason: "not_found" });
});

// ── Direction 3 of 3: a DIFFERENT PR — the check that must not be relaxed ────

test("REFUTED (different_pr): a claim citing another PR is refused, and the row names the rival", () => {
  const r = resolveAlreadySatisfied(claimOf("#999"), answeringGithub(CREDITED), TASK_ID);
  assert.deepEqual(r, { outcome: "refuted", reason: "different_pr", creditedNumber: 42 });
});

test("SECOND TRAP: a genuinely FALSE claim still refuses — crediting on an unreadable read would be worse than the defect", () => {
  // More than one merged PR really can carry a task's trailer: measured over all 1,169 merged PR
  // bodies, 16 of 495 ids are carried by several — W1-T254 by SIX, where #720 is the implementation
  // and the newest is a `chore(plan): close ... as already-satisfied` PR. The numbers below are
  // that shape (implementation vs newer bookkeeping close), not a specific replayed pair. Number
  // equality is the only thing catching it, and it is deliberately not relaxed; preferring the
  // implementing PR among several is W1-T441.
  const rival = resolveAlreadySatisfied(claimOf("#720"), answeringGithub({ ...CREDITED, number: 1016 }), TASK_ID);
  assert.equal(rival.outcome, "refuted");
  assert.notEqual(rival.outcome, "unverifiable", "a gateway that ANSWERED must never read as unverifiable");
  assert.notEqual(rival.outcome, "verified");
});

// ── THE TRAP: three states, three distinguishable outcomes ──────────────────

test("the three states produce THREE distinguishable outcomes — a change treating everything as absent fails", () => {
  const failed = resolveAlreadySatisfied(claimOf("#42"), failingGithub({ status: 1, stderr: "etimedout" }), TASK_ID);
  const absent = resolveAlreadySatisfied(claimOf("#42"), answeringGithub(null), TASK_ID);
  const rival = resolveAlreadySatisfied(claimOf("#999"), answeringGithub(CREDITED), TASK_ID);
  const ok = resolveAlreadySatisfied(claimOf("#42"), answeringGithub(CREDITED), TASK_ID);

  const labels = [failed, absent, rival, ok].map((r) =>
    r.outcome === "verified" ? "verified" : `${r.outcome}:${r.reason}`,
  );
  assert.deepEqual(labels, ["unverifiable:transport", "refuted:not_found", "refuted:different_pr", "verified"]);
  assert.equal(new Set(labels).size, 4, "all four must be distinct, or the row cannot tell them apart");
});

// ── THIRD TRAP: the healthy path is byte-identical ──────────────────────────

test("THIRD TRAP: a verified claim still returns the same credit it always did", () => {
  const r = resolveAlreadySatisfied(claimOf("#42"), answeringGithub(CREDITED), TASK_ID);
  assert.deepEqual(r, { outcome: "verified", number: 42, url: "https://github.com/acme/remudero/pull/42" });
});

test("a gateway that predates readFailed()/readFailureReason() degrades to the pre-change answer", () => {
  // Every fixture written before this change omits both accessors. Optional-method discipline:
  // omitted ⇒ treated as "the read succeeded", i.e. exactly the old refusal.
  const legacy: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
  assert.deepEqual(resolveAlreadySatisfied(claimOf("#42"), legacy, TASK_ID), {
    outcome: "refuted",
    reason: "not_found",
  });
});
