// W1-T12221: a gardener land whose paths are all edits of task files that origin/main holds rides the
// shared sealed landing PR of W1-T12199, and `land` returns a waiting result while that PR is open.
// Every test drives the production path: `gardenCheckoutAsync` over real git against a bare origin, with
// fakes only for GitHub and for the plan preflight verdict.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { clockFromMillisFn } from "#src/lib/clock.js";
import { landTaskFilesAsync, stagedTaskFiles } from "#src/lib/feedback-landing.js";
import {
  gardenStatePath, initialGardenState, isGardenLandWaiting, prepareGardenTaskIds, runGardenAsync,
  type GardenAction, type GardenCheckout, type GardenerDeps, type GardenSpec, type GardenTaskIdMinter,
} from "#src/lib/gardener.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { machineShardHeaderLines } from "#src/lib/machine-filing.js";
import { runMachineFilingJudge, type MachineJudgePorts } from "#src/lib/machine-filing-judge.js";
import type { PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { gitBlobSha } from "#src/lib/plan-shard-repair.js";
import { loadPlan, parseTasksFromYaml, type Task } from "#src/lib/plan.js";
import type { PlanInventory } from "#src/lib/plan-gardener.js";
import { QUEUE_JUDGE_CLASSES, QUEUE_JUDGE_NAME, queueJudgeGardenSpec, type QueueJudgeSources } from "#src/lib/queue-judge-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gardenCheckoutAsync, runShardRepairPass, shardRepairRequester, type GardenCheckoutOpts, type GardenName } from "#test/helpers/run-task-test.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "#test/helpers/git-repo.js";

const T0 = Date.parse("2026-11-11T12:00:00.000Z");
const A = "W1-T90001";
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const shard = (id: string): string => [`- id: ${id}`, "  repo: remudero", "  status: queued", "  attempts: 0", ""].join("\n");
const GREEN: PlanPrPreflightResult = { ok: true, failures: [], unreadable: [] };
const SEALED = "https://github.com/acme/remudero/pull/8000";
type Row = Record<string, unknown> & { step: string };

/** A bare origin whose main holds `files`, a clone the gardens check out from, and GitHub as both landings see it. */
function world(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t12221-`));
  const origin = gitRepo({ bare: true, kind: "w1-t12221-origin" });
  const author = gitRepo({ cloneFrom: origin.dir, kind: "w1-t12221-author" });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(author.dir, rel, ".."), { recursive: true });
    writeFileSync(join(author.dir, rel), text);
  }
  author.git("add", "-A");
  author.git("commit", "--quiet", "-m", "seed the plan");
  author.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "w1-t12221-repo" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  t.after(() => {
    for (const r of [origin, author, repo]) r.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const rows: Row[] = [];
  const log = (step: string, extra: Record<string, unknown> = {}): void => void rows.push({ ...extra, step });
  const gh = { open: [] as Array<{ url: string }>, creates: [] as string[], own: [] as string[] };
  const landingGh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(gh.open);
    if (args[0] === "pr" && args[1] === "create") {
      const url = `https://github.com/acme/remudero/pull/${9000 + gh.creates.length + 1}`;
      gh.creates.push(url);
      gh.open = [{ url }];
      return url;
    }
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN" });
    return "[]";
  };
  let tick = T0;
  const clock = clockFromMillisFn(() => (tick += 1000));
  const taskFilesLanding = { stateRoot: root, gh: landingGh, planPrPreflight: async () => GREEN };
  const checkoutOpts = (name: GardenName): GardenCheckoutOpts => ({
    name, repoDir: repo.dir, worktreesRoot: join(root, "worktrees"), owner: "acme", repo: "remudero", log, clock,
    preflight: () => GREEN,
    // The REST create of a garden's own PR.
    fetcher: async () => {
      const number = 700 + gh.own.length;
      gh.own.push(`https://github.com/acme/remudero/pull/${number}`);
      return { html_url: gh.own.at(-1), number };
    },
    taskFilesLanding,
  });
  const pending = join(root, "state", "task-files-landing-pending", "plan", "tasks.d");
  return {
    root, stateDir: join(root, "state"), origin, repo, rows, gh, clock, checkoutOpts,
    steps: (step: string) => rows.filter((r) => r.step === step),
    heads: () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean),
    staged: () => (existsSync(pending) ? readdirSync(pending).filter((f) => f.endsWith(".yaml")).sort() : []),
    /** A landing PR that is open seals the landing branch. */
    seal: () => void (gh.open = [{ url: SEALED }]),
    /** The sealed PR merged without these files; the next landing call opens a PR that carries them. */
    landWaiting: async () => {
      gh.open = [];
      return withLiveWritesAllowed(() => landTaskFilesAsync(repo.dir, [], { ...taskFilesLanding, targetRepository: { owner: "acme", repo: "remudero" }, log }));
    },
  };
}

