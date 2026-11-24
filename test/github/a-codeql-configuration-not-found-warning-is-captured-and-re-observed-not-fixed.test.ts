// W1-T13470 — GitHub's neutral CodeQL "N configuration(s) not found" check made the security merge policy answer
// `unknown: security-analysis-failed-or-unrecognized`, and the sweep spent generic ci-log fix rounds on it (4 rounds on
// #14442, #15133 and #15380): a source edit cannot clear a GitHub-side processing state. Its summary was never
// captured: the producer kept only its sha256. This suite pins the smaller remedy: the shape keeps UNKNOWN under its own
// reason, its check text is captured verbatim once per head and check generation, the head waits instead of being
// fixed, and a warning that outlives a new CodeQL workflow completion is escalated once. The sweep makes no GitHub
// write for this shape (operator ruling 2026-11-17: no producer dispatch). Nothing newly passes the policy.
//
// The warning summary below is a SYNTHETIC stand-in: no real one has been captured. Only the TITLE is a matcher.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// Namespace imports: on a tree without this change each criterion fails on its own assertion, not on a missing export.
// @ts-expect-error — pure ESM policy outside tsconfig source roots.
import * as policy from "#src/lib/code-scanning-merge-policy.mjs";
// @ts-expect-error — pure ESM adapter outside tsconfig source roots.
import * as adapter from "#src/lib/code-scanning-merge-adapter.mjs";
// @ts-expect-error — pure ESM argv mapping outside tsconfig source roots.
import { securityMetadataGhArgs } from "#src/lib/security-metadata-gh-args.mjs";
import { ghJson, ghJsonAsync } from "#src/lib/github-transport.js";
import { securityMergeHead, securityMergeHeadAsync } from "#src/lib/security-merge-admission.js";
import * as sweep from "#src/lib/sweep.js";
import type { OpenPrView, SecurityMergeObservation, SweepDeps } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const REASON = "codeql-configuration-not-found";
const UNRECOGNIZED = "security-analysis-failed-or-unrecognized";
const CAPTURED = "security.codeql_configuration_warning_captured";
const ESCALATED = "security.codeql_configuration_warning_escalated";
const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const OTHER = "f".repeat(40);
const PR = 17217;
const TASK = "W1-T13470";
const PR_URL = `https://github.com/craigoley/remudero/pull/${PR}`;
const ALERTS = `/craigoley/remudero/security/code-scanning?query=pr%3A${PR}+tool%3ACodeQL+is%3Aopen`;
const LINK = `[View all branch alerts](${ALERTS}).`;
const SUMMARY = "Code scanning could not compare this pull request with its base: 1 configuration present on " +
  "refs/heads/main was not found.\n\n * .github/workflows/codeql.yml:analyze/language:actions\n\n" + LINK;
const APP = { slug: "github-advanced-security", id: 57789, owner: { login: "github" } };
const T1 = "2026-11-17T03:20:00Z", T2 = "2026-11-17T03:24:00Z", T3 = "2026-11-17T03:26:00Z";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Check = Record<string, any>;
const warning = (over: Check = {}): Check => ({ id: 2, name: "CodeQL", head_sha: HEAD, status: "completed", conclusion: "neutral",
  app: APP, started_at: T1, completed_at: T1, output: { title: "1 configuration not found", summary: SUMMARY }, ...over });
const clean = (over: Check = {}): Check => warning({ id: 1, conclusion: "success",
  output: { title: "No new alerts in code changed by this pull request", summary: LINK }, ...over });
const input = (checks: Check[], over: Record<string, unknown> = {}) => ({ prNumber: PR, headSha: HEAD, observedHeadSha: HEAD,
  filesComplete: true, filesHeadSha: HEAD, changedFileCount: 1, files: [{ filename: "src/lib/a.ts" }],
  checksComplete: true, checksHeadSha: HEAD, checks, ...over });
const classify = (x: unknown) => policy.classifyCodeScanningMergePolicy(x) as { state: string; mergeAllowed: boolean; reason: string };
const withSummary = (text: string) => warning({ output: { title: "1 configuration not found", summary: text } });

