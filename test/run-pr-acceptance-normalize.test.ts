/**
 * W1-T4425 — THE RUN PR'S OWN ACCEPTANCE BLOCK MUST NEVER DIVERGE FROM ITS PLAN.
 *
 * `normalizeRunPrAcceptanceFromPlan` (run-task.ts) is the harness-side fix for
 * `trailer-body-proof-divergence` (scripts/acceptance-author-gate.mjs's
 * `trailerBodyProofDivergenceRefusal`): a worker-authored `## Acceptance`/`Acceptance:` block whose
 * proofs disagree with the task's own plan record used to reach CI and get refused there (#6888,
 * #6929, #6931), costing a full fix-lane round each time. This drives the PRODUCTION function
 * directly — both leaves (`fetchBody`/`editBody`) injected, per CLAUDE.md's #977/#978 rule — against
 * the SAME divergence comparison the gate itself runs (proof text as a SET, order and claim wording
 * both ignored), rather than a local restatement of it.
 *
 * Its own file per CLAUDE.md's coverage rule — never appended to test/run-task.test.ts, which
 * intermittently crashes at FILE level under --experimental-test-coverage.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { normalizeRunPrAcceptanceFromPlan } from "../src/run-task.js";
import { parseAcceptanceBlock } from "../src/lib/review.js";
import { ghShim } from "./helpers/gh-shim.js";

const PR = "https://github.com/craigoley/remudero/pull/6888";
const TASK_ID = "W1-T4356";

const PLAN_CRITERIA = [
  { claim: "a borrowed managed checkout is fast-forwarded before its install is used", proof: "unit test: fast-forwards a borrowed checkout" },
  { claim: "an already-current checkout pays no extra fast-forward", proof: "unit test: skips a fast-forward when already current" },
];

function recorder() {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const edits: Array<{ url: string; body: string }> = [];
  return {
    logged,
    edits,
    log: (step: string, extra?: Record<string, unknown>) => logged.push({ step, extra }),
    editBody: (url: string, body: string) => edits.push({ url, body }),
  };
}

/** A worker-authored body whose OWN Acceptance block names proofs the plan record does not
 *  (`- <claim> | <proof>`, the single-line dialect {@link parseAcceptanceBlock} reads verbatim). */
const DIVERGING_BODY = [
  "This PR fast-forwards a borrowed managed checkout before its install is used.",
  "",
  "## Acceptance",
  "- the checkout is refreshed | unit test: a totally different, hand-invented test",
  "- nothing extra happens when current | unit test: another invented one",
  "",
  `Remudero-Task: ${TASK_ID}`,
  "",
].join("\n");

/** The SAME body, but its block already names the plan's own two proofs (bullet order swapped, to
 *  prove the comparison is a SET, not a sequence). */
const MATCHING_BODY = [
  "This PR fast-forwards a borrowed managed checkout before its install is used.",
  "",
  "## Acceptance",
  "- an already-current checkout pays no extra fast-forward | unit test: skips a fast-forward when already current",
  "- a borrowed managed checkout is fast-forwarded before its install is used | unit test: fast-forwards a borrowed checkout",
  "",
  `Remudero-Task: ${TASK_ID}`,
  "",
].join("\n");

test("a diverging run PR body is rewritten from its plan", () => {
  const r = recorder();
  const outcome = normalizeRunPrAcceptanceFromPlan(PR, TASK_ID, PLAN_CRITERIA, r.log, {
    fetchBody: () => DIVERGING_BODY,
    editBody: r.editBody,
  });

  assert.equal(outcome, "rewritten");
  assert.equal(r.edits.length, 1, "the PR body was actually edited, exactly once");
  assert.equal(r.edits[0].url, PR);

  const rewrittenBody = r.edits[0].body;
  const after = parseAcceptanceBlock(rewrittenBody);
  const afterProofs = new Set(after.map((c) => c.proof.trim()));
  const planProofs = new Set(PLAN_CRITERIA.map((c) => c.proof));
  assert.deepEqual(afterProofs, planProofs, "the rewritten block names EXACTLY the plan's own proofs");
  for (const invented of ["a totally different, hand-invented test", "another invented one"]) {
    assert.ok(!rewrittenBody.includes(invented), `the invented proof "${invented}" must not survive`);
  }

  // The worker's own intro prose survives untouched.
  assert.ok(rewrittenBody.startsWith("This PR fast-forwards a borrowed managed checkout before its install is used."));

  // The trailer is still present and is the body's LAST non-blank line (the worker prompt's own
  // contract), not stranded above the freshly-rendered block.
  assert.ok(rewrittenBody.trim().endsWith(`Remudero-Task: ${TASK_ID}`));
  assert.equal((rewrittenBody.match(/^Remudero-Task:/gm) ?? []).length, 1, "exactly one trailer line, never doubled");

  assert.equal(r.logged.length, 1, "exactly one ledger row for this rewrite");
  assert.equal(r.logged[0].step, "pr.body_normalized");
  assert.equal(r.logged[0].extra?.pr, PR);
  assert.deepEqual(
    new Set(r.logged[0].extra?.removed_proofs as string[]),
    new Set(["unit test: a totally different, hand-invented test", "unit test: another invented one"]),
    "removed_proofs names exactly the invented proofs the plan does not carry",
  );
  assert.deepEqual(new Set(r.logged[0].extra?.rendered_proofs as string[]), planProofs, "rendered_proofs is the plan's own proof set");
});