const tend = (root: string, rel: string): void => writeFileSync(join(root, rel), `${readFileSync(join(root, rel), "utf8")}  # tended\n`);
const tendBody = (rel: string): string => `Tend one task file.\n\n## Acceptance\n- claim: the task file is tended\n  proof: grep: # tended in ${rel}`;

test("W1-T12221 criterion 1: an edit of a task file main holds goes through the sealed landing; a docs path or a new file opens its own PR", async (t) => {
  const w = world(t, { [pathOf(A)]: shard(A), "docs/notes.txt": "# notes\n" });
  const edit = await gardenCheckoutAsync(w.checkoutOpts("plan"));
  try {
    tend(edit.root, pathOf(A));
    const url = await withLiveWritesAllowed(() => edit.land({ paths: [pathOf(A)], title: "chore(plan): tend a task file", body: tendBody(pathOf(A)) }));
    assert.equal(url, w.gh.creates[0], "the land returns the landing PR that carries the file");
    assert.equal(w.gh.own.length, 0, "the edit opens no PR of its own");
    assert.ok(w.heads().some((h) => h.startsWith("task-files-landing")), "the file rides the landing branch");
    assert.ok(!w.heads().includes(edit.branch!), "the garden branch is never pushed");
  } finally {
    await edit.dispose();
  }
  const docs = await gardenCheckoutAsync(w.checkoutOpts("plan"));
  try {
    writeFileSync(join(docs.root, "docs/notes.txt"), "# notes\n\ntended\n");
    const url = await withLiveWritesAllowed(() => docs.land({ paths: ["docs/notes.txt"], title: "chore(docs): tend the notes", body: tendBody("docs/notes.txt") }));
    assert.equal(url, w.gh.own[0], "a docs path opens its own PR, as before");
    assert.ok(w.heads().includes(docs.branch!));
  } finally {
    await docs.dispose();
  }
  const fresh = await gardenCheckoutAsync(w.checkoutOpts("plan"));
  try {
    writeFileSync(join(fresh.root, pathOf("W1-T90009")), shard("W1-T90009"));
    const url = await withLiveWritesAllowed(() => fresh.land({ paths: [pathOf("W1-T90009")], title: "chore(plan): file a task", body: tendBody(pathOf("W1-T90009")) }));
    assert.equal(url, w.gh.own[1], "a new task file opens its own PR, as before");
  } finally {
    await fresh.dispose();
  }
  assert.equal(w.gh.creates.length, 1);
});

test("W1-T12221 criterion 2: `land` returns a waiting result when the file is staged behind an open landing PR", async (t) => {
  const w = world(t, { [pathOf(A)]: shard(A) });
  w.seal();
  const ws = await gardenCheckoutAsync(w.checkoutOpts("plan"));
  try {
    tend(ws.root, pathOf(A));
    const result = await withLiveWritesAllowed(() => ws.land({ paths: [pathOf(A)], title: "chore(plan): tend a task file", body: tendBody(pathOf(A)) }));
    assert.deepEqual(result, { waiting: { paths: [pathOf(A)], stateRoot: w.root } });
    assert.equal(isGardenLandWaiting(result), true);
    assert.deepEqual(w.staged(), [`${A}-fixture.yaml`]);
    assert.equal(w.gh.creates.length + w.gh.own.length, 0, "no PR opens while the landing is sealed");
  } finally {
    await ws.dispose();
  }
});

