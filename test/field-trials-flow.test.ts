/**
 * W1-T4574 — FIELD TRIALS FROM OUR OWN FLOW. The audited three-form ledger union joined with each
 * repository's GitHub history into five observational families, and the consent-checked release
 * that is the only way any of it leaves the host. Fixtures only: temp ledgers, a fake page seam,
 * never the live ledger or the network.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  buildFieldTrialsFlowSnapshot, buildFieldTrialsRelease, fieldTrialsCommand, kaplanMeierQuantile, parseFieldTrialsConsent,
  parseReleaseManifest, periodOf, projectFlowRow, PR_URL_RE, readFieldTrialsLedger, recordRelease, revokeRelease,
  revokeWithdrawnConsent, SAFE_LABEL_RE, SAFE_MODEL_RE, suppressCell, unavailableLedger,
  type FieldTrialsConsent, type FieldTrialsFlowSnapshot, type FieldTrialsLedgerRead, type FieldTrialsSource, type ReleaseCell,
} from "../src/lib/field-trials-flow.js";
import { emptyRepoStore, pullOf, type FieldTrialsGithubStore, type GithubPage, type PullDetail } from "../src/lib/field-trials-github.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";
import { writeLedger } from "./helpers/ledger-fixture.js";

const T = (day: number, hour = 0) => new Date(Date.UTC(2026, 8, day, hour)).toISOString();

function row(step: string, task: string | null, run: string | null, ts: string, extra: Record<string, unknown> = {}) {
  return { ts, step, host: "host-alpha", actor: "daemon", ...(task ? { task_id: task } : {}), ...(run ? { run_id: run } : {}), ...extra };
}

function assign(task: string, run: string, id: string, ts: string, opts: { requested?: string; selected?: string; host?: string; taskClass?: string } = {}) {
  return row("worker.assignment", task, run, ts, { host: opts.host ?? "host-alpha",
    worker_assignment: { id, requested: { model: opts.requested ?? "model-a" }, selected: { provider: "p", model: opts.selected ?? "model-a" } },
    benchmark_run: { work: { taskClass: { state: "observed", value: opts.taskClass ?? "implement" } } } });
}

/** A whole task that reached a PR: dispatch, assignment, a worker call, the PR and a posted review. */
function taskRows(task: string, day: number, repo: string, prNumber: number, opts: { taskClass?: string; selected?: string } = {}) {
  const run = `${task}-run-1`;
  return [row("run.start", task, run, T(day, 1)), assign(task, run, `${task}-asg`, T(day, 2), opts),
    row("verdict", task, run, T(day, 3), { selection_assignment_id: `${task}-asg`, success: true, served_model: opts.selected ?? "model-a" }),
    row("pr.opened", task, run, T(day, 4), { pr_url: `https://github.com/${repo}/pull/${prNumber}` }),
    row("review.posted", task, run, T(day, 5))];
}

function flowReadOf(rows: Record<string, unknown>[]): FieldTrialsLedgerRead {
  return { state: "observed", reason: null, forms: { gzip: 0, plain: 0, live: 1 }, malformedRows: 0, duplicateRows: 0, futureRows: 0, unreadSources: 0,
    newestTs: null, rows: rows.map((value, index) => projectFlowRow(value, `fp-${index}-${JSON.stringify(value).length}`)) };
}

type RawPull = Record<string, unknown>;

function rawPull(number: number, opts: { task?: string; branch?: string; created?: string; merged?: string | null; mergeSha?: string;
  open?: boolean; updated?: string; body?: string } = {}): RawPull {
  const merged = opts.merged ?? null;
  return { node_id: `PR_node_${number}`, number, state: opts.open ? "open" : "closed", created_at: opts.created ?? T(1, 6),
    updated_at: opts.updated ?? merged ?? T(1, 7), merged_at: merged, closed_at: opts.open ? null : merged ?? T(1, 7),
    merge_commit_sha: opts.mergeSha ?? `merge-sha-${number}`, head: { ref: opts.branch ?? `feature/${number}`, sha: `head-sha-${number}` },
    body: opts.body ?? (opts.task ? `Summary\n\nRemudero-Task: ${opts.task}\n` : ""), user: { login: "remudero-fleet[bot]", type: "Bot" } };
}

function detail(extra: Partial<PullDetail> = {}): PullDetail {
  return { state: "observed", readAt: T(1), readWhileOpen: false,
    reviews: { total: 1, human: 0, changesRequested: 0, approvals: 1, truncated: false },
    commits: { count: 1, firstSha: "first", lastCommittedAt: T(1, 5), truncated: false },
    checks: { sha: "first", state: "none", distinctChecks: 0, reruns: 0 }, ...extra };
}

function repoStore(pulls: RawPull[], opts: { commits?: Record<string, string>; deployments?: { id: number; sha: string; createdAt: string; at: string }[];
  details?: Record<number, PullDetail>; pullsState?: "complete" | "partial" } = {}) {
  const store = emptyRepoStore();
  for (const raw of pulls) {
    const pull = pullOf(raw)!;
    pull.detail = opts.details?.[pull.number] ?? detail();
    store.pulls[pull.nodeId] = pull;
  }
  store.commits = opts.commits ?? {};
  for (const deployment of opts.deployments ?? []) {
    store.deployments[String(deployment.id)] = { id: deployment.id, sha: deployment.sha, createdAt: deployment.createdAt,
      status: { state: "success", at: deployment.at } };
  }
  for (const cursor of Object.values(store.cursors)) Object.assign(cursor, { state: opts.pullsState ?? "complete", asOf: T(1) });
  return store;
}

function sumStage(snapshot: FieldTrialsFlowSnapshot, label: string, stage: string) {
  const out = { denominator: 0, reached: 0, missingJoin: 0, censored: 0, humanTouched: 0, missingReasons: {} as Record<string, number> };
  for (const [key, partition] of Object.entries(snapshot.families.funnel)) {
    if (!key.startsWith(`${label}|`)) continue;
    const cell = partition.cells.stages[stage]!;
    for (const field of ["denominator", "reached", "missingJoin", "censored", "humanTouched"] as const) out[field] += cell[field];
    for (const [reason, n] of Object.entries(cell.missingReasons)) out.missingReasons[reason] = (out.missingReasons[reason] ?? 0) + n;
  }
  return out;
}

function sumOf<C>(partitions: Record<string, { cells: C }>, label: string, read: (cells: C) => number) {
  return Object.entries(partitions).filter(([key]) => key.startsWith(`${label}|`)).reduce((sum, [, partition]) => sum + read(partition.cells), 0);
}

