/**
 * test/strike-cap-cumulative.test.ts
 *
 * W1-T2452 — THE DEFECT. `DISPOSITION_RULES`' exhaustion row (sweep.ts) gates on the ledger's
 * running `pr.priorStrikes` count — cumulative, across every sweep pass. The rung it dispatches
 * was NOT: `dispatchFix` (run-task.ts) handed `runFixRung` a FRESH FULL `strikeCap` every single
 * call, and `runFixRung` always counts a NEW call from 0 strikes. So a PR that spent one strike
 * on dispatch #1 (via any of the rung's own early-exit guards) and was re-dispatched on dispatch
 * #2 with a fresh budget of `cap` could spend `cap` MORE — a cumulative ceiling of `cap + (cap -
 * 1)` in the worst case, not `cap`. Observed on PR #3043: "fix strikes exhausted (3/2)", cap=2.
 *
 * THE FIX, per the task's own design ("ONE CONCEPT: THE CEILING ACTUALLY IN FORCE"):
 *   - {@link fixCeilingInForce} (sweep.ts) names the ONE ceiling a PR is bound by — the base
 *     `strikeCap`, or the EXTENDED ceiling once an operator's answer is live — the SAME extended
 *     number `DISPOSITION_RULES`' "answered" row already checks.
 *   - {@link fixDispatchBudget} (sweep.ts) turns that ceiling into the REMAINDER a dispatch may
 *     spend (`ceiling - priorStrikes`), and returns `null` — never zero or negative — when there
 *     is nothing left, so the caller can never hand `runFixRung` a zero-budget rung.
 *   - `dispatchFix` (run-task.ts) calls both, BEFORE any worktree/git side effect, and refuses
 *     (ledgering `sweep.fix.ceiling_exhausted`, naming the ceiling) rather than dispatching on a
 *     `null` budget.
 *   - Every DISPOSITION_RULES reason that renders a strike ratio (`strike N/cap`, "fix strikes
 *     exhausted (N/cap)") now renders the denominator through {@link fixCeilingInForce} too, so
 *     the ratio never disagrees with the ceiling the dispatch site actually enforces.
 *
 * SECTIONS: (A)/(B) the two pure functions in isolation — the arithmetic the whole fix rests on;
 * (C) DISPOSITION_RULES' rendered reasons, proven to read the SAME ceiling; (D) a structural lock
 * on the dispatch site's own ordering (fixDispatchBudget computed, checked, and only THEN does
 * runFixRung run) so a future edit cannot silently drop the guard; (E) the real `dispatchFix`
 * closure, driven gateway-free (a stub `gh`, no repository — every case below is decided before
 * any worktree is ever created), proving the gate is wired at the real call site, not just typed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSweepEffects } from "../src/run-task.js";
import {
  DEFAULT_CLARIFY_POLICY,
  DEFAULT_SWEEP_POLICY,
  deriveDisposition,
  fixCeilingInForce,
  fixDispatchBudget,
  strikeCapForAnswer,
  type OpenPrView,
  type SweepPolicy,
} from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";

const NOW = Date.parse("2026-08-29T12:00:00Z");
const RECENT = "2026-08-29T11:00:00Z"; // well under DEFAULT_SWEEP_POLICY.staleDays

function pr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 3043,
    prUrl: "https://github.com/o/r/pull/3043",
    taskId: "W1-TX",
    reviewState: "failure",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: "cafe3043",
    autoMergeArmed: false,
    ...over,
  };
}

// ── (A) fixCeilingInForce ─────────────────────────────────────────────────

test("fixCeilingInForce: no pendingAnswer -> the base strikeCap, unchanged by the clarify policy", () => {
  assert.equal(fixCeilingInForce(pr(), 2), 2);
  assert.equal(fixCeilingInForce(pr(), 2, { resetStrikeCounterOnAnswer: false }), 2);
});

test("fixCeilingInForce: pendingAnswer live, default clarify policy (reset=true) -> the ceiling EXTENDS by a fresh full cap (2 + 2)", () => {
  const answered = pr({ pendingAnswer: { constraint: "use approach X" } });
  assert.equal(fixCeilingInForce(answered, 2), 4);
  assert.equal(fixCeilingInForce(answered, 2, DEFAULT_CLARIFY_POLICY), 4);
});

test("fixCeilingInForce: pendingAnswer live, global clarify policy reset=false -> the ceiling extends by exactly ONE bounded strike (2 + 1)", () => {
  const answered = pr({ pendingAnswer: { constraint: "use approach X" } });
  assert.equal(fixCeilingInForce(answered, 2, { resetStrikeCounterOnAnswer: false }), 3);
});

test("fixCeilingInForce: the answer's OWN resetStrikeCounter overrides the global clarify policy, in both directions", () => {
  const overrideTrue = pr({ pendingAnswer: { constraint: "x", resetStrikeCounter: true } });
  const overrideFalse = pr({ pendingAnswer: { constraint: "x", resetStrikeCounter: false } });
  assert.equal(fixCeilingInForce(overrideTrue, 2, { resetStrikeCounterOnAnswer: false }), 4, "per-answer true wins over a global false");
  assert.equal(fixCeilingInForce(overrideFalse, 2, { resetStrikeCounterOnAnswer: true }), 3, "per-answer false wins over a global true");
});

test("fixCeilingInForce: this IS the same extended number DISPOSITION_RULES' answered row checks (strikeCapForAnswer folded in identically)", () => {
  const clarify = { resetStrikeCounterOnAnswer: false };
  const answered = pr({ pendingAnswer: { constraint: "x" } });
  assert.equal(fixCeilingInForce(answered, 2, clarify), 2 + strikeCapForAnswer(2, clarify));
});

// ── (B) fixDispatchBudget — THE CUMULATIVE BIND ──────────────────────────

test("fixDispatchBudget: a fresh PR (priorStrikes 0) gets the whole ceiling", () => {
  assert.equal(fixDispatchBudget(0, 2), 2);
});

test("fixDispatchBudget: THE EXACT PR #3043 REACHABLE ROUTE — one strike already spent (priorStrikes 1) against cap 2 gets a budget of 1, NEVER the fresh full cap of 2", () => {
  // Before this task: dispatch #2 got `fixStrikeCap(config)` == 2 regardless of priorStrikes,
  // so the ledger could reach 1 (already spent) + 2 (a fresh full budget) == 3 against a cap of
  // 2 — exactly the observed "fix strikes exhausted (3/2)". The fix: the REMAINDER.
  const budget = fixDispatchBudget(1, 2);
  assert.equal(budget, 1);
  assert.equal(1 + (budget ?? 0), 2, "the cumulative ledger total this dispatch can reach never exceeds the ceiling (2), never 3");
});

test("fixDispatchBudget: priorStrikes already AT the ceiling -> null, never zero dispatched as a number", () => {
  assert.equal(fixDispatchBudget(2, 2), null);
});

test("fixDispatchBudget: priorStrikes already OVER the ceiling -> null, never a negative budget", () => {
  assert.equal(fixDispatchBudget(3, 2), null);
});

test("fixDispatchBudget: the invariant holds across a spread of (priorStrikes, ceiling) pairs — the cumulative total a dispatch may reach never exceeds the ceiling", () => {
  const ceilings = [1, 2, 3, 4, 5];
  for (const ceiling of ceilings) {
    for (let priorStrikes = 0; priorStrikes <= ceiling + 2; priorStrikes++) {
      const budget = fixDispatchBudget(priorStrikes, ceiling);
      if (priorStrikes >= ceiling) {
        assert.equal(budget, null, `priorStrikes=${priorStrikes} ceiling=${ceiling} must refuse to dispatch`);
      } else {
        assert.ok(budget !== null && budget > 0, `priorStrikes=${priorStrikes} ceiling=${ceiling} must dispatch a positive budget`);
        assert.ok(
          priorStrikes + (budget as number) <= ceiling,
          `priorStrikes=${priorStrikes} + budget=${budget} must never exceed ceiling=${ceiling}`,
        );
      }
    }
  }
});

// ── (C) DISPOSITION_RULES: every rendered ratio names the ceiling actually in force ──────────

test("deriveDisposition: exhaustion with NO pendingAnswer still renders the base cap — byte-identical regression lock", () => {
  const exhausted = pr({ priorStrikes: 2, unmetCriteria: [{ claim: "still unmet", met: false, reason: "r", proof_exec: "executed_fail" } as never] });
  const result = deriveDisposition(exhausted, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(result.reason, /fix strikes exhausted \(2\/2\)/);
});

test("deriveDisposition: exhaustion with a LIVE pendingAnswer renders the EXTENDED ceiling — the design (iv) 'wrong denominator' reading, fixed", () => {
  // cap=2, default reset -> extended ceiling 4. isBlockedCi(pr) true so the "answered" row's own
  // `when` evaluates the SAME extended-ceiling check (it does not require reviewShape when checks
  // are red) and, at priorStrikes==ceiling, yields to this exhaustion row exactly as intended.
  const policy: SweepPolicy = DEFAULT_SWEEP_POLICY;
  const answeredExhausted = pr({
    priorStrikes: 4,
    checksState: "red",
    pendingAnswer: { constraint: "use approach X" },
  });
  const result = deriveDisposition(answeredExhausted, policy, NOW);
  assert.equal(result.disposition, "blocked-ambiguous");
  assert.match(
    result.reason,
    /fix strikes exhausted \(4\/4\)/,
    `an answered PR's legitimate exhaustion must name ITS ceiling (4), never the base cap (2); got: ${result.reason}`,
  );
});

test("deriveDisposition: a blocked-fixable gate-failure reason also renders the ceiling in force, not the bare base cap, when pendingAnswer is live", () => {
  // Reaches row 7 (actionableGateFailures branch) rather than the "answered" row: unmetCriteria
  // is empty and checks are green, so the answered row's own reviewShape/isBlockedCi guard is
  // false and it yields — proving the ceiling-in-force concept is applied at EVERY rendered
  // ratio, not merely the exhaustion row, even in this corner the "answered" row itself skips.
  const gateFailurePr = pr({
    priorStrikes: 0,
    checksState: "green",
    unmetCriteria: [],
    actionableGateFailures: [{ remedy: "run the formatter", claim: "formatting gate" } as never],
    pendingAnswer: { constraint: "use approach X" },
  });
  const result = deriveDisposition(gateFailurePr, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(result.disposition, "blocked-fixable");
  assert.match(result.reason, /strike 1\/4/, `expected the extended ceiling (4) as the denominator; got: ${result.reason}`);
});

// ── (D) structural lock: the dispatch site can never fall through a non-positive budget ──────

test("src/run-task.ts: dispatchFix computes fixDispatchBudget and checks it BEFORE ever calling runFixRung — a null budget cannot reach the rung", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const closureStart = src.indexOf("dispatchFix: async (pr, evidence) => {");
  assert.ok(closureStart >= 0, "the dispatchFix closure must exist verbatim (re-grep if this ever legitimately renames)");

  const budgetCallIdx = src.indexOf("fixDispatchBudget(", closureStart);
  assert.ok(budgetCallIdx > closureStart, "dispatchFix must call fixDispatchBudget");

  const runFixRungIdx = src.indexOf("await runFixRung(", budgetCallIdx);
  assert.ok(runFixRungIdx > budgetCallIdx, "runFixRung must be called AFTER the budget is computed, never before");

  const between = src.slice(budgetCallIdx, runFixRungIdx);
  assert.match(
    between,
    /strikeCap\s*==\s*null/,
    "a guard on the computed budget being null must sit between the computation and the runFixRung call",
  );
  assert.match(
    between.slice(between.search(/strikeCap\s*==\s*null/)),
    /return;/,
    "the null-budget branch must return — never fall through into runFixRung",
  );
});

// ── (E) the REAL dispatchFix closure, driven gateway-free ────────────────────────────────────
//
// Same discipline test/uncreditable-head-reason.test.ts and test/fix-rung-no-task.test.ts already
// established for this exact closure: a stub `gh` on PATH, no real repository. Every case below
// is decided before `createFixRungWorktree` ever runs, so none of them needs one.

const T = (id: string): Task => ({ id, title: id, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" }) as unknown as Task;
const PLAN: Plan = (() => {
  const tasks = [T("W1-TX")];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

type Drive = { logs: Array<{ step: string; extra?: Record<string, unknown> }> };

/** Drives the real `dispatchFix` closure with a PATH-stubbed `gh`; returns every ledger line it wrote. */
async function driveDispatchFix(prOver: Partial<OpenPrView>, headRefName: string): Promise<Drive> {
  const root = mkdtempSync(join(tmpdir(), "scc-root-"));
  const bin = mkdtempSync(join(tmpdir(), "scc-gh-"));
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const a = process.argv.slice(2); const i = a.indexOf("--json"); const f = i >= 0 ? a[i+1] : undefined;',
      `const HEAD = ${JSON.stringify(headRefName)};`,
      // The one round trip a run PAST the budget gate makes for the head.
      'if (f && f.includes("headRefName")) process.stdout.write(JSON.stringify({ headRefName: HEAD, body: "" }));',
      // ghLiveState's REST read — answered OPEN so the preflight never stands the run down.
      'else if (a[0] === "api" && typeof a[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(a[1])) process.stdout.write(JSON.stringify({ state: "open", merged: false }));',
      'else process.stdout.write("{}");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const effects = buildSweepEffects(
      "acme",
      "scratch-scc-repo",
      { root } as never,
      join(root, "ledger.ndjson"),
      "SWEEP-SCC",
      PLAN,
      (step, extra) => void logs.push({ step, extra }),
      DEFAULT_SWEEP_POLICY,
    );
    await effects.dispatchFix(
      { ...pr(prOver), headRefName } as never,
      { unmetCriteria: [], ciFailures: [] } as never,
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
  return { logs };
}

