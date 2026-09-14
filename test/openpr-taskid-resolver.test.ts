import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenPrViews } from "../src/run-task.js";
import { taskIdFromRunBranch } from "../src/lib/status.js";

/**
 * W1-T453: `buildOpenPrViews` resolved a PR's task id from the `Remudero-Task:` body
 * trailer ALONE, so a fleet-built PR sitting on its own dispatched `run-<taskId>-<epochMs>`
 * branch (`worktreeAdd`'s naming) with no trailer could never arm auto-merge and always
 * reported `criteriaRecoverable: false`, even after a passing review (PR #1722, observed
 * six times). These tests drive the real producer end-to-end (`buildOpenPrViews`, not a
 * hand-built `OpenPrView` fixture) so a regression that unwires the resolver again fails a
 * population check, not a fabricated field — the same discipline `review-orphan-wiring.test.ts`
 * uses for the analogous producer gap.
 */

function ledgerPath(dir: string): string {
  return join(dir, "ledger.ndjson");
}

function writeLedger(path: string, lines: Array<Record<string, unknown>>): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
}

/** One open PR in the REST list shape `fetchOpenPrsRest`/`mapRestPr` expects. */
function restPr(over: {
  number: number;
  headRefName: string;
  body: string;
}): Record<string, unknown> {
  return {
    number: over.number,
    html_url: `https://github.com/craigoley/remudero/pull/${over.number}`,
    head: { ref: over.headRefName, sha: `${"a".repeat(39)}${over.number}` },
    updated_at: "2026-08-13T18:00:00.000Z",
    body: over.body,
    auto_merge: null,
    state: "open",
  };
}

/** A `fetch` stub good for a single-PR sweep: list + best-effort merge-state/checks reads. */
function fetchFor(prs: Array<Record<string, unknown>>): (args: string[]) => unknown {
  return (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) return prs;
    return []; // merge-state / check-run / combined-status lookups — none needed here
  };
}

/**
 * A `fetch` stub that additionally answers the `GET /pulls/:n/files` read
 * (`prFilesRestArgs`, lib/open-prs-rest.ts) `hydratePlanFilingFiles` issues for any PR with no
 * `pr.opened{plan_only:true}` emitter receipt — the read `classifyPlanFiling`'s `github-files`
 * arm and its `unreadable` arm both depend on, and the plain `fetchFor` above never exercises.
 */
function fetchWithFiles(
  prs: Array<Record<string, unknown>>,
  files: Map<number, unknown>,
): (args: string[]) => unknown {
  return (args: string[]): unknown => {
    const path = args[args.length - 1] ?? "";
    if (/state=open/.test(path)) return prs;
    const fileMatch = /\/pulls\/(\d+)\/files/.exec(path);
    if (fileMatch) {
      const number = Number(fileMatch[1]);
      return files.has(number) ? files.get(number) : [];
    }
    return []; // merge-state / check-run / combined-status lookups — none needed here
  };
}

test("a PR whose head is a run branch and whose body carries no trailer resolves its task id", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-openpr-taskid-"));
  const lp = ledgerPath(dir);
  writeLedger(lp, []);

  const prs = [restPr({ number: 1722, headRefName: "run-W1-T451-1786622432602", body: "no trailer here" })];
  const views = buildOpenPrViews("craigoley", "remudero", lp, { fetch: fetchFor(prs), requiredContexts: () => [] });

  assert.equal(views.length, 1);
  assert.equal(views[0].taskId, "W1-T451", "the run branch's own id resolves with no trailer to lean on");
  assert.equal(views[0].criteriaRecoverable, true, "a resolved id makes the criteria recoverable again");
});

test("a PR whose body carries a trailer keeps resolving from the trailer when the two disagree", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-openpr-taskid-"));
  const lp = ledgerPath(dir);
  writeLedger(lp, []);

  // Dispatched from a W1-T900 worktree, but its PR body explicitly claims W1-T901 — a worker
  // that opened a PR for one task from a worktree cut for another. The trailer is the author's
  // deliberate statement and must win over the branch name `worktreeAdd` merely minted.
  const prs = [
    restPr({ number: 42, headRefName: "run-W1-T900-1786600000000", body: "Remudero-Task: W1-T901\n" }),
  ];
  const views = buildOpenPrViews("craigoley", "remudero", lp, { fetch: fetchFor(prs), requiredContexts: () => [] });

  assert.equal(views.length, 1);
  assert.equal(views[0].taskId, "W1-T901", "the trailer wins on disagreement, never the head ref");
});

test("a plan-only filing PR on a run branch does not resolve a task id it would credit", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-openpr-taskid-"));
  const lp = ledgerPath(dir);
  const prUrl = "https://github.com/craigoley/remudero/pull/900";
  // The emitter's own positive record: a plan-filing flow (retro/triage/`rmd plan`) verified its
  // diff is plan-only and logged it BEFORE this PR was ever a sweep input — exactly the shape
  // `run-task.ts`'s `log("pr.opened", { pr_url, plan_only: true, ... })` call sites write.
  writeLedger(lp, [{ step: "pr.opened", pr_url: prUrl, plan_only: true }]);

  // Dispatched from W1-T500's own worktree (so its branch is that task's run branch), but the
  // PR it opened files a NEW task and carries no trailer — the #1527 shape. Falling back to the
  // head ref unconditionally would credit W1-T500 as implemented by a plan-only diff.
  const prs = [restPr({ number: 900, headRefName: "run-W1-T500-1786600000000", body: "no trailer — a filing PR" })];
  const views = buildOpenPrViews("craigoley", "remudero", lp, { fetch: fetchFor(prs), requiredContexts: () => [] });

  assert.equal(views.length, 1);
  assert.equal(views[0].taskId, undefined, "a plan-only filing PR must never resolve the dispatched task's id");
  assert.equal(views[0].criteriaRecoverable, false, "no id resolved ⇒ criteria stay unrecoverable, not silently credited");
});

