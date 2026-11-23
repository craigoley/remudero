import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { benchmarkRunLedgerLogger, buildInboxDraftSpawnArgs, gitCredentialFixSpawn, harnessCommitForShellLessWorker,
  ledgeredNonDispatchSpawn, runFixRung, runReview, runTask } from "#test/helpers/run-task-test.js";
import { benchmarkNonDispatchSpawn, withReceiptWork } from "#src/lib/benchmark-run.js";
import type { Config } from "#src/lib/config.js";
import type { IssueGateway } from "#src/lib/escalate.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { deriveTaskClass } from "#src/lib/task-class.js";
import { openWeightAllowancePath } from "#src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker, workerPromptRevision, type SpawnWorkerArgs, type WorkerResult,
  type WorkerSelectionAssignment } from "#src/lib/worker.js";
import type { Mount } from "#src/lib/mounts.js";
import type { CriterionVerdict, ReviewVerdict } from "#src/lib/review.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown>;
type Receipt = { work: Record<string, unknown>; stack: Record<string, unknown> };

const TASK_ID = "W1-T99121";
const TASK_FILES = ["src/lib/widget.ts", "test/widget.test.ts"];
const MONOLITH_TASK_ID = "W1-T99122";

/** A plan with one sharded task record, the shape `plan/tasks.d` files are filed in. */
function planWithTask(t: TestContext): { root: string; planDir: string; config: Config } {
  const root = ownedFixtureDir(t, "assignment-names-its-work").dir;
  const planDir = join(root, "plan");
  mkdirSync(join(planDir, "tasks.d"), { recursive: true });
  // An older task still lives in the monolith, not a shard.
  writeFileSync(join(planDir, "tasks.yaml"), `- id: ${MONOLITH_TASK_ID}
  title: "An older widget"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: low
  origin: fixture
  files: [docs/widget.md]
  status: queued
  acceptance:
    - claim: "it reads"
      proof: "unit test: it reads"
`);
  writeFileSync(join(planDir, "tasks.d", `${TASK_ID}-a-widget.yaml`), `- id: ${TASK_ID}
  title: "A widget"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: high
  origin: fixture
  files: [${TASK_FILES.join(", ")}]
  status: queued
  acceptance:
    - claim: "it works"
      proof: "unit test: it works"
`);
  return { root, planDir, config: { root, claudeBin: "/unused" } as Config };
}

function assignmentFor(id: string): WorkerSelectionAssignment {
  return {
    version: 1, id, phase: "pre-execution",
    requested: { model: "requested-model", effort: "high", maxTurns: null },
    selected: { provider: "codex", model: "selected-model", effort: "high" },
    routing: { mode: "multi-provider", policy: { preference: "automatic", reservePercent: 5, provenance: "default" } },
    candidates: [],
  };
}

function workerResult(assignmentId: string): WorkerResult {
  return { sessionId: `${assignmentId}-session`, costUsd: 0, numTurns: 1, text: "done", blocks: [], stderr: "",
    subtype: "success", isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "selected-model",
    effort: "high", tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, selectionAssignmentId: assignmentId } as WorkerResult;
}

/** A provider double that assigns the call and returns: the receipt wrapper above it is the code under test. */
const assigningProvider: typeof spawnWorker = async (args) => {
  const id = `${args.runId ?? "run"}-assignment`;
  args.onSelectionAssignment?.(assignmentFor(id));
  return workerResult(id);
};

function baseArgs(config: Config, extra: Partial<SpawnWorkerArgs> = {}): SpawnWorkerArgs {
  return { cwd: config.root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"),
    prompt: "fixture prompt", config, ...extra };
}

function assignmentRows(config: Config): Row[] {
  return readFileSync(ledgerPathFor(config), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row)
    .filter((row) => row.step === "worker.assignment");
}

const receiptOf = (row: Row | undefined): Receipt => row!.benchmark_run as Receipt;

