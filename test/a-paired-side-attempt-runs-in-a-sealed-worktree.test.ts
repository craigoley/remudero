// test/a-paired-side-attempt-runs-in-a-sealed-worktree.test.ts — W1-T4638: the production dispatcher behind
// W1-T4625's `dispatchAttempt` seam. Every case runs against gitRepo() fixtures in rmd- temp dirs with a fake
// worker spawn, a fixed clock and injected config: nothing here spawns a real worker, reads a real ledger or spends.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildBenchmarkAaReport, parseAaTrialManifest, type AaLedgerEvidence, type AaRow,
  type BenchmarkAaReport } from "../src/lib/benchmark-aa.js";
import { activateBenchmarkPaidPilot, parsePaidPilotRequest, type PaidPilotEvidence, type PaidPilotProtocol } from "../src/lib/benchmark-paid-pilot.js";
import { fixedClock, type Clock } from "../src/lib/clock.js";
import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import {
  gradeHeadWithReviewerExecutor, PAIRED_ATTEMPT_MAX_BUDGET_USD, PAIRED_CLI_REFUSAL, PAIRED_PR_URL_RE, pairedAttemptRoot,
  probeSealedIsolation, runPairedTrial, sealedPairedAttemptDispatcher, SEALED_ATTEMPT_CONTRACT_LINES,
  type PairedAttemptRequest, type PairedTrialInput, type PairedTrialResult, type SealedPairedAttemptOptions,
} from "../src/lib/paired-trial.js";
import type { AcceptanceCriterion, Task } from "../src/lib/plan.js";
import type { TaskCaseFile } from "../src/lib/task-case-file.js";
import type { spawnWorker, SpawnWorkerArgs, WorkerResult, WorkerSelectionAssignment } from "../src/lib/worker.js";
import { runTask } from "../src/run-task.js";
import { gitRepo, type GitRepo } from "./helpers/git-repo.js";

