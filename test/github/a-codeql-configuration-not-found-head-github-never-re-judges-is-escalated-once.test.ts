// W1-T13663 — at every real "1 configuration not found" head read so far (#15133, #15380 and #17217 twice), GitHub's
// neutral CodeQL check stayed the latest and GitHub never re-judged the unchanged head: recovery came only from a new
// push. W1-T13470 escalates only when a CodeQL workflow run completes again under the standing warning, a re-judgement
// that never came, so the head waited behind the generic backstop with neither receipt nor remedy. This suite pins the
// smaller remedy: a warning captured on an earlier full pass, with no CodeQL run at the head queued, in progress or
// completed after the standing check, is escalated once per head with its receipt, telling the owner to push a new
// commit or re-run CodeQL at this head. The sweep does neither: it makes no GitHub write for this head, and the
// configuration-not-found shape stays UNKNOWN. The sibling success check GitHub created beside the neutral one is never
// read in its place.
//
// Real shapes: PR numbers, head prefixes, check ids, sibling ids and the 364-character summary are GitHub's (read
// 2026-11-18). #15133 c5580fc2 and #17217 ffcf9ce1 are wholly real: full head, the check's completed_at, and the
// codeql.yml run that produced the warning, created before the check and UPDATED AFTER it (the run finishes after
// uploading the analysis), so a later updated_at alone is no new judgement; a run counts as after the check only when
// its attempt BEGAN after it (created_at, or a re-run's restarted run_started_at, modeled equal to created_at for a first
// attempt). Modeled, for the other two heads: the head's
// 32-hex tail, the clock time, and that run (created a minute before the check, updated five minutes after). The shared
// check suite id is modeled everywhere.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
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
const CAPTURED = "security.codeql_configuration_warning_captured";
const ESCALATED = "security.codeql_configuration_warning_escalated";
const TASK = "W1-T13663";
const TAIL = "0".repeat(32);
const OTHER = "f".repeat(40);
const APP = { slug: "github-advanced-security", id: 57789, owner: { login: "github" } };
const SUITE = 42_000_000_001;
const NOW = "2026-11-18T12:00:00Z"; // the sweep clock; the PR was active a minute before, so staleness never decides
const REMEDY = /push a new commit or re-run CodeQL at this head/;

const shift = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString().replace(".000Z", "Z");
/** A warning head: `at` is the neutral check's completed_at; `producer` the codeql.yml run that produced it. */
interface Head { pr: number; sha: string; neutral: number; sibling?: number; at: string; real: boolean;
  producer: { id: number; created: string; updated: string } }
const modeled = (at: string, id: number) => ({ id, created: shift(at, -60), updated: shift(at, 300) });
const HEADS: Head[] = [
  { pr: 15133, sha: "c5580fc2c5fea15b6fe71bf355f757ff6c8027c5", neutral: 123005843755, at: "2026-10-28T18:06:37Z", real: true,
    producer: { id: 40741843229, created: "2026-10-28T18:05:25Z", updated: "2026-10-28T18:13:07Z" } },
  { pr: 15380, sha: `74359b2a${TAIL}`, neutral: 123309453175, sibling: 123309453136, at: "2026-10-29T12:00:00Z", real: false,
    producer: modeled("2026-10-29T12:00:00Z", 40800000001) },
  { pr: 17217, sha: "ffcf9ce1473ac73c092b6ddfbdecde40d09c7cf7", neutral: 128487785238, sibling: 128487785155, at: "2026-11-07T18:20:10Z",
    real: true, producer: { id: 42400648868, created: "2026-11-07T18:18:44Z", updated: "2026-11-07T18:23:57Z" } },
  { pr: 17217, sha: `53df5da8${TAIL}`, neutral: 128592074795, sibling: 128592074708, at: "2026-11-08T12:00:00Z", real: false,
    producer: modeled("2026-11-08T12:00:00Z", 42500000001) },
];
const alerts = (pr: number) => `/craigoley/remudero/security/code-scanning?query=pr%3A${pr}+tool%3ACodeQL+is%3Aopen`;
const link = (pr: number) => `[View all branch alerts](${alerts(pr)}).`;
/** GitHub's summary at those heads, verbatim except the PR number. */
const summary = (pr: number) => "**Warning**: Code scanning cannot determine the alerts introduced by this pull request, because " +
  "1 configuration present on `refs/heads/main` was not found:\n\n### Actions workflow (`codeql.yml`)\n\n" +
  "* :question:&nbsp;&nbsp;`/language:javascript-typescript`\n\n\n" + link(pr);