test("W1-T12152 criterion 1: an assignment for fix or review work on a pull request with a task records that task's risk and task class, as a build assignment does", async (t) => {
  const { planDir, config } = planWithTask(t);
  const taskClass = deriveTaskClass({ files: TASK_FILES });
  // The build path: the run.start's class and risk ride the logger into the assignment receipt.
  const built: Row[] = [];
  const buildLog = benchmarkRunLedgerLogger((_step, fields) => { built.push(fields); });
  buildLog("run.start", { task_class: taskClass, risk: "high" });
  buildLog("worker.assignment", { worker_assignment: assignmentFor("build-assignment") });
  const build = receiptOf(built.at(-1)).work;
  assert.deepEqual(build.risk, { state: "observed", value: "high" });

  await withLiveWritesAllowed(async () => {
    // The review lane carries its PR's task class (W1-T14146) and names the task; the record supplies the risk.
    await ledgeredNonDispatchSpawn("review", assigningProvider, planDir)(
      withReceiptWork(baseArgs(config, { taskId: TASK_ID, runId: "review-run" }), { taskClass }));
    // A fix rung on the task's pull request carries nothing but the task id; the record supplies both.
    await ledgeredNonDispatchSpawn("main-repair-fix", assigningProvider, planDir)(baseArgs(config, { taskId: TASK_ID, runId: "fix-run" }));
    // A task filed in the monolith is read from there.
    await ledgeredNonDispatchSpawn("review", assigningProvider, planDir)(baseArgs(config, { taskId: MONOLITH_TASK_ID, runId: "old-task-run" }));
    // The falsifier: the same review with the task left out records neither.
    await ledgeredNonDispatchSpawn("review", assigningProvider, planDir)(baseArgs(config, { runId: "taskless-review-run" }));
  });
  const rows = assignmentRows(config);
  for (const runId of ["review-run", "fix-run"]) {
    const work = receiptOf(rows.find((row) => row.run_id === runId)).work;
    assert.deepEqual(work.risk, build.risk, `${runId}: the task's risk, as the build assignment records it`);
    assert.deepEqual(work.taskClass, build.taskClass, `${runId}: the task's class, as the build assignment records it`);
    assert.deepEqual(work.taskClass, { state: "observed", value: taskClass });
  }
  const old = receiptOf(rows.find((row) => row.run_id === "old-task-run")).work;
  assert.deepEqual([old.risk, old.taskClass], [{ state: "observed", value: "low" },
    { state: "observed", value: deriveTaskClass({ files: ["docs/widget.md"] }) }], "the monolith record's risk and class");
  const taskless = receiptOf(rows.find((row) => row.run_id === "taskless-review-run")).work;
  assert.equal((taskless.risk as { state: string }).state, "unavailable", "no task, so no risk");
});

test("W1-T12152 criterion 1: the sweep fix rung's own spawn reads the task's record, so its fix assignment records the task's risk and class", async (t) => {
  const { root, config } = planWithTask(t);
  // The production rung, with the fixture as its harness checkout: its default reader is that checkout's plan.
  await withLiveWritesAllowed(() => gitCredentialFixSpawn(join(root, "helper.sock"), assigningProvider, root)(
    baseArgs(config, { taskId: TASK_ID, runId: "sweep-fix-run" })));
  const work = receiptOf(assignmentRows(config).find((row) => row.run_id === "sweep-fix-run")).work;
  assert.deepEqual(work.pipeline, { state: "observed", value: "sweep-fix" });
  assert.deepEqual(work.risk, { state: "observed", value: "high" }, "the task record's risk");
  assert.deepEqual(work.taskClass, { state: "observed", value: deriveTaskClass({ files: TASK_FILES }) }, "the task record's class");
});

