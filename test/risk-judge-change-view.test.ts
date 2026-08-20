import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  boundRiskJudgeChangeView,
  buildRiskJudgePrompt,
  RISK_JUDGE_CHANGE_VIEW_FILE_CAP,
  runRiskJudge,
  type RiskJudgeInput,
  type RiskJudgeOrchestratorDeps,
} from "../src/lib/risk-judge.js";
import { changeView } from "../src/run-task.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";

/**
 * W1-T1031 — "round 2" of W1-T454's Option A (Option B, the honesty prefix, shipped as
 * #1740). The judge used to see only a description and a DECLARED file list, so a change
 * whose description correctly named the defect it removed read exactly like a change that
 * introduced one (10/75 `risk_judge.decision` rows escalated, 9 merged anyway, none
 * prevented anything). This file proves the fix: the prompt now carries a bounded,
 * REST-sourced view of the change's ACTUAL diff shape (file list + per-file added/deleted
 * line counts, never the diff itself), sourced over REST rather than the GraphQL `gh pr
 * view --json files` path that exhausted three times in one day, and the whole judgment
 * still fails closed to ESCALATE when that view cannot be fetched — never a silent
 * fallback to the old, insufficient input.
 */

function baseInput(overrides: Partial<RiskJudgeInput> = {}): RiskJudgeInput {
  return {
    change: { description: "add a fuzzy-search helper to serve.ts", files: ["src/lib/serve.ts"] },
    gatesState: { lint: "pass", typecheck: "pass", tests: "pass" },
    planContext: { taskId: "W1-T900" },
    ...overrides,
  };
}

// ── (1) the prompt carries a bounded view of the actual change ────────────

test("W1-T1031: the prompt carries a bounded view of the actual change", () => {
  const input = baseInput({
    change: {
      description: "add a fuzzy-search helper to serve.ts",
      // DECLARED list names only one file...
      files: ["src/lib/serve.ts"],
      // ...but the ACTUAL change touched a second file the declared list never named.
      changeView: {
        files: [
          { path: "src/lib/serve.ts", additions: 40, deletions: 2 },
          { path: "src/lib/search.ts", additions: 120, deletions: 0 },
        ],
        truncated: false,
      },
    },
  });
  const prompt = buildRiskJudgePrompt(input);
  assert.match(prompt, /ACTUAL CHANGE/);
  // The file the DECLARED list omitted is nonetheless visible to the judge, with its
  // real added/deleted counts — this is the "bounded view of the actual change" the
  // declared file list alone could never carry.
  assert.match(prompt, /src\/lib\/search\.ts: \+120\/-0/);
  assert.match(prompt, /src\/lib\/serve\.ts: \+40\/-2/);
  // Still never a diff: no patch/hunk marker anywhere in the rendered section.
  assert.doesNotMatch(prompt, /^[+-]{3} /m, "a unified-diff hunk header must never appear — counts only, never patch content");
});

test("W1-T1031: an omitted change view renders honestly rather than silently disappearing", () => {
  const prompt = buildRiskJudgePrompt(baseInput());
  assert.match(prompt, /ACTUAL CHANGE.*no bounded change view supplied/);
});

test("W1-T1031: a change view longer than the cap is truncated, and says so honestly", () => {
  const files = Array.from({ length: RISK_JUDGE_CHANGE_VIEW_FILE_CAP + 5 }, (_, i) => ({
    path: `src/generated/f${i}.ts`,
    additions: 1,
    deletions: 0,
  }));
  const view = boundRiskJudgeChangeView(files);
  assert.equal(view.files.length, RISK_JUDGE_CHANGE_VIEW_FILE_CAP, "the cap must actually bound the rendered file count");
  assert.equal(view.truncated, true);

  const prompt = buildRiskJudgePrompt(baseInput({ change: { description: "x", changeView: view } }));
  assert.match(prompt, /truncated/i);
});

test("W1-T1031: a change view within the cap is never marked truncated", () => {
  const view = boundRiskJudgeChangeView([{ path: "src/a.ts", additions: 1, deletions: 1 }]);
  assert.equal(view.truncated, false);
  const prompt = buildRiskJudgePrompt(baseInput({ change: { description: "x", changeView: view } }));
  assert.doesNotMatch(prompt, /truncated/i);
});

// ── (2)/(3) the falsifier: BOTH directions in one shared judge, per design clause (iv) ──
//
// A fake `judge` that reads the rendered prompt's ACTUAL CHANGE section (exactly what a
// real LLM judge is shown) rather than the description — proving the fix changes what the
// judge's decision can be GROUNDED IN, not merely what fields exist on the input.

function totalLinesTouched(prompt: string): number {
  let total = 0;
  for (const m of prompt.matchAll(/\+(\d+)\/-(\d+)/g)) {
    total += Number(m[1]) + Number(m[2]);
  }
  return total;
}

function sizeAwareFakeJudgeDeps(escalateResult: string): RiskJudgeOrchestratorDeps {
  return {
    judge: async (input) => {
      const prompt = buildRiskJudgePrompt(input);
      const lines = totalLinesTouched(prompt);
      // A judge that actually reads the bounded ACTUAL CHANGE view sizes its verdict on the
      // real diff shape, not on how alarming the description sounds.
      return lines <= 20
        ? { verdict: "low", confidence: 0.9, reasons: ["small, well-scoped change per the actual-change view"] }
        : { verdict: "high", confidence: 0.9, reasons: ["large change per the actual-change view"] };
    },
    escalate: async () => escalateResult,
  };
}