type Check = Record<string, any>;
const neutral = (h: Head, over: Check = {}): Check => ({ id: h.neutral, name: "CodeQL", head_sha: h.sha, status: "completed",
  conclusion: "neutral", app: APP, check_suite: { id: SUITE }, started_at: h.at, completed_at: h.at,
  output: { title: "1 configuration not found", summary: summary(h.pr) }, ...over });
const success = (h: Head, over: Check = {}): Check => neutral(h, { id: h.sibling, conclusion: "success",
  output: { title: "No new alerts in code changed by this pull request", summary: link(h.pr) }, ...over });
/** The head's check corpus as GitHub lists it: the same-second sibling success (lower id) where one exists, then the neutral. */
const corpus = (h: Head): Check[] => h.sibling === undefined ? [neutral(h)] : [success(h), neutral(h)];
const input = (h: Head, checks: Check[]) => ({ prNumber: h.pr, headSha: h.sha, observedHeadSha: h.sha, filesComplete: true,
  filesHeadSha: h.sha, changedFileCount: 1, files: [{ filename: "src/lib/a.ts" }], checksComplete: true, checksHeadSha: h.sha, checks });
const classify = (x: unknown) => policy.classifyCodeScanningMergePolicy(x) as { state: string; mergeAllowed: boolean; reason: string };
/** A CodeQL workflow run at the head; by default the completed one that produced the warning. */
const run = (h: Head, over: Record<string, unknown> = {}) => ({ id: h.producer.id, run_attempt: 1, head_sha: h.sha, event: "pull_request",
  status: "completed", conclusion: "success", created_at: h.producer.created, run_started_at: h.producer.created,
  updated_at: h.producer.updated, ...over });
const listing = (...runs: unknown[]) => ({ total_count: runs.length, workflow_runs: runs });

const ROOT = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t13663-`));
const CHECKS_FILE = join(ROOT, "check-runs.json"), PULL_FILE = join(ROOT, "pull.json"), RUNS_FILE = join(ROOT, "runs.json");
/** GitHub as `gh` serves it, through the shared PATH shim; each answer is read from a file at call time. */
const shim = ghShim([
  { when: "/check-runs?", stdoutFile: CHECKS_FILE },
  { when: "/files?", stdout: JSON.stringify([{ filename: "src/lib/a.ts" }]) },
  { when: "actions/workflows/codeql.yml/runs", stdoutFile: RUNS_FILE },
  { when: "/pulls/", stdoutFile: PULL_FILE },
], { kind: "w1-t13663-security" });
after(() => {
  rmSync(shim.dir, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});
const effects = sweep.buildSweepEffects({ owner: "craigoley", repo: "remudero", config: { claudeBin: "/usr/bin/true", root: ROOT } as never,
  ledgerPath: join(ROOT, "ledger.ndjson"), runId: "SWEEP-13663", plan: { tasks: [] } as never, log: () => {} });
async function onShim<T>(h: Head, checks: Check[], runs: unknown, body: () => T | Promise<T>): Promise<T> {
  writeFileSync(CHECKS_FILE, JSON.stringify({ total_count: checks.length, check_runs: checks }));
  writeFileSync(PULL_FILE, JSON.stringify({ state: "open", head: { sha: h.sha },
    base: { sha: OTHER, ref: "main", repo: { full_name: "craigoley/remudero" } }, changed_files: 1 }));
  writeFileSync(RUNS_FILE, JSON.stringify(runs));
  const previous = process.env.PATH;
  process.env.PATH = `${shim.dir}:${previous}`;
  try {
    return await body();
  } finally {
    process.env.PATH = previous;
  }
}
/** The read-only adapter over the real transport, as the sweep's wired read calls it. */
const observe = (h: Head, checks: Check[] = corpus(h)) => onShim(h, checks, listing(), async () => (await adapter.readSecurityMergeDecision(
  { owner: "craigoley", repo: "remudero", prNumber: h.pr, expectedHead: h.sha },
  (path: string) => ghJsonAsync(securityMetadataGhArgs(path)))) as SecurityMergeObservation);

const prUrl = (h: Head) => `https://github.com/craigoley/remudero/pull/${h.pr}`;
function view(h: Head, over: Partial<OpenPrView> = {}): OpenPrView {
  return { prNumber: h.pr, prUrl: prUrl(h), taskId: TASK, reviewState: "none", checksState: "red", unmetCriteria: [], priorStrikes: 0,
    lastActivityAt: shift(NOW, -60), headSha: h.sha, headRefName: `run-${TASK}-1795023777217`, autoMergeArmed: false,
    ciFailures: [{ name: "security-merge-policy", logTail: "" }], securityMergePolicy: { state: "unknown", reason: REASON }, ...over };
}