test("W1-T12152 criterion 1: the one-shot sweep's default fix spawn, handed no reader, reads the repository plan's task record", async (t) => {
  const { config } = planWithTask(t);
  // The one-shot `rmd sweep` path passes no spawn, so `runSweep` falls back to `benchmarkNonDispatchSpawn("sweep-fix")`.
  const realTask = "W1-T12152";
  await withLiveWritesAllowed(() => benchmarkNonDispatchSpawn("sweep-fix", assigningProvider)(
    baseArgs(config, { taskId: realTask, runId: "one-shot-sweep-fix-run" })));
  const work = receiptOf(assignmentRows(config).find((row) => row.run_id === "one-shot-sweep-fix-run")).work;
  const record = readFileSync(join(REPO_ROOT, "plan/tasks.d/W1-T12152-every-assignment-names-its-risk-its-task-class-and-its-prompt-revision.yaml"), "utf8");
  const risk = /^\s+risk:\s*(\S+)/m.exec(record)?.[1];
  assert.ok(risk, "the real record names a risk");
  assert.deepEqual(work.risk, { state: "observed", value: risk }, "the real record's risk, not task-record-not-read-by-lane");
  assert.equal((work.taskClass as { state: string }).state, "observed", "the real record's class");
});

test("W1-T12152 criterion 2: an assignment for work with no task records the pipeline and a named reason, never an empty risk", async (t) => {
  const { planDir, config } = planWithTask(t);
  await withLiveWritesAllowed(async () => {
    await ledgeredNonDispatchSpawn("triage", assigningProvider, planDir)(baseArgs(config, { runId: "no-task-run" }));
    await ledgeredNonDispatchSpawn("triage", assigningProvider, planDir)(baseArgs(config, { runId: "unfiled-run", taskId: "W1-T99999" }));
    await benchmarkNonDispatchSpawn("ci-judge", assigningProvider)(baseArgs(config, { runId: "unread-run", taskId: TASK_ID }));
    await benchmarkNonDispatchSpawn({ lane: "ci-judge", readTask: () => { throw new Error("EIO"); } }, assigningProvider)(
      baseArgs(config, { runId: "unreadable-run", taskId: TASK_ID }));
    // The inbox-draft lane writes its own assignment row (`ledgerNonDispatchAssignment`), with no task.
    const draft = buildInboxDraftSpawnArgs({ cwd: config.root, settingsFile: join(REPO_ROOT, "settings/worker.json"), prompt: "draft",
      mount: { model: "haiku", effort: "low", maxTurns: 5 } as never, config, disallowedTools: [] });
    draft.onSelectionAssignment!(assignmentFor("draft-assignment"));
  });
  const rows = assignmentRows(config);
  const expected: Array<[string, string, string]> = [
    ["no-task-run", "triage", "work-has-no-task"],
    ["unfiled-run", "triage", "named-task-has-no-record"],
    ["unread-run", "ci-judge", "task-record-not-read-by-lane"],
    ["unreadable-run", "ci-judge", "task-record-unreadable"],
    ["inbox-draft-draft-assignment", "inbox-draft", "work-has-no-task"],
  ];
  for (const [runId, pipeline, reason] of expected) {
    const work = receiptOf(rows.find((row) => row.run_id === runId)).work;
    assert.deepEqual(work.pipeline, { state: "observed", value: pipeline }, `${runId}: the pipeline is recorded`);
    assert.deepEqual(work.risk, { state: "unavailable", reason }, `${runId}: the risk names why it is absent`);
    assert.deepEqual(work.taskClass, { state: "unavailable", reason }, `${runId}: the class names why it is absent`);
  }
});