type Row = Record<string, unknown>;
const HOUR = 3_600_000;
const ACT_MS = Math.floor(Date.now() / 1000) * 1000 - 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const ACT = iso(ACT_MS);
const DURING = iso(ACT_MS + 24 * HOUR);
const AA_NOW = iso(ACT_MS - 50 * 60_000);
const SHA = "a".repeat(40);
const CONSENTED = ["fixture-org/alpha", "fixture-org/beta", "fixture-org/gamma"];
const PAID_PIN = { provider: "cash", model: "gpt-oss-120b", effort: "medium" };
const CONTROL_PIN = { provider: "claude", model: "claude-sonnet-5", effort: "high" };
const REVISION_NAMES = ["harnessRevision", "promptRevision", "toolRevision", "scorerRevision", "environmentRevision"];
const HARNESS = { source: "executing-module-git" as const, revision: SHA };
const CRITERIA: AcceptanceCriterion[] = [
  { claim: "the visible marker ships", proof: "grep: PAIRED-OK in notes.txt" },
  { claim: "the hidden marker ships", proof: "grep: HOLDOUT-OK in holdout.txt", holdout: true },
];
const IDENTITY = ["-c", "user.name=fixture worker", "-c", "user.email=worker@remudero.invalid"];
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A bare origin, one seeded commit on main, and the fleet's clone of it: the shape `<root>/repos/<repo>` has. */
function sealedFixture(): { origin: GitRepo; fleet: GitRepo; root: string; base: string } {
  const origin = gitRepo({ bare: true, kind: "sealed-attempt-origin" });
  const seed = gitRepo({ kind: "sealed-attempt-seed" });
  writeFileSync(join(seed.dir, "notes.txt"), "base\n");
  writeFileSync(join(seed.dir, "package.json"), "{\"name\":\"sealed-fixture\",\"private\":true}\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "base");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const fleet = gitRepo({ cloneFrom: origin.dir, kind: "sealed-attempt-fleet" });
  const root = mkdtempSync(join(tmpdir(), "rmd-sealed-attempt-"));
  return { origin, fleet, root, base: fleet.git("rev-parse", "origin/main") };
}

function taskFixture(id = "T-SEALED"): Task {
  return { id, title: "sealed paired attempt fixture", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "low",
    origin: "fixture", files: ["notes.txt"], status: "queued", acceptance: CRITERIA } as unknown as Task;
}

function attemptRequest(arm: "paid" | "control" = "paid"): PairedAttemptRequest {
  return { pilotId: "sealed-pilot", pairId: "pair-0123456789abcdef", taskId: "T-SEALED", arm, position: 0,
    pin: { ...(arm === "paid" ? PAID_PIN : CONTROL_PIN), billing: arm === "paid" ? "api" : "subscription", stackHash: SHA }, revisions: Object.fromEntries(REVISION_NAMES.map((field) => [field, SHA])) as PairedAttemptRequest["revisions"],
    isolation: { worktree: "fresh-detached", push: false, openPr: false, merge: false },
    stackEvidence: { harnessRevision: HARNESS } as PairedAttemptRequest["stackEvidence"] };
}

function workerResult(text = "REPORT\nsealed attempt done\n", extra: Partial<WorkerResult> = {}): WorkerResult {
  return { provider: "cash", sessionId: "sealed-session", costUsd: 0.75, numTurns: 3, text, blocks: [], stderr: "", subtype: "success", isError: false,
    apiError: false, permissionDenials: [], childEnvKeys: [], model: PAID_PIN.model, servedModel: "served-gpt-oss", effort: PAID_PIN.effort,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
    workerDurationMs: 12, ...extra } as WorkerResult;
}

type Behaviour = (args: SpawnWorkerArgs) => Promise<WorkerResult> | WorkerResult;

/** A fake worker that edits the checkout it was spawned in; `then` adds what a misbehaving worker would do. */
function fakeWorker(spawned: SpawnWorkerArgs[], then: Behaviour = () => workerResult()): typeof spawnWorker {
  return async (args) => {
    spawned.push(args);
    writeFileSync(join(args.cwd, "notes.txt"), "PAIRED-OK\n");
    writeFileSync(join(args.cwd, "holdout.txt"), "HOLDOUT-OK\n");
    return then(args);
  };
}

function options(fixture: ReturnType<typeof sealedFixture>, spawn: typeof spawnWorker,
  rest: Partial<SealedPairedAttemptOptions> = {}): SealedPairedAttemptOptions {
  return { task: taskFixture(), config: { claudeBin: "/bin/true", root: fixture.root, installRoot: process.cwd() } as Config,
    repoDir: fixture.fleet.dir, spawn, clock: fixedClock(ACT_MS), installDependencies: (() => "") as never,
    removeTree: (repoDir, dir) => { git(repoDir, "worktree", "remove", "--force", dir); }, ...rest };
}

const registered = (repoDir: string) => git(repoDir, "worktree", "list", "--porcelain");
const branches = (repoDir: string) => git(repoDir, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort();
const remoteRefs = (repoDir: string) => git(repoDir, "ls-remote", "origin");

test("a sealed attempt runs the pinned arm in a fresh detached worktree at the base and returns its head for grading", async () => {
  const fixture = sealedFixture();
  const spawned: SpawnWorkerArgs[] = [];
  const seen: Record<string, string | null> = {};
  const npm: string[] = [];
  const spawn = fakeWorker(spawned, (args) => {
    seen.head = git(args.cwd, "rev-parse", "HEAD");
    seen.attached = spawnSync("git", ["-C", args.cwd, "symbolic-ref", "-q", "HEAD"]).status === 0 ? "attached" : null;
    seen.registered = registered(fixture.fleet.dir);
    return workerResult();
  });
  const branchesBefore = branches(fixture.fleet.dir);
  const remoteBefore = remoteRefs(fixture.fleet.dir);
  const dispatch = sealedPairedAttemptDispatcher(options(fixture, spawn, {
    installDependencies: ((cmd: string, args: string[], opts: { cwd: string }) => { npm.push(`${cmd} ${args.join(" ")} @ ${opts.cwd}`); return ""; }) as never,
  }));
  const result = await dispatch(attemptRequest("paid"));

  assert.equal(spawned.length, 1, "exactly one worker for one attempt");
  const args = spawned[0]!;
  const dir = args.cwd;
  assert.ok(dir.startsWith(`${pairedAttemptRoot(fixture.root)}/`), "cut beside the fleet's worktrees root, not inside it");
  assert.equal(seen.head, fixture.base, "the worker starts at the task's base commit");
  assert.equal(seen.attached, null, "HEAD is detached: no branch was named for the attempt");
  assert.match(String(seen.registered), new RegExp(`worktree ${dir}\\nHEAD ${fixture.base}\\ndetached`), "a real, fresh, detached worktree");
  assert.deepEqual([args.model, args.effort, args.mountProvider], [PAID_PIN.model, PAID_PIN.effort, PAID_PIN.provider], "the pinned arm is spawned");
  assert.equal(args.maxBudgetUsd, PAIRED_ATTEMPT_MAX_BUDGET_USD, "a task budget above the backstop is clamped to it");
  assert.equal(args.onSelectionAssignment, undefined, "no assignment sink: the attempt can write no worker.assignment row");
  assert.ok(args.prompt.endsWith(SEALED_ATTEMPT_CONTRACT_LINES.join("\n")), "the prompt ends with the sealed contract");
  assert.ok(!args.prompt.includes("HOLDOUT-OK"), "a holdout proof never reaches the worker");
  assert.equal(args.env?.GIT_CONFIG_VALUE_0, "sealed-paired-attempt://push-refused");
  assert.deepEqual(npm, [`npm ci @ ${dir}`], "dependencies are primed the way the reviewer primes a checkout");

  assert.equal(result.headDir, dir);
  assert.ok(result.headSha !== null && result.headSha !== fixture.base, "the worker's edits are committed into a new head");
  assert.equal(git(dir, "rev-parse", `${result.headSha}^`), fixture.base, "and that head sits directly on the base");
  assert.deepEqual([result.pushedRef, result.prUrl, result.breach], [null, null, null], "a sealed attempt reports no breach");
  assert.deepEqual([result.servedModel, result.billingMode, result.costUsd], ["served-gpt-oss", "api", 0.75]);
  const grade = gradeHeadWithReviewerExecutor(CRITERIA, result.headDir!);
  assert.equal(grade.verdict, "pass", "the returned head is graded by the reviewer's own executor, holdout included");

  assert.deepEqual(branches(fixture.fleet.dir), branchesBefore, "no branch was written");
  assert.equal(remoteRefs(fixture.fleet.dir), remoteBefore, "nothing was pushed");
  result.cleanup?.();
  assert.equal(existsSync(dir), false, "cleanup removes the worktree");
  assert.ok(!registered(fixture.fleet.dir).includes(dir), "and unregisters it");
  assert.equal(existsSync(join(fixture.root, "tmp", `worker-settings-${dir.split("/").pop()}.json`)), false, "and its settings file");
});

test("both arms of one pair share one base even when origin moves between them", async () => {
  const fixture = sealedFixture();
  const heads: string[] = [];
  const spawn = fakeWorker([], (args) => { heads.push(git(args.cwd, "rev-parse", "HEAD")); return workerResult(); });
  const dispatch = sealedPairedAttemptDispatcher(options(fixture, spawn));
  (await dispatch(attemptRequest("control"))).cleanup?.();
  const mover = gitRepo({ cloneFrom: fixture.origin.dir, kind: "sealed-attempt-mover" });
  writeFileSync(join(mover.dir, "later.txt"), "later\n");
  mover.git("add", "-A");
  mover.git("commit", "--quiet", "-m", "later");
  mover.git("push", "--quiet", "origin", "main");
  fixture.fleet.git("fetch", "--quiet", "origin");
  (await dispatch(attemptRequest("paid"))).cleanup?.();
  assert.deepEqual(heads, [fixture.base, fixture.base]);
});

test("the worktree is removed when the spawn throws, and the failure reaches the trial", async () => {
  const fixture = sealedFixture();
  const spawned: SpawnWorkerArgs[] = [];
  const dispatch = sealedPairedAttemptDispatcher(options(fixture, fakeWorker(spawned, () => { throw new Error("worker spawn refused"); })));
  await assert.rejects(dispatch(attemptRequest("paid")), /worker spawn refused/);
  const dir = spawned[0]!.cwd;
  assert.equal(existsSync(dir), false, "the thrown spawn still removed its worktree");
  assert.ok(!registered(fixture.fleet.dir).includes(dir));
  assert.deepEqual(branches(fixture.fleet.dir), ["refs/heads/main"]);
});

test("an infrastructure refusal returns no head, so the pair is unmeasurable rather than a loss", async () => {
  const fixture = sealedFixture();
  const dispatch = sealedPairedAttemptDispatcher(options(fixture, fakeWorker([], () => workerResult("REPORT\n", { apiError: true }))));
  const result = await dispatch(attemptRequest("control"));
  assert.equal(result.headDir, null);
  assert.equal(result.headSha, fixture.base, "nothing was committed for an attempt that cannot be graded");
  result.cleanup?.();
});

test("the sealed push url refuses an ordinary push from inside the attempt", async () => {
  const fixture = sealedFixture();
  let refused = "";
  const spawn = fakeWorker([], (args) => {
    execFileSync("git", ["-C", args.cwd, ...IDENTITY, "commit", "--quiet", "-am", "worker commit"]);
    try { execFileSync("git", ["-C", args.cwd, "push", "origin", "HEAD:refs/heads/escaped"], { env: { ...process.env, ...args.env }, stdio: "pipe" }); }
    catch (error) { refused = String((error as { stderr?: Buffer }).stderr ?? error); }
    return workerResult();
  });
  const result = await sealedPairedAttemptDispatcher(options(fixture, spawn))(attemptRequest("paid"));
  assert.match(refused, /sealed-paired-attempt/, "git names the sealed url it refused to push to");
  assert.equal(remoteRefs(fixture.fleet.dir).includes("refs/heads/escaped"), false);
  assert.equal(result.pushedRef, null);
  result.cleanup?.();
});

test("a simulated push is an isolation breach: detected from the remote, never taken from the worker's word", async () => {
  const fixture = sealedFixture();
  const spawn = fakeWorker([], (args) => {
    execFileSync("git", ["-C", args.cwd, ...IDENTITY, "commit", "--quiet", "-am", "worker commit"]);
    execFileSync("git", ["-C", args.cwd, "push", "--quiet", fixture.origin.dir, "HEAD:refs/heads/run-T-SEALED-1790000000000"], { stdio: "pipe" });
    execFileSync("git", ["-C", args.cwd, "reset", "--quiet", "--hard", "HEAD^"]);
    return workerResult("REPORT\nnothing pushed, honest\n");
  });
  const result = await sealedPairedAttemptDispatcher(options(fixture, spawn))(attemptRequest("paid"));
  assert.equal(result.pushedRef, "refs/heads/run-T-SEALED-1790000000000", "a push the worker hid by resetting is still found");
  assert.equal(result.headDir, null, "a breached attempt is never graded");
  result.cleanup?.();
});

test("a pull request url, a fleet-branch write and an unreadable remote are each a named breach", async () => {
  const fixture = sealedFixture();
  const pr = await sealedPairedAttemptDispatcher(options(fixture, fakeWorker([], () =>
    workerResult("REPORT\nPR_URL: https://github.com/fixture-org/alpha/pull/77\n"))))(attemptRequest("paid"));
  assert.equal(pr.prUrl, "https://github.com/fixture-org/alpha/pull/77");
  pr.cleanup?.();

  const branched = await sealedPairedAttemptDispatcher(options(fixture, fakeWorker([], (args) => {
    execFileSync("git", ["-C", args.cwd, "checkout", "--quiet", "-b", "run-T-SEALED-1790000000001"]);
    return workerResult();
  })))(attemptRequest("control"));
  assert.equal(branched.breach, "branch-write:refs/heads/run-T-SEALED-1790000000001");
  branched.cleanup?.();

  const detachedBranch = await sealedPairedAttemptDispatcher(options(fixture, fakeWorker([], (args) => {
    execFileSync("git", ["-C", args.cwd, ...IDENTITY, "commit", "--quiet", "-am", "worker commit"]);
    execFileSync("git", ["-C", args.cwd, "branch", "side-copy"]);
    return workerResult();
  })))(attemptRequest("paid"));
  assert.equal(detachedBranch.breach, "branch-write:refs/heads/side-copy", "a branch left pointing at the attempt's commit is a write");
  detachedBranch.cleanup?.();

  const probe = probeSealedIsolation({ repoDir: fixture.fleet.dir, dir: fixture.fleet.dir, base: fixture.base, text: "" });
  assert.equal(probe.breach, "branch-write:refs/heads/main", "the probe reads an attached HEAD as a branch write");
  fixture.fleet.git("remote", "set-url", "origin", join(fixture.root, "no-such-origin"));
  const unread = await sealedPairedAttemptDispatcher(options(fixture, fakeWorker([])))(attemptRequest("paid"));
  assert.equal(unread.breach, "isolation-unverified:remote-unreadable", "isolation the probe cannot verify is not assumed");
  unread.cleanup?.();
});

test("PAIRED_PR_URL_RE matches a pull request url and nothing else", () => {
  assert.equal(PAIRED_PR_URL_RE.test("see https://github.com/o/r/pull/12 for it"), true);
  assert.equal(PAIRED_PR_URL_RE.test("see https://github.com/o/r/issues/12 and refs/pull/12/head"), false);
});

// ── The trial through the sealed dispatcher, and run-task's wiring of it ───────────────────────────────────

function pilotRequest(taskIds: string[]) {
  return {
    version: "benchmark-paid-pilot-request-v1", pilotId: "sealed-paired-1",
    approval: { reference: "#7418", approvedAt: iso(ACT_MS - 52 * HOUR) },
    repos: CONSENTED.map((repo, i) => ({ repo, consentReceipt: `consent-${i}` })),
    pseudonymSalt: "local-salt-7", assignmentSeed: "seed-paired-1",
    arms: { paid: PAID_PIN, control: CONTROL_PIN },
    revisions: Object.fromEntries(REVISION_NAMES.map((field) => [field, SHA])),
    strataRevision: "strata-v1",
    population: taskIds.map((taskId, i) => ({ taskId, repo: CONSENTED[i % 3], taskClass: "fix", risk: "low" })),
    primaryOutcome: "verified-completion", maturityDays: 14,
    protocolText: "Paired pilot: McNemar on discordant pairs, task unit, fixed horizon.\n",
    design: "paired", paired: { samplingRate: 1, maxPairs: 10, shadow: false },
  };
}

function aaRow(step: string, taskId: string, ts: string): AaRow {
  const assignment = step === "worker.assignment";
  return { ts, step, taskId, runId: `${taskId}-1`, assignmentId: assignment ? `${taskId}-a1` : null,
    selectionAssignmentId: assignment ? null : `${taskId}-a1`, selected: { ...CONTROL_PIN },
    stack: Object.fromEntries(REVISION_NAMES.map((field) => [field, { state: "observed", value: SHA }])),
    work: { taskClass: "fix", risk: "low" }, recordedArm: null, routingExperiment: null, success: true,
    servedModel: CONTROL_PIN.model, billingMode: "subscription", costUsd: 0.5, tokensObserved: true, durationObserved: true, retract: false };
}

function caseFile(taskId: string, prNumber: number, asOf: string): TaskCaseFile {
  const at = <T>(value: T) => ({ state: "observed" as const, value, source: "fixture", asOf });
  const gone = (reason: string) => ({ state: "unavailable" as const, reason, source: "fixture", asOf });
  return {
    version: "task-case-file-v1", taskId, asOf,
    plan: at({ title: taskId, dependsOn: [], verify: "auto", risk: "low" }),
    ledger: at({ windowStart: iso(Date.parse(asOf) - 30 * 24 * HOUR), forms: { gzip: 1, plain: 1, live: 1 }, matchingRows: 3 }),
    runs: [{ runId: `${taskId}-1`, startedAt: iso(Date.parse(asOf) - 70 * 60_000), assignmentId: `${taskId}-a1`, selectedProvider: "claude",
      selectedModel: CONTROL_PIN.model, servedModel: CONTROL_PIN.model, billingMode: "subscription", costUsd: 0.5, verdict: "passed", prNumber }],
    pr: at({ number: prNumber, url: `https://example.invalid/pull/${prNumber}`, headSha: SHA, state: "MERGED", taskCredit: true }),
    review: at({ headSha: SHA, status: "success" as const }), acceptance: at({ headSha: SHA, status: "success" as const }),
    ci: at({ headSha: SHA, status: "success" as const }), mergedSource: at({ prNumber, mergedAt: asOf }),
    deployment: gone("not-collected"), runtime: gone("not-collected"), next: null,
  };
}

function aaReport(): BenchmarkAaReport {
  const parsed = parseAaTrialManifest({ version: "benchmark-aa-trial-v1", trialId: "aa-fixture-1", cohort: { kind: "public-fixture" },
    stack: { ...CONTROL_PIN, ...Object.fromEntries(REVISION_NAMES.map((field) => [field, SHA])) }, strataRevision: "strata-v1",
    tasks: Array.from({ length: 10 }, (_, i) => ({ taskId: `AA-T${i + 1}`, taskClass: "fix", risk: "low" })) });
  assert.ok(parsed.ok);
  const ids = parsed.manifest.tasks.map((task) => task.taskId);
  const at = (i: number, seconds: number) => iso(Date.parse(AA_NOW) - 70 * 60_000 + i * 60_000 + seconds * 1000);
  const rows = ids.flatMap((taskId, i) => [aaRow("worker.assignment", taskId, at(i, 0)), aaRow("verdict", taskId, at(i, 30))]);
  const evidence: AaLedgerEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0,
    duplicateRows: 0, ledgerAssignments: ids.length, newestTs: at(ids.length - 1, 30), rows };
  return buildBenchmarkAaReport({ manifest: parsed.manifest, evidence, nowIso: AA_NOW, caseFiles: ids.map((taskId, i) => caseFile(taskId, 500 + i, AA_NOW)) });
}

function pairedProtocol(taskIds: string[]): PaidPilotProtocol {
  const parsed = parsePaidPilotRequest(pilotRequest(taskIds));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  const result = activateBenchmarkPaidPilot({ request: parsed.request, aaReport: aaReport(), nowIso: ACT, existing: [] });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.protocol;
}

const OBSERVED: PaidPilotEvidence = { state: "observed", forms: { gzip: 0, plain: 0, live: 1 }, unreadSources: [], malformedRows: 0,
  duplicateRows: 0, newestTs: null, rows: [] };
const clockDuring: Clock = fixedClock(Date.parse(DURING));
const livePilot = (protocol: PaidPilotProtocol): Partial<PairedTrialInput> => ({ protocols: () => [protocol], clock: clockDuring,
  readEvidence: async () => OBSERVED, readControls: () => ({ state: "observed", paused: false, reason: null, entries: 0, lastAction: null, lastAt: null }),
  harnessRevision: HARNESS });

test("a live pair through the sealed dispatcher is measured, and the trial's own rows are the only ones it writes", async () => {
  const fixture = sealedFixture();
  const protocol = pairedProtocol(["T-SEALED", "PP-T2"]);
  const rows: Row[] = [];
  const spawned: SpawnWorkerArgs[] = [];
  const remoteBefore = remoteRefs(fixture.fleet.dir);
  const result = await runPairedTrial({ ...livePilot(protocol), task: { id: "T-SEALED", acceptance: CRITERIA }, lane: "implement",
    stateDir: join(fixture.root, "state"), log: (step, fields) => { rows.push({ step, ...fields }); },
    dispatchAttempt: sealedPairedAttemptDispatcher(options(fixture, fakeWorker(spawned))) });
  assert.equal(result.state, "measured", JSON.stringify(result));
  assert.deepEqual(spawned.map((args) => args.model).sort(), [CONTROL_PIN.model, PAID_PIN.model].sort(), "both pinned arms ran");
  assert.ok(rows.every((row) => String(row.step).startsWith("paired_trial.")), rows.map((row) => row.step).join(","));
  assert.equal(rows.filter((row) => row.step === "worker.assignment").length, 0, "no worker.assignment row for the task");
  assert.ok(spawned.every((args) => !existsSync(args.cwd)), "every attempt's worktree is gone once the pair settles");
  assert.deepEqual(branches(fixture.fleet.dir), ["refs/heads/main"]);
  assert.equal(remoteRefs(fixture.fleet.dir), remoteBefore, "and nothing reached the remote");
});

test("a simulated push through the trial makes the pair unmeasurable and names the escaped ref", async () => {
  const fixture = sealedFixture();
  const protocol = pairedProtocol(["T-SEALED", "PP-T2"]);
  const rows: Row[] = [];
  const spawn = fakeWorker([], (args) => {
    execFileSync("git", ["-C", args.cwd, ...IDENTITY, "commit", "--quiet", "-am", "worker commit"]);
    execFileSync("git", ["-C", args.cwd, "push", "--quiet", fixture.origin.dir, "HEAD:refs/heads/escaped-attempt"], { stdio: "pipe" });
    return workerResult();
  });
  const result = await runPairedTrial({ ...livePilot(protocol), task: { id: "T-SEALED", acceptance: CRITERIA }, lane: "implement",
    stateDir: join(fixture.root, "state"), log: (step, fields) => { rows.push({ step, ...fields }); },
    dispatchAttempt: sealedPairedAttemptDispatcher(options(fixture, spawn)) });
  assert.equal(result.state, "unmeasurable");
  assert.ok(result.state === "unmeasurable" && result.reasons.some((reason) => reason.startsWith("isolation-breach:")), JSON.stringify(result));
  const attempt = rows.find((row) => row.step === "paired_trial.attempt")?.paired_trial as Row;
  assert.equal(attempt.isolation_breach, "refs/heads/escaped-attempt");
});

/** A throwaway origin, seed and plan for driving the REAL runTask through recon and implement. */
function dispatchFixture(taskId: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-sealed-dispatch-"));
  const origin = gitRepo({ bare: true, kind: "sealed-dispatch-origin" });
  const seed = gitRepo({ kind: "sealed-dispatch-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "--quiet", origin.dir, join(root, "repos", "remudero")]);
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `- id: ${taskId}\n  title: sealed dispatch fixture\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n`
    + "  risk: medium\n  origin: fixture\n  files: [src/lib/daemon.ts]\n  status: queued\n");
  return { root, planPath, cleanup: () => { seed.cleanup(); origin.cleanup(); } };
}

async function dispatchedRun(taskId: string, pairedTrial: Partial<PairedTrialInput>, host?: "daemon") {
  const fixture = dispatchFixture(taskId);
  const normal: string[] = [];
  const side: SpawnWorkerArgs[] = [];
  const assignment: WorkerSelectionAssignment = {
    version: 1, id: "sealed-normal-1", phase: "pre-execution", requested: { model: "requested-model", effort: "high", maxTurns: null },
    selected: { provider: "codex", model: "selected-model", effort: "high" },
    routing: { mode: "multi-provider", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } }, candidates: [],
  };
  const spawn: typeof spawnWorker = async (args) => {
    args.onSelectionAssignment?.(assignment);
    if (args.cwd.startsWith(pairedAttemptRoot(fixture.root))) return fakeWorker(side)(args);
    normal.push(String(args.model));
    return workerResult(normal.length === 1 ? "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n" : "REPORT\nno PR opened\n",
      { provider: "codex", selectionAssignmentId: assignment.id });
  };
  let settle: (result: PairedTrialResult) => void = () => {};
  const trialEnded = new Promise<PairedTrialResult>((resolve) => { settle = resolve; });
  try {
    await withLiveWritesAllowed(() => runTask(taskId, {
      skipGitSync: true, planPath: fixture.planPath,
      config: { claudeBin: "/bin/true", root: fixture.root, installRoot: process.cwd() } as Config,
      benchmarkStackEvidence: { harnessRevision: HARNESS },
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      spawn,
      containmentExec: async (token) => ({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
      pairedTrial: { ...pairedTrial, settled: settle },
      ...(host === undefined ? {} : { pairedTrialHost: host }),
    }));
    const trial = await trialEnded;
    const rows = readFileSync(join(fixture.root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
    return { trial, rows, side, attemptsLeft: existsSync(pairedAttemptRoot(fixture.root)) ? git(join(fixture.root, "repos", "remudero"), "worktree", "list") : "" };
  } finally {
    fixture.cleanup();
  }
}

test("the daemon's run wires the sealed dispatcher; a CLI run refuses the pair by name", async () => {
  const taskId = "T-SEALED-DISPATCH";
  const protocol = pairedProtocol([taskId, "PP-T2"]);
  const grade: PairedTrialInput["grade"] = ({ headDir }) => gradeHeadWithReviewerExecutor(CRITERIA, headDir);
  const daemon = await dispatchedRun(taskId, { ...livePilot(protocol), grade }, "daemon");
  assert.equal(daemon.trial.state, "measured", JSON.stringify(daemon.trial));
  assert.deepEqual(daemon.side.map((args) => args.model).sort(), [CONTROL_PIN.model, PAID_PIN.model].sort(), "the pinned arms ran through run-task's spawn");
  assert.ok(!daemon.attemptsLeft.includes(pairedAttemptRoot("")), "no sealed worktree outlives its pair");
  const assignmentsOf = (rows: Row[]) => rows.filter((row) => row.step === "worker.assignment").length;

  const cli = await dispatchedRun(taskId, { ...livePilot(protocol), grade });
  assert.equal(cli.trial.state, "refused");
  assert.ok(cli.trial.state === "refused" && cli.trial.reasons.includes(PAIRED_CLI_REFUSAL), JSON.stringify(cli.trial));
  assert.equal(cli.side.length, 0, "a CLI run never spawns a side attempt");
  assert.equal(assignmentsOf(daemon.rows), assignmentsOf(cli.rows), "the side attempts wrote no worker.assignment of their own");
});
