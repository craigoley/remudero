// W1-T12201: a new decision file lands in the plan destination, and the reader reads both roots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DECISIONS_LANDING_BRANCH,
  decisionRecordRelPath,
  landingIdentity,
  readStandingDecisions,
  recordDecision,
  recordDecisionAsync,
  recordRuling,
  type LandFeedbackAsyncOpts,
  type LandFeedbackOpts,
  type LandFeedbackResult,
} from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { planDestinationPath, resolvePlanDestination, type PlanDestinationRepository } from "#src/lib/plan-destination.js";
import { planPrPreflightAtCommit, planPrPreflightAtCommitAsync } from "#src/lib/plan-pr-emitter.js";
import { makeTempDir } from "#src/lib/tmp.js";
import type { WorkerResult } from "#src/lib/worker.js";
import { originWithClone } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { runTask } from "#test/helpers/run-task-test.js";

const OPS = { owner: "fixture", repo: "remudero-ops" };
const PARAMS = { taskId: "W1-T12201", runId: "W1-T12201-1", options: ["a", "b"], chosen: "a", band: "medium", reason: "r" };
const RULING_PATH = "plan/decisions.d/ruling-W1-T12201.md";
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

/** `<root>/state` and `<root>/repos/`, the layout of one instance. */
function instance(t: TestContext) {
  const root = makeTempDir("w12201-instance");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(root, "repos"), { recursive: true });
  return { root, stateDir };
}

function writeSwitch(stateDir: string, kinds: string[]): void {
  writeFileSync(planDestinationPath(stateDir), JSON.stringify({ repository: `${OPS.owner}/${OPS.repo}`, kinds }));
}

const branchesOf = (bare: string): string[] =>
  git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();

/** A `gh` that records each call; no real GitHub. */
function fakeGh() {
  const calls: string[][] = [];
  const answer = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/fixture/remudero-ops/pull/1\n";
    if (args[0] === "api") return "{}";
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { calls, gh: answer, ghAsync: async (args: string[]) => answer(args) };
}

const OPS_BRANCH = landingIdentity({ family: "decisions", targetRepository: OPS }).branch;

/** One instance with its two plan roots (public and destination, each a clone of its own origin)
 *  and the switch set to `kinds`. */
function planRootsAndSwitch(t: TestContext, kinds: string[]) {
  const { root, stateDir } = instance(t);
  const publicDir = join(root, "repos", "remudero");
  const publicOrigin = originWithClone(publicDir, { scope: t, seed: { "scripts/README": "harness\n" } }).origin.dir;
  const opsDir = join(root, "repos", OPS.repo);
  const opsOrigin = originWithClone(opsDir, { scope: t }).origin.dir;
  writeSwitch(stateDir, kinds);
  return { root, stateDir, publicDir, publicOrigin, opsDir, opsOrigin };
}

test("W1-T12201 criterion 1: with decision in the kinds, the three writers commit, push and open the pull request in the destination", async (t) => {
  const f = planRootsAndSwitch(t, ["decision"]);
  const destination = resolvePlanDestination("decision", f.stateDir, { ...OPS, owner: "public", checkoutDir: f.publicDir });
  assert.equal(destination.outcome, "destination");
  const gh = fakeGh();
  const results: LandFeedbackResult[] = [
    withLiveWritesAllowed(() => recordDecision(f.publicDir, PARAMS, { gh: gh.gh, planDestination: destination })),
    withLiveWritesAllowed(() => recordRuling(f.publicDir, RULING_PATH, "ruling\n", { gh: gh.gh, planDestination: destination })),
    await withLiveWritesAllowed(() => recordDecisionAsync(f.publicDir, { ...PARAMS, runId: "W1-T12201-2" },
      { gh: gh.gh, ghAsync: gh.ghAsync, planDestination: destination })),
  ];
  for (const result of results) assert.equal(result.landed, true, result.error);
  assert.deepEqual(branchesOf(f.publicOrigin), ["main"], "nothing is pushed to the public repository");
  assert.deepEqual(branchesOf(f.opsOrigin), [OPS_BRANCH, "main"].sort());
  const files = git(f.opsOrigin, "ls-tree", "-r", "--name-only", OPS_BRANCH).split("\n");
  for (const rel of [decisionRecordRelPath(PARAMS.taskId, PARAMS.runId), RULING_PATH, decisionRecordRelPath(PARAMS.taskId, "W1-T12201-2")]) {
    assert.ok(files.includes(rel), `${rel} is on the destination's landing branch`);
  }
  const create = gh.calls.find((args) => args[0] === "pr" && args[1] === "create");
  assert.ok(create, "a landing pull request is opened");
  assert.equal(create[create.indexOf("--repo") + 1], `${OPS.owner}/${OPS.repo}`, "the pull request is opened in the destination repository");
  assert.equal(git(f.publicDir, "status", "--porcelain"), "", "the public checkout stays clean");
});

