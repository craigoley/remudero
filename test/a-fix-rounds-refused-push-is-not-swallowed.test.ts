// test/a-fix-rounds-refused-push-is-not-swallowed.test.ts — W1-T4693: both fix-rung push deps ran
// gitPushRunBranch with stdio "ignore" inside a catch that dropped every error but a foreign head, so a
// pre-push census refusal of a FIX ROUND was discarded and the rung waited on CI for the PR's old head.
// The runTask tests drive the REAL runTask into the post-PR fix rung against a local origin whose TRACKED
// hooks/pre-push refuses a run branch carrying `census.red` (census) or `other.red` (non-census).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSweepEffects, FixRoundPushError, pushFixRound, runTask } from "./helpers/run-task-test.js";
import type { Config } from "../src/lib/config.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import { LanePushForeignHeadError } from "../src/lib/git-push.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Plan } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { ghShim } from "./helpers/gh-shim.js";
import { gitRepo } from "./helpers/git-repo.js";

const TASK_ID = "T-FIX-PUSH";
const PR_URL = "https://github.com/acme/remudero/pull/501";
const PR_HEAD = "cafed00d5678";
const REFUSAL_HEAD = "census-precheck: this branch grows 1 census count(s) CI will refuse:";
const REFUSAL_ROW =
  "  clock-signature: census.red dateNow 1 > baseline 0 — move it onto the Clock port, or record the row in scripts/clock-signature-baseline.json";

const PLAN = [
  `- id: ${TASK_ID}`,
  "  title: a fix round's refused push is named",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: test",
  "  status: queued",
  "",
].join("\n");

const OFFLINE_GITHUB: GitHub = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 });
const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 });

