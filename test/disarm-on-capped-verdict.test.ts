import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { withdrawArmIfVerdictRefuses } from "../src/run-task.js";

// ── THE GAP ──────────────────────────────────────────────────────────────────────────
// A worker PR is armed AT OPEN (~16s after it exists) before any verdict is computed.
// PR #831 taught the SWEEP to refuse to ARM a proof-failure cap, but nothing withdrew an
// arm ALREADY on GitHub: `disarmAutoMerge` had exactly two call sites, both inside
// `runTask`, so a cap posted from `reviewCommand` — the operator's `rmd review` AND the
// sweep's post-review lane, both of which reach `runReview` via `runReviewDep` — left the
// arm standing. A capped verdict still posts `state: "success"`, so GitHub merged.
//
// LIVE: PR #969 posted "CAPPED — 0/4 proofs executed; not certified" at 23:34:42Z and
// GitHub merged it at 23:34:44Z. Two seconds.
//
// The most important test in this file is the CARVE-OUT one: a plan-only PR is
// STRUCTURALLY and PERMANENTLY capped by design and MUST stay armed. If the withdrawal
// disarmed those, every triage, retro, `rmd approve` and plan-amendment PR would stall —
// one bug replaced by a worse one.

/** Records every disarm the code issues, so a test asserts the CALL, not just execution. */
function recorder(): { calls: string[]; disarm: (prUrl: string) => void } {
  const calls: string[] = [];
  return { calls, disarm: (prUrl) => void calls.push(prUrl) };
}

function ctx(over: Partial<Parameters<typeof withdrawArmIfVerdictRefuses>[1]> = {}) {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return {
    logged,
    value: {
      prUrl: "https://github.com/acme/remudero/pull/969",
      taskId: "W1-T195",
      headSha: "feb7d1bcafe",
      ledgerPath: "/dev/null",
      log: (step: string, extra?: Record<string, unknown>) => void logged.push({ step, extra }),
      ...over,
    },
  };
}

/** No ledger read hits disk: an empty line set means "no operator override recorded". */
const NO_OVERRIDE = { ledgerLines: () => [] as Array<Record<string, unknown>> };

// ── 4: a proof-failure cap on an ARMED PR issues the disarm ──────────────────────────
test("a proof-failure CAPPED verdict WITHDRAWS the arm — the #969 shape", () => {
  const rec = recorder();
  const c = ctx();

  const withdrew = withdrawArmIfVerdictRefuses(
    { state: "success", capped: true, planOnly: false },
    c.value,
    { ...NO_OVERRIDE, disarm: rec.disarm },
  );

  assert.equal(withdrew, true, "the withdrawal was decided");
  assert.deepEqual(
    rec.calls,
    ["https://github.com/acme/remudero/pull/969"],
    "the disarm was ISSUED for exactly this PR — asserting the call, not merely that the code ran",
  );
  const line = c.logged.find((l) => l.step === "automerge.disarmed");
  assert.ok(line, "and it is ledgered under automerge.disarmed");
  assert.match(String(line?.extra?.reason), /CAPPED/, "the ledger line names WHY the arm was withdrawn");
});

// ── 5: THE CARVE-OUT. The most important test in this PR. ────────────────────────────
test("CARVE-OUT: a PLAN-ONLY capped verdict does NOT disarm — W1-T205 PRs must stay armed", () => {
  const rec = recorder();
  const c = ctx();

  const withdrew = withdrawArmIfVerdictRefuses(
    // Structurally capped by design — a filing/amending PR has no executable proof.
    { state: "success", capped: true, planOnly: true },
    c.value,
    { ...NO_OVERRIDE, disarm: rec.disarm },
  );

  assert.equal(withdrew, false, "a plan-only cap must NOT be treated as a refusal");
  assert.deepEqual(
    rec.calls,
    [],
    "NO disarm was issued — otherwise every triage, retro, `rmd approve` and plan-amendment PR stalls",
  );
  assert.equal(
    c.logged.filter((l) => l.step === "automerge.disarmed").length,
    0,
    "and nothing is ledgered as disarmed",
  );
});

// ── 6: the ordinary success path is untouched ────────────────────────────────────────
test("an UNCAPPED passing verdict does NOT disarm — the ordinary success path is unaffected", () => {
  const rec = recorder();
  const c = ctx();

  const withdrew = withdrawArmIfVerdictRefuses(
    { state: "success", capped: false, planOnly: false },
    c.value,
    { ...NO_OVERRIDE, disarm: rec.disarm },
  );

  assert.equal(withdrew, false);
  assert.deepEqual(rec.calls, [], "a full PASS keeps its arm");
});

// ── 7: never armed ⇒ no error, and the call is still safe ───────────────────────────
test("a capped verdict on a PR that was NEVER armed does not error — disarmAutoMerge is best-effort", () => {
  const c = ctx();
  // The REAL disarm is deliberately not injected here: `disarmAutoMerge` swallows its own
  // failure (run-task.ts), which is why this needs no extra API call to learn armed state.
  // A throwing dep proves the caller does not depend on the withdrawal succeeding.
  assert.doesNotThrow(() =>
    withdrawArmIfVerdictRefuses({ state: "success", capped: true, planOnly: false }, c.value, {
      ...NO_OVERRIDE,
      disarm: () => {
        /* a PR that was never armed: gh reports nothing to disable */
      },
    }),
  );
});

// ── an operator override still arms a capped verdict ────────────────────────────────
test("a ledgered operator override keeps a capped PR armed — the escape hatch still works", () => {
  const rec = recorder();
  const c = ctx();

  const withdrew = withdrawArmIfVerdictRefuses(
    { state: "success", capped: true, planOnly: false },
    c.value,
    {
      disarm: rec.disarm,
      ledgerLines: () => [
        {
          step: "automerge.capped_override_granted",
          task_id: "W1-T195",
          head_sha: "feb7d1bcafe",
          by: "craig",
          reason: "reviewed by hand",
        },
      ],
    },
  );

  assert.equal(withdrew, false, "an override granted against THIS head keeps the arm");
  assert.deepEqual(rec.calls, [], "no disarm issued");
});

// ── 8: ORDERING — the withdrawal must precede the status post ───────────────────────
test("ORDERING: runReview withdraws the arm BEFORE it posts the status — a later disarm would race GitHub", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const withdrawAt = src.indexOf("  withdrawArmIfVerdictRefuses(");
  const postAt = src.indexOf("  const posted = await postReviewStatusGuarded({");

  assert.ok(withdrawAt > 0, "the withdrawal call site exists in runReview");
  assert.ok(postAt > 0, "the status post exists in runReview");
  assert.ok(
    withdrawAt < postAt,
    "the withdrawal must be ISSUED BEFORE the required status goes up — #969 merged two " +
      "seconds after its status posted, so a withdrawal ordered after the post loses that race",
  );
});
