// test/escalation-options-are-executable.test.ts — W1-T2273.
//
// The gap this task closes: an escalation option was FREE PROSE rendered under "## Options"
// (escalate.ts:742) with no machine-readable shape at all — the route table carried no review/
// merge/close/reject path, and the console's write surface had never recorded an operator
// action off an escalation option (all fourteen `panel.*` steps read zero against 1,449 SERVE
// rows, per this task's own rationale). The fix is a closed, typed `kind` on EscalationOption
// (escalate.ts) plus a renderer-side resolver (serve.ts) that reads ONLY that declared kind —
// never the option's own prose — to decide whether a button is drawable.
//
// Each `test()` below is named after, and proves, ONE of the seven acceptance claims in
// plan/tasks.d/W1-T2273-escalation-options-are-prose-not-actions.yaml, in the same order.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ESCALATION_OPTION_ROUTES,
  NEEDS_HUMAN_LABEL,
  escalate,
  renderIssueBody,
  validateEscalationOptionKind,
  type Escalation,
  type EscalationOption,
  type EscalationOptionKind,
  type IssueGateway,
} from "../src/lib/escalate.js";
import { resolveEscalationOptionAffordance } from "../src/lib/serve.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalation-options-")), "ledger.ndjson");
}

function fakeIssues(url = "https://github.com/craigoley/remudero/issues/2273"): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
} {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
}

function escalation(options: EscalationOption[]): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-TX",
    summary: "two strikes exhausted",
    detail: "the diagnose-armed retry still failed CI.",
    options,
    recommendation: options[0]?.label ?? "",
  };
}

const REJUDGE_KIND: EscalationOptionKind = {
  type: "executable",
  route: "/v1/drain/kick",
  tier: "high",
  payload: { taskId: "W1-TX" },
};

const REVIEW_MANUALLY_KIND: EscalationOptionKind = { type: "operator-only" };