/** A one-class garden that edits task file A and reserves one task id per filing. */
function tendingGarden(w: ReturnType<typeof world>) {
  const released: string[] = [];
  const escalations: unknown[] = [];
  const cheap = { n: 0 };
  let opened = 0;
  const mint = Object.assign(() => "W1-T99999", {
    async: async () => "W1-T99999",
    release: (id: string) => void released.push(id),
    releaseAsync: async (id: string) => void released.push(id),
  }) as GardenTaskIdMinter;
  const spec: GardenSpec<"edit", { n: number }, GardenAction<"edit">, GardenCheckout> = {
    name: "tending", classes: ["edit"], decision: ["edit"],
    cheapFingerprint: () => String(cheap.n), inventory: () => ({ n: cheap.n }), fingerprint: (i) => String(i.n),
    candidates: () => [{ class: "edit", target: A, reason: "the fixture tends it" }],
    scorecard: () => ({}),
    prepare: (ws, _plan, async) => prepareGardenTaskIds(ws, 1, mint, async),
    apply: (ws) => {
      tend(ws.root, pathOf(A));
      return { paths: [pathOf(A)], title: "chore(plan): tend a task file", body: tendBody(pathOf(A)) };
    },
  };
  const deps: GardenerDeps = {
    stateDir: w.stateDir, repoRoot: w.repo.dir, seed: 1, clock: w.clock,
    log: (step, extra = {}) => void w.rows.push({ ...extra, step }),
    openWorkspace: () => (opened++, gardenCheckoutAsync(w.checkoutOpts("plan"))),
    prState: () => "open",
    escalate: (e) => (escalations.push(e), "https://github.com/acme/remudero/issues/1"),
    mergedPlanLint: () => undefined,
  };
  mkdirSync(w.stateDir, { recursive: true });
  writeFileSync(gardenStatePath(w.stateDir, "tending"), JSON.stringify({ ...initialGardenState(["edit"]), classes: { edit: { alpha: 1000, beta: 1 } } }));
  const state = () => JSON.parse(readFileSync(gardenStatePath(w.stateDir, "tending"), "utf8")) as Record<string, unknown>;
  const pass = () => withLiveWritesAllowed(() => runGardenAsync(spec, deps));
  return { cheap, released, escalations, state, pass, opened: () => opened };
}

test("W1-T12221: a gardener whose file waits records the wait, holds its lane and tracks the landing PR", async (t) => {
  const w = world(t, { [pathOf(A)]: shard(A) });
  const g = tendingGarden(w);
  w.seal();
  await g.pass();

  await t.test("W1-T12221 criterion 3: a waiting result is not a failed filing", () => {
    const s = g.state();
    assert.equal(s.filingFailures, undefined, "no failure is counted");
    assert.equal(s.refusedLanding, undefined, "no draft is stored as refused");
    assert.equal(w.steps("tending.garden_filing_failed").length, 0);
    assert.equal(g.escalations.length, 0, "nothing escalates");
    assert.deepEqual((s.waiting as { paths: string[] }).paths, [pathOf(A)]);
    assert.deepEqual(w.steps("tending.scorecard").at(-1)?.waiting, [pathOf(A)]);
  });

  await t.test("W1-T12221 criterion 4: a waiting result does not release the reserved task id", () => {
    assert.deepEqual(g.released, [], "the id stays reserved while its file waits");
  });

  await t.test("W1-T12221 criterion 5: the waiting gardener plans no new action, then tracks the landing PR that carries its file", async () => {
    g.cheap.n = 1;
    await g.pass();
    assert.equal(g.opened(), 1, "no second checkout: the waiting lane plans nothing");
    assert.equal(w.steps("tending.scorecard").at(-1)?.actions, 0);
    assert.deepEqual(w.staged(), [`${A}-fixture.yaml`], "no second file is staged");
    const landing = await w.landWaiting();
    assert.deepEqual(landing.landed, [pathOf(A)]);
    await g.pass();
    const s = g.state();
    assert.equal(s.waiting, undefined);
    assert.equal((s.pending as { prUrl: string }).prUrl, w.gh.creates[0], "the landing PR becomes the pending PR");
    assert.equal(w.steps("tending.garden_waiting_landed")[0]?.pr_url, w.gh.creates[0]);
  });
});

function machineShard(id: string): string {
  const files = ["docs/ci-friction-remedies.md"];
  return [
    `- id: ${id}`, `  title: ${JSON.stringify(`record the remedy for ${id}`)}`, "  repo: remudero", "  depends_on: []", "  type: implement",
    ...machineShardHeaderLines(files), `  origin: ${JSON.stringify(`ci-friction:${id}`)}`, "  files:", ...files.map((f) => `    - ${f}`),
    "  acceptance:", `    - claim: "the remedy for ${id} is recorded"`, `      proof: "grep: ${id} in ${files[0]}"`, "",
  ].join("\n");
}

