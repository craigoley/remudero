import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import { reviewCommand, UNTASKED_REVIEW_BUDGET_USD } from "../src/run-task.js";
import { requiredSemanticDecisionDigest, requiredSemanticRefusal } from "../src/lib/required-semantic-review.js";
import { loadPlanAtRef } from "../src/lib/plan.js";
import { usesUntaskedReviewMetadata } from "../src/lib/tick-read-worker.js";

const REPO_ROOT = process.cwd();
const HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();

async function review(body: string, headRefName = "codex/not-a-run-branch") {
  const root = mkdtempSync(join(tmpdir(), "rmd-untasked-review-"));
  let captured: Record<string, any> | undefined;
  try {
    const deps = {
      fetchView: () => ({
        headRefOid: HEAD,
        headRefName,
        body,
        url: "https://github.com/craigoley/remudero/pull/5106",
        number: 5106,
      }),
      fetchHead: () => {},
      loadConfig: () => ({ root, installRoot: REPO_ROOT, claudeBin: "/bin/true" }) as Config,
      postReviewPending: async () => ({ posted: true }),
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }),
      runReview: async (args: Record<string, any>) => {
        captured = { ...args };
        return { state: "success", headSha: HEAD, reviewerOutcome: "not_attempted", criteria: [] };
      },
      executionMode: "semantic" as const,
    };
    const code = await reviewCommand(headRefName, ["--repo", "craigoley/remudero"], deps as never);
    if (code === 0) assert.ok(captured, "an admitted review command must reach runReview");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const ledger = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
    return { args: captured as Record<string, any>, ledger, code };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("an untrailered PR with no derivable task id still spawns the semantic reviewer under a default risk and budget", async () => {
  const { args, ledger } = await review("## Acceptance\n- it works | grep: review in src/lib/review.ts\n");

  assert.equal(args.task.id, "PR-5106");
  assert.equal(args.spawnReviewer, true, "an untasked PR must still be reviewed semantically");
  assert.equal(args.task.risk, "medium");
  assert.equal(args.task.budget_usd, UNTASKED_REVIEW_BUDGET_USD);
  assert.equal(args.budgetUsd, UNTASKED_REVIEW_BUDGET_USD);
  assert.ok(args.reviewerMount, "a reviewer mount must be resolved for the default risk");
  assert.ok(ledger.some((r) => r.step === "review.reviewer.untasked_defaults" && r.task_id === "PR-5106"));
  assert.ok(!ledger.some((r) => r.step === "review.reviewer.skipped"), "no skip row for an untasked PR");
});

test("a derived task id whose shard is missing refuses semantic review before any verdict", async () => {
  const { args, ledger, code } = await review("## Acceptance\n- x | grep: review in src/lib/review.ts\n\nRemudero-Task: W1-T999999");

  assert.equal(code, 2);
  assert.equal(args, undefined);
  const skips = ledger.filter((r) => r.step === "review.reviewer.skipped");
  assert.deepEqual(skips.map((r) => r.reason), ["head-task-metadata-unavailable"]);
});

test("a resolved shard without budget_usd runs the semantic reviewer under the default review cap, visibly", async () => {
  // Budget is optional in a shard (builds default it); 182 of 523 queued shards had none on 2026-10-20, and each
  // review of such a PR was refused after #12954 instead of reviewed. Pick one at HEAD rather than pin an id.
  const shard = [...loadPlanAtRef(REPO_ROOT, "plan/tasks.yaml", HEAD).byId.values()]
    .find((t) => t.budget_usd === undefined && (t.acceptance?.length ?? 0) > 0);
  assert.ok(shard, "the plan at HEAD must hold a shard with acceptance and no budget_usd for this case to measure anything");
  const { args, ledger, code } = await review(`Remudero-Task: ${shard.id}`);

  assert.equal(code, 0, "a shard that resolved must be reviewed, not refused");
  assert.equal(args.task.id, shard.id);
  assert.equal(args.spawnReviewer, true);
  assert.equal(args.requireSemanticReview, true, "the defaults change the cap, never the required-semantic policy");
  assert.equal(args.budgetUsd, UNTASKED_REVIEW_BUDGET_USD);
  assert.equal(args.task.risk, shard.risk);
  assert.ok(args.reviewerMount);
  const defaults = ledger.filter((r) => r.step === "review.reviewer.metadata_defaults");
  assert.deepEqual(defaults.map((r) => [r.task, r.missing, r.task_risk, r.hard_cap_usd]),
    [[shard.id, ["budget_usd"], shard.risk, UNTASKED_REVIEW_BUDGET_USD]]);
  assert.ok(!ledger.some((r) => r.step === "review.reviewer.skipped" || r.step === "review.semantic_setup_refused"));
});

const unfiledHead = "run-unfiled-1791211800000";

test("generated triage and main-repair ids receive required semantic review without fictional plan shards", async () => {
  for (const id of ["TRIAGE-evidence-coverage-inbox-response-served-model", "main-repair-ratchet-105b1219ee15"]) {
    const { args, ledger, code } = await review(`## Acceptance\n- x | grep: review in src/lib/review.ts\n\nRemudero-Task: ${id}`, `run-${id}-1791211800000`);
    assert.equal(code, 0, id);
    assert.equal(args.task.id, id, "retain the generated identity for attribution");
    assert.equal(args.spawnReviewer, true);
    assert.equal(args.requireSemanticReview, true);
    assert.equal(args.task.risk, "medium");
    assert.equal(args.budgetUsd, UNTASKED_REVIEW_BUDGET_USD);
    assert.ok(args.reviewerMount);
    assert.equal(ledger.filter(row => row.step === "review.reviewer.untasked_defaults").length, 1);
    assert.ok(!ledger.some(row => row.step === "review.semantic_setup_refused"));
  }
});