function workerResult(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "implement-session",
    costUsd: 0.02,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "test",
    effort: "test",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

/** The fleet's hook reduced to its census arm (W1-T4656's shape): `census.red` is a census refusal,
 *  `other.red` a non-census one. Every run-branch push it judges is logged with its verdict and sha. */
function hookScript(logPath: string): string {
  return [
    "#!/bin/sh",
    "while read -r _lref lsha rref _rsha; do",
    '  case "$rref" in refs/heads/run-*) ;; *) continue ;; esac',
    "  if [ -f census.red ]; then",
    `    echo "refused $lsha" >> '${logPath}'`,
    `    echo '${REFUSAL_HEAD}' >&2`,
    `    echo '${REFUSAL_ROW}' >&2`,
    "    exit 1",
    "  fi",
    "  if [ -f other.red ]; then",
    `    echo "other $lsha" >> '${logPath}'`,
    "    echo 'rule15-precheck: a plan record rides with code' >&2",
    "    exit 1",
    "  fi",
    `  echo "accepted $lsha" >> '${logPath}'`,
    "done",
    "exit 0",
    "",
  ].join("\n");
}

interface Fixture {
  root: string;
  origin: string;
  hookLog: () => string[];
  cleanup: () => void;
}

function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fix-push-root-`));
  const logPath = join(root, "hook.log");
  writeFileSync(join(root, "tasks.yaml"), PLAN);
  writeFileSync(logPath, "");
  const origin = gitRepo({ bare: true, kind: "fix-push-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "fix-push-seed" });
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  mkdirSync(join(seed.dir, "plan"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.yaml"), PLAN);
  mkdirSync(join(seed.dir, "hooks"), { recursive: true });
  writeFileSync(join(seed.dir, "hooks", "pre-push"), hookScript(logPath));
  chmodSync(join(seed.dir, "hooks", "pre-push"), 0o755);
  // W1-T6106: the host push runs the HARNESS's pre-push, never the lane's tracked copy; this seed's hooks/ plays the harness.
  process.env.RMD_HARNESS_HOOKS_DIR = join(seed.dir, "hooks");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "main");
  mkdirSync(join(root, "repos"), { recursive: true });
  const local = join(root, "repos", "remudero");
  execFileSync("git", ["clone", "-q", origin.dir, local]);
  execFileSync("git", ["-C", local, "config", "user.email", "fixture@remudero.invalid"]);
  execFileSync("git", ["-C", local, "config", "user.name", "remudero test fixture"]);
  return {
    root,
    origin: origin.dir,
    hookLog: () => readFileSync(logPath, "utf8").split("\n").filter(Boolean),
    cleanup: () => {
      origin.cleanup();
      seed.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function commitIn(cwd: string, message: string, edit: () => void): string {
  edit();
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  execFileSync("git", ["-C", cwd, "commit", "-q", "-m", message]);
  return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

const BLOCKED_REVIEW = {
  state: "failure" as const,
  criteria: [],
  testTheater: false,
  summary: "failure — one unmet criterion",
  floorDegraded: false,
  capped: false,
  keywordOnly: false,
  planOnly: false,
  headSha: PR_HEAD,
  reviewerOutcome: "success",
};

type FixRound = (cwd: string, strike: number) => void;

/** Drives the real runTask: recon, an implement worker that opens PR 501, one blocked review, then every
 *  FIX worker to `fix`. `ghCallsAtFix[n]` is how many `gh` calls had run when fix strike n+1 spawned. */
async function drive(fx: Fixture, t: { mock: { method: (o: object, k: string, f: () => number) => unknown } }, fix: FixRound) {
  const fixedTs = 1790600000000;
  const branch = `run-${TASK_ID}-${fixedTs}`;
  const gh = ghShim(
    [
      { when: "--json headRefName", stdout: JSON.stringify({ headRefName: branch, headRefOid: PR_HEAD, body: "" }) },
      { when: "--json headRefOid", stdout: JSON.stringify({ headRefOid: PR_HEAD }) },
      { when: "--json body", stdout: JSON.stringify({ body: "" }) },
      // W1-T4074: an unreadable PR diff stands the fix rung down before dispatch — answer the read.
      { when: "--json files", stdout: JSON.stringify({ files: [{ path: "src/lib/daemon.ts" }] }) },
      { when: "pulls/501/", stdout: "[]" },
      { when: "check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
      { when: "pulls/501", stdout: JSON.stringify({ state: "open", merged: false, head: { sha: PR_HEAD } }) },
      { when: "issue create", stdout: "https://github.com/acme/remudero/issues/501" },
      { when: "api", stdout: "[]" },
    ],
    { kind: "fix-push-gh" },
  );
  const fixCalls: SpawnWorkerArgs[] = [];
  const ghCallsAtFix: number[] = [];
  let calls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    calls += 1;
    if (calls === 1) return workerResult({ text: "RECON REPORT\nOBSERVED: fixture\n" });
    if (String(args.prompt).startsWith("You are a FIX worker")) {
      fixCalls.push(args);
      ghCallsAtFix.push(gh.calls().length);
      fix(args.cwd!, fixCalls.length);
      return workerResult({ sessionId: `fix-session-${fixCalls.length}`, text: "REPORT\nfix applied\n" });
    }
    return workerResult({ text: `REPORT\nPR_URL: ${PR_URL}\n` });
  };
  t.mock.method(Date, "now", () => fixedTs);
  const savedPath = process.env.PATH;
  process.env.PATH = `${gh.dir}:${savedPath}`;
  try {
    const error = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath: join(fx.root, "tasks.yaml"),
        config: { claudeBin: "/bin/true", root: fx.root, installRoot: process.cwd() } as Config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
        runReview: async () => BLOCKED_REVIEW,
      }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    const ghCalls = gh.calls();
    return { error, fixCalls, ghCallsAtFix, ghCalls, ledger: readLedger(fx.root), branch };
  } finally {
    process.env.PATH = savedPath;
    rmSync(gh.dir, { recursive: true, force: true });
  }
}

const rows = (ledger: Array<Record<string, unknown>>, step: string) => ledger.filter((row) => row.step === step);
const ciPolls = (calls: string[]) => calls.filter((c) => c.includes("check-runs")).length;

test("W1-T4693: a census-refused fix round writes fix.push_refused, never waits on CI for the old head, and hands the refusal to the next strike", async (t) => {
  const fx = buildFixture();
  try {
    const shas: string[] = [];
    const run = await drive(fx, t, (cwd, strike) => {
      shas.push(
        strike === 1
          ? commitIn(cwd, "fix: read the clock directly", () => writeFileSync(join(cwd, "census.red"), "Date.now()\n"))
          : commitIn(cwd, "fix: move the clock read onto the port", () => execFileSync("git", ["-C", cwd, "rm", "-q", "census.red"])),
      );
    });
    assert.equal(run.fixCalls.length, 2, `two strikes ran; steps=${JSON.stringify(run.ledger.map((r) => r.step))}`);

    const refused = rows(run.ledger, "fix.push_refused");
    assert.equal(refused.length, 1, "strike 1's refusal is named in the ledger");
    assert.deepEqual(refused[0]!.censuses, ["clock-signature"]);
    assert.equal(refused[0]!.strike, 1);
    assert.equal(refused[0]!.head_sha, shas[0], "the row names the head that never landed");
    assert.ok(String(refused[0]!.refusal).startsWith(REFUSAL_HEAD), "the row carries the hook's own text");

    // No CI read between strike 1's push and strike 2's spawn: the rung did not wait on the old head.
    const between = run.ghCalls.slice(run.ghCallsAtFix[0], run.ghCallsAtFix[1]);
    assert.equal(ciPolls(between), 0, `no check-runs read for the refused round; calls=${JSON.stringify(between)}`);
    assert.equal(rows(run.ledger, "fix.ci_not_green").filter((r) => r.strike === 1).length, 0);

    const prompt = String(run.fixCalls[1]!.prompt);
    assert.match(prompt, /MODE: ci-log/, "the next strike is a ci-log strike on the refusal");
    assert.ok(prompt.includes(REFUSAL_HEAD) && prompt.includes(REFUSAL_ROW.trim()), "the next strike's prompt carries the refusal text");
    assert.match(prompt, /PRE-PUSH CENSUS \(W1-T4693\)/);
    assert.match(prompt, /Never push with --no-verify/);

    assert.deepEqual(fx.hookLog().slice(-2), [`refused ${shas[0]}`, `accepted ${shas[1]}`], "the retried push ran the hook and passed it");
    assert.equal(execFileSync("git", ["-C", fx.origin, "rev-parse", `refs/heads/${run.branch}`], { encoding: "utf8" }).trim(), shas[1]);
    assert.ok(ciPolls(run.ghCalls.slice(run.ghCallsAtFix[1])) > 0, "the push that landed is the one the rung waits on CI for");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4693: a non-census push failure is ledgered by class and ends the rung, never swallowed", async (t) => {
  const fx = buildFixture();
  try {
    const run = await drive(fx, t, (cwd) => {
      commitIn(cwd, "fix: trade the red for another", () => writeFileSync(join(cwd, "other.red"), "x\n"));
    });
    assert.equal(run.error, undefined, `the run resolves; got ${String((run.error as Error)?.message)}`);
    assert.equal(run.fixCalls.length, 1, "the failed push ends the rung — no strike is spent on the old head");
    const failed = rows(run.ledger, "fix.push_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.cause, "git-push-failed");
    assert.match(String(failed[0]!.error), /rule15-precheck/, "the hook's own text is kept");
    assert.equal(rows(run.ledger, "fix.push_refused").length, 0);
    assert.equal(ciPolls(run.ghCalls.slice(run.ghCallsAtFix[0])), 0, "no CI wait after the failed push");
    const stood = rows(run.ledger, "fix.stood_down").concat(rows(run.ledger, "verdict")).map((r) => JSON.stringify(r));
    assert.ok(stood.some((r) => r.includes("fix round push failed (git-push-failed)")), `the outcome names the failure; rows=${stood.join("\n")}`);
  } finally {
    fx.cleanup();
  }
});

/** A lane on a run branch whose tip carries `census.red`, with the tracked hook active. */
function censusLane(fx: Fixture): { dir: string; branch: string; head: string } {
  const dir = join(fx.root, "lane");
  execFileSync("git", ["clone", "-q", fx.origin, dir]);
  for (const [k, v] of [["user.email", "fixture@remudero.invalid"], ["user.name", "remudero test fixture"], ["core.hooksPath", "hooks"]]) {
    execFileSync("git", ["-C", dir, "config", k!, v!]);
  }
  const branch = "run-T-FIX-PUSH-1";
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", branch]);
  const head = commitIn(dir, "feat: the census grows", () => writeFileSync(join(dir, "census.red"), "Date.now()\n"));
  return { dir, branch, head };
}

test("W1-T4693: pushFixRound — a head the remote already holds is a silent no-op; a foreign head still raises; a refusal is named", async () => {
  const fx = buildFixture();
  try {
    const lane = censusLane(fx);
    await withLiveWritesAllowed(async () => {
      const refusal = await pushFixRound(lane.dir, lane.branch, lane.head).then(() => undefined, (e: unknown) => e);
      assert.ok(refusal instanceof FixRoundPushError, `a refused push throws FixRoundPushError; got ${String(refusal)}`);
      assert.equal(refusal.pushCause, "census-refused-push");
      assert.deepEqual(refusal.refusal?.censuses, ["clock-signature"]);

      // The head reaches origin by a path this helper does not own (it landed before the hook was armed);
      // the hook still refuses the now up-to-date push, and that is the one failure that means nothing.
      execFileSync("git", ["-C", lane.dir, "-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD"]);
      await assert.doesNotReject(() => pushFixRound(lane.dir, lane.branch, lane.head));
      await assert.rejects(() => pushFixRound(lane.dir, lane.branch, "0".repeat(40)), LanePushForeignHeadError);
    });
    assert.deepEqual(fx.hookLog().map((l) => l.split(" ")[0]), ["refused"], "the up-to-date push ran the hook with nothing to send");
  } finally {
    fx.cleanup();
  }
});

test("W1-T4693: the sweep's fix dispatch hands runFixRung the same push, so its refusal surfaces too", async () => {
  const fx = buildFixture();
  const shim = ghShim(
    [
      {
        when: "pr view https://github.com/craigoley/remudero/pull/2890 --json headRefName,headRefOid,body",
        stdout: JSON.stringify({ headRefName: "run-W1-T2890-1789022939729", headRefOid: "remote123456789", body: "" }),
      },
    ],
    { kind: "w1-t4693-sweep-gh" },
  );
  const oldPath = process.env.PATH;
  try {
    const lane = censusLane(fx);
    process.env.PATH = `${shim.dir}:${oldPath}`;
    for (const d of ["state/inflight", "repos/remudero-fixture", "tmp"]) mkdirSync(join(fx.root, d), { recursive: true });
    const task = { id: "W1-T2890", title: "sweep push", risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" };
    let surfaced: unknown;
    let ownerReads = 0;
    // The PRODUCTION adapter, with no push injected: what reaches runFixRung is the entrypoint's own wiring.
    const effects = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero-fixture",
      repoRoot: process.cwd(),
      localRepoName: "remudero",
      config: { root: fx.root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(fx.root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T4693",
      plan: { tasks: [task], byId: new Map([[task.id, task]]) } as unknown as Plan,
      log: () => {},
      policy: DEFAULT_SWEEP_POLICY,
      reviewRunner: async () => 0,
      issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/2890" },
      stallNotice: () => {},
      armImpl: () => "armed",
      armSessionPrsOverride: false,
      captureRepairFeedbackImpl: () => {},
      ghRunImpl: () => {},
      spawnWallClockBoundMsOverride: 1,
      reclaimWorkerImpl: () => {},
      disarmImpl: () => undefined,
      readJsonImpl: async () => ({}),
      registeredWorktreeOwnerImpl: () => (++ownerReads === 1 ? join(fx.root, "worktrees", "owner") : undefined),
      registeredOwnerRecovery: {
        capture: () => ({
          path: join(fx.root, "worktrees", "owner"),
          localSha: "local123456789",
          remoteSha: "remote123456789",
          ageMs: 10,
          pathState: "managed",
          attachmentState: "exact",
          treeState: "clean",
          remoteState: "exact",
          historyState: "ahead",
          claimState: "clear",
          processState: "clear",
        }),
        publishAhead: () => {},
        remove: () => {},
      },
      decideRegisteredFixOwnerRecoveryImpl: () => ({ kind: "publish-ahead" }),
      dispatchFixPreflightStandDownImpl: async () => undefined,
      // W1-T4073: the fixture's head is no real commit; an empty head contract keeps the task as resolved.
      resolveTaskContractAtHeadImpl: () => ({ criteria: [] }),
      fixBranchClaimKeyImpl: () => "claim-key",
      createFixRungWorktreeImpl: () => undefined,
      captureWorktreeSnapshotImpl: () => ({ headSha: "birth123" }),
      buildFixRungDispatchArgsImpl: () => ({}),
      openTaskIdsFromPlanImpl: () => new Set(["W1-T2890"]),
      runFixRungImpl: async (args: { deps: { push: (wt: string, branch: string, sha: string) => Promise<void> } }) => {
        try {
          await args.deps.push(lane.dir, lane.branch, lane.head);
        } catch (e) {
          surfaced = e;
        }
        return { outcome: "stood_down", strikes: 0, retriggers: 0, reason: "test" };
      },
      spawnImpl: async () => ({ sessionId: "new-session" }) as never,
    } as unknown as Parameters<typeof buildSweepEffects>[0]);

    await withLiveWritesAllowed(() =>
      effects.dispatchFix!(
        {
          prNumber: 2890,
          prUrl: "https://github.com/craigoley/remudero/pull/2890",
          headSha: "remote123456789",
          taskId: "W1-T2890",
          priorStrikes: 0,
          mergeState: "clean",
          checksState: "failure",
        } as never,
        { unmetCriteria: [], ciFailures: [{ name: "ci", logTail: "red" }] } as never,
      ),
    );
    assert.ok(surfaced instanceof FixRoundPushError, `the sweep's push surfaces the refusal; got ${String(surfaced)}`);
    assert.deepEqual(surfaced.refusal?.censuses, ["clock-signature"]);
    assert.deepEqual(fx.hookLog().map((l) => l.split(" ")[0]), ["refused"], "through the hook, never around it");
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    fx.cleanup();
  }
});
