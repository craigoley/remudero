// W1-T5839 — a run-unfiled PR's review verdict is written and read under its own PR.
//
// The live shape (fleet ledger, 2026-10-05): plan-only PR #9305 on `run-unfiled-1791201175994`
// drew 16 `review.posted` success rows in 31 minutes. The review lane resolved the branch to the
// shared `unfiled` sentinel and wrote every row under it; the sweep classified the same PR a
// plan-only filing, keyed its exact-input read `PR-9305`, counted zero attempts, and the W1-T2860
// success-recovery row re-admitted the reviewer on every pass.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_RISK, type Plan, type Task } from "../src/lib/plan.js";
import { ownDiffDigestFromCompareFiles } from "../src/lib/open-prs-rest.js";
import type { Config } from "../src/lib/config.js";
import { armAutoMergeDetailed } from "../src/lib/arm-auto-merge.js";
import { parseAcceptanceBlock, priorReviewVerdictFromLedger, reviewContractDigest, reviewInputDigest, reviewLedgerKeyFor } from "../src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, reviewReuseVerdict } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildOpenPrViews, buildOpenPrViewsAsync, UNTASKED_REVIEW_BUDGET_USD, resolveReviewTaskId, reviewAttemptsForInput, reviewCommand, runReview } from "../src/run-task.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const HEAD_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
const OTHER_HEAD = "9307000000000000000000000000000000000000";
const BRANCH = "run-unfiled-1791201175994";
const PR = 9305;
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const OTHER_URL = "https://github.com/craigoley/remudero/pull/9307";
const BODY = ["## Acceptance", "- the shard is filed | grep: W1-T5839 in plan/tasks.d"].join("\n");
const DIGEST = reviewInputDigest(HEAD_SHA, BODY);
const NOW = Date.now();
const RECENT = new Date(NOW - 60 * 1000).toISOString();
const NEWER = new Date(NOW - 30 * 1000).toISOString();

function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}${label}-`));
}

function posted(taskId: string, prUrl: string | undefined, state: "success" | "failure", ts: string, head = HEAD_SHA) {
  return {
    ts,
    run_id: `review-PR${prUrl?.split("/").at(-1) ?? "legacy"}-${ts}`,
    task_id: taskId,
    step: "review.posted",
    lane: "review",
    state,
    head_sha: head,
    ...(prUrl === undefined ? {} : { pr_url: prUrl }),
    review_input_digest: prUrl === PR_URL ? DIGEST : "other-digest",
    capped: false,
    plan_only: true,
  };
}

function writeLedger(path: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("a run-unfiled PR's review key is PR-<n> whatever its plan-filing classification; a real id is unchanged", () => {
  for (const planOnlyFiling of [true, false]) {
    assert.equal(reviewLedgerKeyFor(resolveReviewTaskId(BODY, BRANCH, planOnlyFiling), PR), "PR-9305");
  }
  assert.equal(reviewLedgerKeyFor(resolveReviewTaskId("Remudero-Task: W1-T5839", BRANCH, false), PR), "W1-T5839");
  assert.equal(reviewLedgerKeyFor(resolveReviewTaskId("", "run-W1-T5839-1791203321909", false), PR), "W1-T5839");
  assert.equal(reviewLedgerKeyFor(resolveReviewTaskId("", "codex/manual-fix", false), PR), "PR-9305");
});

test("the review lane writes every row of a run-unfiled PR under PR-<n>, plan-only or not", async () => {
  for (const planOnlyFiling of [false, true, undefined]) {
    const root = tempRoot("unfiled-review-writer");
    const sentinel = "stop after the review identity is captured";
    let reviewedTaskId: string | undefined;
    try {
      await assert.rejects(
        () =>
          reviewCommand(String(PR), ["--repo", "craigoley/remudero"], {
            fetchView: () => ({
              body: BODY,
              html_url: PR_URL,
              head: { ref: BRANCH, sha: HEAD_SHA },
              updated_at: RECENT,
              number: PR,
            }),
            loadConfig: () => ({ root }) as Config,
            fetchHead: () => {},
            postReviewPending: async () => ({ posted: true }) as never,
            materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "fixture" } }) as never,
            runReview: (async (args: Parameters<typeof runReview>[0]) => {
              reviewedTaskId = args.task.id;
              throw new Error(sentinel);
            }) as never,
            ...(planOnlyFiling === undefined ? {} : { planOnlyFiling }),
          }),
        (error: Error) => error.message === sentinel,
      );
      assert.equal(reviewedTaskId, "PR-9305", `planOnlyFiling=${planOnlyFiling}`);
      const rows = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(rows.length > 0);
      assert.deepEqual([...new Set(rows.map((row) => row.task_id))], ["PR-9305"], `planOnlyFiling=${planOnlyFiling}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("priorReviewVerdictFromLedger given a PR url ignores another PR's newer row under the same key", () => {
  const lines = [posted("unfiled", PR_URL, "success", RECENT), posted("unfiled", OTHER_URL, "failure", NEWER, OTHER_HEAD)];
  for (const key of ["unfiled", "PR-9305"]) {
    const prior = priorReviewVerdictFromLedger(lines, key, PR_URL);
    assert.equal(prior?.state, "success", `key ${key}`);
    assert.equal(prior?.headSha, HEAD_SHA, `key ${key}`);
  }
  // A legacy row with no pr_url still counts under its key, newest wins as before.
  const legacy = [...lines, posted("PR-9305", undefined, "failure", NEWER)];
  assert.equal(priorReviewVerdictFromLedger(legacy, "PR-9305", PR_URL)?.state, "failure");
  // No url given: the pre-W1-T5839 key-only read, unchanged.
  assert.equal(priorReviewVerdictFromLedger(lines, "unfiled")?.state, "failure");
});