const ROOT = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13470-`));
const CHECKS_FILE = join(ROOT, "check-runs.json");
const PR_ROW = { state: "open", head: { sha: HEAD }, base: { sha: OTHER, ref: "main", repo: { full_name: "craigoley/remudero" } }, changed_files: 1 };
/** GitHub as `gh` serves it, through the shared PATH shim: the PR, its one changed file, the check corpus (read from a
 *  file at each call, so a test can move it) and this head's CodeQL runs. First matching route wins. */
const shim = ghShim([
  { when: "/check-runs?", stdoutFile: CHECKS_FILE },
  { when: "/files?", stdout: JSON.stringify([{ filename: "src/lib/a.ts" }]) },
  { when: "actions/workflows/codeql.yml/runs", stdout: JSON.stringify({ total_count: 0, workflow_runs: [] }) },
  { when: `/pulls/${PR}`, stdout: JSON.stringify(PR_ROW) },
], { kind: "w1-t13470-security" });
after(() => {
  rmSync(shim.dir, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});
/** The production sweep effects: their default transport is the real `gh`, which the shim answers. */
const effects = sweep.buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { claudeBin: "/usr/bin/true", root: ROOT } as never,
  ledgerPath: join(ROOT, "ledger.ndjson"), runId: "SWEEP-13470", plan: { tasks: [] } as never, log: () => {} });
async function onShim<T>(checks: Check[], run: () => T | Promise<T>): Promise<T> {
  writeFileSync(CHECKS_FILE, JSON.stringify({ total_count: checks.length, check_runs: checks }));
  const previous = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previous}`;
  try {
    return await run();
  } finally {
    process.env.PATH = previous;
  }
}
/** The read-only adapter over the real transport, exactly as the sweep's wired read calls it (criterion 4 pins that). */
const observe = (checks: Check[]) => onShim(checks, async () => (await adapter.readSecurityMergeDecision(
  { owner: "craigoley", repo: "remudero", prNumber: PR, expectedHead: HEAD },
  (path: string) => ghJsonAsync(securityMetadataGhArgs(path)))) as SecurityMergeObservation);

function view(over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: PR, prUrl: PR_URL, taskId: TASK, reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: T1, headSha: HEAD, headRefName: `run-${TASK}-1794947563086`, autoMergeArmed: false,
    ciFailures: [{ name: "security-merge-policy", logTail: "" }],
    securityMergePolicy: { state: "unknown", reason: REASON }, ...over };
}

/** A sweep pass's deps: every arm effect that could act on GitHub fails the test; the W1-T13470 seams record. */
function harness(prior: Record<string, unknown>[], answer: () => Promise<SecurityMergeObservation>, runs: unknown = { workflow_runs: [] }) {
  const rows: Record<string, unknown>[] = [];
  const calls = { escalated: [] as Array<{ reason: string; owner: string }>, runsRead: 0 };
  const forbidden = (what: string) => () => assert.fail(`a configuration-not-found wait never ${what}`);
  const deps: SweepDeps = {
    arm: forbidden("arms"), close: forbidden("closes"), dispatchFix: forbidden("dispatches a fix round"),
    postReview: forbidden("posts a review status"), updateBranch: forbidden("updates the branch"),
    requeueCheck: forbidden("re-runs a check"), rerunFailedChecks: forbidden("re-runs failed checks"),
    readyDraft: forbidden("readies a draft"), disarmAutoMerge: forbidden("disarms"),
    escalate: (_pr, reason, question) => { calls.escalated.push({ reason, owner: question.taskId }); },
    readSecurityMergeObservation: answer,
    readCodeqlWorkflowRuns: async () => { calls.runsRead++; return runs; },
    ledgerPath: "/nonexistent/rmd-w1-t13470/rows.ndjson", runId: "SWEEP-13470", now: () => Date.parse(T3) + 60_000,
    readLedger: () => [...prior, ...rows], appendLine: (_path, row) => { rows.push(row); },
    log: (step, extra = {}) => { rows.push({ run_id: "SWEEP-13470", step, ...extra }); },
  };
  return { deps, rows, calls };
}