/** A git and gh that answer like an empty remote and record every call, sync and awaited. */
function recordingTransport() {
  const calls: string[][] = [];
  const answer = (args: string[]): string => {
    // The scratch directory of a landing has a random name; the call is the same.
    calls.push(args.map((arg) => arg.replace(/rmd-decisions-landing-[^/]+/, "rmd-decisions-landing-*")));
    if (args[0] === "rev-parse") {
      if (args[1] === "origin/main") return "main-sha";
      if (args[1] === "main-sha^{tree}") return "main-tree";
      throw new Error(`fixture ref absent: ${args[1]}`);
    }
    if (args[0] === "config") return "https://github.com/fixture/remudero.git";
    if (args[0] === "hash-object") return "blob";
    if (args[0] === "write-tree") return "tree";
    if (args.includes("commit-tree")) return "commit";
    if (args[0] === "pr" && args[1] === "list") return "[]";
    if (args[0] === "pr" && args[1] === "create") return "https://github.com/fixture/remudero/pull/1";
    return "";
  };
  const opts: LandFeedbackOpts = {
    sourceRepository: { owner: "fixture", repo: "remudero" },
    git: answer,
    gh: answer,
    planPrPreflight: (sha) => { calls.push(["preflight", sha]); return { ok: true, failures: [], unreadable: [] }; },
  };
  const asyncOpts: LandFeedbackAsyncOpts = {
    ...opts,
    planPrPreflight: async (sha) => { calls.push(["preflight", sha]); return { ok: true, failures: [], unreadable: [] }; },
    gitAsync: async (args) => answer(args),
    ghAsync: async (args) => answer(args),
  };
  return { calls, opts, asyncOpts };
}

async function landAllThree(root: string, extra: Pick<LandFeedbackOpts, "planDestination">) {
  const sync = recordingTransport();
  withLiveWritesAllowed(() => recordDecision(root, PARAMS, { ...sync.opts, ...extra }));
  withLiveWritesAllowed(() => recordRuling(root, RULING_PATH, "ruling\n", { ...sync.opts, ...extra }));
  const awaited = recordingTransport();
  await withLiveWritesAllowed(() => recordDecisionAsync(root, PARAMS, { ...awaited.asyncOpts, ...extra }));
  return [...sync.calls, ["--- awaited"], ...awaited.calls];
}

test("W1-T12201 criterion 2: with no host file, each writer lands on the same branch of the same repository with the same calls", async (t) => {
  const { root, stateDir } = instance(t);
  const publicDir = join(root, "repos", "remudero");
  mkdirSync(publicDir, { recursive: true });
  const publicRepository: PlanDestinationRepository = { owner: "fixture", repo: "remudero", checkoutDir: publicDir };
  const off = resolvePlanDestination("decision", stateDir, publicRepository);
  assert.equal(off.outcome, "off");
  const today = await landAllThree(publicDir, {});
  assert.deepEqual(await landAllThree(publicDir, { planDestination: off }), today);
  const pushes = today.filter((args) => args[0] === "push").map((args) => args.at(-1));
  assert.deepEqual(pushes, Array(3).fill(`commit:refs/heads/${DECISIONS_LANDING_BRANCH}`));
  const creates = today.filter((args) => args[0] === "pr" && args[1] === "create");
  assert.equal(creates.length, 3);
  for (const args of creates) assert.equal(args[args.indexOf("--repo") + 1], "fixture/remudero");

  writeSwitch(stateDir, ["feedback"]);
  const notListed = resolvePlanDestination("decision", stateDir, publicRepository);
  assert.equal(notListed.outcome, "not_listed");
  assert.deepEqual(await landAllThree(publicDir, { planDestination: notListed }), today, "a kind that is not listed lands as today");
});