type Escalation = { reason: string; owner: string; labels: string[] };
/** A pass's deps: every arm effect that could act on GitHub fails the test; the observation seams record. */
function harness(prior: Record<string, unknown>[], answer: SecurityMergeObservation, runs: unknown = listing()) {
  const rows: Record<string, unknown>[] = [];
  const calls = { escalated: [] as Escalation[], runsRead: 0 };
  const forbidden = (what: string) => () => assert.fail(`a configuration-not-found wait never ${what}`);
  const deps: SweepDeps = {
    arm: forbidden("arms"), close: forbidden("closes"), dispatchFix: forbidden("dispatches a fix round"),
    postReview: forbidden("posts a review status"), updateBranch: forbidden("updates the branch"),
    requeueCheck: forbidden("re-runs a check"), rerunFailedChecks: forbidden("re-runs failed checks"),
    readyDraft: forbidden("readies a draft"), disarmAutoMerge: forbidden("disarms"),
    escalate: (_pr, reason, question) => {
      calls.escalated.push({ reason, owner: question.taskId, labels: question.resolutions.map((r) => r.label) });
    },
    readSecurityMergeObservation: async () => answer,
    readCodeqlWorkflowRuns: async () => { calls.runsRead++; return runs; },
    ledgerPath: "/nonexistent/rmd-w1-t13663/rows.ndjson", runId: "SWEEP-13663", now: () => Date.parse(NOW),
    readLedger: () => [...prior, ...rows], appendLine: (_path, row) => { rows.push(row); },
    log: (step, extra = {}) => { rows.push({ run_id: "SWEEP-13663", step, ...extra }); },
  };
  return { deps, rows, calls };
}
/** One full sweep pass over the head; it always waits with no fix round. */
async function sweepPass(h: Head, prior: Record<string, unknown>[], answer: SecurityMergeObservation, runs?: unknown) {
  const x = harness(prior, answer, runs);
  await sweep.runSweep([view(h)], x.deps);
  assert.equal(x.rows.some((r) => String(r.step).startsWith("fix.") || r.step === "sweep.fix_dispatch"), false, "no fix round row");
  const disposed = x.rows.filter((r) => r.step === "sweep.disposed");
  assert.equal(disposed.length, 1);
  assert.deepEqual([disposed[0]!.disposition, disposed[0]!.acted, disposed[0]!.blocker], ["wait", false, "security-unknown-hold"]);
  return { ...x, reason: String(disposed[0]!.reason) };
}
/** One direct observation over the head. */
async function pass(h: Head, prior: Record<string, unknown>[], answer: SecurityMergeObservation, runs?: unknown) {
  const x = harness(prior, answer, runs);
  const reason = await sweep.observeCodeqlConfigurationWarning(x.deps, prior, view(h), "wait");
  return { ...x, reason };
}
const escalations = (rows: Record<string, unknown>[]) => rows.filter((r) => r.step === ESCALATED);