// ── (1) a machine readable kind drawn from a closed set, alongside the prose ────────────────
test("an escalation option carries a machine readable kind drawn from a closed set, alongside the prose sentence it already renders", () => {
  const rejudge: EscalationOption = {
    label: "re-judge",
    detail: "re-examine the reviewer's reasoning and re-post remudero-review by hand if the block is unwarranted.",
    kind: REJUDGE_KIND,
  };
  const reviewManually: EscalationOption = {
    label: "review-manually",
    detail: "read the diff and either merge it by hand or push a follow-up fix, then re-drain.",
    kind: REVIEW_MANUALLY_KIND,
  };

  // The closed set has exactly two shapes — "executable" and "operator-only" — nothing else.
  assert.equal(rejudge.kind?.type, "executable");
  assert.equal(reviewManually.kind?.type, "operator-only");

  // The prose is UNTOUCHED — kind is a sibling field, never a replacement for label/detail.
  assert.equal(rejudge.label, "re-judge");
  assert.match(rejudge.detail, /re-examine the reviewer's reasoning/);
  assert.equal(reviewManually.label, "review-manually");
  assert.match(reviewManually.detail, /merge it by hand/);

  // Both validate cleanly at the emitter — a well-formed member of the closed set is accepted.
  assert.doesNotThrow(() => validateEscalationOptionKind(rejudge));
  assert.doesNotThrow(() => validateEscalationOptionKind(reviewManually));

  // An option with NO kind at all is still a legal EscalationOption (every existing producer —
  // run-task.ts, triage.ts — none of which this task touches) and validates as a no-op.
  const untyped: EscalationOption = { label: "retry", detail: "resume the run with a fresh worker" };
  assert.equal(untyped.kind, undefined);
  assert.doesNotThrow(() => validateEscalationOptionKind(untyped));
});

// ── (2) an executable option names route+payload; an inexecutable one is marked operator-only ──
test("an option the console can execute names the route and payload it posts, and an option it cannot execute is marked as operator only", () => {
  const rejudge: EscalationOption = {
    label: "re-judge",
    detail: "re-post remudero-review by hand if the block is unwarranted.",
    kind: REJUDGE_KIND,
  };
  const reviewManually: EscalationOption = {
    label: "review-manually",
    detail: "read the diff and either merge it by hand or push a follow-up fix, then re-drain.",
    kind: REVIEW_MANUALLY_KIND,
  };
  const untyped: EscalationOption = { label: "wait", detail: "no action available yet" };

  const executableAffordance = resolveEscalationOptionAffordance(rejudge);
  assert.equal(executableAffordance.executable, true);
  assert.ok(executableAffordance.executable);
  if (executableAffordance.executable) {
    assert.equal(executableAffordance.route, "/v1/drain/kick");
    assert.equal(executableAffordance.tier, "high");
    assert.deepEqual(executableAffordance.payload, { taskId: "W1-TX" });
  }

  const operatorOnlyAffordance = resolveEscalationOptionAffordance(reviewManually);
  assert.equal(operatorOnlyAffordance.executable, false);
  assert.equal((operatorOnlyAffordance as { route?: unknown }).route, undefined);

  // No declared kind at all resolves the SAME as operator-only — never silently pressable.
  const untypedAffordance = resolveEscalationOptionAffordance(untyped);
  assert.equal(untypedAffordance.executable, false);
});

// ── (3) the renderer reads the declared kind, never pattern-matches prose ───────────────────
test("the renderer reads what the option declares and never maps prose to a route by pattern matching", () => {
  // This option's PROSE names a real route path and the word "merge" — if the resolver ever
  // regexed label/detail to find a route, this would falsely resolve as executable against
  // /v1/manual/approve. It carries NO kind, so it must resolve as non-executable regardless.
  const decoy: EscalationOption = {
    label: "merge it",
    detail: "POST /v1/manual/approve by hand, or just merge the PR yourself.",
  };
  const decoyAffordance = resolveEscalationOptionAffordance(decoy);
  assert.equal(decoyAffordance.executable, false);

  // Conversely: an option whose prose describes something UNRELATED to its declared route must
  // still resolve to exactly the DECLARED route — the resolver reads `kind`, not the sentence.
  const misleading: EscalationOption = {
    label: "totally unrelated wording",
    detail: "this sentence never mentions any route, tier, or verb the resolver could key on.",
    kind: { type: "executable", route: "/v1/control/resume", tier: "middle" },
  };
  const misleadingAffordance = resolveEscalationOptionAffordance(misleading);
  assert.equal(misleadingAffordance.executable, true);
  assert.ok(misleadingAffordance.executable);
  if (misleadingAffordance.executable) {
    assert.equal(misleadingAffordance.route, "/v1/control/resume");
    assert.equal(misleadingAffordance.tier, "middle");
  }
});

// ── (4) no merge/close/reject route is added ─────────────────────────────────────────────────
test("no route is added that merges a pull request, closes one, or rejects one", () => {
  const paths = Object.keys(ESCALATION_OPTION_ROUTES);
  assert.ok(paths.length > 0);
  for (const path of paths) {
    assert.doesNotMatch(path, /review|merge|close|reject/i, `route ${path} looks like a merge/close/reject path`);
  }
  // The nearest reachable action stays a task dispatch, never a merge action.
  assert.ok(paths.includes("/v1/drain/kick"));
  assert.ok(!paths.some((p) => /\/v1\/(pr|pull)s?\//i.test(p)));
});

// ── (5) an executable option is assigned one of the three existing tiers, no fourth tier ───
test("an executable option is assigned one of the three existing tiers and no fourth tier is introduced", () => {
  const tiers = new Set(Object.values(ESCALATION_OPTION_ROUTES));
  assert.deepEqual([...tiers].sort(), ["high", "low", "middle"]);

  // A caller claiming a tier that disagrees with the route's REAL tier is refused...
  const wrongTier: EscalationOption = {
    label: "re-judge",
    detail: "re-post remudero-review by hand.",
    kind: { type: "executable", route: "/v1/drain/kick", tier: "low" },
  };
  assert.throws(() => validateEscalationOptionKind(wrongTier), /declares tier "low"/);

  // ...and a fabricated fourth tier is refused too (not merely mismatched, INVENTED).
  const fourthTier: EscalationOption = {
    label: "re-judge",
    detail: "re-post remudero-review by hand.",
    kind: { type: "executable", route: "/v1/drain/kick", tier: "critical" as unknown as "high" },
  };
  assert.throws(() => validateEscalationOptionKind(fourthTier), /declares tier/);
});

// ── (6) the prose survives on every option, including operator-only ones ────────────────────
test("the human readable sentence survives on every option, including the ones that are operator only", () => {
  const rejudge: EscalationOption = {
    label: "re-judge",
    detail: "re-examine the reviewer's reasoning against the deterministic floor and re-post remudero-review by hand.",
    kind: REJUDGE_KIND,
  };
  const reviewManually: EscalationOption = {
    label: "review-manually",
    detail: "read the diff and either merge it by hand or push a follow-up fix, then re-drain.",
    kind: REVIEW_MANUALLY_KIND,
  };

  const body = renderIssueBody(escalation([rejudge, reviewManually]));
  assert.match(body, /## Options/);
  assert.match(body, /\*\*re-judge\*\* — re-examine the reviewer's reasoning/);
  assert.match(body, /\*\*review-manually\*\* — read the diff and either merge it by hand/);

  // The resolved affordance carries the SAME prose forward too, typed or not.
  assert.equal(resolveEscalationOptionAffordance(rejudge).label, "re-judge");
  assert.equal(resolveEscalationOptionAffordance(reviewManually).detail, reviewManually.detail);
});

// ── (7) an unrecognised option kind is refused at the emitter, not rendered as an inert button ──
test("an unrecognised option kind is refused at the emitter rather than rendered as an inert button", () => {
  const issues = fakeIssues();

  const bogusType: EscalationOption = {
    label: "do-a-thing",
    detail: "some option",
    kind: { type: "sort-of-executable" } as unknown as EscalationOptionKind,
  };
  assert.throws(
    () => escalate(escalation([bogusType]), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" }),
    /unrecognised kind/,
  );
  assert.equal(issues.calls.length, 0, "a bogus kind must never reach gh issue create");

  const unknownRoute: EscalationOption = {
    label: "merge-it",
    detail: "merge the PR",
    kind: { type: "executable", route: "/v1/pulls/merge" as unknown as "/v1/drain/kick", tier: "high" },
  };
  assert.throws(
    () => escalate(escalation([unknownRoute]), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" }),
    /not in the closed set of routes/,
  );
  assert.equal(issues.calls.length, 0, "a route outside the closed set must never reach gh issue create");

  // A well-formed option, by contrast, is accepted and opens the issue exactly as before.
  // (Deliberately avoids the "by hand" idiom classifyAsk keys on for its OWN, unrelated
  // action-vs-question split — this test's concern is kind validation, not that heuristic.)
  const rejudge: EscalationOption = {
    label: "re-judge",
    detail: "re-post remudero-review since the block looks unwarranted.",
    kind: REJUDGE_KIND,
  };
  const url = escalate(escalation([rejudge]), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/2273");
  assert.equal(issues.calls.length, 1);
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked", "needs-question"]);
});
