import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyDisarmFailure,
  disarmAutoMerge,
  disarmOutcomeWithdrawn,
  withdrawArmIfVerdictRefuses,
} from "../src/run-task.js";

// ── W1-T1056: THE LEDGER MUST NOT RECORD A WITHDRAWAL THAT DID NOT HAPPEN ────────────────────
//
// `disarmAutoMerge` swallows a failed withdrawal BY DESIGN, and that is not the defect:
// GitHub refuses `--disable-auto` on a PR that was never armed, and learning the arm state up
// front would cost one request per PR per sweep pass (`withdrawArmIfVerdictRefuses`'s own
// "SAFE WHEN NOT ARMED" clause). The defect is that the call site then wrote
// `automerge.disarmed` regardless, so a refusal GitHub made for a REAL reason was recorded, in
// the same step and the same words, as a withdrawal that succeeded. A missing row leaves the
// reader with a question; that one leaves them with a wrong answer.
//
// LIVE: the daemon narrated `automerge.disarm_failed (W1-T125): ... GraphQL: Can't disable
// auto-merge for this pull request. (disablePullRequestAutoMerge)` on PR #2234 on 2026-08-19.
//
// EVERY TEST BELOW RUNS BOTH DIRECTIONS IN ONE INVOCATION (the shard's design clause iii): a
// test that only proves the row is ABSENT after a failure is satisfied by code that never
// writes the row at all.

function ctx() {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return {
    logged,
    value: {
      prUrl: "https://github.com/acme/remudero/pull/2234",
      taskId: "W1-T195",
      headSha: "feb7d1bcafe",
      ledgerPath: "/dev/null",
      log: (step: string, extra?: Record<string, unknown>) => void logged.push({ step, extra }),
    },
  };
}

const NO_OVERRIDE = { ledgerLines: () => [] as Array<Record<string, unknown>> };
const CAPPED = { state: "success" as const, capped: true, planOnly: false };

// ── the pure classifier, both arms in one test ───────────────────────────────────────────────

test("disarm outcome: the benign not-armed refusal is separated from a real failure", () => {
  // The message the catch ALREADY holds — no extra API call is needed to tell these apart.
  assert.equal(
    classifyDisarmFailure(
      "Command failed: gh pr merge <url> --disable-auto\nGraphQL: Can't disable auto-merge for " +
        "this pull request. (disablePullRequestAutoMerge)",
    ),
    "not-armed",
  );
  // CONTROL, and the whole point of pairing them: a DIFFERENT failure must not read as not-armed.
  assert.equal(classifyDisarmFailure("Command failed: gh pr merge <url> --disable-auto\nHTTP 502"), "failed");
});

test("disarm outcome: an unrecognised error fails towards failed, never towards not-armed", () => {
  // THE FAIL-OPEN SHAPE THIS GUARDS: answering the same value for "definitely not armed" and
  // "no idea" would let an unreadable error masquerade as a negative reading, which is exactly
  // the false record this task removes. Anything unrecognised is `failed`.
  for (const opaque of ["", "   ", "socket hang up", "undefined", "GraphQL: Something Else Entirely"]) {
    assert.equal(classifyDisarmFailure(opaque), "failed", `an opaque error must not read as not-armed: ${opaque}`);
  }
  // CONTROL: the one recognised string still classifies, so the loop above is not vacuous.
  assert.equal(classifyDisarmFailure("Can't disable auto-merge"), "not-armed");
});

// ── the I/O wrapper, both directions in one test ─────────────────────────────────────────────

test("disarm outcome: the wrapper reports what happened and still never throws", () => {
  const said: string[] = [];
  const say = (m: string) => void said.push(m);

  // SUCCESS half.
  assert.equal(disarmAutoMerge("https://x/pull/1", { disableAuto: () => undefined, say }), "disarmed");

  // BENIGN-REFUSAL half — same call, a throwing seam.
  const benign = () => {
    throw new Error("GraphQL: Can't disable auto-merge for this pull request. (disablePullRequestAutoMerge)");
  };
  assert.equal(disarmAutoMerge("https://x/pull/2", { disableAuto: benign, say }), "not-armed");

  // REAL-FAILURE half.
  const real = () => {
    throw new Error("HTTP 502 Bad Gateway");
  };
  assert.equal(disarmAutoMerge("https://x/pull/3", { disableAuto: real, say }), "failed");

  // It absorbed both throws rather than propagating them, and narrated every one.
  assert.equal(said.length, 3, `every outcome is narrated: ${JSON.stringify(said)}`);
});