test("generated review defaults require the exact generated branch and never cover missing filed task records", () => {
  for (const id of ["RETRO", "RETRO-1", "TRIAGE-feedback", "PLAN-repair", "APPROVE-feedback", "main-repair-105b1219ee15", "main-repair-revert-105b1219ee15"]) {
    assert.equal(usesUntaskedReviewMetadata(id, `run-${id}-1791211800000`), true, id);
    assert.equal(usesUntaskedReviewMetadata(id, "codex/foreign"), false, id);
    assert.equal(usesUntaskedReviewMetadata(id, `run-${id}-other-1791211800000`), false, id);
  }
  for (const id of ["W1-T999999", "main-repair-ratchet-not-a-sha", "unknown-lane"]) {
    assert.equal(usesUntaskedReviewMetadata(id, `run-${id}-1791211800000`), false, id);
  }
});

test("a canonical unfiled run receives bounded semantic review under its own PR identity", async () => {
  const { args, ledger } = await review("## Acceptance\n- x | grep: review in src/lib/review.ts\n", unfiledHead);
  assert.equal(args.task.id, "PR-5106");
  assert.equal(args.spawnReviewer, true);
  assert.equal(args.task.risk, "medium");
  assert.equal(args.budgetUsd, UNTASKED_REVIEW_BUDGET_USD);
  assert.ok(args.reviewerMount);
  assert.equal(ledger.filter((row) => row.step === "review.reviewer.untasked_defaults").length, 1);
  assert.ok(!ledger.some((row) => row.step === "review.reviewer.skipped"));
});

test("an explicit missing plan task on an unfiled branch remains a metadata refusal", async () => {
  const { args, ledger, code } = await review("Remudero-Task: W1-T999999", unfiledHead);
  assert.equal(code, 2);
  assert.equal(args, undefined);
  assert.ok(!ledger.some((row) => row.step === "review.reviewer.untasked_defaults"));
  assert.equal(ledger.find((row) => row.step === "review.reviewer.skipped")?.reason, "head-task-metadata-unavailable");
});

test("explicit semantic setup failure refuses before pending status, materialization and automatic merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-semantic-setup-refusal-"));
  const effects: string[] = [];
  try {
    const code = await reviewCommand("fixture-branch", ["--execution-mode", "semantic"], {
      resolveOwnerRepo: () => ({ owner: "acme", repo: "fixture" }),
      fetchView: () => ({ headRefOid: HEAD, headRefName: "topic", body: "## Acceptance\n- x | grep: fixed in src/x.ts\n", url: "https://github.com/acme/fixture/pull/1", number: 1 }),
      loadConfig: () => ({ root, installRoot: join(root, "missing-install"), claudeBin: "/bin/true" }) as Config,
      fetchHead: () => {},
      postReviewPending: async () => { effects.push("pending"); return { posted: true }; },
      materialize: () => { effects.push("materialize"); throw new Error("must not materialize"); },
      runReview: async () => { effects.push("review-and-auto-arm"); throw new Error("must not judge or auto-arm"); },
    } as never);
    assert.equal(code, 2);
    assert.deepEqual(effects, []);
    const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(rows.find(r => r.step === "review.semantic_setup_refused")?.reason, "semantic-setup-unavailable");
    assert.ok(!rows.some(r => r.step === "review.posted" || r.step === "automerge.armed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("required semantic review refuses unavailable or incomplete outcomes rather than accepting the floor", () => {
  for (const outcome of ["not_attempted", "spawn_error", "signal_terminated", "error_max_turns", "error_max_budget_usd", "unknown"]) {
    assert.equal(requiredSemanticRefusal({ required: true, planOnly: false, outcome, criteriaCount: 1, verdicts: [true] }), `required-semantic-${outcome}`);
  }
  for (const verdicts of [undefined, [], [undefined], [true, true]]) {
    assert.equal(requiredSemanticRefusal({ required: true, planOnly: false, outcome: "success", criteriaCount: 1, verdicts }), "required-semantic-incomplete-verdicts");
  }
  assert.equal(requiredSemanticRefusal({ required: true, planOnly: false, outcome: "success", criteriaCount: 0, verdicts: [] }), "required-semantic-incomplete-verdicts");
});

test("required semantic completion preserves negative findings and existing deterministic and plan-only policies", () => {
  for (const verdicts of [[true], [false]]) assert.equal(requiredSemanticRefusal({ required: true, planOnly: false, outcome: "success", criteriaCount: 1, verdicts }), undefined);
  assert.equal(requiredSemanticRefusal({ required: false, planOnly: false, outcome: "not_attempted", criteriaCount: 1, verdicts: undefined }), undefined);
  assert.equal(requiredSemanticRefusal({ required: true, planOnly: true, outcome: "not_attempted_plan_only", criteriaCount: 1, verdicts: undefined }), undefined);
});

test("required semantic decision identity cannot replay an advisory-only terminal and is deterministic", () => {
  const digest = "v2:" + "a".repeat(64);
  assert.equal(requiredSemanticDecisionDigest(digest, false), digest);
  assert.notEqual(requiredSemanticDecisionDigest(digest, true), digest);
  assert.equal(requiredSemanticDecisionDigest(digest, true), requiredSemanticDecisionDigest(digest, true));
  assert.notEqual(requiredSemanticDecisionDigest(digest, true), requiredSemanticDecisionDigest(digest + "b", true));
});