test("W1-T1031: a benign change whose description names a hazard is not escalated", async () => {
  const input = baseInput({
    change: {
      description: "fix the SQL injection vulnerability in the login handler",
      files: ["src/lib/auth.ts"],
      changeView: boundRiskJudgeChangeView([
        { path: "src/lib/auth.ts", additions: 3, deletions: 1 },
        { path: "test/auth.test.ts", additions: 12, deletions: 0 },
      ]),
    },
  });
  const result = await runRiskJudge(input, sizeAwareFakeJudgeDeps("should-not-be-called"));
  assert.equal(result.action.kind, "proceed", "a small, benign actual-change view must not be overridden by a hazard-sounding description");
});

test("W1-T1031: a genuinely dangerous change still escalates", async () => {
  const input = baseInput({
    change: {
      description: "small cleanup to the auth module",
      files: ["src/lib/auth.ts"],
      changeView: boundRiskJudgeChangeView([
        { path: "src/lib/auth.ts", additions: 400, deletions: 380 },
        { path: "src/lib/session.ts", additions: 220, deletions: 190 },
      ]),
    },
  });
  const result = await runRiskJudge(input, sizeAwareFakeJudgeDeps("https://github.com/owner/repo/issues/99"));
  assert.equal(result.action.kind, "escalate", "a large, dangerous actual-change view must still escalate even behind a mild description — the judge must not have stopped judging");
  assert.equal(result.escalationUrl, "https://github.com/owner/repo/issues/99");
});

// ── (4) the change view is sourced over REST, never GraphQL ───────────────

test("W1-T1031: the change view is sourced over rest not graphql", () => {
  const calls: string[][] = [];
  const fakeFetch: GhApiFetcher = (args) => {
    calls.push(args);
    return [
      { filename: "src/lib/foo.ts", additions: 10, deletions: 2 },
      { filename: "test/foo.test.ts", additions: 30, deletions: 0 },
    ];
  };
  const view = changeView("https://github.com/owner/repo/pull/42", fakeFetch);

  assert.equal(calls.length, 1, "exactly one gh call — the REST files read");
  assert.deepEqual(calls[0], ["api", "repos/owner/repo/pulls/42/files?per_page=100"], "must call the REST pulls/{n}/files endpoint");
  assert.doesNotMatch(calls[0][0], /^pr$/, "must never call the `gh pr ...` GraphQL surface");
  assert.deepEqual(view, {
    files: [
      { path: "src/lib/foo.ts", additions: 10, deletions: 2 },
      { path: "test/foo.test.ts", additions: 30, deletions: 0 },
    ],
    truncated: false,
  });
});

test("W1-T1031: changeView refuses to guess on an unparseable PR url rather than falling back to gh pr view", () => {
  const fakeFetch: GhApiFetcher = () => {
    throw new Error("must not be called");
  };
  assert.throws(() => changeView("not-a-pr-url", fakeFetch), /cannot resolve owner\/repo\/number/);
});

// ── (5) an unavailable change view fails closed to ESCALATE ───────────────

test("W1-T1031: an unavailable change view still fails closed to escalate", async () => {
  const throwingFetch: GhApiFetcher = () => {
    throw new Error("gh api rate limited");
  };
  // Mirrors run-task.ts's own wiring exactly: the judge dependency fetches the change view
  // FIRST, using the real `changeView` reader, and lets a throw propagate — never catching it
  // to fall back onto the input's declared `files` alone (which would just reproduce this
  // task's own defect under a different name).
  const deps: RiskJudgeOrchestratorDeps = {
    judge: async (input) => {
      const view = changeView("https://github.com/owner/repo/pull/7", throwingFetch);
      return { verdict: "low", confidence: 0.99, reasons: [`unreachable — saw ${view.files.length} files`] };
    },
    escalate: async () => "https://github.com/owner/repo/issues/1",
  };
  const result = await runRiskJudge(baseInput(), deps);
  assert.equal(result.action.kind, "escalate", "a REST failure must fail the whole judgment closed, never pass the change through unassessed");
  assert.match(result.action.reason, /judge unavailable/i);
  assert.equal(result.escalationUrl, "https://github.com/owner/repo/issues/1");
});

// ── (6) the call site actually supplies the change view ───────────────────

const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

test("W1-T1031: run-task.ts's risk-judge call site supplies the change view, sourced fresh right before the real judge runs", () => {
  assert.match(runTaskSrc, /export function changeView\(/, "the REST-sourced reader must be defined in run-task.ts");

  const mountIdx = runTaskSrc.indexOf("const riskJudgeMount = resolveRiskJudgeMount(");
  assert.ok(mountIdx >= 0);
  const judgeDepIdx = runTaskSrc.indexOf("judge: judgeWithChangeView,", mountIdx);
  assert.ok(judgeDepIdx >= 0, "the runRiskJudge call must be wired to a judge that supplies the change view");

  const wrapperIdx = runTaskSrc.indexOf("const judgeWithChangeView =", mountIdx);
  assert.ok(wrapperIdx >= 0 && wrapperIdx < judgeDepIdx, "the wrapper must be declared before it is wired in as the judge dependency");

  const callIdx = runTaskSrc.indexOf("changeView(prUrl)", wrapperIdx);
  assert.ok(callIdx >= 0 && callIdx < judgeDepIdx, "changeView(prUrl) must be called inside the wrapper, before the judge dependency is wired in");

  // Nothing between the fetch and the judge dependency wraps it in a try/catch that could
  // swallow a throw and silently fall back — the same fail-closed proof as the unit test
  // above, now anchored to the REAL call site's own source text.
  const between = runTaskSrc.slice(callIdx, judgeDepIdx);
  assert.doesNotMatch(between, /\btry\s*\{/, "no try/catch may sit between the REST fetch and the judge wiring — a throw must propagate to assessRisk's own fail-closed catch");
});