test("W1-T12221 criterion 6: the machine-filing judge holds its rulings while they wait and does not rule on the same tasks again", async (t) => {
  const rel = "plan/tasks.d/W1-T9700-x.yaml";
  const w = world(t, { "plan/tasks.yaml": "[]\n", [rel]: machineShard("W1-T9700"), "docs/ci-friction-remedies.md": "# remedies\n" });
  let asked = 0;
  const ports: MachineJudgePorts = {
    stateDir: w.stateDir,
    plan: () => loadPlan(join(w.repo.dir, "plan", "tasks.yaml")),
    riskJudge: async () => (asked++, { verdict: "low", confidence: 0.9, reasons: ["a docs remedy for a measured gate cost"] }),
    openWorkspace: () => gardenCheckoutAsync(w.checkoutOpts("machine-judge")),
    prState: () => "open",
    stageProposal: () => undefined,
    log: (step, extra = {}) => void w.rows.push({ ...extra, step }),
    clock: w.clock,
  };
  mkdirSync(w.stateDir, { recursive: true });
  w.seal();
  const first = await withLiveWritesAllowed(() => runMachineFilingJudge(ports));
  assert.deepEqual(first.waiting, ["W1-T9700"], "the ruling waits for the landing");
  assert.equal(first.unlanded, undefined, "a wait is not an unlanded ruling");
  assert.equal(asked, 1);
  const second = await withLiveWritesAllowed(() => runMachineFilingJudge(ports));
  assert.deepEqual(second.waiting, ["W1-T9700"]);
  assert.deepEqual(second.proceeded, [], "the judge rules on nothing while its rulings wait");
  assert.equal(asked, 1, "no second model call for the same task");
  await w.landWaiting();
  await withLiveWritesAllowed(() => runMachineFilingJudge(ports));
  assert.equal(w.steps("machine_judge.landing_carried")[0]?.landing_pr, w.gh.creates[0], "the landing PR becomes the judge's pending PR");
  assert.equal(w.steps("machine_judge.waiting").at(-1)?.pr_url, w.gh.creates[0]);
  assert.equal(asked, 1);
});

/** W1-T5431's shard as main carried it before #8877, as `a-shard-repair-that-did-not-land-is-retried` has it. */
const BROKEN_SHARD = [
  "- id: W1-T5431",
  "  title: \"REPAIR THE SELECTOR EDGE INTO test/error-subclass-census.test.ts — a coverage shard failure its retry did not recover was missed\"",
  "  repo: remudero", "  depends_on: []", "  type: implement", "  verify: auto", "  priority: 2.5", "  risk: low", "  priority: 4", "  status: queued",
  "  # backlog gardener: band=4 evidence=0140d95b35f086e4", "  attempts: 0", "  author_class: machine",
  "  origin: \"selector-shadow-miss:test/error-subclass-census.test.ts\"", "  files: [src/lib/affected-suites.ts]",
  "  acceptance:",
  "    - claim: \"the floor selector includes test/error-subclass-census.test.ts when this edge is exercised\"",
  "      proof: \"grep: test/error-subclass-census\\\\.test\\\\.ts in src/lib/affected-suites.ts\"",
  "  risk_ruling:", "    verdict: \"low\"", "    action: proceed", "    confidence: 0.88", "    reasons:",
  "      - \"The filed remedy and sole declared file align: include test/error-subclass-census.test.ts through src/lib/affected-suites.ts.\"",
  "    judged_at: \"2026-10-03T08:48:29.101Z\"",
  "    pin: \"ab561e1f8b0b1a2db9dc2724733bce897da330455897447b4d4ff7927b7c634a\"",
  "",
].join("\n");

test("W1-T12221 criterion 7: the repair of a task file keeps its request while it waits, and opens no second repair for the same file", async (t) => {
  const rel = "plan/tasks.d/w1-t5431-selector-shadow-miss.yaml";
  const w = world(t, { [rel]: BROKEN_SHARD });
  const log = (step: string, extra: Record<string, unknown> = {}): void => void w.rows.push({ ...extra, step });
  mkdirSync(w.stateDir, { recursive: true });
  shardRepairRequester(w.stateDir, log)({ id: "W1-T5431", files: [`origin/main:${rel}`], reason: "shard_invalid" } as Parameters<ReturnType<typeof shardRepairRequester>>[0]);
  const requests = join(w.stateDir, "plan-shard-repair", "requests");
  const request = () => readdirSync(requests).map((f) => JSON.parse(readFileSync(join(requests, f), "utf8")) as Record<string, unknown>);
  const pass = () => withLiveWritesAllowed(() => runShardRepairPass({
    stateDir: w.stateDir, repoDir: w.repo.dir, worktreesRoot: join(w.root, "worktrees"), owner: "acme", repo: "remudero", log, clock: w.clock,
    prState: () => "open", taskFilesLanding: { stateRoot: w.root, gh: w.checkoutOpts("plan").taskFilesLanding!.gh, planPrPreflight: async () => GREEN },
  }));
  w.seal();
  await pass();
  assert.equal(w.steps("plan.shard_repair_waiting").length, 1);
  assert.equal(request().length, 1, "the request is kept while the repair waits");
  assert.equal(request()[0]!.attempts, undefined, "a wait is not an attempt toward the cap");
  assert.equal(w.steps("plan.shard_repair_retry_scheduled").length, 0);
  assert.deepEqual(w.staged(), ["w1-t5431-selector-shadow-miss.yaml"]);
  await pass();
  assert.equal(w.steps("plan.shard_repair_waiting").length, 2);
  assert.equal(w.steps("plan.shard_repair_waiting")[1]!.kept, undefined, "the second pass finds the staged file and lands nothing");
  assert.equal(w.gh.creates.length + w.gh.own.length, 0, "no second repair opens");
  await w.landWaiting();
  await pass();
  const opened = JSON.parse(readFileSync(join(w.stateDir, "plan-shard-repair", "opened.json"), "utf8")) as Record<string, string>;
  assert.deepEqual(opened, { [gitBlobSha(BROKEN_SHARD)]: w.gh.creates[0] }, "the landing PR is recorded once for these bytes");
  assert.equal(existsSync(requests) ? readdirSync(requests).length : 0, 0, "the request is consumed");
});