test("the exact-input attempt count finds a row written as unfiled when the sweep keys PR-<n>", () => {
  const lines = [posted("unfiled", PR_URL, "success", RECENT), posted("unfiled", OTHER_URL, "success", NEWER, OTHER_HEAD)];
  assert.equal(reviewAttemptsForInput(lines, "PR-9305", PR_URL, HEAD_SHA, DIGEST).attempts, 1);
  assert.equal(reviewAttemptsForInput(lines, "PR-9305", OTHER_URL, HEAD_SHA, DIGEST).attempts, 0);
});

function boardFetch(planFiles: boolean) {
  return (args: string[]): unknown => {
    const path = args.at(-1) ?? "";
    if (/pulls\?state=open/.test(path)) {
      return [{
        number: PR,
        html_url: PR_URL,
        head: { ref: BRANCH, sha: HEAD_SHA },
        updated_at: RECENT,
        created_at: RECENT,
        body: BODY,
        auto_merge: null,
        state: "open",
      }];
    }
    if (/check-runs/.test(path)) return { check_runs: [{ name: "ci-gate", status: "completed", conclusion: "success" }] };
    if (/commits\/.+\/status/.test(path)) {
      return { statuses: [{ context: "remudero-review", state: "success", created_at: RECENT }] };
    }
    if (new RegExp(`/pulls/${PR}/files`).test(path)) {
      return [{ filename: planFiles ? "plan/tasks.d/W1-T5839-x.yaml" : "src/run-task.ts", status: "modified" }];
    }
    if (new RegExp(`/pulls/${PR}$`).test(path)) return { mergeable: true, mergeable_state: "clean" };
    return [];
  };
}