/** A real spawnWorker routed to a Codex double: the assignment it emits is the code under test. */
function routedSpawn(t: TestContext) {
  const root = ownedFixtureDir(t, "assignment-prompt-revision").dir;
  // The worker home is seeded from HOME's credentials: a fixture HOME keeps the operator's out of the spawn.
  const home = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { process.env.HOME = home; });
  const now = Date.now();
  const config: Config = { root, claudeBin: "/unused", dailyCapUsd: 25,
    workerProviders: { enabled: ["claude", "codex"] } } as Config;
  const allowance = openWeightAllowancePath(config);
  mkdirSync(dirname(allowance), { recursive: true });
  writeFileSync(allowance, JSON.stringify({ utcDay: new Date(now).toISOString().slice(0, 10), reservations: {} }));
  const result = (): WorkerResult => ({ provider: "codex", sessionId: "fixture-session", text: "done", blocks: [], stderr: "",
    isError: false, apiError: false, subtype: "success", costUsd: 0, numTurns: 1, permissionDenials: [], childEnvKeys: [],
    model: "fixture", effort: "low", tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false });
  const args = (extra: Partial<SpawnWorkerArgs>): SpawnWorkerArgs => ({
    cwd: root, permissionMode: "bypassPermissions", settingsFile: join(REPO_ROOT, "settings/worker.json"), config,
    model: "haiku", effort: "low", prompt: "unset", egress: { mode: "off" },
    providerRouting: {
      now: () => now, draw: 0, writeStatus: () => {},
      readClaudeHealth: async () => ({ degradedModels: [], source: "fresh", observedAtMs: now }),
      readClaude: async () => ({ provider: "claude", readable: true, windows: [{ name: "fixture", usedPercent: 100 }] }),
      readCodex: async () => ({ provider: "codex", readable: true, model: "gpt-6.1-sol", effort: "low",
        windows: [{ name: "fixture", usedPercent: 0 }] }),
      spawnCodex: async () => result(),
    },
    claudeExecutable: { cache: createClaudeExecutableCache(), deps: {
      env: { RMD_CLAUDE_BIN: "/fixture/claude" }, home: root, exists: () => true,
      which: () => "/fixture/claude", canExecute: () => true, locations: [],
    } },
    ...extra,
  });
  const assigned = async (extra: Partial<SpawnWorkerArgs>): Promise<WorkerSelectionAssignment> => {
    const seen: WorkerSelectionAssignment[] = [];
    await spawnWorker(args({ ...extra, onSelectionAssignment: (a) => seen.push(a) }));
    assert.equal(seen.length, 1, "the call was assigned once");
    return seen[0]!;
  };
  return { config, args, assigned };
}

const TEMPLATE = "You are a REVIEW worker.\n# TASK\n${TASK_BODY}\n# OUTPUT CONTRACT\nEnd with REVIEW_VERDICT lines.";
const fill = (body: string) => TEMPLATE.split("${TASK_BODY}").join(body);

