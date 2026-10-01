/**
 * W1-T4435: the fleet prices its own slowest gate. A ci-friction gardener (a gardener.ts spec)
 * prices every extra-head cause in PR MINUTES — never fire count, the module's own falsifier — and
 * drafts a parked task for the costliest cause nothing already tracks.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  GARDEN_FILING_ESCALATE_AT,
  GARDEN_FILING_RETRY_BASE_MS,
  GARDEN_LEDGER_BUCKET_MS,
  gardenStatePath,
  readGardenState,
  runGarden,
  type GardenCheckout,
} from "../src/lib/gardener.js";
import type { Escalation } from "../src/lib/escalate.js";
import type { DaemonDeps, DaemonSummary } from "../src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { daemonCommand } from "../src/run-task.js";
import { rule15SplitViolation } from "../src/lib/ci-parity.js";
import { criterionFieldTampered, planOnlyDiff } from "../src/lib/review.js";
import {
  appendCiFrictionTrendRow,
  CI_FRICTION_GARDEN_CLASSES,
  CI_FRICTION_HALF_LIFE_MS,
  ciFailureSignature,
  ciFrictionRecencyWeight,
  refusalReasonKey,
  ciCheckFamily,
  CI_FRICTION_REMEDIES_FILE,
  ciFrictionGardenLogPath,
  ciFrictionCauseKey,
  ciFrictionGardenSpec,
  ciFrictionOrigin,
  ciFrictionRecordVerdict,
  ciFrictionRoundsFromLedger,
  readCiFrictionLedgerRecords,
  ciFrictionShardYaml,
  costliestUntrackedCause,
  freshCiFrictionPlanOrigins,
  priceCiFrictionCauses,
  PR_URL_RE,
  readGateFireRateReport,
  runPrIndex,
  type CiFrictionGardenSources,
} from "../src/lib/ci-friction-gardener.js";
import type { GardenerDeps } from "../src/lib/gardener.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { gateFireRatesPath, type GateFireRateReport } from "../src/lib/gate-fire-rate.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { gitRepo } from "./helpers/git-repo.js";

test("the ci-friction origin census sees a merged filing while the daemon checkout trails main", () => {
  const author = gitRepo({ kind: "ci-friction-author" });
  const remote = gitRepo({ kind: "ci-friction-remote", bare: true });
  mkdirSync(join(author.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(author.dir, "plan", "tasks.d", "baseline.yaml"), "- id: W1-T1\n  origin: baseline\n");
  author.git("add", "plan/tasks.d");
  author.git("commit", "-q", "-m", "seed plan");
  author.addRemote("origin", remote.dir);
  author.git("push", "-q", "origin", "main");
  const daemon = gitRepo({ kind: "ci-friction-daemon", cloneFrom: remote.dir });
  const staleHead = daemon.git("rev-parse", "HEAD");

  writeFileSync(join(author.dir, "plan", "tasks.d", "filing.yaml"),
    '- id: W1-T2\n  origin: "ci-friction:fix_refusal:the-worker-changed-nothing"\n');
  author.git("add", "plan/tasks.d/filing.yaml");
  author.git("commit", "-q", "-m", "file priced cause");
  author.git("push", "-q", "origin", "main");

  assert.deepEqual(freshCiFrictionPlanOrigins(daemon.dir), ["ci-friction:fix_refusal:the-worker-changed-nothing"]);
  assert.equal(daemon.git("rev-parse", "HEAD"), staleHead, "read the fetched tree without changing the daemon checkout");
  daemon.git("remote", "set-url", "origin", join(daemon.dir, "missing-origin"));
  assert.throws(() => freshCiFrictionPlanOrigins(daemon.dir), "an unreadable remote cannot become an empty origin set");
});

test("readGateFireRateReport returns only a present, parseable persisted report", () => {
  const root = gitRepo({ kind: "w1t4435-gate-fire-rate-report" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const reportPath = gateFireRatesPath(stateDir);
  const report: GateFireRateReport = {
    status: "measured",
    prsScanned: 1,
    gates: [],
    neverFired: [],
    alwaysFired: [],
  };

  assert.equal(readGateFireRateReport(stateDir), undefined, "absence is no report, not a guessed zero");
  writeFileSync(reportPath, JSON.stringify(report));
  assert.deepEqual(readGateFireRateReport(stateDir), report);
  writeFileSync(reportPath, "{");
  assert.equal(readGateFireRateReport(stateDir), undefined, "malformed persisted evidence degrades to unknown");
});

test("W1-T4435: the gardener prices each cause in PR minutes", () => {
  // A FREQUENT, CHEAP check: ten one-minute rounds against pull request 1's `pr.opened`.
  const cheapRounds: LedgerRecord[] = [
    { step: "pr.opened", run_id: "run-cheap", pr_url: "https://github.com/acme/remudero/pull/1", ts: "2026-09-24T00:00:00.000Z" },
  ];
  for (let i = 0; i < 10; i++) {
    const mm = String(i + 1).padStart(2, "0");
    cheapRounds.push({ step: "fix.dispatch", run_id: "run-cheap", mode: "reviewer-unmet", round: i + 1, ts: `2026-09-24T00:${mm}:00.000Z` });
  }
  // A RARE, EXPENSIVE round: one merge conflict costing 25 minutes on pull request 2.
  const expensiveRound: LedgerRecord[] = [
    { step: "pr.opened", run_id: "run-rare", pr_url: "https://github.com/acme/remudero/pull/2", ts: "2026-09-24T01:00:00.000Z" },
    { step: "fix.dispatch", run_id: "run-rare", mode: "merge-conflict", round: 1, ts: "2026-09-24T01:25:00.000Z" },
  ];
  const rounds = ciFrictionRoundsFromLedger([...cheapRounds, ...expensiveRound]);
  const priced = priceCiFrictionCauses(rounds);
  // THE FALSIFIER: ranked by fire count, the ten-round cheap check would come first. Ranked by
  // minutes lost, the one rare round that cost 25 minutes must outrank it.
  assert.equal(priced[0]!.cause.kind, "conflict");
  assert.equal(priced[0]!.minutes, 25);
  assert.equal(priced[0]!.rounds, 1);
  const cheap = priced.find((p) => p.cause.kind === "check")!;
  assert.equal(cheap.rounds, 10);
  assert.equal(cheap.minutes, 10);
  assert.ok(priced[0]!.minutes > cheap.minutes, "the rare 25-minute cause outranks the frequent one-minute one");

  // A round whose commit was refused buys no progress: it is priced as `fix_refusal`, not as
  // whatever mode triggered it, and a persisted GateFireRateReport prices `check` causes by name.
  const refused: LedgerRecord[] = [
    { step: "pr.opened", run_id: "run-refused", pr_url: "https://github.com/acme/remudero/pull/3", ts: "2026-09-24T02:00:00.000Z" },
    { step: "fix.dispatch", run_id: "run-refused", mode: "ci-log", round: 1, ts: "2026-09-24T02:03:00.000Z" },
    { step: "fix.commit_refused", run_id: "run-refused", round: 1, reason: "diff exceeds declared scope", ts: "2026-09-24T02:03:00.000Z" },
    // main merged in: a base refresh, named by the shared file it blames.
    { step: "fix.base_refreshed", run_id: "run-refused", matching_base_files: ["src/lib/shared.ts"], ts: "2026-09-24T02:33:00.000Z" },
  ];
  const withRefusal = priceCiFrictionCauses(ciFrictionRoundsFromLedger(refused));
  const refusal = withRefusal.find((p) => p.cause.kind === "fix_refusal");
  assert.equal(refusal?.cause.name, "diff-exceeds-declared-scope", "named by its reason, so each harness refusal is its own cause");
  assert.equal(refusal?.minutes, 3);
  const mainMerge = withRefusal.find((p) => p.cause.kind === "main_merge");
  assert.equal(mainMerge?.cause.name, "src/lib/shared.ts");
  assert.equal(mainMerge?.minutes, 30);
  // The `ci-log` dispatch is entirely superseded by the refusal — no double count for one round.
  assert.equal(withRefusal.find((p) => p.cause.kind === "check" && p.cause.name === "ci-log"), undefined);

  // A GateFireRateReport's own measured minutes price `check` causes by real gate name.
  const gateFireRates: GateFireRateReport = {
    status: "measured",
    prsScanned: 5,
    gates: [{ gate: "ci", prs: 3, runs: 6, redRuns: 2, refusals: 2, repaired: 2, overridden: 0, minutes: 40 }],
    neverFired: [],
    alwaysFired: [],
  };
  const priced2 = priceCiFrictionCauses([], gateFireRates);
  assert.deepEqual(priced2, [{ cause: { kind: "check", name: "ci" }, minutes: 40, rounds: 2, prs: 3 }]);

  // A run this cannot attribute to a pull request contributes no round, never a guess.
  assert.equal(runPrIndex([{ step: "pr.opened", run_id: "orphan", ts: "2026-09-24T00:00:00.000Z" }]).size, 0);
});

test("W1-T4435: PR_URL_RE accepts a pull request URL and rejects everything else", () => {
  // unhealthy arm: a GitHub URL with no `/pull/<n>` suffix names no pull request.
  assert.equal(PR_URL_RE.test("https://github.com/acme/remudero/issues/2"), false);
  // healthy arm, distinguishable: the very same host, matched once the suffix is a pull request.
  assert.equal(PR_URL_RE.test("https://github.com/acme/remudero/pull/2"), true);
});

test("W1-T4435: the costliest untracked cause becomes a drafted task", async () => {
  const tracked = { cause: { kind: "check" as const, name: "ci" }, minutes: 90, rounds: 9, prs: 4 };
  const untracked = { cause: { kind: "main_merge" as const, name: "src/lib/shared.ts" }, minutes: 30, rounds: 1, prs: 1 };
  const priced = [tracked, untracked];

  // Its origin is already on a queued task — the costliest cause is skipped in favour of the next.
  assert.equal(costliestUntrackedCause(priced, [ciFrictionOrigin(tracked.cause)]), untracked);
  assert.equal(costliestUntrackedCause(priced, [ciFrictionOrigin(tracked.cause), ciFrictionOrigin(untracked.cause)]), undefined);

  // The rendered shard is a real, lintable plan record — parked for a person, Law 5's mark riding it.
  const yaml = ciFrictionShardYaml(untracked, "W1-T9001");
  assert.match(yaml, /^- id: W1-T9001$/m);
  assert.match(yaml, /^ {2}verify: human$/m);
  assert.match(yaml, /^ {2}author_class: machine$/m);
  assert.match(yaml, new RegExp(`^ {2}origin: "ci-friction:main_merge:src/lib/shared\\.ts"$`, "m"));
  assert.match(yaml, new RegExp(`proof: "grep: ${ciFrictionOrigin(untracked.cause)} in ${CI_FRICTION_REMEDIES_FILE}"`));
  const verdict = ciFrictionRecordVerdict(yaml, "test");
  assert.equal(verdict.ok, true, verdict.reason);

  const malformed = ciFrictionRecordVerdict("- id: [", "malformed");
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /^unparseable:/);

  // Wired end-to-end through the gardener framework: ONE class, judged by whether its PR merges,
  // and the SAME pass writes the trend row into the state dir — never into the filing PR.
  const repo = gitRepo({ kind: "w1t4435" });
  const root = repo.dir;
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, ".remudero"), { recursive: true });
  writeFileSync(join(root, ".remudero", "layout.json"), JSON.stringify({ planDir: "roadmap" }));

  type Landed = { paths: string[]; title: string; body: string };
  const landed: Landed[] = [];
  let minted = 0;
  const deps: GardenerDeps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({ root, branch: "ci-friction-garden-test", land: (opts) => (landed.push(opts), "https://github.com/acme/remudero/pull/99"), dispose: () => {} }),
    log: () => {},
    seed: 1,
    // The pass runs just after its own rounds, so recency weighting leaves them whole.
    clock: clockFromMillisFn(() => Date.parse("2026-09-24T01:30:00.000Z")),
  };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => [
      { step: "pr.opened", run_id: "run-1", pr_url: "https://github.com/acme/remudero/pull/2", ts: "2026-09-24T01:00:00.000Z" },
      { step: "fix.base_refreshed", run_id: "run-1", matching_base_files: ["src/lib/shared.ts"], ts: "2026-09-24T01:30:00.000Z" },
    ],
    gateFireRates: () => ({
      status: "measured",
      prsScanned: 4,
      gates: [{ gate: "ci", prs: 4, runs: 9, redRuns: 9, refusals: 9, repaired: 9, overridden: 0, minutes: 90 }],
      neverFired: [],
      alwaysFired: [],
    }),
    planOrigins: () => [ciFrictionOrigin(tracked.cause)],
    mintTaskId: (branch) => (assert.equal(branch, "ci-friction-garden-test"), `W1-T900${++minted}`),
  };

  const spec = ciFrictionGardenSpec(deps, sources);
  assert.deepEqual(Object.keys(spec.review ?? {}), ["draft"], "filing a task is a person's call, judged by its PR");
  assert.deepEqual([...CI_FRICTION_GARDEN_CLASSES], ["draft"]);

  const pass = runGarden(spec, deps);
  assert.deepEqual(pass.plan?.acting, ["draft"]);
  assert.equal(pass.plan?.actions[0]?.target, ciFrictionCauseKey(untracked.cause));
  assert.equal(landed.length, 1);
  assert.equal("review" in landed[0]!, false, "never held or drafted — reviewed and auto-merges like every fleet PR");
  assert.match(landed[0]!.body, /^\*\*Judged by its outcome\.\*\* The ci-friction gardener's `draft` changes are judged by whether this PR merges/);

  const relPath = landed[0]!.paths.find((p) => p.startsWith("roadmap/tasks.d/"))!;
  assert.match(relPath, /^roadmap\/tasks\.d\/W1-T9001-main-merge/);
  const shard = readFileSync(join(root, relPath), "utf8");
  assert.match(shard, /^- id: W1-T9001$/m);
  assert.match(shard, new RegExp(`^ {2}origin: "${ciFrictionOrigin(untracked.cause).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`, "m"));
  assert.match(landed[0]!.body, new RegExp(`proof: grep: ${ciFrictionOrigin(untracked.cause)} in ${relPath}`));

  assert.deepEqual(landed[0]!.paths, [relPath], "the filing PR carries the shard alone");
  const log = readFileSync(ciFrictionGardenLogPath(deps.stateDir), "utf8");
  assert.match(log, /\| pass \| total PR minutes \| costliest cause \|/);
  // 90 (ci) + 30 (main_merge) = 120 total priced this pass, topped by the check gate-fire-rate priced higher.
  assert.match(log, /\| 2026-.*\| 120 \| check:ci \(90m\) \|/);
  assert.ok(landed[0]!.body.includes(`grep: ${ciFrictionOrigin(untracked.cause)} in ${CI_FRICTION_REMEDIES_FILE}`), "the body names the proof that will carry the shard's criterion");
});

test("W1-T4435: the gardener preserves an existing trend log while appending a new pass", () => {
  const root = gitRepo({ kind: "w1t4435-existing-garden-log" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const priorLog = "# prior garden receipt\n| prior row |\n";
  writeFileSync(ciFrictionGardenLogPath(stateDir), priorLog);

  const landed: Array<{ paths: string[]; title: string; body: string }> = [];
  const deps: GardenerDeps = {
    stateDir,
    repoRoot: root,
    openWorkspace: () => ({
      root,
      branch: "ci-friction-garden-test",
      land: (opts) => (landed.push(opts), "https://github.com/acme/remudero/pull/100"),
      dispose: () => {},
    }),
    log: () => {},
    seed: 1,
  };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => [
      { step: "pr.opened", run_id: "run-existing-log", pr_url: "https://github.com/acme/remudero/pull/5", ts: "2026-09-24T04:00:00.000Z" },
      { step: "fix.dispatch", run_id: "run-existing-log", mode: "merge-conflict", round: 1, ts: "2026-09-24T04:25:00.000Z" },
    ],
    planOrigins: () => [],
    mintTaskId: (branch) => (assert.equal(branch, "ci-friction-garden-test"), "W1-T9003"),
  };

  const pass = runGarden(ciFrictionGardenSpec(deps, sources), deps);
  assert.deepEqual(pass.plan?.acting, ["draft"]);
  assert.equal(landed.length, 1);
  const appendedLog = readFileSync(ciFrictionGardenLogPath(stateDir), "utf8");
  assert.ok(appendedLog.startsWith(priorLog), "the previous trend receipt must be retained");
  assert.equal(appendedLog.trim().split("\n").filter((line) => line.startsWith("| 2026-")).length, 1);
  // An unchanged pricing appends nothing: the log records the total MOVING, not every look.
  appendCiFrictionTrendRow(ciFrictionGardenLogPath(stateDir), "2026-09-30T00:00:00.000Z", pass.scorecard!.priced as never);
  assert.equal(readFileSync(ciFrictionGardenLogPath(stateDir), "utf8"), appendedLog);
});

test("W1-T4767: an unreadable ledger fails the garden pass without a zero scorecard", () => {
  const root = gitRepo({ kind: "w1t4767-unreadable-garden" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const archive = join(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson");
  writeFileSync(archive, "");
  const events: string[] = [];
  const deps: GardenerDeps = {
    stateDir, repoRoot: root,
    openWorkspace: () => { throw new Error("no action should be filed"); },
    log: (step) => { events.push(step); },
  };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => readCiFrictionLedgerRecords(stateDir),
    planOrigins: () => [],
    mintTaskId: () => { throw new Error("no task should be minted"); },
  };
  const spec = ciFrictionGardenSpec(deps, sources);
  assert.deepEqual(runGarden(spec, deps).scorecard?.causes, 0);
  const statePath = gardenStatePath(stateDir, "ci-friction");
  const previous = readFileSync(statePath, "utf8");
  writeFileSync(join(stateDir, "ledger.2026-01-02T00-00-00-000Z.ndjson.gz"), "invalid gzip");
  assert.throws(() => runGarden(spec, deps), /ci-friction ledger union unreadable: unread ledger file/);
  assert.equal(readFileSync(statePath, "utf8"), previous, "failed evidence leaves the prior pass receipt intact");
  assert.deepEqual(events, ["ci-friction.scorecard"], "a failed read emits no clean scorecard or task");
});

test("W1-T4767: a readable empty ledger remains a valid measured input", () => {
  const root = gitRepo({ kind: "w1t4767-empty-ledger" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  assert.throws(() => readCiFrictionLedgerRecords(stateDir), /no ledger rotations/);
  writeFileSync(join(stateDir, "ledger.2026-01-01T00-00-00-000Z.ndjson"), "");
  assert.deepEqual(readCiFrictionLedgerRecords(stateDir), []);
});

test("a growing live ledger does not re-read the ci-friction union within the hour", () => {
  const root = gitRepo({ kind: "ci-friction-ledger-bucket" }).dir;
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const livePath = join(stateDir, "ledger.ndjson");
  writeFileSync(livePath, '{"step":"daemon.alive"}\n');
  let nowMs = Date.UTC(2026, 8, 29, 11, 0, 0);
  let reads = 0;
  const deps: GardenerDeps = {
    stateDir,
    repoRoot: root,
    openWorkspace: () => assert.fail("nothing to land"),
    log: () => {},
    seed: 1,
    clock: clockFromMillisFn(() => nowMs),
  };
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => (reads++, []),
    planOrigins: () => [],
    mintTaskId: () => assert.fail("nothing to mint"),
  };
  const spec = ciFrictionGardenSpec(deps, sources);

  runGarden(spec, deps);
  assert.equal(reads, 1, "the first pass reads the union");
  for (let minute = 1; minute <= 3; minute++) {
    writeFileSync(livePath, readFileSync(livePath, "utf8") + `{"step":"daemon.alive","n":${minute}}\n`);
    nowMs += 60_000;
    runGarden(spec, deps);
  }
  assert.equal(reads, 1, "a live ledger that only grew must not re-read the whole union every poll");

  renameSync(livePath, join(stateDir, "previous-live.txt"));
  writeFileSync(livePath, '{"step":"daemon.alive"}\n');
  runGarden(spec, deps);
  assert.equal(reads, 2, "replacing the live file is a new evidence source even within the hour");

  nowMs += GARDEN_LEDGER_BUCKET_MS;
  runGarden(spec, deps);
  assert.equal(reads, 3, "the next hour's pass still reads the union");
});

// ── The filing loop closes: plan-only shape, retry on failure, a stale pass re-files ─────────

function frictionFixture(kind: string, land: GardenCheckout["land"], extra: Partial<GardenerDeps> = {}) {
  const repo = gitRepo({ kind });
  const stateDir = join(repo.dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const events: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let minted = 0;
  const deps: GardenerDeps = {
    stateDir,
    repoRoot: repo.dir,
    openWorkspace: () => ({ root: repo.dir, branch: "ci-friction-garden-1", land, dispose: () => {} }),
    log: (step, e) => { events.push({ step, extra: e }); },
    seed: 1,
    ...extra,
  };
  let origins: string[] = [];
  const sources: CiFrictionGardenSources = {
    ledgerRecords: () => [],
    gateFireRates: () => ({
      status: "measured",
      prsScanned: 19,
      gates: [{ gate: "reviewer-unmet", prs: 19, runs: 26, redRuns: 26, refusals: 26, repaired: 26, overridden: 0, minutes: 465.7 }],
      neverFired: [],
      alwaysFired: [],
    }),
    planOrigins: () => origins,
    mintTaskId: () => `W1-T95${String(++minted).padStart(2, "0")}`,
  };
  return { repo, deps, events, sources, spec: ciFrictionGardenSpec(deps, sources), track: (o: string[]) => { origins = o; } };
}

test("a ci-friction filing lands as a plan-only diff the Rule 15 precheck passes", () => {
  let diff = "";
  let base = "";
  const fx = frictionFixture("ci-friction-rule15", (opts) => {
    fx.repo.git("add", "--", ...opts.paths);
    fx.repo.git("commit", "-q", "-m", opts.title);
    diff = fx.repo.git("diff", base, "HEAD");
    return "https://github.com/acme/remudero/pull/7";
  });
  base = fx.repo.git("rev-parse", "HEAD");
  const pass = runGarden(fx.spec, fx.deps);
  assert.equal(pass.prUrl, "https://github.com/acme/remudero/pull/7");
  assert.ok(criterionFieldTampered(diff), "the filing really adds a criterion, so the precheck is not vacuous");
  assert.equal(rule15SplitViolation(diff).refused, false, "a shard-only filing is the plan-only shape Rule 15 exempts");
  assert.ok(planOnlyDiff(diff));
});

test("a failed ci-friction filing push leaves the finding eligible to retry after a backoff", () => {
  let nowMs = Date.UTC(2026, 8, 25, 15, 27, 0);
  let failNext = true;
  const landed: string[][] = [];
  const fx = frictionFixture("ci-friction-retry", (opts) => {
    if (failNext) throw new Error("rule15-precheck: THIS DIFF WILL BE REFUSED under Standing rule 15");
    landed.push(opts.paths);
    return "https://github.com/acme/remudero/pull/8";
  }, { clock: clockFromMillisFn(() => nowMs) });

  const failed = runGarden(fx.spec, fx.deps);
  assert.equal(failed.prUrl, undefined);
  const statePath = gardenStatePath(fx.deps.stateDir, "ci-friction");
  const afterFailure = readGardenState(statePath, CI_FRICTION_GARDEN_CLASSES);
  assert.equal(afterFailure.lastPass, undefined, "a failed filing records no pass");
  assert.equal(afterFailure.filingFailures?.count, 1);
  const row = fx.events.find((e) => e.step === "ci-friction.garden_filing_failed");
  assert.match(String(row?.extra?.reason), /rule15-precheck/, "the ledger carries the failure's reason");

  failNext = false;
  assert.equal(runGarden(fx.spec, fx.deps).ran, false, "the retry waits out its backoff");
  nowMs += GARDEN_FILING_RETRY_BASE_MS;
  const retried = runGarden(fx.spec, fx.deps);
  assert.equal(retried.prUrl, "https://github.com/acme/remudero/pull/8", "the same finding is filed on retry");
  assert.equal(landed.length, 1);
  const settled = readGardenState(statePath, CI_FRICTION_GARDEN_CLASSES);
  assert.equal(settled.filingFailures, undefined, "a landing ends the failure streak");
  assert.equal(settled.lastPass?.landed, "https://github.com/acme/remudero/pull/8");
});

test("a third consecutive failed filing escalates to a person", () => {
  let nowMs = Date.UTC(2026, 8, 25, 15, 27, 0);
  const raised: Escalation[] = [];
  const fx = frictionFixture("ci-friction-escalate", () => { throw new Error("push refused"); }, {
    clock: clockFromMillisFn(() => nowMs),
    escalate: (e) => (raised.push(e), "https://github.com/acme/remudero/issues/1"),
  });
  for (let attempt = 1; attempt <= GARDEN_FILING_ESCALATE_AT + 1; attempt++) {
    runGarden(fx.spec, fx.deps);
    nowMs += GARDEN_FILING_RETRY_BASE_MS * 2 ** attempt;
  }
  assert.equal(fx.events.filter((e) => e.step === "ci-friction.garden_filing_failed").length, GARDEN_FILING_ESCALATE_AT + 1);
  assert.equal(raised.length, 1, "one escalation per streak, never one per retry");
  assert.match(raised[0]!.detail, /push refused/);
  assert.equal(fx.events.find((e) => e.step === "ci-friction.garden_filing_escalated")?.extra?.issue_url, "https://github.com/acme/remudero/issues/1");
});

test("a stale recorded ci-friction pass with no matching task re-files the finding", () => {
  const landed: string[][] = [];
  const fx = frictionFixture("ci-friction-stale", (opts) => (landed.push(opts.paths), `https://github.com/acme/remudero/pull/${10 + landed.length}`));
  const fingerprint = fx.spec.fingerprint(fx.spec.inventory());
  const statePath = gardenStatePath(fx.deps.stateDir, "ci-friction");
  // The host's shape on 2026-09-29: a pass that drew no action recorded this very fingerprint.
  writeFileSync(statePath, JSON.stringify({ classes: { draft: { alpha: 3, beta: 1 } }, lastCheap: "an-earlier-hour", lastPass: { fingerprint } }));
  assert.equal(runGarden(fx.spec, fx.deps).prUrl, "https://github.com/acme/remudero/pull/11", "no task carries the origin, so the recorded pass is not trusted");

  // A pass that LANDED the filing is trusted, even once its PR is decided: a declined filing is not re-filed.
  writeFileSync(statePath, JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), pending: undefined, lastCheap: "later" }));
  assert.equal(runGarden(fx.spec, fx.deps).ran, false);
  // Once the plan carries the origin, the cause is tracked and nothing is re-filed.
  fx.track(["ci-friction:check:reviewer-unmet"]);
  writeFileSync(statePath, JSON.stringify({ classes: { draft: { alpha: 3, beta: 1 } }, lastCheap: "later", lastPass: { fingerprint } }));
  assert.equal(runGarden(fx.spec, fx.deps).prUrl, undefined);
  assert.equal(landed.length, 1);
});

test("a self-hosting daemon wires the ci-friction gardener with its escalation path", async () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ci-friction-home-`));
  const root = join(home, "Remudero");
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(home, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  let captured: DaemonDeps | undefined;
  try {
    await daemonCommand(["--allow-self-target", "--plan", planPath, "--max", "0"], {
      runDaemon: async (_plan, d): Promise<DaemonSummary> => {
        captured = d;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    // plan, gate, test, config, export, then ci-friction (W1-T4435).
    const garden = captured!.gardens![5]!(60_000);
    garden.stop();
    // No ledger rotation exists in this fresh root, so the pass fails loudly under its own name.
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8");
    assert.match(ledger, /"step":"ci-friction\.gardener_failed".*no ledger rotations/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("a sweep fix round with no pr.opened is priced by its own worker minutes and tied to its PR by head", () => {
  const records: LedgerRecord[] = [
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 7816, head_sha: "aaa", ts: "2026-09-29T13:21:15.000Z" },
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_url: "https://github.com/acme/remudero/pull/7830", head_sha: "bbb", ts: "2026-09-29T13:22:00.000Z" },
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "reviewer-unmet", head_sha: "aaa", elapsed_ms: 870_000, ts: "2026-09-29T13:36:01.000Z" },
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "bbb", elapsed_ms: 300_000, ts: "2026-09-29T13:40:00.000Z" },
    // A body-only repair spawns no worker and names no elapsed time: counted nowhere rather than
    // priced by a gap that spans other PRs' rounds on the shared sweep run.
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "body-repair", head_sha: "bbb", ts: "2026-09-29T15:00:00.000Z" },
  ];
  assert.deepEqual(ciFrictionRoundsFromLedger(records), [
    { pr: 7816, cause: { kind: "check", name: "reviewer-unmet" }, minutes: 14.5, at: "2026-09-29T13:36:01.000Z" },
    { pr: 7830, cause: { kind: "check", name: "ci-log" }, minutes: 5, at: "2026-09-29T13:40:00.000Z" },
  ]);
});

test("an old friction round fades by its half-life so a cause that stops recurring falls in the ranking", () => {
  const now = Date.parse("2026-09-29T00:00:00.000Z");
  const day = 24 * 3_600_000;
  const at = (daysAgo: number) => new Date(now - daysAgo * day).toISOString();
  const rounds = [
    { pr: 1, cause: { kind: "check" as const, name: "reviewer-unmet" }, minutes: 400, at: at(30) },
    { pr: 2, cause: { kind: "check" as const, name: "ci-log" }, minutes: 60, at: at(1) },
  ];
  assert.equal(priceCiFrictionCauses(rounds)[0]!.cause.name, "reviewer-unmet", "all-time pricing ranks stale history first");
  const recent = priceCiFrictionCauses(rounds, undefined, now);
  assert.equal(recent[0]!.cause.name, "ci-log", "the current load outranks a month-old burst");
  assert.equal(ciFrictionRecencyWeight(at(7), now), 0.5);
  assert.equal(ciFrictionRecencyWeight(undefined, now), 1);
  // Two half-lives with no new rounds: the cause's price is a quarter of what it was.
  const later = priceCiFrictionCauses(rounds, undefined, now + 2 * CI_FRICTION_HALF_LIFE_MS);
  assert.equal(later.find((p) => p.cause.name === "ci-log")!.minutes, Math.round(recent.find((p) => p.cause.name === "ci-log")!.minutes / 4 * 10) / 10);
});

test("a ci-log round is priced against each red check and the failing test file its log names", () => {
  const records: LedgerRecord[] = [
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 7816, head_sha: "aaa", red_checks: ["coverage-shard (5/8)", "commitlint"], ts: "2026-09-29T12:44:00.000Z" },
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "aaa", elapsed_ms: 600_000, ts: "2026-09-29T12:54:00.000Z" },
    // An older sweep row names its check only in its reason.
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 7817, head_sha: "bbb", reason: "fix strikes exhausted (2/2) — coverage-ratchet failed on bbb1234 — ci-log fix", ts: "2026-09-29T13:00:00.000Z" },
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "bbb", elapsed_ms: 120_000, ts: "2026-09-29T13:02:00.000Z" },
    // A dispatch that carries its own failures names the failing test, and a retried file is flaky.
    { step: "test.flake_retry", file: "test/house-layout.test.ts", ts: "2026-09-29T12:00:00.000Z" },
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 7818, head_sha: "ccc", ts: "2026-09-29T13:10:00.000Z" },
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "ccc", elapsed_ms: 60_000, ts: "2026-09-29T13:11:00.000Z",
      ci_failures: [{ check: "coverage-shard (5/8)", signature: ciFailureSignature("coverage-shard (5/8)\t2026-09-29T13:05:00.1Z not ok 3 - test/house-layout.test.ts") }] },
  ];
  const byName = new Map(ciFrictionRoundsFromLedger(records).map((r) => [`${r.pr}:${r.cause.name}`, r.minutes]));
  assert.deepEqual(Object.fromEntries(byName), {
    "7816:ci-log:coverage-shard": 5,
    "7816:ci-log:commitlint": 5,
    "7817:ci-log:coverage-ratchet": 2,
    "7818:ci-log:coverage-shard:test-house-layout-test-ts:flaky": 1,
  });
  assert.equal(ciFailureSignature("2026-09-29T13:05:00.1Z Error: census abc1234def refused 12 rows"), "Error: census  refused N rows");
  assert.equal(ciFailureSignature("all green"), undefined);
});

test("a sweep refusal on a resume round is priced as fix_refusal by its reason", () => {
  const records: LedgerRecord[] = [
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 7816, head_sha: "aaa", red_checks: ["coverage-ratchet"], ts: "2026-09-29T12:44:00.000Z" },
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "aaa", elapsed_ms: 510_000, ts: "2026-09-29T12:52:59.949Z" },
    { step: "fix.commit_refused", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "aaa", reason: "no anchored COMMIT_MESSAGE line in the report", ts: "2026-09-29T12:52:59.952Z" },
    // The next round on the SAME unmoved head is its own round: the earlier refusal does not taint it.
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "fresh", mode: "ci-log", head_sha: "aaa", elapsed_ms: 60_000, ts: "2026-09-29T13:10:00.000Z" },
  ];
  assert.deepEqual(ciFrictionRoundsFromLedger(records).map((r) => [r.cause.kind, r.cause.name, r.minutes]), [
    ["fix_refusal", "no-anchored-commit-message-line-in-the-report", 8.5],
    ["check", "ci-log:coverage-ratchet", 1],
  ]);
  assert.equal(refusalReasonKey(undefined), "commit_refused");
});

test("coverage-shard checks from different CI matrix sizes price as one shard family", () => {
  const records: LedgerRecord[] = [
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 1, head_sha: "aaa", red_checks: ["coverage-shard (5/8)"], ts: "2026-09-29T12:00:00.000Z" },
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "aaa", elapsed_ms: 60_000, ts: "2026-09-29T12:01:00.000Z" },
    { step: "sweep.disposed", run_id: "DAEMON-1", pr_number: 2, head_sha: "bbb", red_checks: ["coverage-shard (5/4)"], ts: "2026-09-29T12:02:00.000Z" },
    { step: "fix.dispatch", run_id: "DAEMON-1", round: "resume", mode: "ci-log", head_sha: "bbb", elapsed_ms: 120_000, ts: "2026-09-29T12:03:00.000Z" },
  ];
  const priced = priceCiFrictionCauses(ciFrictionRoundsFromLedger(records));
  assert.deepEqual(priced.map((p) => [p.cause.name, p.minutes, p.rounds]), [["ci-log:coverage-shard", 3, 2]]);
  assert.equal(ciCheckFamily("ci-shard (1/4)"), "ci-shard");
  assert.equal(ciCheckFamily("commitlint"), "commitlint");
});

test("a failed ci-friction filing still writes its scorecard row", () => {
  const fx = frictionFixture("ci-friction-scorecard-on-failure", () => {
    throw new Error("header must not be longer than 100 characters, current length is 112 [header-max-length]");
  });
  const pass = runGarden(fx.spec, fx.deps);
  assert.equal(pass.prUrl, undefined);
  const card = fx.events.find((e) => e.step === "ci-friction.scorecard");
  assert.ok(card, `the measurement is ledgered despite the refused filing: ${fx.events.map((e) => e.step).join(",")}`);
  assert.equal(card.extra?.filing_failed, 1);
  assert.equal(card.extra?.pr_url, null);
  assert.equal(card.extra?.untracked, "check:reviewer-unmet");
});