test("W1-T13663 criterion 1: a warning captured on an earlier pass, with no CodeQL run pending or completed after it, is escalated once per head with its receipt and the remedy", async () => {
  assert.equal(summary(15133).length, 364, "positive control: the fixture is GitHub's 364-character summary");
  assert.equal(HEADS.filter((h) => h.real).length, 2, "positive control: two wholly real heads");
  for (const h of HEADS) {
    assert.ok(Date.parse(h.producer.created) < Date.parse(h.at) && Date.parse(h.producer.updated) > Date.parse(h.at),
      `${h.pr} ${h.sha.slice(0, 8)}: the producing run is created before its check and updated after it`);
    const answer = await observe(h);
    const receipt = answer.observation?.configurationWarning;
    assert.equal(receipt?.checkId, h.neutral, `${h.pr}: the receipt is the neutral check's`);
    const ledger: Record<string, unknown>[] = [];
    const runs = listing(run(h));
    const first = await sweepPass(h, ledger, answer, runs);
    ledger.push(...first.rows);
    assert.deepEqual([first.calls.escalated.length, ledger.filter((r) => r.step === CAPTURED).length], [0, 1], `${h.pr}: the first pass only captures`);

    const second = await sweepPass(h, ledger, answer, runs);
    ledger.push(...second.rows);
    assert.equal(second.calls.escalated.length, 1, `${h.pr} ${h.sha.slice(0, 8)}: the next full pass escalates the unchanged head ` +
      `(its producing run ${h.producer.id} was updated at ${h.producer.updated}, after the check, and judged nothing new)`);
    const sent = second.calls.escalated[0]!;
    assert.equal(sent.owner, TASK, "the PR's task owns it");
    assert.match(sent.reason, new RegExp(`check ${h.neutral} completed at ${h.at} still reads "1 configuration not found"`));
    assert.match(sent.reason, /GitHub has not re-judged it at this head/);
    assert.match(sent.reason, REMEDY);
    assert.ok(sent.reason.includes(JSON.stringify(receipt)), "the receipt is the evidence");
    assert.deepEqual(sent.labels, ["push a new commit", "re-run CodeQL at this head"]);
    const row = escalations(second.rows);
    assert.deepEqual(row.map((r) => [r.check_id, r.first_check_id, r.workflow_run_id, r.trigger, r.owner, r.receipt]),
      [[h.neutral, h.neutral, null, "never-re-judged", TASK, receipt]]);
    assert.match(second.reason, /GitHub has not re-judged check \d+ at this head — escalated once to W1-T13663/);

    const third = await sweepPass(h, ledger, answer, runs);
    assert.equal(third.calls.escalated.length, 0, "escalated once per head");
    assert.match(third.reason, /already escalated once at this head/);
  }
  // No run listed at the head at all reads the same: nothing will re-judge it.
  const h = HEADS[3]!;
  const answer = await observe(h);
  const captured = (await pass(h, [], answer)).rows;
  for (const runs of [listing(), listing(run(h, { head_sha: OTHER, updated_at: shift(h.at, 600) }))]) {
    const empty = await pass(h, captured, answer, runs);
    assert.deepEqual([empty.calls.escalated.length, escalations(empty.rows).length], [1, 1], JSON.stringify(runs));
    assert.match(empty.calls.escalated[0]!.reason, REMEDY);
  }
});