function queueShard(id: string, priority: string, depends: string[] = []): string {
  return [
    `- id: ${id}`, `  title: "task ${id}"`, "  repo: remudero", `  depends_on: [${depends.join(", ")}]`, "  type: implement", "  verify: auto", "  risk: low",
    "  files:", `    - src/${id}.ts`, `  priority: ${priority}`, "  status: queued", "  attempts: 0", "",
  ].join("\n");
}

test("W1-T12221 criterion 9: the queue judge keeps its own PR and records `queue_judge.prediction` with a real PR url", async (t) => {
  const texts: Record<string, string> = { "W1-T1": queueShard("W1-T1", "2"), "W1-T2": queueShard("W1-T2", "1"), "W1-T6": queueShard("W1-T6", "2", ["W1-T1"]) };
  const w = world(t, Object.fromEntries(Object.entries(texts).map(([id, text]) => [`plan/tasks.d/${id}.yaml`, text])));
  const shards = new Map(Object.keys(texts).map((id) => [id, `plan/tasks.d/${id}.yaml`]));
  const tasks: Task[] = Object.entries(texts).flatMap(([id, text]) => parseTasksFromYaml(text, shards.get(id)!));
  const plan: PlanInventory = { open: tasks, all: tasks, shards };
  const answer = JSON.stringify({ moves: [{
    id: "W1-T1", priority: 1, reason: "unblocks W1-T6", evidence: ["dependents"], expected_cost_of_delay: 7,
    expected_outcome: { unblocks_tasks: ["W1-T6"], ends_incidents: [], unsticks_prs: [], starts_within: 2 },
  }] });
  const clock = clockFromMillisFn(() => Date.parse("2026-10-26T12:00:00.000Z"));
  const sources: Partial<QueueJudgeSources> = {
    clock, plan: () => plan, readShard: (r) => readFileSync(join(w.repo.dir, r), "utf8"), ledger: () => [], incidents: () => [],
    openPrNumbers: () => new Set(), filingDates: () => new Map(), history: () => [], churn: () => 0, credited: () => 0,
    judgeText: async () => answer,
  };
  const deps: GardenerDeps = {
    stateDir: w.stateDir, repoRoot: w.repo.dir, clock, seed: 1, log: (step, extra = {}) => void w.rows.push({ ...extra, step }),
    openWorkspace: () => gardenCheckoutAsync(w.checkoutOpts("queue-judge")), mergedPlanLint: () => undefined,
  };
  mkdirSync(w.stateDir, { recursive: true });
  const strong = initialGardenState(QUEUE_JUDGE_CLASSES);
  for (const c of QUEUE_JUDGE_CLASSES) strong.classes[c] = { alpha: 1000, beta: 1 };
  writeFileSync(gardenStatePath(w.stateDir, QUEUE_JUDGE_NAME), JSON.stringify(strong));
  w.seal();
  const result = await withLiveWritesAllowed(() => runGardenAsync(queueJudgeGardenSpec(deps, sources), deps));
  assert.equal(result.prUrl, w.gh.own[0], "the queue judge opens its own PR while the task-file landing is sealed");
  assert.deepEqual(w.staged(), [], "nothing of the queue judge waits in the landing");
  const prediction = w.steps("queue_judge.prediction")[0];
  assert.equal(prediction?.task_id, "W1-T1");
  assert.equal(prediction?.pr_url, w.gh.own[0], "the prediction names the real PR that carries it");
});
