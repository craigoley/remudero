/**
 * test/draft-pr-merge-hold.test.ts — W1-T3551.
 *
 * THE DEFECT: `src/lib/sweep.ts`'s `mergeable` disposition row (and its downstream arm path —
 * `decideAutoMergeArm` in `src/lib/review.ts`, `armAutoMerge`/`armAutoMergeDetailed`/
 * `armAutoMergeAtOpen` in `src/lib/arm-auto-merge.ts`) never read `OpenPrView.isDraft`. A draft PR
 * that is checks-green and review-success therefore matched `mergeable` exactly like a
 * ready-for-review one, the sweep called the real arm effector, GitHub refused (it always refuses
 * `gh pr merge --auto` on a draft), and the refusal was logged as a generic acted-on failure
 * rather than a named held-draft disposition — so the hold silently repeated every pass.
 *
 * THE FIX (two seams, mirroring W1-T1000002's own "gate where arms originate" shape):
 *  (i)  A NEW `held-draft` disposition row in `DISPOSITION_RULES`, ordered strictly before
 *       `mergeable`, matching `isDraft === true` plus the SAME checks-green/review-success
 *       predicate. `acted` is always false and no dedup key is ever seeded (the same "wait" shape),
 *       so an unchanged draft is held again on every later pass instead of being silently promoted.
 *  (ii) `attemptArm` (`src/lib/arm-auto-merge.ts`) — the ONE shared call site every arm path
 *       (`armAutoMergeDetailed`, reached by both the sweep and `armIfVerdictPermits`'s default arm;
 *       and `armAutoMergeAtOpen`) routes through — refuses immediately on `isDraft === true`, before
 *       even the operator-hold read. `armIfVerdictPermits` (the `rmd review <pr>` manual-review
 *       arm call, per `src/lib/authority.ts`'s own naming) ALSO short-circuits on `ctx.isDraft`
 *       before ever touching `deps.arm`, so an injected/mocked effector is never reached either.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  runSweep,
  type OpenPrView,
  type SweepDeps,
} from "../src/lib/sweep.js";
import { readLedgerLines } from "../src/lib/status.js";
import {
  armAutoMergeAtOpen,
  armIfVerdictPermits,
  armOutcomeReason,
  attemptArm,
} from "../src/lib/arm-auto-merge.js";

const NOW = Date.parse("2026-09-14T12:00:00Z");
const RECENT = "2026-09-14T11:00:00Z";
const HEAD = "d00dd00dcafebabe";
const TASK = "W1-T3551D";
const PR_URL = "https://github.com/craigoley/remudero/pull/3551";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-draft-hold-")), "ledger.ndjson");
}

/** The exact shape the `mergeable` row matches: required checks green, review success. */
function greenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3551,
    prUrl: PR_URL,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

/** A recording fake for every injected sweep effect — same minimal shape test/sweep-arm-parity.test.ts
 *  uses. `readLedger`/`appendLine` are deliberately OMITTED so `runSweep` reads/writes the REAL
 *  ledger file at `path`, letting a second call see the first pass's own rows (reconciliation). */