test("disarm outcome: a pre-signature fake still counts as a withdrawal", () => {
  // The same allowance `armOutcomeArmed` already makes, so no existing lane regresses.
  assert.equal(disarmOutcomeWithdrawn(undefined), true);
  // CONTROL, both real arms, so the line above is not the only thing this asserts.
  assert.equal(disarmOutcomeWithdrawn("disarmed"), true);
  assert.equal(disarmOutcomeWithdrawn("not-armed"), false);
  assert.equal(disarmOutcomeWithdrawn("failed"), false);
});

// ── the load-bearing call site, both directions in one test ──────────────────────────────────

test("disarm outcome: the row follows the outcome, so a refused withdrawal is not recorded as one", () => {
  // SUCCESS half — the row must still be written, or "absent after a failure" proves nothing.
  const ok = ctx();
  assert.equal(
    withdrawArmIfVerdictRefuses(CAPPED, ok.value, { ...NO_OVERRIDE, disarm: () => "disarmed" as const }),
    true,
  );
  assert.ok(
    ok.logged.find((l) => l.step === "automerge.disarmed"),
    "a withdrawal that HAPPENED is still recorded as automerge.disarmed",
  );

  // FAILURE half — same verdict, same context shape, only the outcome differs.
  const bad = ctx();
  assert.equal(
    withdrawArmIfVerdictRefuses(CAPPED, bad.value, { ...NO_OVERRIDE, disarm: () => "failed" as const }),
    true,
  );
  assert.equal(
    bad.logged.find((l) => l.step === "automerge.disarmed"),
    undefined,
    "a withdrawal GitHub REFUSED must never be recorded as automerge.disarmed — the arm is still standing",
  );
  const skipped = bad.logged.find((l) => l.step === "automerge.disarm_skipped");
  assert.ok(skipped, "and what DID happen is still recorded, never silently dropped");
  assert.equal(skipped?.extra?.outcome, "failed", "the outcome field carries the truth the step name cannot");
  assert.match(String(skipped?.extra?.reason), /refuses auto-merge/, "the reason survives the correction");
});

test("disarm outcome: a benignly-unarmed PR is recorded as skipped rather than disarmed", () => {
  const c = ctx();
  assert.equal(
    withdrawArmIfVerdictRefuses(CAPPED, c.value, { ...NO_OVERRIDE, disarm: () => "not-armed" as const }),
    true,
  );
  assert.equal(c.logged.find((l) => l.step === "automerge.disarmed"), undefined);
  const skipped = c.logged.find((l) => l.step === "automerge.disarm_skipped");
  assert.equal(skipped?.extra?.outcome, "not-armed");
  // CONTROL: the SAME call with a real withdrawal still lands on the other step, so this test
  // cannot pass against code that simply stopped writing rows.
  const ok = ctx();
  withdrawArmIfVerdictRefuses(CAPPED, ok.value, { ...NO_OVERRIDE, disarm: () => "disarmed" as const });
  assert.ok(ok.logged.find((l) => l.step === "automerge.disarmed"));
});

test("disarm outcome: no new step is invented per outcome — both non-withdrawals share one", () => {
  // The shard's design clause (iv): the outcome FIELD already carries the distinction, and a
  // step per outcome makes a corpus that is already mostly-unread worse.
  const steps = new Set<string>();
  for (const outcome of ["not-armed", "failed"] as const) {
    const c = ctx();
    withdrawArmIfVerdictRefuses(CAPPED, c.value, { ...NO_OVERRIDE, disarm: () => outcome });
    for (const l of c.logged) steps.add(l.step);
  }
  assert.deepEqual([...steps], ["automerge.disarm_skipped"], "one step for both non-withdrawals");
});
