import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { benchmarkRunLedgerLogger, buildInboxDraftSpawnArgs, ledgeredNonDispatchSpawn } from "#test/routing/assignment-receipt-test-seams.js";
import { benchmarkNonDispatchSpawn, withReceiptWork } from "#src/lib/benchmark-run.js";
import type { Config } from "#src/lib/config.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { deriveTaskClass } from "#src/lib/task-class.js";
import { openWeightAllowancePath } from "#src/lib/worker-provider.js";
import { createClaudeExecutableCache, spawnWorker, workerPromptRevision, type SpawnWorkerArgs, type WorkerResult,
  type WorkerSelectionAssignment } from "#src/lib/worker.js";
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

test("W1-T12152 criterion 2: an assignment for work with no task records the pipeline and a named reason, never an empty risk", async (t) => {
  const { planDir, config } = planWithTask(t);
  await withLiveWritesAllowed(async () => {
    await ledgeredNonDispatchSpawn("triage", assigningProvider, planDir)(baseArgs(config, { runId: "no-task-run" }));
    await ledgeredNonDispatchSpawn("triage", assigningProvider, planDir)(baseArgs(config, { runId: "unfiled-run", taskId: "W1-T99999" }));
    await benchmarkNonDispatchSpawn("ci-judge", assigningProvider)(baseArgs(config, { runId: "unread-run", taskId: TASK_ID }));
    await benchmarkNonDispatchSpawn("ci-judge", assigningProvider, () => { throw new Error("EIO"); })(
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