function pageFake(routes: Record<string, unknown[]>, failing: (path: string) => boolean = () => false) {
  return async (path: string): Promise<GithubPage> => {
    if (failing(path)) return { ok: false, reason: "github-read-failed" };
    const items = routes[path.split("?")[0]!] ?? [];
    return { ok: true, items: /[?&]page=1(?:&|$)/.test(path) || !path.includes("page=") ? items : [] };
  };
}

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}field-trials-${name}-`));
}

test("field trials regexes admit only safe labels, model names and GitHub PR URLs", () => {
  assert.equal(SAFE_LABEL_RE.test("implement"), true);
  assert.equal(SAFE_LABEL_RE.test("W1-T4574"), false);
  assert.equal(SAFE_MODEL_RE.test("claude-opus-5.5"), true);
  assert.equal(SAFE_MODEL_RE.test("model with spaces"), false);
  assert.equal(PR_URL_RE.test("https://github.com/acme/core/pull/12"), true);
  assert.equal(PR_URL_RE.test("https://example.com/acme/core/pull/12"), false);
  assert.equal(periodOf("2026-09-06T23:00:00.000Z"), "2026-08-31", "a Sunday belongs to the week that began on Monday");
  assert.equal(periodOf("2026-09-07T00:00:00.000Z"), "2026-09-07");
  assert.equal(periodOf(null), "unknown");
  assert.equal(kaplanMeierQuantile([{ ms: 10, observed: true }, { ms: 20, observed: false }, { ms: 30, observed: true }], 0.5), 30,
    "a censored unit leaves the risk set without counting as an event");
  assert.equal(kaplanMeierQuantile([{ ms: 5, observed: false }], 0.5), null, "all-censored work never reaches a median");
  assert.equal(projectFlowRow({ step: "fix.dispatch", task_id: "T", pr_number: 7 }, "f").prNumber, 7);
});

test("private Field Trials counts assignment class, risk, lane and effective stack pin coverage", () => {
  const observedValue = (value: string) => ({ state: "observed", value });
  const assignment = { step: "worker.assignment", ts: T(10), task_id: "W1-T4900", run_id: "W1-T4900-run",
    worker_assignment: { id: "assignment-1", requested: { model: "sonnet" },
      selected: { model: "claude-sonnet-5-5" } },
    benchmark_run: { work: { taskClass: observedValue("docs"), risk: observedValue("low"),
      shape: { lane: observedValue("fix") } }, stack: { harnessRevision: observedValue("a".repeat(40)),
      promptRevision: { state: "unavailable", reason: "not-pinned" } } } };
  const source: FieldTrialsSource = { label: "core", repo: "acme/core", ledger: flowReadOf([assignment]) };
  const snapshot = buildFieldTrialsFlowSnapshot({ asOf: T(10), sources: [source],
    github: { version: "field-trials-github-v1", repos: { "acme/core": emptyRepoStore() } } });
  assert.deepEqual(snapshot.assignmentTelemetry, [{ source: "core", selectedModel: "claude-sonnet-5-5", assignments: 1,
    taskClass: 1, risk: 1, workLane: 1, harnessPinned: 1, promptPinned: 0, toolPinned: 0,
    scorerPinned: 0, environmentPinned: 0, attemptReceipts: 0, nonStarterAssignments: 1,
    costMissingAssignments: 1, apiCostEstimateUsd: 0, subscriptionNotionalUsd: 0 }]);
});

test("private Field Trials joins terminal cost by assignment and separates API estimates from subscription notional cost", () => {
  const assignment = (id: string) => ({ step: "worker.assignment", ts: T(10), task_id: `W1-${id}`,
    worker_assignment: { id, selected: { model: "claude-sonnet-5-5" } } });
  const rows = [assignment("api"), assignment("subscription"), assignment("without-attempt"),
    { step: "worker.activity", ts: T(10, 1), selection_assignment_id: "api", total_cost_usd: 900 },
    { step: "worker.attempt", ts: T(10, 1), selection_assignment_id: "api", cost_usd: 0.5, billing_mode: "api" },
    { step: "worker.attempt", ts: T(10, 2), selection_assignment_id: "api", total_cost_usd: 0.25, billing_mode: "api" },
    { step: "worker.attempt", ts: T(10, 3), selection_assignment_id: "subscription", total_cost_usd: 0.75,
      billing_mode: "subscription" }];
  const snapshot = buildFieldTrialsFlowSnapshot({ asOf: T(11),
    sources: [{ label: "core", repo: "acme/core", ledger: flowReadOf(rows) }],
    github: { version: "field-trials-github-v1", repos: { "acme/core": emptyRepoStore() } } });
  assert.deepEqual(snapshot.assignmentTelemetry.map(({ assignments, attemptReceipts, nonStarterAssignments,
    costMissingAssignments, apiCostEstimateUsd, subscriptionNotionalUsd }) => ({ assignments, attemptReceipts,
    nonStarterAssignments, costMissingAssignments, apiCostEstimateUsd, subscriptionNotionalUsd })),
  [{ assignments: 3, attemptReceipts: 2, nonStarterAssignments: 1, costMissingAssignments: 1,
    apiCostEstimateUsd: 0.25, subscriptionNotionalUsd: 0.75 }]);
  assert.equal(projectFlowRow(rows[4]!, "legacy-cost").costUsd, 0.5,
    "a legacy terminal cost remains readable, while the newer attempt wins the assignment join");
});

test("field trials join three repo ledger and GitHub histories with explicit missingness", async () => {
  const root = tempDir("join");
  try {
    const core = writeLedger([
      ...taskRows("T3-core-task", 3, "acme/core", 13),
      row("run.start", "T4-core-task", "T4-core-task-run-1", T(3, 5)),
      assign("T4-core-task", "T4-core-task-run-1", "T4-asg", T(3, 6)),
    ], { dir: join(root, "core"), rotations: [
      { at: "2026-09-01T12:00:00.000Z", gz: true, rows: taskRows("T1-core-task", 1, "acme/core", 11) },
      { at: "2026-09-02T12:00:00.000Z", rows: [...taskRows("T2-core-task", 2, "acme/core", 12), row("run.start", "T1-core-task", "T1-core-task-run-1", T(1, 1))] },
    ] });
    const plain = readdirSync(core.dir).find((name) => name.endsWith(".ndjson") && name !== "ledger.ndjson")!;
    appendFileSync(join(core.dir, plain), "{not json\n");
    const site = writeLedger(taskRows("S1-site-task", 2, "acme/site", 21), { dir: join(root, "site") });
    const fetch = pageFake({
      "repos/acme/core/pulls": [
        rawPull(11, { task: "T1-core-task", branch: "run-T1-core-task-111", merged: T(1, 8) }),
        rawPull(12, { branch: "fix/unrelated", open: true }),
        rawPull(14, { task: "T4-core-task", branch: "run-T5-core-task-1", open: true }),
        rawPull(15, { branch: "docs/readme" }),
        rawPull(16, { branch: "run-T9-core-task-1", merged: T(2, 8) }),
      ],
      "repos/acme/site/pulls": [rawPull(21, { task: "S1-site-task", merged: T(2, 9) })],
    }, (path) => path.startsWith("repos/acme/console/"));
    const out: string[] = [];
    const code = await fieldTrialsCommand(["--source", "core=acme/core", "--source", "site=acme/site", "--source", "console=acme/console",
      "--ledger", `core=${core.dir}`, "--ledger", `site=${site.dir}`, "--out-dir", join(root, "out"), "--json"],
    buildFieldTrialsFlowSnapshot, { nowIso: T(10), fetch, print: (line) => out.push(line), resolveConfig: () => ({ root }) });
    assert.equal(code, 0, "a partial join is still a successful, explicitly partial snapshot");
    const printed = JSON.parse(out[0]!);
    assert.equal(printed.github.state, "partial");
    assert.equal(printed.manifest.lastRefresh.state, "withheld", "no consent file means no release, and says so");
    const snapshot = JSON.parse(readFileSync(join(root, "out", "field-trials-flow-v1.json"), "utf8")) as FieldTrialsFlowSnapshot;
    const [coreSource, siteSource, consoleSource] = snapshot.provenance.sources;
    assert.deepEqual(coreSource!.ledger.forms, { gzip: 1, plain: 1, live: 1 }, "every ledger form was opened");
    assert.equal(coreSource!.ledger.duplicateRows, 1, "an exact replayed row is counted once and named");
    assert.deepEqual([coreSource!.ledger.state, coreSource!.ledger.malformedRows], ["observed-partial", 1]);
    assert.deepEqual([siteSource!.ledger.state, siteSource!.ledger.forms], ["observed", { gzip: 0, plain: 0, live: 1 }]);
    assert.deepEqual([consoleSource!.ledger.state, consoleSource!.ledger.reason], ["unavailable", "ledger-not-provided-on-this-host"]);
    assert.equal(coreSource!.github.pulls!.state, "complete");
    assert.equal(coreSource!.github.pulls!.pagesRead, 1);
    assert.equal(coreSource!.github.pulls!.asOf, T(10));
    assert.deepEqual([consoleSource!.github.pulls!.state, consoleSource!.github.pulls!.reason], ["unavailable", "github-read-failed"]);
    assert.equal(snapshot.state, "observed-partial");
    assert.deepEqual(snapshot.reasons, ["core:ledger:ledger-source-malformed", "console:ledger:ledger-not-provided-on-this-host",
      "console:github:github-read-failed"]);
    const { unmatchedPrs, ambiguousPrs, ...links } = snapshot.links;
    assert.deepEqual(links, { prs: 6, matched: 4, ambiguous: 1, unmatched: 1, byPath: { trailer: 3, branch: 3, ledger: 3, multiplePaths: 2 },
      ledgerPrNotInGithub: 1, githubOnlyTasks: 1 });
    assert.deepEqual(unmatchedPrs, [{ source: "core", number: 15 }]);
    assert.deepEqual(ambiguousPrs, [{ source: "core", number: 14, tasks: ["T4-core-task", "T5-core-task"] }]);
    const pr = sumStage(snapshot, "core", "pr");
    assert.deepEqual([pr.denominator, pr.reached, pr.missingJoin, pr.censored, pr.missingReasons], [4, 2, 1, 1, { "ledger-pr-not-in-github": 1 }],
      "a ledger PR GitHub never returned is a missing join, and a task still in flight is censored, never a task without a PR");
    assert.equal(sumStage(snapshot, "site", "merge").reached, 1);
    assert.equal(Object.keys(snapshot.families.funnel).some((key) => key.startsWith("console|")), false, "no ledger, no invented tasks");
    assert.equal(sumOf(snapshot.families.repair, "core", (cells) => cells.mergedPrs), 2, "every merged PR is a repair unit, linked or not");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function deployScenario(opts: { pullsState?: "complete" | "partial" } = {}) {
  const core: FieldTrialsSource = { label: "core", repo: "acme/core", ledger: flowReadOf([
    ...taskRows("T1-deployed", 1, "acme/core", 31), ...taskRows("T2-awaiting-boot", 1, "acme/core", 32),
    ...taskRows("T3-still-open", 1, "acme/core", 33), ...taskRows("T4-closed-unmerged", 1, "acme/core", 34),
    row("daemon.boot", null, null, T(3), { head_sha: "boot-head-sha" }),
  ]) };
  const site: FieldTrialsSource = { label: "site", repo: "acme/site", ledger: flowReadOf(taskRows("T5-site-task", 1, "acme/site", 41)) };
  const consoleSource: FieldTrialsSource = { label: "console", repo: "acme/console", ledger: flowReadOf(taskRows("T6-console-task", 1, "acme/console", 51)) };
  const github: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: {
    "acme/core": repoStore([
      rawPull(31, { task: "T1-deployed", merged: T(2) }), rawPull(32, { task: "T2-awaiting-boot", merged: T(4), mergeSha: "late-merge" }),
      rawPull(33, { task: "T3-still-open", open: true }), rawPull(34, { task: "T4-closed-unmerged" }),
      rawPull(35, { merged: T(5), body: "Reverts acme/core#32" }),
    ], { commits: { "merge-sha-31": T(2), "boot-head-sha": T(2, 12), "late-merge": T(4), "merge-sha-35": T(5) },
      details: { 31: detail({ checks: { sha: "first", state: "green", distinctChecks: 3, reruns: 1 } }) }, pullsState: opts.pullsState }),
    "acme/site": repoStore([rawPull(41, { task: "T5-site-task", merged: T(2) })],
      { commits: { "merge-sha-41": T(2), "deployed-sha": T(2, 6) }, deployments: [{ id: 1, sha: "deployed-sha", createdAt: T(3), at: T(3, 6) }] }),
    "acme/console": repoStore([rawPull(51, { task: "T6-console-task", merged: T(2) })], { commits: { "merge-sha-51": T(2) } }),
  } };
  return { sources: [core, site, consoleSource], github };
}

function caseFileFor(taskId: string, runId: string, assignmentId: string, prNumber: number, asOf: string): TaskCaseFile {
  const observed = <V>(value: V) => ({ state: "observed" as const, value, source: "fixture", asOf });
  const gate = observed({ headSha: `head-sha-${prNumber}`, status: "success" as const });
  return { version: "task-case-file-v1", taskId, asOf,
    plan: observed({ title: "t", dependsOn: [], verify: "auto", risk: "low" }) as TaskCaseFile["plan"],
    ledger: observed({ windowStart: T(1), forms: { gzip: 0, plain: 0, live: 1 }, matchingRows: 1 }),
    runs: [{ runId, startedAt: T(1, 1), assignmentId, selectedProvider: "p", selectedModel: "model-a", servedModel: "model-a",
      billingMode: null, costUsd: null, verdict: "merged", prNumber }],
    pr: observed({ number: prNumber, url: "u", headSha: `head-sha-${prNumber}`, state: "MERGED" as const, taskCredit: true }),
    review: gate, acceptance: gate, ci: gate, mergedSource: observed({ prNumber, mergedAt: T(2) }),
    deployment: { state: "unavailable", reason: "fixture", source: "fixture", asOf }, runtime: { state: "unavailable", reason: "fixture", source: "fixture", asOf },
    next: null };
}

test("field trials distinguish merge deployment verification and censored work", () => {
  const { sources, github } = deployScenario();
  const snapshot = buildFieldTrialsFlowSnapshot({ asOf: T(10), sources, github });
  const merge = sumStage(snapshot, "core", "merge");
  assert.deepEqual([merge.denominator, merge.reached, merge.censored], [4, 2, 1], "an open PR is censored at merge, a closed one is not");
  const coreDeploy = sumStage(snapshot, "core", "deployment");
  assert.deepEqual([coreDeploy.denominator, coreDeploy.reached, coreDeploy.censored], [2, 1, 1],
    "a merge after the last boot is awaiting deployment, never deployed");
  assert.equal(sumStage(snapshot, "site", "deployment").reached, 1, "a successful GitHub deployment at or after the merge commit");
  assert.deepEqual(sumStage(snapshot, "console", "deployment").missingReasons, { "no-deployment-evidence": 1 },
    "a merge with no deployment source is a missing join, not a deployment");
  for (const label of ["core", "site", "console"]) {
    const verified = sumStage(snapshot, label, "verified");
    assert.equal(verified.reached, 0, `${label}: a merge, a green check or a deployment never awards verification`);
    assert.equal(verified.missingReasons["no-case-file-snapshot"], verified.denominator);
  }
  const repair = Object.entries(snapshot.families.repair).filter(([key]) => key.startsWith("core|")).map(([, partition]) => partition.cells);
  const bucket = (name: string) => repair.reduce((sum, cells) => sum + cells.correctness[name as keyof typeof cells.correctness], 0);
  assert.equal(repair.reduce((sum, cells) => sum + (cells.firstPass.green ?? 0), 0), 1);
  assert.deepEqual([bucket("adverse-signal"), bucket("window-immature"), bucket("no-adverse-signal-in-window"), bucket("unknown")], [1, 2, 0, 0],
    "a green first pass inside the follow-up window is immature, never correct; the reverted merge is adverse");
  assert.equal(sumOf(snapshot.families.repair, "core", (cells) => cells.reverted), 1);
  const toMerge = Object.values(snapshot.families.flow).filter((_, index) => Object.keys(snapshot.families.flow)[index]!.startsWith("core|"))
    .map((partition) => partition.cells.toMerge);
  assert.deepEqual([toMerge[0]!.observed, toMerge[0]!.censored, toMerge[0]!.excluded], [2, 1, { stopped: 1 }],
    "open work is censored at the cutoff; a closed PR is a competing outcome, not a slow merge");
  assert.equal(toMerge[0]!.p50Ms, 71 * 3_600_000, "Kaplan-Meier median: 23h and 71h merges, one open PR censored at 215h");
  const commitToDeploy = Object.values(snapshot.families.flow).find((_, index) => Object.keys(snapshot.families.flow)[index]!.startsWith("core|"))!.cells.commitToDeploy;
  assert.deepEqual([commitToDeploy.observed, commitToDeploy.censored], [1, 1], "DORA commit-to-deploy lead time is its own distribution");

  const late = buildFieldTrialsFlowSnapshot({ asOf: T(30), sources, github: deployScenario({ pullsState: "partial" }).github });
  assert.equal(sumOf(late.families.repair, "core", (cells) => cells.correctness.unknown), 2,
    "with the revert scan incomplete a mature merge is unknown, never assumed correct");
  const mature = buildFieldTrialsFlowSnapshot({ asOf: T(30), sources, github });
  assert.equal(sumOf(mature.families.repair, "core", (cells) => cells.correctness["no-adverse-signal-in-window"]), 2);

  const verified = buildFieldTrialsFlowSnapshot({ asOf: T(10), sources, github,
    caseFiles: [caseFileFor("T1-deployed", "T1-deployed-run-1", "T1-deployed-asg", 31, T(10))] });
  const joined = sumStage(verified, "core", "verified");
  assert.deepEqual([joined.reached, joined.missingReasons], [1, { "case-file-missing": 1 }], "only the case-file join verifies a task");
});

test("field trials adoption separates source merge from served model exposure", () => {
  const rows = [
    row("daemon.boot", null, null, T(1), { head_sha: "boot-with-model-b" }),
    row("daemon.boot", null, null, T(1), { host: "host-gamma", head_sha: "unknown-head" }),
    assign("TA-adopt-1", "TA-adopt-1-run", "asg-1", T(2), { requested: "model-a", selected: "model-b" }),
    row("worker.attempt", "TA-adopt-1", "TA-adopt-1-run", T(2, 3), { selection_assignment_id: "asg-1", success: true, served_model: "model-c" }),
    assign("TA-adopt-2", "TA-adopt-2-run", "asg-2", T(3), { requested: "model-b", selected: "model-b" }),
    row("worker.attempt", "TA-adopt-2", "TA-adopt-2-run", T(4), { selection_assignment_id: "asg-2", success: true, served_model: "model-b" }),
    assign("TA-adopt-3", "TA-adopt-3-run", "asg-3", T(3, 5), { selected: "model-b" }),
    row("worker.attempt", "TA-adopt-3", "TA-adopt-3-run", T(3, 6), { selection_assignment_id: "asg-3", success: false }),
    assign("TA-adopt-4", "TA-adopt-4-run", "asg-4", T(3, 7), { selected: "model-b", host: "host-beta" }),
    assign("TA-adopt-5", "TA-adopt-5-run", "asg-5", T(3, 8), { selected: "model-b", host: "host-gamma" }),
  ];
  const github: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: { "acme/core": repoStore([], { commits: { "boot-with-model-b": T(0, 20) } }) } };
  const snapshot = buildFieldTrialsFlowSnapshot({ asOf: T(10), sources: [{ label: "core", repo: "acme/core", ledger: flowReadOf(rows) }], github });
  const entry = (host: string, model: string) => snapshot.families.transitions.find((item) => item.host === host && item.model === model)!;
  const b = entry("host-alpha", "model-b");
  assert.equal(b.sourceMerge.state === "observed" && b.sourceMerge.at, T(0, 20), "source merge: when the booted head was committed");
  assert.equal(b.runtimeBoot.state === "observed" && b.runtimeBoot.at, T(1), "runtime boot: when this instance started running it");
  assert.equal(b.firstRequestedAt, T(3));
  assert.equal(b.firstSelectedAt, T(2), "first selection");
  assert.equal(b.firstServedAt, T(4), "first served exposure is later than first selection: the first call was served another model");
  assert.equal(b.servedOtherwise, 1, "a fallback is counted, not hidden");
  const c = entry("host-alpha", "model-c");
  assert.deepEqual([c.firstSelectedAt, c.firstServedAt, c.runtimeBoot], [null, T(2, 3), { state: "unavailable", reason: "never-selected" }]);
  assert.deepEqual(entry("host-beta", "model-b").runtimeBoot, { state: "unavailable", reason: "no-boot-before-first-selection" });
  assert.deepEqual(entry("host-gamma", "model-b").sourceMerge, { state: "unavailable", reason: "boot-head-not-in-commit-history" });
  const cells = Object.entries(snapshot.families.adoption).filter(([key]) => key.startsWith("core|host-alpha|")).map(([, partition]) => partition.cells);
  const total = (field: "requested" | "selected" | "served" | "servedUnavailable", key: string) => cells.reduce((sum, cell) => sum + (cell[field][key] ?? 0), 0);
  assert.deepEqual([total("requested", "model-a"), total("selected", "model-b"), total("served", "model-b"), total("served", "model-c")], [2, 3, 1, 1],
    "requested, selected and served are three separate tallies");
  assert.equal(total("servedUnavailable", "not-recorded"), 1, "a call with no served model is unavailable, never the selected one");
  assert.equal(sumOf(snapshot.families.adoption, "core|host-beta", (cell) => cell.servedUnavailable["no-attempt"] ?? 0), 1);
  assert.deepEqual([snapshot.observational, snapshot.causalClaims], [true, "none"]);
  assert.equal(JSON.stringify(snapshot.families).includes("effect"), false, "no family carries an effect estimate");
});

function releaseScenario(extraTaskClass?: string) {
  const rows = [
    ...[1, 2, 3, 4, 5, 6].flatMap((n) => taskRows(`T${n}-release-task`, 1, "acme/core", 60 + n)),
    ...taskRows("task-leak-7", 1, "acme/core", 70, { taskClass: extraTaskClass ?? "docs" }),
    row("daemon.boot", null, null, T(5), { head_sha: "release-boot-sha" }),
  ];
  const pulls = [1, 2, 3, 4, 5, 6].map((n) => rawPull(60 + n, { task: `T${n}-release-task`, merged: n <= 2 ? T(2) : null, open: n > 2 }));
  return buildFieldTrialsFlowSnapshot({ asOf: T(10), github: { version: "field-trials-github-v1", repos: {
    "acme/core": repoStore(pulls, { commits: { "merge-sha-61": T(2), "merge-sha-62": T(2), "release-boot-sha": T(4) } }),
  } }, sources: [{ label: "core", repo: "acme/core", ledger: flowReadOf(rows) },
    { label: "site", repo: "acme/site", ledger: flowReadOf(taskRows("S1-site-private", 1, "acme/site", 80)) },
    { label: "console", repo: "acme/console", ledger: unavailableLedger("ledger-not-provided-on-this-host") }] });
}

const CONSENT: FieldTrialsConsent = { version: "field-trials-consent-v1", repos: [
  { repo: "acme/core", rights: "aggregate-opt-in", receipt: "receipt-core-2026-09", publicSourceUrl: "https://github.com/acme/core" },
  { repo: "acme/site", rights: "private", receipt: "receipt-site" },
] };

test("field trials release manifest suppresses private join keys and unsafe cells", () => {
  const snapshot = releaseScenario();
  const result = buildFieldTrialsRelease(snapshot, CONSENT, "salt-one");
  assert.equal(result.state, "candidate");
  if (result.state !== "candidate") return;
  const release = result.release;
  const encoded = JSON.stringify({ ...release, sources: release.sources.map((source) => ({ ...source, publicSourceUrl: null })) });
  for (const key of snapshot.privateKeys) assert.equal(encoded.includes(key), false, `private join key leaked: ${key}`);
  for (const key of ["acme/site", "host-alpha", "T1-release-task", "PR_node_61", "receipt-core-2026-09"]) {
    assert.equal(encoded.includes(key), false, `private value leaked: ${key}`);
  }
  assert.equal(release.sources.length, 1, "only a repository with live aggregate consent contributes");
  assert.deepEqual(release.withheld, [{ reason: "no-aggregate-consent", sources: 2 }]);
  assert.equal(release.links, null, "link totals mix withheld sources, so they are not released");
  assert.equal(release.sources[0]!.publicSourceUrl, "https://github.com/acme/core");
  assert.deepEqual([release.status, release.observational, release.causalClaims], ["candidate-unreviewed", true, "none"]);
  const funnel = release.cells.filter((cell) => cell.family === "funnel");
  const small = funnel.find((cell) => cell.stratum.taskClass === "docs")!;
  assert.deepEqual([small.n, small.counts["eligible.reached"], small.suppressed], [null, null, ["cell:small-n"]], "a one-task cell is withheld whole");
  const big = funnel.find((cell) => cell.stratum.taskClass === "implement")!;
  assert.deepEqual([big.n, big.counts["eligible.reached"], big.counts["merge.reached"]], [6, 6, null], "a count below the floor is withheld");
  assert.ok(big.suppressed.includes("merge.reached"));
  assert.equal(Object.keys(big.counts).some((key) => key.endsWith(".denominator")), false,
    "a stage denominator is the previous stage's reached count, so releasing it would reveal a withheld one");
  assert.equal(release.funnelStageFollows.merge, "pr");
  assert.ok(release.disclosure.suppressedCells >= 1 && release.disclosure.suppressedValues >= 2);
  assert.ok(release.cells.every((cell) => cell.source.startsWith("src-")), "sources are pseudonyms");
  const rotated = buildFieldTrialsRelease(snapshot, CONSENT, "salt-two");
  assert.notEqual(rotated.state === "candidate" && rotated.release.sources[0]!.source, release.sources[0]!.source, "rotating the salt rotates pseudonyms");

  const leaking = releaseScenario("task-leak-7");
  assert.deepEqual(buildFieldTrialsRelease(leaking, CONSENT, "salt-one"), { state: "refused", reason: "private-join-key-in-release" },
    "a private key that slips past the allowlists refuses the whole release");
  assert.deepEqual(buildFieldTrialsRelease(snapshot, null, "s"), { state: "withheld", reason: "no-consent-receipt" });
  assert.deepEqual(buildFieldTrialsRelease(snapshot, parseFieldTrialsConsent({ version: "x" }), "s"), { state: "withheld", reason: "consent-invalid" });
  assert.equal(parseFieldTrialsConsent({ version: "field-trials-consent-v1", repos: [{ repo: "a/b", rights: "everything", receipt: "r" }] }), "consent-invalid");
  assert.deepEqual(buildFieldTrialsRelease(snapshot, { version: "field-trials-consent-v1", repos: [{ ...CONSENT.repos[0]!, revoked: true }] }, "s"),
    { state: "withheld", reason: "no-aggregate-consent" });
  assert.deepEqual(buildFieldTrialsRelease({ ...snapshot, state: "unavailable" }, CONSENT, "s"), { state: "refused", reason: "snapshot-unavailable" });

  const cell: ReleaseCell = { family: "f", source: "s", stratum: {}, n: 20, counts: { a: 3, b: 7, c: 10, d: 0 }, measures: {}, reasons: [], suppressed: [] };
  assert.deepEqual(suppressCell(cell, [["a", "b", "c", "d"], ["d"]]), { values: 2, complementary: 1 });
  assert.deepEqual(cell.counts, { a: null, b: null, c: 10, d: 0 }, "the smallest remaining member of the sum is withheld too");
  const lone: ReleaseCell = { ...cell, n: 9, counts: { a: 4, z: 0 }, suppressed: [] };
  assert.deepEqual(suppressCell(lone, [["a", "z"]]), { values: 1, complementary: 0 }, "nothing left to withhold beside a lone member");

  const manifest = parseReleaseManifest(null);
  const entry = (releaseId: string, createdAt: string) => ({ releaseId, asOf: createdAt, createdAt, file: `releases/${releaseId}.json`,
    sha256: "x", consentReceipts: result.consentReceipts, status: "candidate-unreviewed" as const });
  recordRelease(manifest, entry("first", T(10)));
  recordRelease(manifest, entry("second", T(11)));
  assert.deepEqual(manifest.releases.map((item) => item.status), ["superseded", "candidate-unreviewed"]);
  assert.deepEqual(manifest.lastKnownGood, { releaseId: "second", asOf: T(11) });
  assert.deepEqual(revokeWithdrawnConsent(manifest, CONSENT, T(12)), [], "a live consent revokes nothing");
  assert.deepEqual(revokeWithdrawnConsent(manifest, { ...CONSENT, repos: [{ ...CONSENT.repos[0]!, revoked: true }] }, T(12)),
    ["releases/first.json", "releases/second.json"], "withdrawn consent withdraws every release it covered");
  assert.deepEqual([manifest.releases[1]!.status, manifest.releases[1]!.revokeReason, manifest.lastKnownGood], ["revoked", "consent-withdrawn", null]);
  assert.equal(revokeRelease(manifest, "first", T(13), "again"), null, "a revoked release cannot be revoked twice");
  assert.deepEqual(revokeWithdrawnConsent(parseReleaseManifest({ version: "field-trials-release-manifest-v1", releases: [entry("third", T(9))],
    lastKnownGood: null, lastRefresh: null }), null, T(12)), ["releases/third.json"]);
});

function replayScenario(late: boolean) {
  const rows = [
    ...taskRows("P1-week-one-a", 1, "acme/core", 91), ...taskRows("P1-week-one-b", 1, "acme/core", 92),
    row("daemon.boot", null, null, T(1, 20), { head_sha: "week-one-boot" }),
    ...taskRows("P2-week-two", 8, "acme/core", 93),
    ...(late ? [row("fix.dispatch", "P2-week-two", "P2-week-two-run-2", T(9), { pr_number: 93 })] : []),
  ];
  const pulls = [rawPull(91, { task: "P1-week-one-a", created: T(1, 6), merged: T(1, 10) }), rawPull(92, { task: "P1-week-one-b", created: T(1, 6), merged: T(1, 11) }),
    late ? rawPull(93, { task: "P2-week-two", created: T(8, 6), merged: T(9, 2), updated: T(9, 2) }) : rawPull(93, { task: "P2-week-two", created: T(8, 6), open: true })];
  return { sources: [{ label: "core", repo: "acme/core", ledger: flowReadOf(rows) }], github: { version: "field-trials-github-v1" as const, repos: {
    "acme/core": repoStore(pulls, { commits: { "merge-sha-91": T(1, 10), "merge-sha-92": T(1, 11), "week-one-boot": T(1, 12), "merge-sha-93": T(9, 2) } }) } } };
}

test("field trials replay late evidence without blocking work", async () => {
  const first = buildFieldTrialsFlowSnapshot({ asOf: T(20), ...replayScenario(false) });
  const replayed = buildFieldTrialsFlowSnapshot({ asOf: T(30), ...replayScenario(true), prior: first });
  assert.ok(replayed.rebuild.rebuiltPartitions.length > 0);
  assert.ok(replayed.rebuild.rebuiltPartitions.every((key) => !key.includes("2026-08-31") && !key.includes("2026-09-01")),
    `a late page and a ledger repair rebuild only the week they touch: ${replayed.rebuild.rebuiltPartitions.join(", ")}`);
  assert.ok(replayed.rebuild.rebuiltPartitions.some((key) => key.startsWith("funnel:core|2026-09-07")));
  assert.ok(replayed.rebuild.reusedPartitions >= 4, "the untouched week is reused verbatim");
  assert.equal(sumStage(replayed, "core", "merge").reached, 3, "the late merge is now counted");
  const again = buildFieldTrialsFlowSnapshot({ asOf: T(30), ...replayScenario(true), prior: replayed });
  assert.deepEqual(again.rebuild.rebuiltPartitions, [], "an identical replay is idempotent");

  const root = tempDir("replay");
  try {
    const ledger = writeLedger([...taskRows("P1-week-one-a", 1, "acme/core", 91), row("daemon.boot", null, null, T(1, 20), { head_sha: "week-one-boot" })],
      { dir: join(root, "state") });
    const ledgerBytes = readFileSync(ledger.path);
    const consentPath = join(root, "consent.json");
    writeFileSync(consentPath, JSON.stringify(CONSENT));
    const out = join(root, "out");
    const args = ["--source", "core=acme/core", "--out-dir", out, "--consent", consentPath];
    const fetch = pageFake({ "repos/acme/core/pulls": [rawPull(91, { task: "P1-week-one-a", merged: T(1, 10) })],
      "repos/acme/core/commits": [{ sha: "merge-sha-91", commit: { committer: { date: T(1, 10) } } }] });
    const printed: string[] = [];
    assert.equal(await fieldTrialsCommand([...args, "--ledger", `core=${ledger.dir}`], buildFieldTrialsFlowSnapshot,
      { nowIso: T(20), fetch, print: (line) => printed.push(line), resolveConfig: () => ({ root }) }), 0);
    const manifestPath = join(out, "field-trials-release-manifest.json");
    assert.equal(statSync(out).mode & 0o777, 0o700, "the private output directory is owner-only");
    for (const path of [manifestPath, join(out, "field-trials-github-v1.json"), join(out, "field-trials-flow-v1.json")]) {
      assert.equal(statSync(path).mode & 0o777, 0o600, `${path} remains private under a 022 umask`);
    }
    const good = parseReleaseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    assert.equal(good.lastRefresh!.state, "released");
    const releaseFile = join(out, good.releases[0]!.file);
    assert.ok(existsSync(releaseFile));
    assert.equal(statSync(dirname(releaseFile)).mode & 0o777, 0o700);
    assert.equal(statSync(releaseFile).mode & 0o777, 0o600);
    assert.match(printed[1]!, /release: released; last known good [0-9a-f]{16} as of 2026-09-20/);
    const snapshotBefore = readFileSync(join(out, "field-trials-flow-v1.json"), "utf8");

    const errors: string[] = [];
    const failed = await fieldTrialsCommand([...args, "--ledger", `core=${join(root, "no-such-state")}`], buildFieldTrialsFlowSnapshot,
      { nowIso: T(21), fetch: pageFake({}, () => true), print: () => undefined, printError: (line) => errors.push(line),
        resolveConfig: () => ({ root }) });
    assert.equal(failed, 1, "the refresh reports its failure to the operator");
    const event = JSON.parse(errors[0]!);
    assert.deepEqual([event.event, event.reason, event.last_known_good.releaseId], ["field_trials.refresh_failed", "no-source-observed",
      good.lastKnownGood!.releaseId]);
    const after = parseReleaseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    assert.deepEqual(after.lastKnownGood, good.lastKnownGood, "the dated last known good release is retained");
    assert.deepEqual([after.lastRefresh!.state, after.lastRefresh!.at], ["failed", T(21)]);
    assert.ok(existsSync(releaseFile));
    assert.equal(readFileSync(join(out, "field-trials-flow-v1.json"), "utf8"), snapshotBefore, "an unavailable pass never overwrites the snapshot");
    assert.deepEqual(readFileSync(ledger.path), ledgerBytes, "the pass never writes the ledger it reads");

    const revoked: string[] = [];
    assert.equal(await fieldTrialsCommand(["--out-dir", out, "--revoke", good.lastKnownGood!.releaseId], buildFieldTrialsFlowSnapshot,
      { nowIso: T(22), print: (line) => revoked.push(line), resolveConfig: () => ({ root }) }), 0);
    assert.equal(existsSync(releaseFile), false, "a revoked release is withdrawn from disk");
    assert.match(revoked[0]!, /revoked [0-9a-f]{16}; last known good none/);
    assert.equal(await fieldTrialsCommand(["--out-dir", out, "--revoke", "nope"], buildFieldTrialsFlowSnapshot,
      { print: () => undefined, resolveConfig: () => ({ root }) }), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("field trials command refuses bad input, reads config defaults and names an unpersisted release", async () => {
  const root = tempDir("command");
  try {
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    const resolveConfig = () => ({ root, fleetRepos: ["acme/remudero", "acme/remudero-site"] });
    assert.equal(await fieldTrialsCommand(["--bogus"], buildFieldTrialsFlowSnapshot, { print, resolveConfig }), 2);
    assert.match(lines.at(-1)!, /arguments-invalid/);
    assert.equal(await fieldTrialsCommand(["--source", "no-equals"], buildFieldTrialsFlowSnapshot, { print, resolveConfig }), 2);
    assert.match(lines.at(-1)!, /invalid: no-equals/);
    assert.equal(await fieldTrialsCommand(["--ledger", "core="], buildFieldTrialsFlowSnapshot, { print, resolveConfig }), 2);
    assert.equal(await fieldTrialsCommand(["--max-pages", "0"], buildFieldTrialsFlowSnapshot, { print, resolveConfig }), 2);
    assert.match(lines.at(-1)!, /invalid: --max-pages/);
    const bad = join(root, "cases.json");
    writeFileSync(bad, JSON.stringify([{ version: "other" }]));
    assert.equal(await fieldTrialsCommand(["--case-files", bad], buildFieldTrialsFlowSnapshot, { print, resolveConfig }), 2);
    assert.match(lines.at(-1)!, /case-file-snapshot-invalid/);

    writeLedger(taskRows("T1-default-root", 1, "acme/remudero", 1), { dir: join(root, "state") });
    writeFileSync(join(root, "good-cases.json"), JSON.stringify([caseFileFor("T1-default-root", "T1-default-root-run-1", "T1-default-root-asg", 2, T(10))]));
    writeFileSync(join(root, "consent.json"), JSON.stringify({ ...CONSENT, repos: [{ repo: "acme/remudero", rights: "public-benchmark", receipt: "r-core" }] }));
    mkdirSync(join(root, "state", "field-trials"), { recursive: true });
    writeFileSync(join(root, "state", "field-trials", "releases"), "a file where the release directory should be");
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  try {
    const lines: string[] = [];
    const errors: string[] = [];
    const resolveConfig = () => ({ root, fleetRepos: ["acme/remudero", "acme/remudero-site"] });
    const code = await fieldTrialsCommand(["--case-files", join(root, "good-cases.json"), "--consent", join(root, "consent.json"), "--offline"],
      buildFieldTrialsFlowSnapshot, { nowIso: T(10), print: (line) => lines.push(line), printError: (line) => errors.push(line), resolveConfig });
    assert.equal(code, 1);
    assert.match(errors[0]!, /release-not-persisted/);
    assert.match(lines[0]!, /snapshot observed-partial; github skipped \(0 pages\)/);
    assert.ok(lines.some((line) => line === "  partial: site:ledger:ledger-not-provided-on-this-host"), "a default non-local source is named unavailable");
    const snapshot = JSON.parse(readFileSync(join(root, "state", "field-trials", "field-trials-flow-v1.json"), "utf8")) as FieldTrialsFlowSnapshot;
    assert.deepEqual(snapshot.provenance.sources.map((source) => source.label), ["core", "site"]);
    assert.deepEqual(snapshot.provenance.githubPass!.state, "skipped");
    assert.equal(sumStage(snapshot, "core", "eligible").reached, 1, "the configured root's own ledger is the core source");
    const failing = await fieldTrialsCommand(["--offline"], buildFieldTrialsFlowSnapshot, { nowIso: T(11), print: () => undefined,
      printError: () => undefined, resolveConfig, readLedger: async () => { throw new Error("disk gone"); } });
    assert.equal(failing, 1, "a ledger reader that throws is an unavailable source, not a crash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("field trials ledger reader counts every form and never calls an unreadable corpus empty", async () => {
  const root = tempDir("ledger");
  try {
    assert.deepEqual([(await readFieldTrialsLedger(join(root, "absent"))).state, (await readFieldTrialsLedger(join(root, "absent"))).reason],
      ["unavailable", "ledger-source-unreadable"]);
    mkdirSync(join(root, "empty"));
    assert.equal((await readFieldTrialsLedger(join(root, "empty"))).reason, "ledger-source-missing");
    const dir = join(root, "state");
    writeLedger([row("run.start", "T1-reader", "r", T(2)), row("noise.step", null, null, T(3)),
      row("anything", "T1-reader", "r", T(4), { actor: "operator" }),
      row("worker.assignment", "T1-future", "r", T(8))], { dir });
    writeFileSync(join(dir, "ledger.2026-09-01T00-00-00-000Z.ndjson.gz"), gzipSync("not a ledger line\n").subarray(0, 12));
    const read = await readFieldTrialsLedger(dir, Date.parse(T(4)));
    assert.deepEqual([read.state, read.reason, read.unreadSources, read.forms.gzip], ["observed-partial", "ledger-source-unreadable", 1, 1]);
    assert.deepEqual(read.rows.map((item) => item.step), ["run.start", "anything"], "an operator's own row is kept as a human touch");
    assert.equal(read.newestTs, T(4));
    assert.equal(read.futureRows, 1, "a future-dated assignment cannot advance the watermark or enter an observed cohort");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("field trials learning loop counts proposals to outcomes and never zeroes human effort", () => {
  const card = (step: string, prNumber: number, day: number) => row(step, null, null, T(day), { pr_url: `https://github.com/acme/core/pull/${prNumber}` });
  const rows = [
    card("ci_friction.scorecard", 101, 1), card("ci_friction.scorecard", 102, 1), card("ci_friction.scorecard", 103, 1),
    card("ci_friction.scorecard", 104, 2), card("ci_friction.scorecard", 105, 2), card("ci_friction.scorecard", 199, 2),
    row("ci_friction.scorecard", null, null, T(2), { pr_url: null }),
    row("ci_friction.gardener_judged", null, null, T(3), { verdict: "credit" }), row("ci_friction.gardener_judged", null, null, T(3), { verdict: "debit" }),
    row("ci_friction.gardener_judged", null, null, T(3), { verdict: "neutral" }),
    row("evidence_coverage.filed", null, null, T(3), { action: "filed" }), row("evidence_coverage.filed", null, null, T(3), { action: "updated" }),
  ];
  const github: FieldTrialsGithubStore = { version: "field-trials-github-v1", repos: { "acme/core": repoStore([
    rawPull(101, { merged: T(1, 5) }), rawPull(102, { merged: T(1, 6) }), rawPull(103, { open: true }), rawPull(104, {}),
    rawPull(105, { merged: T(2, 5) }), rawPull(106, { merged: T(2, 9), body: "Reverts acme/core#105" }),
  ]) } };
  const snapshot = buildFieldTrialsFlowSnapshot({ asOf: T(10), sources: [{ label: "core", repo: "acme/core", ledger: flowReadOf(rows) }], github });
  const learning = Object.values(snapshot.families.learning).map((partition) => partition.cells);
  const total = (field: "proposals" | "accepted" | "declined" | "open" | "unknown" | "credits" | "debits" | "followUpDefects") =>
    learning.reduce((sum, cells) => sum + cells[field], 0);
  assert.deepEqual([total("proposals"), total("accepted"), total("declined"), total("open"), total("unknown"), total("followUpDefects")],
    [7, 3, 1, 1, 2, 1], "a proposal missing from GitHub and a filed follow-up are unknown, never declined");
  assert.deepEqual([total("credits"), total("debits")], [1, 1]);
  assert.ok(learning.every((cells) => cells.humanEffort.state === "unavailable"));
  const released = buildFieldTrialsRelease(snapshot, CONSENT, "salt");
  assert.equal(released.state, "candidate");
  const cells = released.state === "candidate" ? released.release.cells.filter((cell) => cell.family === "learning") : [];
  assert.deepEqual(cells.map((cell) => cell.stratum.kind).sort(), ["evidence-followup", "gardener-pr", "judgement"]);
  assert.ok(cells.every((cell) => cell.reasons.includes("humanEffort:no-independent-human-effort-estimate")));
});
