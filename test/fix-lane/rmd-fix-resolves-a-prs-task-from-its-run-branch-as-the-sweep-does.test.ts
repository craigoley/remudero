// W1-T12702: `rmd fix` read a PR's task only from a body trailer, so it refused #18449 and #18427 as
// "criteria unrecoverable" on 2026-11-14 while the sweep repaired both from their run branches. The verb now
// resolves the task with the sweep's own resolveReviewTaskId and plan-filing classification.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixCommand, routeFix } from "#test/helpers/run-task-test.js";
import type { Config } from "#src/lib/config.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { classifyPlanFiling, resolveReviewTaskId } from "#src/lib/tick-read-worker.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const SHA = "2".repeat(40);
// Relative to the wall clock, never a fixed date: the router closes a PR idle >= staleDays (14d) as
// abandoned, so a literal 2026-11-14 stamp turned every case into that refusal on 2026-11-28.
const STAMP = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const PR = 18449;
const PR_URL = `https://github.com/fixture/fix-task/pull/${PR}`;
const UNRECOVERABLE = "criteria unrecoverable (no Remudero-Task: trailer to resolve them from)";

interface Case {
  body: string;
  head: string;
  /** The PR's changed paths, as GitHub's files endpoint lists them. */
  files?: string[];
  /** Write the emitter's own plan-only filing row for this PR. */
  emitterFiling?: boolean;
  /** Review rows for these tasks, each with one unmet criterion. */
  reviewed?: string[];
}

interface Observed {
  code: number;
  view: OpenPrView;
  rows: Array<Record<string, unknown>>;
  dispatched: boolean;
  filesRead: number;
}