function fakeDeps(path: string, overrides: Partial<SweepDeps> = {}): SweepDeps & { armed: OpenPrView[] } {
  const armed: OpenPrView[] = [];
  return {
    armed,
    arm: (p) => {
      armed.push(p);
      return "armed";
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: path,
    runId: "DRAFT-HOLD-TEST",
    now: () => NOW,
    ...overrides,
  };
}

// ── pure disposition-table check ─────────────────────────────────────────────────────────────

test("W1-T3551: deriveDisposition routes a draft PR with green checks and review success to held-draft, never mergeable", () => {
  const result = deriveDisposition(greenPr({ isDraft: true }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "held-draft");
  assert.match(result.reason, /draft/i, "the reason names the draft state explicitly");
});

test("W1-T3551: deriveDisposition still routes the IDENTICAL non-draft PR to mergeable — isDraft undefined and isDraft false both", () => {
  assert.equal(deriveDisposition(greenPr(), DEFAULT_SWEEP_POLICY, NOW).disposition, "mergeable", "isDraft undefined");
  assert.equal(
    deriveDisposition(greenPr({ isDraft: false }), DEFAULT_SWEEP_POLICY, NOW).disposition,
    "mergeable",
    "isDraft false",
  );
});

// ── acceptance 1 + 2: no arm effect on an ordinary pass, and none on a later reconciliation pass ──

test("W1-T3551: a draft PR with green checks and review success calls no arm effect during an ordinary sweep pass, and is held again on a later reconciliation pass over the same unchanged PR", async () => {
  const path = ledgerPath();
  const draft = greenPr({ isDraft: true });

  const deps1 = fakeDeps(path);
  const summary1 = await runSweep([draft], deps1);
  assert.equal(summary1.byDisposition["held-draft"], 1, "the draft is disposed held-draft");
  assert.equal(summary1.byDisposition.mergeable, 0, "never counted as mergeable");
  assert.deepEqual(deps1.armed, [], "deps.arm must never fire for a draft PR");
  assert.equal(summary1.actionsTaken, 0);
  assert.equal(summary1.actions[0].disposition, "held-draft");
  assert.equal(summary1.actions[0].acted, false);

  // POST-FIX RECONCILIATION (design iv): a second, later pass over the SAME unchanged draft PR.
  // A held-draft row seeds no dedup key, so the row must re-derive and hold again — never
  // silently promoted by a stale "already handled" entry.
  const deps2 = fakeDeps(path);
  const summary2 = await runSweep([draft], deps2);
  assert.equal(summary2.byDisposition["held-draft"], 1, "still held on the second pass");
  assert.deepEqual(deps2.armed, [], "still no arm effect on the second pass");
  assert.equal(summary2.actions[0].acted, false);

  // ── acceptance 3: the held-draft row records acted false with a reason naming the draft state ──
  const disposed = readLedgerLines(path).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 2, "one held-draft ledger row per pass — re-derived, never deduped away");
  for (const row of disposed) {
    assert.equal(row.disposition, "held-draft");
    assert.equal(row.acted, false);
    assert.match(String(row.reason), /draft/i, "the ledgered reason names the draft state");
  }
});

// ── acceptance 4: a non-draft PR with the same green/success shape still arms exactly as before ──

test("W1-T3551: a non-draft pull request with the same green checks and review success still arms exactly as before", async () => {
  const path = ledgerPath();
  const ready = greenPr(); // isDraft omitted — the pre-existing, unchanged shape

  const deps = fakeDeps(path);
  const summary = await runSweep([ready], deps);

  assert.equal(summary.byDisposition.mergeable, 1, "still mergeable, not held-draft");
  assert.equal(summary.byDisposition["held-draft"], 0);
  assert.equal(deps.armed.length, 1, "the arm effector still fires for a non-draft PR");
  assert.equal(deps.armed[0].prNumber, ready.prNumber);
  assert.equal(summary.actionsTaken, 1);
  assert.equal(summary.actions[0].acted, true);
});

// ── acceptance 5: a manual review of a draft PR never reaches the arm effector ───────────────────

test("W1-T3551: armIfVerdictPermits (the rmd review <pr> manual-review arm call) never reaches the arm effector for a draft PR", () => {
  let armCalled = false;
  const outcome = armIfVerdictPermits(
    { state: "success", capped: false, planOnly: false },
    {
      prUrl: PR_URL,
      taskId: TASK,
      headSha: HEAD,
      ledgerPath: ledgerPath(),
      isDraft: true,
      log: () => {},
    },
    {
      arm: () => {
        armCalled = true;
        return "armed";
      },
    },
  );
  assert.equal(outcome, "skipped");
  assert.equal(armCalled, false, "the injected arm effector must never be invoked for a draft PR");
});

test("W1-T3551: armIfVerdictPermits still reaches the arm effector for the identical non-draft PR — isDraft undefined and isDraft false both", () => {
  for (const isDraft of [undefined, false] as const) {
    let armCalled = false;
    const outcome = armIfVerdictPermits(
      { state: "success", capped: false, planOnly: false },
      {
        prUrl: PR_URL,
        taskId: TASK,
        headSha: HEAD,
        ledgerPath: ledgerPath(),
        ...(isDraft === undefined ? {} : { isDraft }),
        log: () => {},
      },
      {
        arm: () => {
          armCalled = true;
          return "armed";
        },
      },
    );
    assert.equal(outcome, "armed");
    assert.equal(armCalled, true, `the arm effector still fires when isDraft is ${String(isDraft)}`);
  }
});

// ── attemptArm's own shared gate: the ONE choke point armAutoMergeDetailed and armAutoMergeAtOpen
// both route through — driven DIRECTLY (not via runSweep's higher-level `deps.arm`) so the
// isDraft === true branch inside attemptArm itself is exercised, not just its callers' decision
// never to invoke the sweep's own arm effector ──────────────────────────────────────────────────

test("W1-T3551: attemptArm refuses immediately on isDraft === true, before the ledger-hold read, and never calls armAuto/mergeDirect", () => {
  const said: string[] = [];
  let ledgerReadCalled = false;
  const result = attemptArm(
    PR_URL,
    {
      armAuto: () => {
        throw new Error("armAuto must never be called for a draft PR");
      },
      mergeDirect: () => {
        throw new Error("mergeDirect must never be called for a draft PR");
      },
      isMerged: () => false,
      say: (m) => void said.push(m),
      ledgerLines: () => {
        ledgerReadCalled = true;
        return [];
      },
    },
    HEAD,
    true, // isDraft
  );

  assert.deepEqual(result, { outcome: "draft-refused" });
  assert.equal(ledgerReadCalled, false, "the draft check is FIRST — it never even reads the hold ledger");
  assert.ok(
    said.some((m) => m.includes("automerge.draft_refused") && m.includes(PR_URL)),
    "the draft refusal is said with the W1-T3551 tag and the PR url",
  );
});

test("W1-T3551: attemptArm still reaches the ledger-hold read and arms normally when isDraft is undefined or false", () => {
  for (const isDraft of [undefined, false] as const) {
    const ghCalls: string[] = [];
    const result = attemptArm(
      PR_URL,
      {
        armAuto: () => void ghCalls.push("armAuto"),
        mergeDirect: () => void ghCalls.push("mergeDirect"),
        isMerged: () => false,
        say: () => {},
        ledgerLines: () => [],
      },
      HEAD,
      isDraft,
    );
    assert.equal(result.outcome, "armed", `isDraft=${String(isDraft)} must still arm`);
    assert.deepEqual(ghCalls, ["armAuto"]);
  }
});

test("W1-T3551: armAutoMergeAtOpen threads isDraft straight through to attemptArm's shared gate — the ungated at-open arm holds a draft too", () => {
  let armAutoCalled = false;
  const outcome = armAutoMergeAtOpen(
    PR_URL,
    {
      armAuto: () => void (armAutoCalled = true),
      mergeDirect: () => void (armAutoCalled = true),
      isMerged: () => false,
      say: () => {},
    },
    false, // irreversible
    true, // isDraft
  );
  assert.equal(outcome, "draft-refused");
  assert.equal(armAutoCalled, false, "the at-open arm effector must never fire for a draft PR");
});

test("W1-T3551: armAutoMergeAtOpen's isDraft parameter defaults to false — every pre-existing call site (which never passes it) keeps arming exactly as before", () => {
  const ghCalls: string[] = [];
  const outcome = armAutoMergeAtOpen(PR_URL, {
    armAuto: () => void ghCalls.push("armAuto"),
    mergeDirect: () => void ghCalls.push("mergeDirect"),
    isMerged: () => false,
    say: () => {},
  });
  assert.equal(outcome, "armed");
  assert.deepEqual(ghCalls, ["armAuto"]);
});

// ── armOutcomeReason's new "draft-refused" case ──────────────────────────────────────────────────

test("W1-T3551: armOutcomeReason names the draft state and says only marking it ready lifts the hold", () => {
  const reason = armOutcomeReason("draft-refused", "verdict is a full PASS");
  assert.match(reason, /draft/i, "the ledger row names WHAT refused, not just that something did");
  assert.match(reason, /held until marked ready for review/i, "and names the ONE thing that lifts it");
  // PAIRED POSITIVE CONTROL: the SAME decision reason under a different outcome reads
  // differently, so the assertions above are not satisfied by a switch returning one string.
  assert.notEqual(armOutcomeReason("armed", "verdict is a full PASS"), reason);
  assert.equal(armOutcomeReason("armed", "verdict is a full PASS"), "verdict is a full PASS");
});