test("W1-T13470 criterion 1: the configuration-not-found shape answers its own UNKNOWN, a high count still blocks, every near miss keeps its old reason", () => {
  for (const title of ["1 configuration not found", "2 configurations not found", "12 configurations not found"]) {
    for (const summary of [SUMMARY, "", "anything GitHub writes here", " * 0 high\n * 0 critical\n"]) {
      assert.deepEqual(classify(input([warning({ output: { title, summary } })])), { state: "unknown", mergeAllowed: false, reason: REASON },
        `${title} / ${JSON.stringify(summary)}`);
    }
    for (const count of [" * 1 high", " * 3 critical", "\n * 2 high\n"]) {
      assert.deepEqual(classify(input([warning({ output: { title, summary: `${SUMMARY}\n${count}\n` } })])),
        { state: "blocked", mergeAllowed: false, reason: "new-high-or-critical-security-alert" }, `${title} with${count}`);
    }
  }
  assert.equal(policy.CODEQL_CONFIGURATION_NOT_FOUND, REASON, "the reason is one exported constant the sweep reads");
  const nearTitles = ["0 configurations not found", "1 configuration not found.", " 1 configuration not found", "1 Configuration not found",
    "configuration not found", "01 configuration not found", "1 configuration not found\n", "1 configuration missing", "Analysis incomplete"];
  for (const title of nearTitles) {
    assert.deepEqual(classify(input([warning({ output: { title, summary: SUMMARY } })])), { state: "unknown", mergeAllowed: false, reason: UNRECOGNIZED }, title);
  }
  for (const conclusion of ["success", "failure", "action_required", "cancelled", "skipped", "timed_out", "stale", null]) {
    assert.deepEqual(classify(input([warning({ conclusion })])), { state: "unknown", mergeAllowed: false, reason: UNRECOGNIZED }, String(conclusion));
  }
  assert.equal(classify(input([warning({ status: "in_progress" })])).reason, "security-analysis-pending");
  assert.equal(classify(input([warning({ app: { ...APP, id: 1 } })])).reason, "trusted-exact-head-codeql-result-missing");
});

test("W1-T13470 criterion 2: the observation receipt carries the warning verbatim and bounded, and the sweep writes one capture row per head and check id", async () => {
  const result = await observe([clean(), warning()]);
  const receipt = result.observation?.configurationWarning;
  assert.deepEqual(receipt, { checkId: 2, headSha: HEAD, completedAt: T1, conclusion: "neutral", title: "1 configuration not found",
    summary: SUMMARY, summarySha256: sha256(SUMMARY), truncated: false, alertsLink: ALERTS });
  assert.equal(result.decision.reason, REASON);
  assert.equal(result.observation?.latest?.id, 2, "the generation the receipt belongs to");
  assert.doesNotMatch(JSON.stringify(result.observation), /authorization|bearer|token|x-github/i, "GitHub's check text only");

  const max = adapter.CODEQL_WARNING_SUMMARY_MAX_CHARS as number;
  assert.ok(Number.isSafeInteger(max) && max >= 4096, "a BACKSTOP bound, not a hash-only receipt");
  const long = SUMMARY + "x".repeat(max);
  const bounded = (await observe([withSummary(long)])).observation?.configurationWarning;
  assert.equal(bounded?.summary, long.slice(0, max));
  assert.equal(bounded?.truncated, true);
  assert.equal(bounded?.summarySha256, sha256(long), "the hash names the whole summary");
  const exact = (await observe([withSummary("y".repeat(max))])).observation?.configurationWarning;
  assert.equal(exact?.truncated, false, "a summary at the bound is whole");
  assert.equal(exact?.alertsLink, null, "no link in the summary reads null");
  const bare = (await observe([warning({ output: { title: "2 configurations not found" } })])).observation?.configurationWarning;
  assert.deepEqual([bare?.summary, bare?.summarySha256, bare?.truncated, bare?.alertsLink], [null, null, false, null]);
  for (const checks of [[clean()], [warning({ id: 1 }), clean({ id: 3 })], [warning({ conclusion: "failure" })], [warning({ app: { ...APP, id: 1 } })]]) {
    assert.equal((await observe(checks)).observation?.configurationWarning, undefined, "only the latest trusted check of that shape has a receipt");
  }

  const pass = async (prior: Record<string, unknown>[], answer: SecurityMergeObservation, pr = view()) => {
    const h = harness(prior, async () => answer);
    await sweep.observeCodeqlConfigurationWarning(h.deps, prior, pr, "wait");
    return h.rows;
  };
  const first = await pass([], result);
  assert.deepEqual(first.filter((r) => r.step === CAPTURED), [{ run_id: "SWEEP-13470", task_id: TASK, pr_number: PR, pr_url: PR_URL,
    head_sha: HEAD, step: CAPTURED, check_id: 2, decision: `unknown: ${REASON}`, receipt }]);
  assert.equal((await pass(first, result)).filter((r) => r.step === CAPTURED).length, 0, "no second row for the same head and check id");
  const newer = await observe([clean(), warning(), warning({ id: 3, completed_at: T2 })]);
  assert.deepEqual((await pass(first, newer)).filter((r) => r.step === CAPTURED).map((r) => r.check_id), [3], "a new generation is its own capture");
  const moved = await pass(first, { ...result, headSha: OTHER }, view({ headSha: OTHER }));
  assert.deepEqual(moved.filter((r) => r.step === CAPTURED).map((r) => [r.head_sha, r.check_id]), [[OTHER, 2]], "a new head is its own capture");
});