async function observe(t: TestContext, c: Case): Promise<Observed> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t12702-`));
  mkdirSync(join(root, "state"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const seed = [
    ...(c.reviewed ?? []).map((task) => ({ ts: STAMP, run_id: "REVIEW-1", task_id: task, step: "review.posted", pr_url: PR_URL,
      state: "failure", unmet_criteria: [`${task} claim`], reasons: [`${task} reason`] })),
    ...(c.emitterFiling ? [{ ts: STAMP, run_id: "RETRO-1", task_id: "RETRO", step: "pr.opened", pr_url: PR_URL, plan_only: true }] : []),
  ];
  writeFileSync(ledgerPath, seed.map((row) => JSON.stringify(row) + "\n").join(""));
  const shim = ghShim([
    { when: "required_status_checks", stdout: JSON.stringify({ contexts: ["remudero-review"] }) },
    { when: "", exit: 1 },
  ], { kind: "t12702-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  let view: OpenPrView | undefined;
  let dispatched = false;
  let filesRead = 0;
  const [log, error] = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  let code: number;
  try {
    code = await fixCommand([String(PR)], {
      config: { root, claudeBin: "/bin/true" } as Config,
      self: { owner: "fixture", repo: "fix-task" },
      contributorAdmission: async () => {},
      fetch: (args) => {
        if (args[1] === `repos/fixture/fix-task/pulls/${PR}`) return {
          number: PR, html_url: PR_URL, state: "open", merged: false, title: "a run branch PR", body: c.body,
          updated_at: STAMP, head: { ref: c.head, sha: SHA }, auto_merge: null,
        };
        if (args[1] === `repos/fixture/fix-task/pulls/${PR}/files?per_page=100`) {
          filesRead += 1;
          return (c.files ?? []).map((filename) => ({ filename }));
        }
        if (args[1]?.includes("/check-runs?")) return { check_runs: [] };
        if (args[1] === `repos/fixture/fix-task/commits/${SHA}/status`) return {
          statuses: [{ context: "remudero-review", state: "failure", created_at: STAMP }],
        };
        assert.fail(`unrouted REST read: ${args.join(" ")}`);
      },
      // The real router; only the dispatch is held, so no worker starts.
      route: (state, pr, deps, policy) => {
        view = pr;
        return routeFix(state, pr, { ...deps, dispatchFix: () => { dispatched = true; return false; },
          escalate: () => assert.fail("no escalation in these fixtures") }, policy);
      },
    });
  } finally {
    [console.log, console.error] = [log, error];
  }
  assert.ok(view, "the verb reached its router");
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => String(r.run_id).startsWith("FIX-"));
  return { code, view, rows, dispatched, filesRead };
}

const refusal = (o: Observed) => o.rows.find((r) => r.step === "fix.refused")?.reason;

test("W1-T12702 criterion 1: a trailerless PR on run-W1-T<n>-<ms> resolves W1-T<n> with its unmet criteria", async (t) => {
  const o = await observe(t, { body: "Repairs the board read.\n", head: "run-W1-T12544-1794625576000",
    files: ["src/lib/a.ts"], reviewed: ["W1-T12544"] });
  assert.equal(o.view.taskId, "W1-T12544");
  assert.equal(o.view.criteriaRecoverable, true);
  assert.deepEqual(o.view.unmetCriteria.map((c) => c.claim), ["W1-T12544 claim"]);
  assert.ok(o.dispatched, "the router reached the dispatch");
  assert.ok(!String(refusal(o)).includes(UNRECOVERABLE), `refused as ${String(refusal(o))}`);
});

test("W1-T12702 criterion 2: the verb's task id is the one resolveReviewTaskId returns", async (t) => {
  const cases: Array<Case & { name: string; emitter: boolean }> = [
    { name: "a body trailer wins over the branch", body: "Remudero-Task: W1-T12550\n", head: "run-W1-T12544-1794625576000",
      files: ["src/lib/a.ts"], emitter: false },
    { name: "a run branch only", body: "no trailer\n", head: "run-W1-T12550-1794620837000", files: ["src/lib/a.ts"], emitter: false },
    { name: "a plan-only filing on a run branch", body: "no trailer\n", head: "run-W1-T12550-1794620837000",
      files: ["plan/tasks.d/W1-T12999-a-filed-task.yaml"], emitter: false },
    { name: "neither", body: "no trailer\n", head: "fix/some-branch", files: ["src/lib/a.ts"], emitter: false },
  ];
  const seen: Array<string | undefined> = [];
  for (const c of cases) {
    await t.test(c.name, async (child) => {
      const o = await observe(child, c);
      const files = { state: "complete" as const, paths: c.files ?? [], cache: "miss" as const };
      const expected = resolveReviewTaskId(c.body, c.head, classifyPlanFiling(c.emitter, files).isPlanFiling);
      assert.equal(o.view.taskId, expected);
      seen.push(o.view.taskId);
    });
  }
  assert.deepEqual(seen, ["W1-T12550", "W1-T12550", undefined, undefined]);
});

test("W1-T12702 criterion 3: a plan-only filing on a run branch resolves no task and is refused", async (t) => {
  for (const c of [
    { name: "the emitter's plan-only row", body: "no trailer\n", head: "run-W1-T12550-1794620837000", emitterFiling: true,
      reviewed: ["W1-T12550"] },
    { name: "changed paths all in plan scope", body: "no trailer\n", head: "run-W1-T12550-1794620837000",
      files: ["plan/tasks.d/W1-T12999-a-filed-task.yaml"], reviewed: ["W1-T12550"] },
  ] satisfies Array<Case & { name: string }>) {
    await t.test(c.name, async (child) => {
      const o = await observe(child, c);
      assert.equal(o.view.taskId, undefined);
      assert.equal(o.view.criteriaRecoverable, false);
      assert.equal(o.code, 1);
      assert.ok(String(refusal(o)).includes(UNRECOVERABLE), `refused as ${String(refusal(o))}`);
      assert.equal(o.dispatched, false);
      if (c.emitterFiling) assert.equal(o.filesRead, 0, "the emitter row answers without a files read");
    });
  }
});

test("W1-T12702 criterion 4: no trailer and a branch that names no task is still refused", async (t) => {
  const o = await observe(t, { body: "no trailer\n", head: "fix/some-branch", files: ["src/lib/a.ts"], reviewed: ["W1-T12550"] });
  assert.equal(o.view.taskId, undefined);
  assert.equal(o.view.criteriaRecoverable, false);
  assert.equal(o.code, 1);
  assert.ok(String(refusal(o)).includes(UNRECOVERABLE), `refused as ${String(refusal(o))}`);
  assert.equal(o.dispatched, false);
});