test("W1-T12152 criterion 3: every assignment records a prompt revision, a hash of the prompt template and the tool list, and two workers given the same template and tools record the same revision", async (t) => {
  const { config, args, assigned } = routedSpawn(t);
  const tools = ["Read", "Grep", "Glob"];
  const first = await assigned({ prompt: fill("review PR 1"), promptTemplate: TEMPLATE, tools });
  const second = await assigned({ prompt: fill("review PR 2"), promptTemplate: TEMPLATE, tools: ["Glob", "Read", "Grep"] });
  assert.equal((first.prompt_revision as { source: string }).source, "resolved-artifact");
  assert.match((first.prompt_revision as { revision: string }).revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(second.prompt_revision, first.prompt_revision, "same template and tools, in any order: the same revision");
  assert.deepEqual(first.prompt_revision, workerPromptRevision(TEMPLATE, tools), "the revision is the template and tools' hash");

  const moreTools = await assigned({ prompt: fill("review PR 1"), promptTemplate: TEMPLATE, tools: [...tools, "Bash"] });
  assert.notDeepEqual(moreTools.prompt_revision, first.prompt_revision, "a different tool list is a different revision");
  const otherTemplate = await assigned({ prompt: fill("review PR 1"), promptTemplate: `${TEMPLATE}\nOne more rule.`, tools });
  assert.notDeepEqual(otherTemplate.prompt_revision, first.prompt_revision, "a different template is a different revision");
  const undeclared = await assigned({ prompt: fill("review PR 1"), tools });
  assert.deepEqual(undeclared.prompt_revision, { state: "unavailable", reason: "prompt-template-not-declared" },
    "a call that declared no template records the named gap");

  // The receipt on the ledgered row pins the worker's revision.
  await withLiveWritesAllowed(() => benchmarkNonDispatchSpawn("review", spawnWorker)(
    args({ prompt: fill("review PR 3"), promptTemplate: TEMPLATE, tools, runId: "receipted-run" })));
  const row = assignmentRows(config).find((r) => r.run_id === "receipted-run");
  assert.deepEqual(receiptOf(row).stack.promptRevision,
    { state: "observed", value: (first.prompt_revision as { revision: string }).revision });
});

test("W1-T12152 criterion 4: the hash is taken from the template before task text is filled in, so no task text or secret enters it", async (t) => {
  const { config, args, assigned } = routedSpawn(t);
  const tools = ["Read"];
  const secret = "ghp_" + "Z".repeat(36);
  const one = await assigned({ prompt: fill(`task W1-T1 body with ${secret}`), promptTemplate: TEMPLATE, tools });
  const two = await assigned({ prompt: fill("task W1-T2 body, nothing alike"), promptTemplate: TEMPLATE, tools });
  assert.deepEqual(one.prompt_revision, two.prompt_revision, "two tasks under one template give one revision");
  const revision = (one.prompt_revision as { revision: string }).revision;
  const filledHash = createHash("sha256").update(fill(`task W1-T1 body with ${secret}`)).digest("hex");
  assert.notEqual(revision, filledHash, "the filled prompt is never what is hashed");

  await withLiveWritesAllowed(() => benchmarkNonDispatchSpawn("review", spawnWorker)(
    args({ prompt: fill(`task W1-T1 body with ${secret}`), promptTemplate: TEMPLATE, tools, runId: "secret-run" })));
  const row = assignmentRows(config).find((r) => r.run_id === "secret-run");
  assert.equal(JSON.stringify(row).includes(secret), false, "no secret reaches the assignment row");
  assert.equal(JSON.stringify(row).includes("task W1-T1 body"), false, "no task text reaches the assignment row");
  assert.deepEqual(receiptOf(row).stack.promptRevision, { state: "observed", value: revision });
});

type LaneCall = { lane: "build" | "fix" | "review"; marker: string; args: SpawnWorkerArgs };

const LANE_MARKERS = ["alpha-widget-zq " + "ghp_" + "Q".repeat(36), "beta-gadget-xv nothing alike"] as const;
const LANE_MOUNT: Mount = { model: "sonnet", effort: "high", maxTurns: 20, contextBudget: 120000 };

function laneWorker(text: string, over: Partial<WorkerResult> = {}): WorkerResult {
  return { sessionId: "lane-session", costUsd: 0, numTurns: 1, text, blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "sonnet", effort: "high",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {}, compactionEvents: [],
    qualitySuspect: false, ...over } as WorkerResult;
}

/** The build lane: a real dispatch of a task whose title carries `marker`, its implement spawn captured. */
async function buildLaneCall(marker: string): Promise<SpawnWorkerArgs> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t12152-build-"));
  const bare = gitRepo({ bare: true, kind: "w1-t12152-origin" });
  const seed = gitRepo({ kind: "w1-t12152-seed" });
  try {
    seed.addRemote("origin", bare.dir);
    seed.git("push", "--quiet", "origin", "main");
    mkdirSync(join(root, "repos"), { recursive: true });
    execFileSync("git", ["clone", "--quiet", bare.dir, join(root, "repos", "remudero")]);
    mkdirSync(join(root, "state"), { recursive: true });
    const planPath = join(root, "tasks.yaml");
    writeFileSync(planPath, `- id: W1-T99123
  title: "build ${marker}"
  repo: remudero
  depends_on: []
  type: implement
  verify: auto
  risk: medium
  origin: fixture
  files: [src/lib/daemon.ts, test/daemon.test.ts]
  acceptance:
    - claim: the fixture dispatches
      proof: "unit test: test/daemon.test.ts"
  status: queued
`);
    const calls: SpawnWorkerArgs[] = [];
    const spawn = async (args: SpawnWorkerArgs) => {
      calls.push(args);
      return laneWorker(calls.length === 1 ? "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n"
        : "REPORT\nno PR opened\n", { sessionId: `build-${calls.length}` });
    };
    await withLiveWritesAllowed(() => runTask("W1-T99123", {
      skipGitSync: true, planPath,
      config: { claudeBin: "/bin/true", root, installRoot: process.cwd() } as Config,
      github: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
      spawn,
      containmentExec: async (token) => ({ transcript: `touch ../${token}.txt: Operation not permitted`, outsideWriteCreated: false,
        insideWriteCreated: true, costUsd: 0 }),
      isolationExec: async () => ({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0,
        functionCount: 0, functionNames: "-", costUsd: 0 }),
    }));
    const implement = calls.find((args) => args.prompt.startsWith("You are an IMPLEMENT worker"));
    assert.ok(implement, `the dispatch reached its implement spawn (${calls.length} spawns)`);
    return implement;
  } finally {
    rmSync(root, { recursive: true, force: true });
    seed.cleanup();
    bare.cleanup();
  }
}