test("W1-T13470 criterion 3: the head waits with no fix round or strike, GitHub's refresh asks the sweep for nothing, and a warning outliving a new CodeQL completion is escalated once", async () => {
  const waiting = sweep.deriveDisposition(view(), sweep.DEFAULT_SWEEP_POLICY, Date.parse(T3));
  assert.deepEqual([waiting.disposition, waiting.blocker], ["wait", "security-unknown-hold"]);
  for (const [why, pr] of [
    ["today's unrecognized reason", view({ securityMergePolicy: { state: "unknown", reason: UNRECOGNIZED } })],
    ["another red beside it", view({ ciFailures: [{ name: "security-merge-policy", logTail: "" }, { name: "ci-gate", logTail: "not ok 1" }] })],
    ["a red required child", view({ redRequiredChecks: ["coverage-shard (1/8)"] })],
    ["a high alert read at this head", view({ codeqlHeadAlerts: { headSha: HEAD, alerts: [{ alertNumber: 9, ruleId: "js/x", severity: "high",
      path: "src/a.ts", line: 1 }] } as OpenPrView["codeqlHeadAlerts"] })],
    ["no named red", view({ ciFailures: [] })],
  ] as const) {
    assert.equal(sweep.deriveDisposition(pr, sweep.DEFAULT_SWEEP_POLICY, Date.parse(T3)).disposition, "blocked-fixable", `control: ${why} keeps the fix round`);
  }
  assert.notEqual(sweep.deriveDisposition(view({ reviewState: "failure" }), sweep.DEFAULT_SWEEP_POLICY, Date.parse(T3)).disposition, "wait",
    "a failed review is a red of its own");

  const gen2 = await observe([clean(), warning()]);
  const gen3ok = await observe([clean(), warning(), clean({ id: 3, completed_at: T3 })]);
  const gen3warn = await observe([clean(), warning(), warning({ id: 3, completed_at: T3 })]);
  const ledger: Record<string, unknown>[] = [];
  const sweepPass = async (answer: SecurityMergeObservation, runs?: unknown) => {
    const h = harness([...ledger], async () => answer, runs);
    await sweep.runSweep([view()], h.deps);
    ledger.push(...h.rows);
    assert.equal(h.rows.some((r) => String(r.step).startsWith("fix.") || r.step === "sweep.fix_dispatch"), false, "no fix round row");
    const disposed = h.rows.filter((r) => r.step === "sweep.disposed");
    assert.equal(disposed.length, 1);
    assert.deepEqual([disposed[0]!.disposition, disposed[0]!.acted, disposed[0]!.blocker], ["wait", false, "security-unknown-hold"]);
    return { ...h.calls, reason: String(disposed[0]!.reason) };
  };
  const one = await sweepPass(gen2);
  assert.equal(one.escalated.length, 0, "the first sighting only captures");
  assert.match(one.reason, /no fix round and no strike — captured check 2's warning verbatim/);
  assert.equal(ledger.filter((r) => r.step === CAPTURED).length, 1);
  const two = await sweepPass(gen3ok);
  assert.deepEqual([two.escalated.length, two.runsRead], [0, 0], "GitHub's refreshed check needs nothing from the sweep");
  assert.doesNotMatch(two.reason, /producer|request/);
  assert.deepEqual(ledger.filter((r) => String(r.step).startsWith("security.")).map((r) => r.step), [CAPTURED],
    "the only security row the waits wrote is the one capture");

  // Escalation: a CodeQL run that completed after the first capture, which GitHub re-judged and still warns on.
  const run = (over: Record<string, unknown>) => ({ id: 700, run_attempt: 1, head_sha: HEAD, status: "completed", conclusion: "success",
    created_at: T1, run_started_at: T1, updated_at: T2, ...over });
  const escalation = async (prior: Record<string, unknown>[], runs: unknown, answer = gen3warn) => {
    const h = harness(prior, async () => answer, runs);
    const reason = await sweep.observeCodeqlConfigurationWarning(h.deps, prior, view(), "wait");
    return { ...h, reason };
  };
  const captured = ledger.filter((r) => r.step === CAPTURED);
  for (const [why, runs] of [
    ["a completed re-run began after the standing check", { workflow_runs: [run({ created_at: "2026-11-17T03:27:00Z",
      run_started_at: "2026-11-17T03:27:00Z", updated_at: "2026-11-17T03:27:00Z" })] }],
    ["a run still in progress", { workflow_runs: [run({ status: "in_progress" })] }],
    ["an unreadable listing", { message: "Not Found" }],
  ] as const) {
    const quiet = await escalation(captured, runs);
    assert.deepEqual([quiet.calls.escalated.length, quiet.rows.some((r) => r.step === ESCALATED)], [0, false], `control: ${why}`);
  }
  // W1-T13663: GitHub never re-judges an unchanged head, so these two, each with a capture from an earlier pass and no
  // CodeQL run at the head open or created after the standing check, now escalate once with the owner's remedy. The
  // producing run is created before the check and updated after it, as on #15133 and #17217.
  for (const [why, runs] of [
    ["the run that produced the warning, never re-judged",
      { workflow_runs: [run({ created_at: "2026-11-17T03:25:00Z", updated_at: "2026-11-17T03:30:00Z" })] }],
    ["another head's run", { workflow_runs: [run({ head_sha: OTHER })] }],
  ] as const) {
    const escalated = await escalation(captured, runs);
    assert.deepEqual([escalated.calls.escalated.length, escalated.rows.filter((r) => r.step === ESCALATED).length], [1, 1], `W1-T13663: ${why}`);
    assert.match(escalated.calls.escalated[0]!.reason, /push a new commit or re-run CodeQL at this head/, why);
  }
  assert.equal((await escalation(captured, { workflow_runs: [run({})] }, gen3ok)).calls.runsRead, 0, "a refreshed check escalates nothing");
  const fired = await escalation(captured, { workflow_runs: [run({})] });
  assert.equal(fired.calls.escalated.length, 1);
  assert.equal(fired.calls.escalated[0]!.owner, TASK, "the PR's task owns it");
  assert.match(fired.calls.escalated[0]!.reason, /CodeQL workflow run 700 \(attempt 1\) completed at 2026-11-17T03:24:00Z/);
  assert.ok(fired.calls.escalated[0]!.reason.includes(JSON.stringify(gen3warn.observation?.configurationWarning)), "the receipt is the evidence");
  const row = fired.rows.find((r) => r.step === ESCALATED);
  assert.deepEqual([row?.check_id, row?.workflow_run_id, row?.owner, row?.receipt], [3, 700, TASK, gen3warn.observation?.configurationWarning]);
  const again = await escalation([...captured, ...fired.rows], { workflow_runs: [run({})] });
  assert.deepEqual([again.calls.escalated.length, again.calls.runsRead], [0, 0], "escalated once per head");
  assert.match(again.reason, /already escalated once at this head/);
  const taskless = await escalation(captured.map((r) => ({ ...r, task_id: "SWEEP" })), { workflow_runs: [run({})] });
  assert.equal(taskless.calls.escalated[0]?.owner, TASK, "control: the owner comes from the PR, not the row");
  const h = harness(captured, async () => gen3warn, { workflow_runs: [run({})] });
  await sweep.observeCodeqlConfigurationWarning(h.deps, captured, view({ taskId: undefined }), "wait");
  assert.equal(h.calls.escalated[0]?.owner, "security-policy", "a taskless PR escalates to security-policy");
});

test("W1-T13470 criterion 3: an unread decision, a moved head, unread runs and a failed escalation each say so and spend nothing twice", async () => {
  const gen2 = await observe([clean(), warning()]);
  const h = harness([], async () => { throw new Error("read refused"); });
  assert.match(await sweep.observeCodeqlConfigurationWarning(h.deps, [], view(), "wait"), /^wait — the security decision was not read this pass \(read refused\)$/);
  const moved = harness([], async () => ({ ...gen2, headSha: OTHER }));
  assert.match(await sweep.observeCodeqlConfigurationWarning(moved.deps, [], view(), "wait"), /answered unknown: codeql-configuration-not-found at fffffff, not this head/);
  assert.equal(moved.rows.length, 0);
  const unwired = harness([], async () => gen2);
  delete unwired.deps.readSecurityMergeObservation;
  assert.equal(await sweep.observeCodeqlConfigurationWarning(unwired.deps, [], view(), "wait"), "wait");

  const stale = await observe([clean({ id: 4 })]);
  const quiet = harness([], async () => stale);
  assert.equal(await sweep.observeCodeqlConfigurationWarning(quiet.deps, [], view(), "wait"), "wait",
    "a status the latest trusted check no longer supports is left to GitHub's own refresh");
  assert.deepEqual([quiet.rows.length, quiet.calls.runsRead, quiet.calls.escalated.length], [0, 0, 0]);

  const captured = (await (async () => { const c = harness([], async () => gen2); await sweep.observeCodeqlConfigurationWarning(c.deps, [], view(), "wait"); return c.rows; })());
  const gen3warn = await observe([clean(), warning(), warning({ id: 3, completed_at: T3 })]);
  const refused = harness(captured, async () => gen3warn, { workflow_runs: [{ id: 701, head_sha: HEAD, status: "completed", updated_at: T2 }] });
  refused.deps.escalate = () => { throw new Error("issues disabled"); };
  assert.match(await sweep.observeCodeqlConfigurationWarning(refused.deps, captured, view(), "wait"),
    /its escalation to W1-T13470 failed \(issues disabled\) and is not repeated at this head/);
  assert.equal(refused.rows.filter((r) => r.step === ESCALATED).length, 1);
  const unreadRuns = harness(captured, async () => gen3warn);
  unreadRuns.deps.readCodeqlWorkflowRuns = async () => { throw new Error("HTTP 502"); };
  assert.match(await sweep.observeCodeqlConfigurationWarning(unreadRuns.deps, captured, view(), "wait"), /CodeQL workflow runs unread \(HTTP 502\)/);
});

/** origin/main's answer for a named input, measured on its classifier; `changed` marks the one shape whose reason moves. */
const NAMED: Array<[string, unknown, { state: string; mergeAllowed: boolean; reason: string }, boolean]> = [
  ["no new alerts", input([clean()]), { state: "safe", mergeAllowed: true, reason: "trusted-complete-exact-head-no-new-alerts" }, false],
  ["quality only", input([clean({ output: { title: "1 new alert",
    summary: "### New alerts in code changed by this pull request\n\n * 1 note\n\nSee annotations below for details.\n\n" + LINK } })]),
    { state: "safe", mergeAllowed: true, reason: "trusted-complete-exact-head-below-security-threshold" }, false],
  ["sectioned below threshold", input([clean({ conclusion: "failure", output: { title: "3 new alerts including 1 medium severity security vulnerability",
    summary: "### New alerts in code changed by this pull request\n\nSecurity Alerts:\n * 1 low\n * 1 medium\n\nOther Alerts:\n * 1 note\n\n" +
      "See annotations below for details.\n\n" + LINK } })]),
    { state: "safe", mergeAllowed: true, reason: "trusted-complete-exact-head-below-security-threshold" }, false],
  ["a high alert", input([clean({ conclusion: "failure", output: { title: "1 new alert including 1 high severity security vulnerability",
    summary: "### New alerts in code changed by this pull request\n\nSecurity Alerts:\n * 1 high\n\n" + LINK } })]),
    { state: "blocked", mergeAllowed: false, reason: "new-high-or-critical-security-alert" }, false],
  ["docs only", input([], { files: [{ filename: "docs/a.md" }] }), { state: "not-applicable", mergeAllowed: true, reason: "complete-verified-out-of-codeql-scope" }, false],
  ["head moved", input([warning()], { observedHeadSha: OTHER }), { state: "unknown", mergeAllowed: false, reason: "head-unavailable-or-changed" }, false],
  ["checks incomplete", input([warning()], { checksComplete: false }), { state: "unknown", mergeAllowed: false, reason: "check-corpus-incomplete" }, false],
  ["duplicate generation", input([warning(), warning()]), { state: "unknown", mergeAllowed: false, reason: "check-generation-ambiguous" }, false],
  ["untrusted warning", input([warning({ app: { ...APP, owner: { login: "attacker" } } })]),
    { state: "unknown", mergeAllowed: false, reason: "trusted-exact-head-codeql-result-missing" }, false],
  ["pending warning", input([warning({ status: "queued" })]), { state: "unknown", mergeAllowed: false, reason: "security-analysis-pending" }, false],
  ["warning without summary", input([warning({ output: { title: "1 configuration not found" } })]),
    { state: "unknown", mergeAllowed: false, reason: "security-result-shape-unavailable" }, false],
  ["warning with a high count", input([withSummary(`${SUMMARY}\n * 1 high\n`)]), { state: "blocked", mergeAllowed: false, reason: "new-high-or-critical-security-alert" }, false],
  ["warning with a critical count", input([withSummary(" * 4 critical\n")]), { state: "blocked", mergeAllowed: false, reason: "new-high-or-critical-security-alert" }, false],
  ["warning superseded by a clean check", input([warning(), clean({ id: 3 })]), { state: "safe", mergeAllowed: true, reason: "trusted-complete-exact-head-no-new-alerts" }, false],
  ["warning that failed", input([warning({ conclusion: "failure" })]), { state: "unknown", mergeAllowed: false, reason: UNRECOGNIZED }, false],
  ["warning that succeeded", input([warning({ conclusion: "success", output: { title: "1 configuration not found", summary: LINK } })]),
    { state: "unknown", mergeAllowed: false, reason: UNRECOGNIZED }, false],
  ["another neutral title", input([warning({ output: { title: "Analysis paused", summary: SUMMARY } })]), { state: "unknown", mergeAllowed: false, reason: UNRECOGNIZED }, false],
  ["the warning", input([warning()]), { state: "unknown", mergeAllowed: false, reason: UNRECOGNIZED }, true],
  ["the warning over a clean check", input([clean(), warning()]), { state: "unknown", mergeAllowed: false, reason: UNRECOGNIZED }, true],
  ["two missing configurations, zero high", input([warning({ output: { title: "2 configurations not found", summary: " * 0 high\n" } })]),
    { state: "unknown", mergeAllowed: false, reason: UNRECOGNIZED }, true],
];

test("W1-T13470 criterion 4: no new success path — every input keeps origin/main's state, only the warning's reason moves, the merge guard still refuses it, and the sweep writes no status", async () => {
  for (const [name, x, base, changed] of NAMED) {
    assert.deepEqual(classify(x), changed ? { ...base, reason: REASON } : base, name);
  }
  // The warning family, swept: origin/main answers pending before completion, blocked on a positive high or critical
  // count, and unrecognized otherwise. Here only completed+neutral+exact-title without a positive count moves reason.
  let moved = 0, total = 0;
  const titles = ["1 configuration not found", "2 configurations not found", "1 configurations not found", "0 configuration not found",
    "1 configuration not found.", "configuration not found", "No new alerts in code changed by this pull request", "1 new alert"];
  const summaries = [SUMMARY, LINK, "", " * 1 high\n", " * 0 critical\n", "\n * 7 critical\n"];
  for (const status of ["completed", "in_progress", "queued"]) for (const conclusion of ["neutral", "success", "failure", "skipped", null])
    for (const title of titles) for (const summary of summaries) {
      const got = classify(input([warning({ status, conclusion, output: { title, summary } })]));
      const positive = /^\s*\* (\d+) (high|critical)\s*$/m.exec(summary) !== null && !/^\s*\* 0 /m.test(summary);
      const base = status !== "completed" ? "security-analysis-pending" : positive ? "new-high-or-critical-security-alert"
        : conclusion === "success" && title === "No new alerts in code changed by this pull request" && summary === LINK
          ? "trusted-complete-exact-head-no-new-alerts" : UNRECOGNIZED;
      const shape = status === "completed" && conclusion === "neutral" && /^[1-9][0-9]* configurations? not found$/.test(title) && !positive;
      const state = base === "security-analysis-pending" || base === UNRECOGNIZED ? "unknown" : base.startsWith("new-") ? "blocked" : "safe";
      assert.deepEqual(got, { state, mergeAllowed: state === "safe", reason: shape ? REASON : base }, `${status}/${conclusion}/${title}/${JSON.stringify(summary)}`);
      total++; if (shape) moved++;
    }
  assert.ok(total === 720 && moved === 12, `positive control: the sweep covered ${total} inputs and ${moved} of them are the shape`);

  const before = shim.calls().length;
  await assert.rejects(onShim([clean(), warning()], () => securityMergeHeadAsync(PR_URL, undefined, HEAD)),
    (error: { state?: string; reason?: string }) => error.state === "unknown" && error.reason === REASON, "the arm guard refuses the shape");
  await onShim([clean(), warning()], () => assert.throws(() => securityMergeHead(PR_URL, (path) => ghJson(securityMetadataGhArgs(path)), HEAD),
    (error: { state?: string; reason?: string }) => error.state === "unknown" && error.reason === REASON, "and so does the sync guard"));
  await assert.rejects(onShim([withSummary(" * 1 high\n")], () => securityMergeHeadAsync(PR_URL, undefined, HEAD)),
    (error: { state?: string }) => error.state === "blocked", "a high count under it stays blocked");
  assert.ok(shim.calls().slice(before).filter((call) => call.includes("/check-runs?")).length >= 3, "positive control: the guards read the corpus");

  // The production effects' GitHub calls for this wait are GET reads only: no dispatch, no status, no write at all.
  const mark = shim.calls().length;
  const observed = await onShim([clean(), warning()], () => effects.readSecurityMergeObservation!(view()));
  assert.deepEqual(observed, await observe([clean(), warning()]), "the wired read is the adapter's, over the same transport");
  assert.equal(observed.observation?.configurationWarning?.checkId, 2);
  assert.deepEqual(await onShim([], () => effects.readCodeqlWorkflowRuns!(view())), { total_count: 0, workflow_runs: [] });
  assert.equal("requestSecurityMergeProducer" in effects, false, "no producer dispatch is wired");
  const calls = shim.calls().slice(mark);
  assert.ok(calls.length >= 5, `positive control: ${calls.length} calls`);
  assert.ok(calls.some((call) => call.includes(`repos/craigoley/remudero/actions/workflows/codeql.yml/runs?head_sha=${HEAD}&per_page=100`)));
  const writes = calls.filter((call) => /(^| )(-X|--method)( |$)/.test(call) && !/--method GET/.test(call));
  assert.deepEqual(writes, [], "the sweep makes no GitHub write for this shape");
  assert.equal(calls.some((call) => /statuses|dispatches/.test(call)), false, "no commit status and no workflow dispatch");
});

/** W1-T14681 — the publish step over a pinned read: the PR, its one file, the given checks and this head's workflow runs. */
const NOW_14681 = Date.parse("2026-11-24T16:26:00Z");
const codeqlRun = (over: Record<string, unknown> = {}) => ({ id: 45437, path: ".github/workflows/codeql.yml", head_sha: HEAD,
  status: "in_progress", run_started_at: new Date(NOW_14681 - 2 * 60_000).toISOString(), repository: { full_name: "craigoley/remudero" }, ...over });
async function publish(checks: Check[], runs: unknown[]) {
  const statuses: { state: string; description: string }[] = [];
  const read = async (path: string) => {
    if (path.includes("/actions/runs?")) return { total_count: runs.length, workflow_runs: runs };
    if (path.includes("/files?")) return [{ filename: "src/lib/a.ts" }];
    if (path.includes("/check-runs?")) return { total_count: checks.length, check_runs: checks };
    return PR_ROW;
  };
  const result = await adapter.publishSecurityMergeDecision({ owner: "craigoley", repo: "remudero", prNumber: PR, expectedHead: HEAD },
    { read, status: async (s: { state: string; description: string }) => { statuses.push(s); }, now: () => NOW_14681 }, undefined);
  return { result, statuses };
}

test("W1-T14681: a configuration-not-found warning with an exact-head analysis still running posts pending", async () => {
  // #20683 b9ae6d7c0: the neutral check landed after the actions and python analyses, while javascript-typescript ran on.
  for (const status of ["queued", "in_progress"]) {
    const { result, statuses } = await publish([warning()], [codeqlRun({ status })]);
    assert.equal(result.decision.reason, REASON, "the decision keeps its own reason");
    assert.equal(result.decision.mergeAllowed, false, "a waiting warning grants nothing");
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]!.state, "pending", `a ${status} CodeQL run`);
    assert.equal(statuses[0]!.description, `unknown: ${REASON}`);
  }
});

test("W1-T14681: a configuration-not-found warning with every analysis complete still posts unknown", async () => {
  const overdue = new Date(NOW_14681 - adapter.CODEQL_RUN_PENDING_BOUND_MS - 1).toISOString();
  const cases: [string, unknown[]][] = [
    ["a completed run", [codeqlRun({ status: "completed" })]],
    ["no run at this head", []],
    ["a run past the bound", [codeqlRun({ run_started_at: overdue })]],
    ["a newer completed re-run over an older running one", [codeqlRun({ id: 2, status: "in_progress" }), codeqlRun({ id: 3, status: "completed" })]],
  ];
  for (const [label, runs] of cases) {
    const { result, statuses } = await publish([warning()], runs);
    assert.equal(result.decision.state, "unknown", label);
    assert.equal(result.decision.reason, REASON, label);
    assert.equal(statuses[0]!.state, "error", label);
  }
  // GitHub's re-judgement after the last analysis is the only way out: the clean check beside a running run is success.
  const cleared = await publish([warning({ id: 2 }), clean({ id: 3 })], [codeqlRun()]);
  assert.equal(cleared.statuses[0]!.state, "success");
});
