/**
 * `OpenPrView.reviewSummary` was hard-coded `undefined` at both producers in src/run-task.ts
 * (`buildOpenPrViews` and `fixCommand`), so the sweep could never quote the reviewer's own reason and
 * the rules in lib/sweep.ts that read it (`namesRule15Refusal`, `namesUnsatisfiableGate`) could never
 * fire. These tests pin the producer: the summary is the `failure_reason` of the latest `review.posted`
 * row for the PR's EXACT head, and a summary posted for an older head is ignored.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, namesRule15Refusal, namesUnsatisfiableGate, type OpenPrView } from "../src/lib/sweep.js";
import { reviewInputDigest } from "../src/lib/review.js";
import * as runTask from "./helpers/run-task-test.js";
import { ghShim } from "./helpers/gh-shim.js";

const TASK = "W1-T10600-FIXTURE";
const PR_NUMBER = 10600;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`;
const HEAD = "d".repeat(40);
const OLD_HEAD = "e".repeat(40);
const BODY = `Remudero-Task: ${TASK}`;
const RULE_15 =
  "remudero-review: FAIL — Standing rule 15: a criterion was added/edited beside non-plan files — file the shard in its own plan-only PR";
const RENUMBER = "remudero-review: FAIL — id W1-T7620 is reserved by scout-garden-1, not this PR — renumber";
const ENTANGLED = "remudero-review: FAIL — entangled: instrument path(s) scripts/x.mjs changed beside src/y.ts";

function reviewRow(headSha: string, summary: string, state = "failure"): Record<string, unknown> {
  return {
    step: "review.posted", task_id: TASK, pr_url: PR_URL, head_sha: headSha, state,
    review_input_digest: reviewInputDigest(headSha, BODY),
    unmet_criteria: [], reasons: [],
    ...(state === "failure" ? { failure_reason: summary } : {}),
    decision_verdict: { state, summary, criteria: [] },
  };
}

function fetchFor(headSha: string) {
  return (args: string[]): unknown => {
    const path = args.at(-1) ?? "";
    if (/state=open/.test(path)) {
      return [{ number: PR_NUMBER, html_url: PR_URL, head: { ref: `run-${TASK}-1`, sha: headSha },
        updated_at: "2026-10-10T05:00:00.000Z", body: BODY, auto_merge: null, state: "open" }];
    }
    if (/\/pulls\/\d+$/.test(path)) {
      return { number: PR_NUMBER, html_url: PR_URL, state: "open", body: BODY, updated_at: "2026-10-10T05:00:00.000Z",
        head: { ref: `run-${TASK}-1`, sha: headSha }, auto_merge: null, mergeable: true, mergeable_state: "clean" };
    }
    if (/check-runs/.test(path)) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
    if (/commits\/.+\/status/.test(path)) return { statuses: [{ context: "remudero-review", state: "failure" }] };
    return [];
  };
}

function viewFrom(rows: Record<string, unknown>[], headSha = HEAD): OpenPrView {
  const dir = mkdtempSync(join(tmpdir(), "rmd-review-summary-"));
  try {
    const ledgerPath = join(dir, "ledger.ndjson");
    writeFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const [view] = runTask.buildOpenPrViews("craigoley", "remudero", ledgerPath, {
      fetch: fetchFor(headSha),
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => ["ci-gate"],
      fetchCiFailureEvidence: () => [],
    });
    assert.ok(view, "the fake REST gateway produced the target PR");
    assert.equal(view.reviewState, "failure", "the fixture's review status is failing");
    return view;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the sweep's open-PR view carries the reviewer's own summary for the current head", () => {
  const view = viewFrom([reviewRow(HEAD, RENUMBER)]);
  assert.equal(view.reviewSummary, RENUMBER);
});

test("a review summary posted for an older head is not carried onto the current head's view", () => {
  const view = viewFrom([reviewRow(HEAD, RENUMBER), reviewRow(OLD_HEAD, RULE_15)]);
  assert.equal(view.reviewSummary, RENUMBER, "the newer row belongs to another head, so the exact-head row still wins");
  assert.equal(viewFrom([reviewRow(OLD_HEAD, RULE_15)]).reviewSummary, undefined);
});

test("a later passing review at the same head clears the carried review summary", () => {
  assert.equal(viewFrom([reviewRow(HEAD, RENUMBER), reviewRow(HEAD, "remudero-review: PASS", "success")]).reviewSummary, undefined);
});

test("a rule-15 refusal on the current head is named in the sweep's escalation reason", () => {
  const view = viewFrom([reviewRow(HEAD, RULE_15)]);
  assert.equal(namesRule15Refusal(view), true);
  const { disposition, reason } = deriveDisposition(view, DEFAULT_SWEEP_POLICY);
  assert.equal(disposition, "blocked-ambiguous");
  assert.match(reason, /Standing rule 15/);
  assert.doesNotMatch(reason, /contradictory/);
});

test("a rule-25 entanglement summary on the current head is seen as an unsatisfiable gate", () => {
  assert.equal(namesUnsatisfiableGate(viewFrom([reviewRow(HEAD, ENTANGLED)])), true);
});

test("rmd fix hands the router the reviewer's own summary for the current head", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fix-review-summary-"));
  const shim = ghShim([{ when: "", stdout: '{"contexts":[]}' }], { kind: "fix-review-summary-gh" });
  const oldPath = process.env.PATH;
  const oldError = console.error;
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.ndjson"),
      [reviewRow(HEAD, RENUMBER), reviewRow(OLD_HEAD, RULE_15)].map((row) => JSON.stringify(row)).join("\n") + "\n");
    process.env.PATH = `${shim.dir}:${oldPath}`;
    console.error = () => {};
    const routed: OpenPrView[] = [];
    await runTask.fixCommand([String(PR_NUMBER)], {
      config: { root, claudeBin: "/bin/true" } as Config,
      // The reviewer's sandbox checkout has no origin remote, so name the slug instead of reading it.
      self: { owner: "craigoley", repo: "remudero" },
      fetch: fetchFor(HEAD),
      route: async (_state, pr) => {
        routed.push(pr);
        return { outcome: "refused", reason: "fixture router" };
      },
    });
    assert.equal(routed.length, 1, "fixCommand reached the router");
    assert.equal(routed[0]!.reviewState, "failure");
    assert.equal(routed[0]!.reviewSummary, RENUMBER);
  } finally {
    console.error = oldError;
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});