/** The fix lane: one real fix rung round on a task whose title carries `marker`, its fix spawn captured. */
async function fixLaneCall(marker: string): Promise<SpawnWorkerArgs> {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t12152-fix-"));
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ task_id: "W1-T99124", step: "run.start" })}\n`);
  const criterion: CriterionVerdict = { claim: `fix ${marker}`, proof: "unit test: the fix lands", met: false,
    reason: `still blocked ${marker}`, proof_exec: "not_executable" };
  const failed = (): ReviewVerdict & { headSha: string; reviewerOutcome: string } => ({ state: "failure", criteria: [criterion],
    testTheater: false, summary: `blocked ${marker}`, floorDegraded: false, capped: false, keywordOnly: false, planOnly: false,
    headSha: "head-a", reviewerOutcome: "failure" });
  const issues: IssueGateway = { create: () => "https://github.com/acme/remudero/issues/1", listOpen: () => [], comment: () => {} };
  const calls: SpawnWorkerArgs[] = [];
  try {
    await runFixRung({
      taskId: "W1-T99124", runId: "DAEMON-12152",
      task: { id: "W1-T99124", title: `fix ${marker}`, files: ["src/run-task.ts"], acceptance: [{ claim: criterion.claim, proof: criterion.proof }] },
      prUrl: "https://github.com/acme/remudero/pull/12152", branch: "run-W1-T99124-1", worktreePath: process.cwd(),
      initialSessionId: "initial-session", mount: LANE_MOUNT, settingsFile: join(root, "settings.json"),
      config: { root } as Config, budgetUsd: 10, strikeCap: 1, initialReview: failed(),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: root, reviewerMount: LANE_MOUNT },
      deps: {
        spawn: async (args: SpawnWorkerArgs) => {
          calls.push(args);
          return laneWorker("REPORT\nfixed it\nCOMMIT_MESSAGE: fix(ci): repair the red check");
        },
        waitForCiGreen: async () => "green" as const,
        runReview: async () => failed(),
        fetchPrBody: async () => "REPORT",
        push: () => {},
        issues, ledgerPath,
        log: () => {}, say: () => {},
        account: (result: WorkerResult) => result,
        worktreeHasUncommittedChanges: () => false,
        harnessCommitForShellLessWorker: (input: Parameters<typeof harnessCommitForShellLessWorker>[0]) =>
          harnessCommitForShellLessWorker(input, { commit: () => ({ committed: true, sha: "new-head", undeclared: [] }), ahead: () => 1 }),
      },
    });
    const fix = calls.find((args) => args.prompt.startsWith("You are a FIX worker"));
    assert.ok(fix, `the rung reached its fix spawn (${calls.length} spawns)`);
    return fix;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The review lane: the real runReview of a PR whose criterion carries `marker`, its reviewer spawns captured. */
async function reviewLaneCalls(marker: string): Promise<SpawnWorkerArgs[]> {
  const repo = gitRepo({ kind: "w1-t12152-review" });
  mkdirSync(join(repo.dir, "src"));
  writeFileSync(join(repo.dir, "src", "changed.ts"), "export const changed = true;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "fixture");
  const headSha = repo.git("rev-parse", "HEAD");
  const prUrl = "https://github.com/acme/remudero/pull/12153";
  const diff = "diff --git a/src/changed.ts b/src/changed.ts\n+++ b/src/changed.ts\n@@ -0,0 +1 @@\n+export const changed = true;\n";
  const shim = ghShim([
    { when: "pulls/", stdout: JSON.stringify({ number: 12153, html_url: prUrl, updated_at: "t", body: "changed", state: "open",
      head: { ref: "b", sha: headSha } }) },
    { when: "pr diff", stdout: diff },
    { when: "pr view", stdout: '{"state":"OPEN"}' },
    { when: "/statuses?", stdout: "[[]]" },
    { when: "api ", stdout: "{}" },
  ], { kind: "w1-t12152-review-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  const calls: SpawnWorkerArgs[] = [];
  try {
    await runReview({
      owner: "acme", repo: "remudero", prUrl, diff, report: "changed",
      task: { id: "W1-T99125", files: ["src/changed.ts"], acceptance: [{ claim: `review ${marker}`, proof: "grep: changed in src/changed.ts" }] },
      settingsFile: join(repo.dir, "settings.json"), config: { root: repo.dir, claudeBin: "/unused" } as never,
      log: () => {}, say: () => {}, account: (worker: WorkerResult) => worker,
      spawnReviewer: true,
      reviewerSpawnWorker: (async (args: SpawnWorkerArgs) => { calls.push(args); return laneWorker("REVIEW_VERDICT 1: PASS"); }) as typeof spawnWorker,
      reviewerMount: LANE_MOUNT, headCheckoutDir: repo.dir, ledgerPath: join(repo.dir, "ledger.ndjson"), runId: `review-${calls.length}`,
      disarm: () => "not-armed" as const, arm: () => ({ armed: false, reason: "test" }),
    } as never);
    assert.ok(calls.length > 0, "the review reached its reviewer spawn");
    return calls;
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    repo.cleanup();
  }
}

let laneCallsOnce: Promise<LaneCall[]> | undefined;
/** Each lane driven once per marker: two tasks, one renderer, one contract. */
function laneCalls(): Promise<LaneCall[]> {
  laneCallsOnce ??= (async () => {
    const out: LaneCall[] = [];
    for (const marker of LANE_MARKERS) {
      out.push({ lane: "build", marker, args: await buildLaneCall(marker) });
      out.push({ lane: "fix", marker, args: await fixLaneCall(marker) });
      for (const args of await reviewLaneCalls(marker)) out.push({ lane: "review", marker, args });
    }
    return out;
  })();
  return laneCallsOnce;
}

const revisionOf = (args: SpawnWorkerArgs) => workerPromptRevision(args.promptTemplate, args.tools, args.disallowedTools);

test("W1-T12152 criterion 3: the build, fix and review lanes each declare their prompt template, so two of their workers given the same template and tools record the same revision", async () => {
  const calls = await laneCalls();
  for (const lane of ["build", "fix", "review"] as const) {
    const [first, second] = LANE_MARKERS.map((marker) => calls.find((call) => call.lane === lane && call.marker === marker)!);
    assert.ok(first && second, `${lane}: both tasks reached the lane's spawn`);
    assert.equal(typeof first.args.promptTemplate, "string", `${lane}: the call site declares its template`);
    const revision = revisionOf(first.args);
    assert.equal((revision as { source?: string }).source, "resolved-artifact", `${lane}: a hashed revision, not the named gap`);
    assert.deepEqual(revisionOf(second.args), revision, `${lane}: two tasks under one template and tool list give one revision`);
  }
});

test("W1-T12152 criterion 4: each lane's template is taken before task text is filled in, so the filled text never changes its revision", async () => {
  const calls = await laneCalls();
  for (const lane of ["build", "fix", "review"] as const) {
    const [first, second] = LANE_MARKERS.map((marker) => calls.find((call) => call.lane === lane && call.marker === marker)!);
    assert.ok(first.args.prompt.includes(LANE_MARKERS[0]), `${lane}: the filled prompt carries the first task's text`);
    assert.notEqual(first.args.prompt, second.args.prompt, `${lane}: the two filled prompts differ`);
    for (const { args } of [first, second]) {
      for (const marker of LANE_MARKERS) {
        assert.equal(args.promptTemplate!.includes(marker), false, `${lane}: no task text or secret enters the template`);
      }
    }
    assert.notDeepEqual(revisionOf(first.args), workerPromptRevision(first.args.prompt, first.args.tools, first.args.disallowedTools),
      `${lane}: the filled prompt is never what is hashed`);
  }
});