test("a run PR body that matches its plan is left alone", () => {
  const r = recorder();
  const outcome = normalizeRunPrAcceptanceFromPlan(PR, TASK_ID, PLAN_CRITERIA, r.log, {
    fetchBody: () => MATCHING_BODY,
    editBody: r.editBody,
  });

  assert.equal(outcome, "healthy");
  assert.equal(r.edits.length, 0, "no gh pr edit is issued for a body that already agrees with its plan");
  assert.equal(r.logged.length, 0, "and nothing is ledgered — silence is the correct trace for a healthy body");
});

test("a body with no Acceptance block at all (trailer-only shape) is untouched", () => {
  const r = recorder();
  const trailerOnly = `Nothing to see here.\n\nRemudero-Task: ${TASK_ID}\n`;
  const outcome = normalizeRunPrAcceptanceFromPlan(PR, TASK_ID, PLAN_CRITERIA, r.log, {
    fetchBody: () => trailerOnly,
    editBody: r.editBody,
  });
  assert.equal(outcome, "no-block");
  assert.equal(r.edits.length, 0);
  assert.equal(r.logged.length, 0);
});

test("no plan criteria at all is a documented no-op, never a guess", () => {
  const r = recorder();
  const outcome = normalizeRunPrAcceptanceFromPlan(PR, TASK_ID, [], r.log, {
    fetchBody: () => DIVERGING_BODY,
    editBody: r.editBody,
  });
  assert.equal(outcome, "no-block");
  assert.equal(r.edits.length, 0);
});

test("the function is best-effort — a failed body read is ledgered, never thrown into the run", () => {
  const r = recorder();
  const outcome = normalizeRunPrAcceptanceFromPlan(PR, TASK_ID, PLAN_CRITERIA, r.log, {
    fetchBody: () => {
      throw new Error("gh exploded");
    },
    editBody: r.editBody,
  });
  assert.equal(outcome, "error");
  assert.equal(r.edits.length, 0);
  const line = r.logged.find((l) => l.step === "pr.body_normalize.error");
  assert.ok(line, "the failure is named on its own ledger step");
  assert.match(String(line?.extra?.error), /gh exploded/, "carrying the real message, not a placeholder");
});

test("a failed EDIT is also contained — the read succeeded, the write did not", () => {
  const r = recorder();
  const outcome = normalizeRunPrAcceptanceFromPlan(PR, TASK_ID, PLAN_CRITERIA, r.log, {
    fetchBody: () => DIVERGING_BODY,
    editBody: () => {
      throw new Error("edit refused");
    },
  });
  assert.equal(outcome, "error");
  assert.ok(r.logged.some((l) => l.step === "pr.body_normalize.error"));
  assert.equal(r.logged.some((l) => l.step === "pr.body_normalized"), false, "a repair that never landed is not claimed");
});

// ── THE DEFAULT LEAVES — really shelling out, per CLAUDE.md's #977/#978 rule ─────────────────

test("the DEFAULT leaves really shell out to gh — argv, JSON parse and the edit are all exercised", () => {
  // The shared PATH-shim `gh` (test/helpers/gh-shim.ts). Its routes `echo` their stdout, and dash's
  // echo turns a `\\n` escape into a raw newline — illegal inside a JSON string — so every newline
  // in the body travels as the JSON escape `\\u000a` instead, which echo passes through untouched.
  const gh = ghShim(
    [{ when: "--json body", stdout: JSON.stringify({ body: DIVERGING_BODY }).replace(/\\n/g, "\\u000a") }],
    { kind: "gh-run-pr-normalize" },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${oldPath}`;
  try {
    const logged: string[] = [];
    // NO deps object at all — the spread defaults are what run.
    const outcome = normalizeRunPrAcceptanceFromPlan(PR, TASK_ID, PLAN_CRITERIA, (s) => logged.push(s));
    assert.equal(outcome, "rewritten", "the real default read + comparison + real default edit all ran");
    const argv = gh.calls().join("\n");
    assert.match(argv, /pr view .*--json body/, "the real default fetch issued the real view argv");
    assert.match(argv, /api -X PATCH repos\/[^/]+\/[^/]+\/pulls\/\d+ -f body=/, "and the real REST edit argv");
    assert.ok(logged.includes("pr.body_normalized"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(gh.dir, { recursive: true, force: true });
  }
});