/**
 * W1-T3505 criterion 1: PR #5340's exact shape — an EXTERNALLY filed plan-only PR with no
 * `pr.opened{plan_only:true}` emitter receipt (this host never ran the filing), dispatched from
 * an existing task's own run branch, with no `Remudero-Task:` trailer. `buildOpenPrViews`
 * classifies its complete GitHub file list as plan-only (`classifyPlanFiling`'s `github-files`
 * arm) and must withhold the run branch's task id exactly like an emitter-ledger hit does — not
 * only stamp `isPlanFiling: true` while `resolveOpenPrTaskId` still credits the branch.
 */
test("W1-T3505 criterion 1: GitHub-files plan-only filing resolves no task id", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-openpr-taskid-"));
  const lp = ledgerPath(dir);
  writeLedger(lp, []); // no emitter receipt — this host never ran the filing

  const prs = [restPr({ number: 5340, headRefName: "run-W1-T500-1786600000000", body: "no trailer — a filing PR" })];
  const files = new Map<number, unknown>([
    [5340, [{ filename: "plan/tasks.d/W1-T999-some-new-task.yaml" }, { filename: "plan/tasks.yaml" }]],
  ]);
  const views = buildOpenPrViews("craigoley", "remudero", lp, {
    fetch: fetchWithFiles(prs, files),
    requiredContexts: () => [],
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].isPlanFiling, true, "the complete plan-scoped file list classifies this PR as a filing");
  assert.equal(views[0].planFilingSource, "github-files", "classified via the GitHub file-list read, not the emitter ledger");
  assert.equal(views[0].taskId, undefined, "a github-files-classified filing must not resolve the dispatched task's id");
  assert.equal(
    views[0].criteriaRecoverable,
    false,
    "no id resolved ⇒ the filing cannot be recovered as W1-T500's implementation",
  );
});

/**
 * W1-T3505 criterion 2: a genuine (non-plan) implementation PR on a run branch, with no trailer,
 * whose complete GitHub file list touches ordinary source — `classifyPlanFiling` returns
 * `isPlanFiling: false, source: "not-plan-only"`. The threaded classification must not suppress
 * the run-branch fallback for this population; only a POSITIVE filing classification withholds it.
 */
test("W1-T3505 criterion 2: non-plan implementation resolves the run branch task id", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-openpr-taskid-"));
  const lp = ledgerPath(dir);
  writeLedger(lp, []); // no emitter receipt

  const prs = [restPr({ number: 5341, headRefName: "run-W1-T500-1786600000000", body: "no trailer here" })];
  const files = new Map<number, unknown>([[5341, [{ filename: "src/run-task.ts" }]]]);
  const views = buildOpenPrViews("craigoley", "remudero", lp, {
    fetch: fetchWithFiles(prs, files),
    requiredContexts: () => [],
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].isPlanFiling, false, "a source-touching diff is not classified as a plan filing");
  assert.equal(views[0].planFilingSource, "not-plan-only");
  assert.equal(views[0].taskId, "W1-T500", "the run branch's own id still resolves through the fallback");
  assert.equal(views[0].criteriaRecoverable, true, "a resolved id keeps criteria recoverable for a real implementation");
});

/**
 * W1-T3505 criterion 3: the GitHub file-list read is unreadable (malformed response), so
 * `classifyPlanFiling` returns `source: "unreadable"`. An unreadable observation is NOT proof of
 * a filing and must not manufacture one, but it must also not suppress the existing branch task
 * identity — the pre-existing, non-filing resolution for this population is unchanged.
 */
test("W1-T3505 criterion 3: unreadable file observation keeps the branch task id", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-openpr-taskid-"));
  const lp = ledgerPath(dir);
  writeLedger(lp, []); // no emitter receipt

  const prs = [restPr({ number: 5342, headRefName: "run-W1-T500-1786600000000", body: "no trailer here" })];
  const files = new Map<number, unknown>([[5342, { not: "an array" }]]); // malformed ⇒ "unreadable"
  const views = buildOpenPrViews("craigoley", "remudero", lp, {
    fetch: fetchWithFiles(prs, files),
    requiredContexts: () => [],
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].isPlanFiling, false, "an unreadable observation is not proof of a filing");
  assert.equal(views[0].planFilingSource, "unreadable");
  assert.equal(views[0].taskId, "W1-T500", "the branch task id survives an unreadable file observation");
  assert.equal(views[0].criteriaRecoverable, true);
});

test("taskIdFromRunBranch: the lifted extractor matches the exact shape it replaces in projectPlan", () => {
  assert.equal(taskIdFromRunBranch("run-W1-T453-1786654962673"), "W1-T453");
  assert.equal(taskIdFromRunBranch("run-W1-T453-1786654962673"), taskIdFromRunBranch("run-W1-T453-1786654962673"));
  assert.equal(taskIdFromRunBranch("feat/some-branch"), undefined, "a non-run branch resolves nothing");
  assert.equal(taskIdFromRunBranch(undefined), undefined, "an absent head ref resolves nothing");
});