test("W1-T12201 criterion 3: readStandingDecisions reads the public root and the destination checkout while the host file names a repository", (t) => {
  const { root, stateDir } = instance(t);
  const publicDir = join(root, "repos", "remudero");
  mkdirSync(join(publicDir, "plan", "decisions.d"), { recursive: true });
  writeFileSync(join(publicDir, "DECISIONS.md"), "public root decision");
  writeFileSync(join(publicDir, "plan", "decisions.d", "one.md"), "public shard");
  const opsShards = join(root, "repos", OPS.repo, "plan", "decisions.d");
  mkdirSync(opsShards, { recursive: true });
  writeFileSync(join(opsShards, "two.md"), "destination shard");

  assert.equal(readStandingDecisions(publicDir, stateDir), "public root decision\npublic shard", "no host file: the public root only");
  writeSwitch(stateDir, []);
  assert.equal(readStandingDecisions(publicDir, stateDir), "public root decision\npublic shard\ndestination shard",
    "decision is not in the kinds: files already in the destination still stand");
  writeSwitch(stateDir, ["decision"]);
  assert.equal(readStandingDecisions(publicDir, stateDir), "public root decision\npublic shard\ndestination shard");
});

test("W1-T12201 criterion 4: the preflight in a destination checkout with no scripts directory passes a change of decision files only", async (t) => {
  const { root } = instance(t);
  const opsDir = join(root, "repos", OPS.repo);
  originWithClone(opsDir, { scope: t, seed: { "plan/tasks.d/W1-T1-seed.yaml": "- id: W1-T1\n" } });
  git(opsDir, "checkout", "--quiet", "-b", "work");
  mkdirSync(join(opsDir, "plan", "decisions.d"), { recursive: true });
  writeFileSync(join(opsDir, "plan", "decisions.d", "x.md"), "decision\n");
  git(opsDir, "add", "-A");
  git(opsDir, "commit", "--quiet", "-m", "chore(decisions): one record");
  const decisionsOnly = git(opsDir, "rev-parse", "HEAD");
  const pr = { title: "chore(decisions): land pending decision records", body: "## Acceptance\n- x | grep: . in plan/decisions.d/x.md" };
  assert.deepEqual(await planPrPreflightAtCommitAsync(opsDir, decisionsOnly, pr), { ok: true, failures: [], unreadable: [] },
    "the awaited preflight runs only the checks that apply");
  const syncForm = planPrPreflightAtCommit(opsDir, decisionsOnly, pr);
  assert.equal(syncForm.ok, true, "the sync form passes too: a check that cannot run does not refuse");
  assert.equal(syncForm.failures.length, 0);

  writeFileSync(join(opsDir, "plan", "tasks.d", "W1-T1-seed.yaml"), "- id: W1-T1\n  title: changed\n");
  git(opsDir, "commit", "--quiet", "-am", "chore(plan): a task file too");
  const withTask = await planPrPreflightAtCommitAsync(opsDir, git(opsDir, "rev-parse", "HEAD"), pr);
  assert.ok(withTask.unreadable.some((finding) => finding.check === "lint-plan"), "a change with a task file still runs the task checks");
});