test("W1-T13663 criterion 2: no escalation on the capturing pass, under a pending or later run, an unread listing or a newer success; the completed-again escalation is unchanged and either one is the head's one", async () => {
  const h = HEADS[2]!;
  const answer = await observe(h);
  const capturing = await pass(h, [], answer, listing());
  assert.deepEqual([capturing.calls.escalated.length, capturing.rows.filter((r) => r.step === CAPTURED).length], [0, 1], "the capturing pass only captures");
  const captured = capturing.rows;
  const elsewhere = captured.map((r) => ({ ...r, head_sha: OTHER }));
  const another = await pass(h, elsewhere, answer, listing());
  assert.deepEqual([another.calls.escalated.length, another.rows.filter((r) => r.step === CAPTURED).length], [0, 1],
    "a capture at another head is not an earlier capture at this one");

  const quiet: Array<[string, unknown]> = [
    ...["queued", "in_progress", "waiting", "requested", "pending"].map((status): [string, unknown] =>
      [`a run ${status}`, listing(run(h),
        run(h, { id: 1, status, conclusion: null, created_at: shift(h.at, -600), updated_at: shift(h.at, 30) }))]),
    ["a run queued with an earlier stamp",
      listing(run(h, { status: "queued", conclusion: null, created_at: shift(h.at, -900), updated_at: shift(h.at, -600) }))],
    ["a new run created after the standing check", listing(run(h), run(h, { id: 2, created_at: shift(h.at, 1), updated_at: shift(h.at, 400) }))],
    // A re-run keeps its created_at (before the check) but restarts run_started_at; its finished attempt may not have
    // produced a visible check yet, so it is not "never re-judged".
    ["a finished re-run begun after the standing check (created_at kept, run_started_at new)",
      listing(run(h, { run_attempt: 2, run_started_at: shift(h.at, 60), updated_at: shift(h.at, 400) }))],
    ["a re-run with an unreadable start time", listing(run(h, { run_started_at: "soon" }))],
    ["a run with an unreadable creation time", listing(run(h, { created_at: "soon" }))],
    ["a run with no creation time", listing({ ...run(h), created_at: undefined })],
    ["a truncated listing", { total_count: 101, workflow_runs: [run(h)] }],
    ["an unreadable listing", { message: "Not Found" }],
    ["no listing", null],
  ];
  for (const [why, runs] of quiet) {
    const x = await pass(h, captured, answer, runs);
    assert.deepEqual([x.calls.escalated.length, escalations(x.rows).length, x.calls.runsRead], [0, 0, 1], `control: ${why}`);
  }
  const unread = harness(captured, answer);
  unread.deps.readCodeqlWorkflowRuns = async () => { throw new Error("HTTP 502"); };
  assert.match(await sweep.observeCodeqlConfigurationWarning(unread.deps, captured, view(h), "wait"), /CodeQL workflow runs unread \(HTTP 502\)$/);
  assert.equal(unread.calls.escalated.length, 0, "control: the runs listing unread");
  const unwired = harness(captured, answer);
  delete unwired.deps.readCodeqlWorkflowRuns;
  assert.equal(await sweep.observeCodeqlConfigurationWarning(unwired.deps, captured, view(h), "wait"), "wait");
  assert.equal(unwired.calls.escalated.length, 0, "control: no runs reader");
  const healed = await observe(h, [...corpus(h), success(h, { id: h.neutral + 1, completed_at: shift(h.at, 300) })]);
  assert.equal(healed.decision.state, "safe", "positive control: a newer success check is GitHub's re-judgement");
  const afterSuccess = await pass(h, captured, healed, listing(run(h)));
  assert.deepEqual([afterSuccess.calls.escalated.length, afterSuccess.calls.runsRead], [0, 0], "control: a newer check reads success");

  // A new warning check on the same head has not been captured just because an older warning was.
  // Its producing run finishes after the check, so W1-T13470's completed-again rule does not fire.
  const newerWarning = await observe(h, [...corpus(h), neutral(h, { id: h.neutral + 2, completed_at: shift(h.at, 600) })]);
  const producingRun = run(h, { updated_at: shift(h.at, 900) });
  const firstForNewCheck = await pass(h, captured, newerWarning, listing(producingRun));
  assert.deepEqual([firstForNewCheck.calls.escalated.length, firstForNewCheck.rows.filter((r) => r.step === CAPTURED)
    .map((r) => r.check_id)], [0, [h.neutral + 2]], "a newer warning is captured before it can be escalated");
  const afterNewCheckCapture = await pass(h, [...captured, ...firstForNewCheck.rows], newerWarning, listing(producingRun));
  assert.equal(afterNewCheckCapture.calls.escalated.length, 1, "the same newer warning escalates on its next pass");

  // W1-T13470's escalation, a CodeQL run that completed again under a standing newer warning, keeps its text and its row.
  const later = await observe(h, [...corpus(h), neutral(h, { id: h.neutral + 1, completed_at: shift(h.at, 240) })]);
  const standing = later.observation!.configurationWarning!;
  const again = run(h, { id: 7001, updated_at: shift(h.at, 120) });
  const old = await pass(h, captured, later, listing(again));
  assert.equal(old.calls.escalated.length, 1);
  assert.equal(old.calls.escalated[0]!.reason, `CodeQL configuration-not-found persists at head ${h.sha.slice(0, 7)} of #${h.pr}: ` +
    `CodeQL workflow run 7001 (attempt 1) completed at ${again.updated_at}, and GitHub's trusted CodeQL check ${h.neutral + 1} ` +
    `completed at ${standing.completedAt} still reads "1 configuration not found" — security-merge-policy stays unknown and no fix ` +
    `round was spent. Receipt: ${JSON.stringify(standing)}`, "W1-T13470's reason, unchanged");
  assert.deepEqual(old.calls.escalated[0]!.labels, ["re-run CodeQL", "file the recovery rule"]);
  assert.deepEqual(escalations(old.rows).map((r) => [r.check_id, r.workflow_run_id, r.workflow_run_attempt, "trigger" in r]),
    [[h.neutral + 1, 7001, 1, false]]);

  // Either escalation is the one per head.
  const afterOld = await pass(h, [...captured, ...old.rows], answer, listing(run(h)));
  assert.deepEqual([afterOld.calls.escalated.length, afterOld.calls.runsRead], [0, 0], "a completed-again escalation is the head's one");
  const fresh = await pass(h, captured, answer, listing(run(h)));
  assert.equal(fresh.calls.escalated.length, 1);
  const afterNew = await pass(h, [...captured, ...fresh.rows], later, listing(again));
  assert.deepEqual([afterNew.calls.escalated.length, afterNew.calls.runsRead], [0, 0], "a never-re-judged escalation is the head's one");

  // A failed escalation keeps its pre-written row, so it is not repeated at this head.
  const refused = harness(captured, answer, listing(run(h)));
  refused.deps.escalate = () => { throw new Error("issues disabled"); };
  assert.match(await sweep.observeCodeqlConfigurationWarning(refused.deps, captured, view(h), "wait"),
    /its escalation to W1-T13663 failed \(issues disabled\) and is not repeated at this head/);
  const retry = await pass(h, [...captured, ...refused.rows], answer, listing(run(h)));
  assert.equal(retry.calls.escalated.length, 0);
});