test("dispatchFix: priorStrikes AT the ceiling refuses BEFORE touching the head at all — logs sweep.fix.ceiling_exhausted naming the ceiling, spends nothing, never even fetches headRefName", async () => {
  const { logs } = await driveDispatchFix({ priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap }, "run-W1-TX-1785600000000");
  const row = logs.find((l) => l.step === "sweep.fix.ceiling_exhausted");
  assert.ok(row, `expected sweep.fix.ceiling_exhausted; got steps ${JSON.stringify(logs.map((l) => l.step))}`);
  assert.equal(row.extra?.prior_strikes, DEFAULT_SWEEP_POLICY.strikeCap);
  assert.equal(row.extra?.ceiling, DEFAULT_SWEEP_POLICY.strikeCap);
  assert.ok(!logs.some((l) => l.step === "sweep.fix.synthetic_task"), "never reached task resolution");
  assert.ok(!logs.some((l) => l.step === "sweep.fix.uncreditable_head"), "never reached the head check");
  assert.ok(!logs.some((l) => l.step === "fix.dispatch"), "no strike was spent — the load-bearing half of the fix");
});

test("dispatchFix: priorStrikes BELOW the ceiling is NOT wrongly blocked — it proceeds past the budget gate to the next real check", async () => {
  // An uncreditable head (does not match run-W1-TX-<epochMs>) is the FIRST check reached once the
  // budget gate passes — its presence in the logs is the proof this run cleared the gate.
  const { logs } = await driveDispatchFix({ priorStrikes: 0 }, "some-foreign-branch");
  assert.ok(
    !logs.some((l) => l.step === "sweep.fix.ceiling_exhausted"),
    "a genuine remaining budget must never be refused at the ceiling gate",
  );
  const row = logs.find((l) => l.step === "sweep.fix.uncreditable_head");
  assert.ok(row, `expected the run to reach the head check; got steps ${JSON.stringify(logs.map((l) => l.step))}`);
});