test("W1-T12201 criterion 5: an unreadable host file lands the decision in no repository and names the cause", async (t) => {
  const { stateDir } = instance(t);
  writeFileSync(planDestinationPath(stateDir), "{ not json");
  const unreadable = resolvePlanDestination("decision", stateDir, { owner: "fixture", repo: "remudero", checkoutDir: "/nonexistent" });
  assert.equal(unreadable.outcome, "unreadable");
  const sync = recordingTransport();
  const awaited = recordingTransport();
  const results = [
    withLiveWritesAllowed(() => recordDecision("/nonexistent", PARAMS, { ...sync.opts, planDestination: unreadable })),
    withLiveWritesAllowed(() => recordRuling("/nonexistent", RULING_PATH, "ruling\n", { ...sync.opts, planDestination: unreadable })),
    await withLiveWritesAllowed(() => recordDecisionAsync("/nonexistent", PARAMS, { ...awaited.asyncOpts, planDestination: unreadable })),
  ];
  for (const result of results) {
    assert.equal(result.landed, false);
    assert.match(result.error ?? "", /landed in no repository: .*plan-destination\.json: not valid JSON/);
  }
  assert.equal(sync.calls.length + awaited.calls.length, 0, "no git or gh call: nothing is fetched, committed or pushed");
});

/** The worker answers of one run that reaches DECISION_REQUEST, as in the W1-T9735 fixture. */
const worker = (text: string): WorkerResult => ({
  sessionId: "fixture", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
  isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "fixture", effort: "low",
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [], qualitySuspect: false,
});

async function runToDecision(root: string, decisionLanding: LandFeedbackAsyncOpts): Promise<Record<string, unknown> | undefined> {
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, `- id: W1-T12201\n  title: prove the destination landing\n  repo: remudero\n  type: implement\n  verify: auto\n  risk: medium\n  files: [src/lib/daemon.ts]\n  origin: architect\n  status: queued\n`);
  const resumed = new Error("fixture stopped after the decision was recorded");
  let workerCalls = 0;
  await assert.rejects(withLiveWritesAllowed(() => runTask("W1-T12201", {
    planPath, skipGitSync: true, owner: "fixture",
    config: { root, claudeBin: "/bin/true", installRoot: REPO_ROOT },
    github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    binaryPinDeps: { readCliManifest: () => '{"dependencies":{"@anthropic-ai/claude-code":"1.2.3"}}', runClaudeVersion: () => "1.2.3" },
    containmentExec: async (token) => ({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
    isolationExec: async () => ({ transcript: "clean", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
    decisionLanding,
    spawn: async () => {
      if (++workerCalls === 1) return worker("RECON REPORT\nOBSERVED: fixture\n");
      if (workerCalls === 2) return worker("DECISION_REQUEST\n- migrate schema (RECOMMENDED)\n- defer\nFALSIFIER: the column already exists\n");
      throw resumed;
    },
  })), (error: unknown) => error === resumed);
  const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return ledger.find((row) => row.step === "decision.autochoose");
}

test("W1-T12201: the run verb resolves the destination and lands its decision there (criteria 1 and 6)", async (t) => {
  const f = planRootsAndSwitch(t, ["decision"]);
  const gh = fakeGh();
  const row = await runToDecision(f.root, { gh: gh.gh, ghAsync: gh.ghAsync });
  assert.equal(row?.landed, true);
  assert.equal(row?.plan_destination, "destination");
  assert.deepEqual(branchesOf(f.publicOrigin), ["main"], "nothing is pushed to the public repository");
  assert.deepEqual(branchesOf(f.opsOrigin), [OPS_BRANCH, "main"].sort());
  const files = git(f.opsOrigin, "ls-tree", "-r", "--name-only", OPS_BRANCH).split("\n");
  assert.ok(files.some((rel) => rel.startsWith("plan/decisions.d/W1-T12201-")), files.join(","));
});

test("W1-T12201: on an unreadable host file the run verb's ledger row is the only record and names the cause (criterion 5)", async (t) => {
  const f = planRootsAndSwitch(t, ["decision"]);
  writeFileSync(planDestinationPath(f.stateDir), "{ not json");
  const gh = fakeGh();
  const row = await runToDecision(f.root, { gh: gh.gh, ghAsync: gh.ghAsync });
  assert.equal(row?.recorded, true);
  assert.equal(row?.landed, false);
  assert.equal(row?.plan_destination, "unreadable");
  assert.match(String(row?.plan_destination_reason), /plan-destination\.json: not valid JSON/);
  assert.deepEqual(branchesOf(f.publicOrigin), ["main"]);
  assert.deepEqual(branchesOf(f.opsOrigin), ["main"]);
  assert.equal(gh.calls.length, 0);
});