test("W1-T13663 criterion 3: invariant:no-new-success-path — the real shapes answer unknown, the sibling success is never read in place of the max-id check, the merge guards refuse, and the sweep makes no GitHub write for the head", async () => {
  let siblings = 0;
  for (const h of HEADS) {
    assert.deepEqual(classify(input(h, corpus(h))), { state: "unknown", mergeAllowed: false, reason: REASON }, `${h.pr} ${h.sha.slice(0, 8)}`);
    const observed = await observe(h);
    assert.deepEqual([observed.decision.state, observed.decision.mergeAllowed, observed.decision.reason], ["unknown", false, REASON]);
    assert.equal(observed.observation?.latest?.id, h.neutral, "the max-id check is the one read");
    assert.equal(observed.observation?.configurationWarning?.summary, summary(h.pr), "GitHub's text, verbatim");
    if (h.sibling !== undefined) {
      siblings++;
      assert.ok(h.sibling < h.neutral, "the sibling has the lower id");
      assert.deepEqual(classify(input(h, [success(h)])), { state: "safe", mergeAllowed: true, reason: "trusted-complete-exact-head-no-new-alerts" },
        "positive control: read alone, the sibling would grant — so it must never be read in place of the neutral check");
    }
    await assert.rejects(onShim(h, corpus(h), listing(), () => securityMergeHeadAsync(prUrl(h), undefined, h.sha)),
      (error: { state?: string; reason?: string }) => error.state === "unknown" && error.reason === REASON, "the arm guard refuses the shape");
    await onShim(h, corpus(h), listing(), () => assert.throws(() => securityMergeHead(prUrl(h), (path) => ghJson(securityMetadataGhArgs(path)), h.sha),
      (error: { state?: string; reason?: string }) => error.state === "unknown" && error.reason === REASON, "and so does the sync guard"));
  }
  assert.equal(siblings, 3, "positive control: 3 of the 4 real heads carry the same-second sibling success");

  // The escalating pass over the production read effects and the real transport: every dep it touches is recorded, and
  // every gh call it makes is a GET read.
  const h = HEADS[2]!;
  const answer = await observe(h);
  const captured = (await pass(h, [], answer)).rows;
  const x = harness(captured, answer);
  const touched = new Set<string>();
  const real = { ...x.deps, readSecurityMergeObservation: effects.readSecurityMergeObservation,
    readCodeqlWorkflowRuns: effects.readCodeqlWorkflowRuns } as SweepDeps;
  const watched = new Proxy(real, { get: (target, key) => { touched.add(String(key)); return Reflect.get(target, key); } });
  const mark = shim.calls().length;
  const reason = await onShim(h, corpus(h), listing(run(h)), () => sweep.observeCodeqlConfigurationWarning(watched, captured, view(h), "wait"));
  assert.equal(x.calls.escalated.length, 1, "positive control: this pass escalates");
  assert.match(reason, /escalated once to W1-T13663/);
  const allowed = new Set(["readSecurityMergeObservation", "readCodeqlWorkflowRuns", "escalate", "appendLine", "ledgerPath", "runId"]);
  assert.deepEqual([...touched].filter((key) => !allowed.has(key)), [], "the pass touches no other sweep effect");
  const calls = shim.calls().slice(mark);
  assert.ok(calls.some((call) => call.includes(`/commits/${h.sha}/check-runs?`)), "positive control: the check corpus was read");
  assert.ok(calls.some((call) => call.includes(`actions/workflows/codeql.yml/runs?head_sha=${h.sha}`)), "positive control: the runs were read");
  const writes = calls.filter((call) => /(^| )(-X|--method)( |$)/.test(call) && !/--method GET/.test(call));
  assert.deepEqual(writes, [], "the sweep makes no GitHub write for this head");
  assert.equal(calls.some((call) => /statuses|dispatches|rerun|workflow run|run rerun/.test(call)), false, "no status, no workflow dispatch, no re-run");
});