function boardView(ledgerRows: Array<Record<string, unknown>>, planFiles: boolean) {
  const root = tempRoot("unfiled-review-board");
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    writeLedger(ledgerPath, ledgerRows);
    const [view] = buildOpenPrViews("craigoley", "remudero", ledgerPath, {
      fetch: boardFetch(planFiles),
      requiredContexts: () => ["ci-gate"],
      readCiGateRequired: () => ["ci-gate"],
      fetchCiFailureEvidence: () => [],
    });
    return view;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const RECOVERY_REASON = /no matching completed review\.posted evidence for this exact input/;

test("the live #9305 loop: a verdict written as unfiled is found by a sweep that reads the PR as a plan-only PR-<n>", () => {
  const emitterReceipt = { ts: RECENT, run_id: "filing", task_id: "RETRO", step: "pr.opened", pr_url: PR_URL, plan_only: true };
  const legacyRows = [emitterReceipt, posted("unfiled", PR_URL, "success", RECENT), posted("unfiled", OTHER_URL, "failure", NEWER, OTHER_HEAD)];
  const view = boardView(legacyRows, true);
  assert.equal(view.isPlanFiling, true, "the fixture is the live shape: the sweep classifies #9305 a plan-only filing");
  assert.equal(view.taskId, undefined);
  assert.ok((view.priorReviewAttemptsForInput ?? 0) >= 1, "the unfiled-stamped row counts for #9305's exact input");
  const disposition = deriveDisposition(view, DEFAULT_SWEEP_POLICY, NOW);
  assert.doesNotMatch(disposition.reason, RECOVERY_REASON, `re-admitted: ${disposition.disposition} ${disposition.reason}`);

  // After the fix the writer stamps PR-9305; the read finds it under either classification.
  const fixedRows = [emitterReceipt, posted("PR-9305", PR_URL, "success", RECENT)];
  for (const planFiles of [true, false]) {
    const rows = planFiles ? fixedRows : fixedRows.slice(1);
    const fixedView = boardView(rows, planFiles);
    assert.equal(fixedView.isPlanFiling, planFiles);
    assert.ok((fixedView.priorReviewAttemptsForInput ?? 0) >= 1, `planFiles=${planFiles}`);
    assert.doesNotMatch(deriveDisposition(fixedView, DEFAULT_SWEEP_POLICY, NOW).reason, RECOVERY_REASON);
  }
});

test("the arm gate reads the older run-unfiled PR's own verdict, not another PR's newer one", () => {
  const lines = [posted("unfiled", PR_URL, "success", RECENT), posted("unfiled", OTHER_URL, "failure", NEWER, OTHER_HEAD)];
  const said: string[] = [];
  let armed = 0;
  const result = armAutoMergeDetailed(PR_URL, "unfiled", {
    headSha: () => HEAD_SHA,
    ledgerLines: () => lines,
    armAuto: () => {
      armed++;
    },
    mergeDirect: () => assert.fail("auto-merge armed; no direct merge is needed"),
    disableAuto: () => {},
    say: (msg) => void said.push(msg),
  });
  assert.notEqual(result.outcome, "ledger-refused", said.join("\n"));
  assert.equal(armed, 1);
});

// W1-T5714: keep the sweep producer proofs with the existing unfiled-review integration suite.
{
  const PROOF = "unit test: test/an-unfiled-prs-review-contract-has-a-sweep-side-producer.test.ts";
  const PR = 5714;
  const URL = `https://github.com/craigoley/remudero/pull/${PR}`;
  const OLD = "a".repeat(40);
  const HEAD = "b".repeat(40);
  const BODY = "## Acceptance\n- the change works | grep: example in src/example.ts\n";
  const FILES = [{ filename: "src/example.ts", status: "modified", sha: "blob1" }];

  function fixture(options: {
    branch?: string;
    body?: string;
    reviewedBody?: string;
    task?: Task;
    semantic?: boolean;
    compare?: "throws" | "malformed" | "changed" | "moved-base";
    posted?: boolean;
  } = {}) {
    const root = mkdtempSync(join(tmpdir(), "rmd-unfiled-contract-"));
    const ledgerPath = join(root, "ledger.ndjson");
    const key = options.task?.id ?? "PR-5714";
    const reviewedContractDigest = reviewContractDigest({
      taskId: key,
      acceptance: options.task?.acceptance ?? parseAcceptanceBlock(options.reviewedBody ?? BODY),
      declaredFiles: options.task?.files,
      risk: options.task?.risk ?? (options.semantic ? DEFAULT_RISK : undefined),
      budgetUsd: options.task?.budget_usd ?? (options.semantic ? UNTASKED_REVIEW_BUDGET_USD : undefined),
    });
    const now = Date.now();
    const rows = options.posted === false ? [] : [{
      ts: new Date(now - 60_000).toISOString(), run_id: "review-old", task_id: key,
      step: "review.posted", state: "success", head_sha: OLD, pr_url: URL,
      own_diff_digest: ownDiffDigestFromCompareFiles(FILES), merge_base_sha: "base1",
      review_contract_digest: reviewedContractDigest, capped: false,
    }];
    writeFileSync(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const compares: string[] = [];
    const deps = {
      fetch: (args: string[]): unknown => {
        const path = args[args.length - 1];
        if (path.includes("pulls?state=open")) return [{
          number: PR, html_url: URL, head: { ref: options.branch ?? "run-unfiled-1", sha: HEAD },
          body: options.body ?? BODY, auto_merge: null, state: "open",
          created_at: new Date(now - 120_000).toISOString(), updated_at: new Date(now - 30_000).toISOString(),
        }];
        if (path.includes("check-runs")) return { check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] };
        if (path.endsWith("/status")) return { statuses: [] };
        if (path.includes(`/pulls/${PR}/files`)) return FILES;
        if (path.endsWith(`/pulls/${PR}`)) return { mergeable: true, mergeable_state: "clean" };
        if (path.includes("/compare/")) {
          compares.push(path);
          if (options.compare === "throws") throw new Error("compare denied for this head");
          if (options.compare === "malformed") return { files: FILES };
          return {
            merge_base_commit: { sha: options.compare === "moved-base" ? "base2" : "base1" },
            files: options.compare === "changed" ? [{ ...FILES[0], sha: "blob2" }] : FILES,
          };
        }
        assert.fail(`unexpected GitHub read: ${path}`);
      },
      requiredContexts: () => ["ci"],
      readCiGateRequired: () => ["ci"],
      readMainPlan: () => ({ tasks: options.task ? [options.task] : [], byId: new Map(options.task ? [[key, options.task]] : []) }) as Plan,
      fetchCiFailureEvidence: () => [],
    };
    return {
      ledgerPath, deps, compares, reviewedContractDigest, now,
      rows: () => readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row)),
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  test(PROOF, () => {
    for (const branch of ["run-unfiled-1", "manual-fix"]) {
      for (const semantic of [false, true]) {
        const f = fixture({ branch, semantic });
        try {
          const [view] = buildOpenPrViews("o", "r", f.ledgerPath, f.deps);
          assert.equal(view.currentContractDigest, f.reviewedContractDigest);
          assert.equal(view.reviewedContractDigest, f.reviewedContractDigest);
          assert.equal(view.reviewOrphanedByPush, true);
          assert.deepEqual(reviewReuseVerdict(view), { kind: "reuse", judgedHeadSha: OLD });
          assert.equal(deriveDisposition(view, DEFAULT_SWEEP_POLICY, f.now).disposition, "review-reused");
          assert.equal(f.compares.length, 1);
          assert.equal(f.rows().length, 1, "a successful hydration writes no failure row");
        } finally { f.cleanup(); }
      }
    }
  });

  test(`${PROOF}: failed hydration records one PR-specific reason and requires full review`, async () => {
    for (const compare of ["throws", "malformed"] as const) {
      for (const asyncRead of [false, true]) {
        const f = fixture({ compare });
        try {
          const [view] = asyncRead
            ? await buildOpenPrViewsAsync("o", "r", f.ledgerPath, { ...f.deps, fetchAsync: async (args) => f.deps.fetch(args) })
            : buildOpenPrViews("o", "r", f.ledgerPath, f.deps);
          assert.equal(view.currentOwnDiffDigest, undefined);
          assert.deepEqual(reviewReuseVerdict(view), { kind: "full-review" });
          const failures = f.rows().filter((row) => row.step === "sweep.review_reuse_unreadable");
          assert.equal(failures.length, 1);
          assert.equal(failures[0].pr_number, PR);
          assert.equal(failures[0].pr_url, URL);
          assert.equal(failures[0].head_sha, HEAD);
          assert.match(failures[0].reason, compare === "throws" ? /compare denied for this head/ : /merge_base_commit/);
          assert.equal(f.compares.length, 1);
        } finally { f.cleanup(); }
      }
    }
  });

  test(`${PROOF}: changed inputs stay full review, moved bases discriminate, and filed contracts remain authoritative`, () => {
    const task = {
      id: "W1-T5714", acceptance: [{ claim: "the filed contract", proof: "grep: filed in src/example.ts" }],
      files: ["src/example.ts"], risk: "medium", budget_usd: 6,
    } as Task;
    for (const options of [
      { body: BODY.replace("change works", "change differs"), semantic: true },
      { body: "## Summary\nno acceptance" },
      { compare: "changed" as const },
      { compare: "moved-base" as const },
      { task, body: `${BODY}\nRemudero-Task: ${task.id}` },
      { posted: false },
    ]) {
      const f = fixture(options);
      try {
        const [view] = buildOpenPrViews("o", "r", f.ledgerPath, f.deps);
        const expected = options.task ? "reuse" : options.compare === "moved-base" ? "discriminate-only" : "full-review";
        assert.equal(reviewReuseVerdict(view).kind, expected);
        if (options.task) assert.equal(view.currentContractDigest, f.reviewedContractDigest);
        if (options.body === "## Summary\nno acceptance") assert.equal(view.currentContractDigest, undefined);
        if (options.posted === false) assert.equal(f.compares.length, 0, "unreviewed PRs cost no compare");
        assert.equal(f.rows().filter((row) => row.step === "sweep.review_reuse_unreadable").length, 0);
      } finally { f.cleanup(); }
    }
  });
}
