import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_RISK, type Plan, type Task } from "../src/lib/plan.js";
import { ownDiffDigestFromCompareFiles } from "../src/lib/open-prs-rest.js";
import { parseAcceptanceBlock, reviewContractDigest } from "../src/lib/review.js";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, reviewReuseVerdict } from "../src/lib/sweep.js";
import { buildOpenPrViews, buildOpenPrViewsAsync, UNTASKED_REVIEW_BUDGET_USD } from "../src/run-task.js";

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
