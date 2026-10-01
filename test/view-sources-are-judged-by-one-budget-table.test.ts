// Arch Phase 4 (design D3 and §3, P4-T02): every view source carries kind, phase, lagMs, etaMs and
// budgetMs, and serve judges every kind at request time against one budget table. Before, only
// `ledger:` was re-judged, `plan:` and `host-probe:` were hard-coded fresh, and the console parsed the
// normal post-boot catch-up's prose as stale.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { gitPlanBehind, planSource } from "../src/lib/now-view.js";
import { createReadModelTicker, createReadModelWorker, ledgerSource, type ReadModelView, type ReadModelWorkerMessage } from "../src/lib/read-model-worker.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { describeSource, HOST_PROBE_BUDGET_MS, judgeSource, PLAN_BUDGET_MS, sourceKindOf } from "../src/lib/view-freshness.js";
import type { ViewSource } from "../src/lib/views.js";
import { gitRepo } from "./helpers/git-repo.js";

type TestCtx = { after: (fn: () => void) => void };

const T0 = Date.parse("2026-10-01T03:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function scratch(t: TestCtx, kind: string): string {
  const dir = makeTempDir(kind);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a catching up ledger source carries phase catching_up with an eta", (t) => {
  const base = { instance: "core", generation: 3, lease: "held" as const, failures: 0, newestTs: iso(T0 - 60_000) };
  const catching = { ...base, tickedAt: T0, reason: "catching up: about 120000 rows (52000000 bytes) behind, done in about 40 s", catchUp: { rowsBehind: 120_000, etaMs: 40_000, at: T0 } };
  const source = ledgerSource(catching, T0 + 5_000);
  assert.deepEqual(
    { state: source.state, kind: source.kind, phase: source.phase, etaMs: source.etaMs, lagMs: source.lagMs, budgetMs: source.budgetMs },
    { state: "stale", kind: "ledger", phase: "catching_up", etaMs: 35_000, lagMs: 5_000, budgetMs: 10_000 },
    "the normal post-boot catch-up names its phase and how long is left, not only prose",
  );
  assert.equal(ledgerSource(catching, T0 + 60_000).etaMs, 0, "an overdue eta reads zero, never negative");
  assert.equal(ledgerSource({ ...catching, failures: 2 }, T0 + 1_000).phase, "failed", "a failing tick is failed even mid catch-up");
  assert.equal(ledgerSource({ ...base, lease: "elsewhere", reason: "lease held by pid 1 on h" }, T0).phase, "elsewhere");
  assert.equal(ledgerSource(base, T0).phase, "warming");
  assert.equal(ledgerSource({ ...base, tickedAt: T0 }, T0 + 12_000).phase, "behind");
});

test("the projector posts its catch-up in its state and clears it once caught up", (t) => {
  const ledgerDir = scratch(t, "vf-ledger");
  const stateDir = scratch(t, "vf-state");
  let text = "";
  for (let i = 0; i < 4_000; i++) text += `${JSON.stringify({ ts: iso(T0 - 86_400_000 + i), step: "run.start", task_id: `T${i % 40}`, run_id: `r-${i}` })}\n`;
  writeFileSync(join(ledgerDir, "ledger.2026-09-30T00-00-00-000Z.ndjson.gz"), gzipSync(text));
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  const posted: ReadModelWorkerMessage[] = [];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir }], holder: "vf", oracle: "off", tickBudgetMs: 1, views: [], post: (m) => void posted.push(m) });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const states = (): Array<Extract<ReadModelWorkerMessage, { type: "state" }>> => posted.filter((m): m is Extract<ReadModelWorkerMessage, { type: "state" }> => m.type === "state");
  const first = states().at(-1)!.instances[0]!;
  assert.ok(first.catchUp && first.catchUp.rowsBehind > 0 && first.catchUp.etaMs >= 0, `a budget-bound tick leaves a structured catch-up: ${JSON.stringify(first.catchUp)}`);
  assert.equal(ledgerSource(first, first.tickedAt!).phase, "catching_up");
  for (let i = 0; i < 500 && states().at(-1)!.instances[0]!.catchUp; i++) ticker.tick();
  assert.equal(states().at(-1)!.instances[0]!.catchUp, undefined, "caught up, the structured catch-up is gone");
});

test("a plan source turns stale when the checkout is behind a plan commit", (t) => {
  const repo = gitRepo({ kind: "vf-plan" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(repo.dir, "plan", "tasks.yaml"), "[]\n");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "plan");
  const head = repo.git("rev-parse", "HEAD");
  const planPath = join(repo.dir, "plan", "tasks.yaml");
  const calls: string[][] = [];
  const git = (args: string[]): string => {
    calls.push(args);
    return repo.git(...args.slice(2));
  };
  const memo = {};
  const unknowable = gitPlanBehind(planPath, memo, git);
  assert.match("reason" in unknowable ? unknowable.reason : "", /^cannot compare the plan's checkout with origin\/main: /, "with no origin/main the comparison is unknowable");
  assert.equal(planSource("plan:core", unknowable, T0).state, "unavailable");

  // origin/main gains one plan commit and one unrelated commit the checkout does not have.
  writeFileSync(join(repo.dir, "plan", "tasks.d", "W1-T9.yaml"), "[]\n");
  repo.git("add", "plan");
  repo.git("commit", "-q", "-m", "a plan commit");
  const planCommitMs = Number(repo.git("log", "-1", "--format=%ct")) * 1000;
  writeFileSync(join(repo.dir, "README.md"), "other\n");
  repo.git("add", "README.md");
  repo.git("commit", "-q", "-m", "not the plan");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("reset", "-q", "--hard", head);

  calls.length = 0;
  const behind = gitPlanBehind(planPath, memo, git);
  assert.deepEqual(behind, { commits: 1, sinceMs: planCommitMs }, "only the plan-touching commit counts");
  assert.equal(gitPlanBehind(planPath, memo, git), behind);
  assert.equal(calls.filter((args) => args.includes("log")).length, 1, "unmoved heads reuse the last answer");

  const within = planSource("plan:core", behind, planCommitMs + PLAN_BUDGET_MS - 1_000);
  assert.deepEqual([within.state, within.kind, within.budgetMs], ["fresh", "plan", PLAN_BUDGET_MS], "a merge the checkout has not pulled yet is within budget at first");
  const late = planSource("plan:core", behind, planCommitMs + PLAN_BUDGET_MS + 1_000);
  assert.deepEqual({ state: late.state, phase: late.phase, reason: late.reason, lagMs: late.lagMs }, { state: "stale", phase: "behind", reason: "plan 1 merge behind origin/main", lagMs: PLAN_BUDGET_MS + 1_000 });
  assert.equal(planSource("plan:core", { commits: 2, sinceMs: T0 }, T0 + PLAN_BUDGET_MS + 1).reason, "plan 2 merges behind origin/main");

  repo.git("reset", "-q", "--hard", "origin/main");
  const current = planSource("plan:core", gitPlanBehind(planPath, memo, git), T0);
  assert.deepEqual([current.state, current.asOf], ["fresh", iso(T0)], "a checkout as new as origin/main is fresh as of the check");
});

test("a host probe source older than three intervals is judged stale at request time", () => {
  const probe: ViewSource = { name: "host-probe:core", asOf: iso(T0), state: "fresh" };
  const handle = createReadModelWorker({ stateDir: "/nonexistent-vf", instances: [{ name: "core", ledgerDir: "/nonexistent-vf" }] });
  const [within] = handle.judge([probe], T0 + HOST_PROBE_BUDGET_MS);
  assert.deepEqual([within!.state, within!.kind, within!.instance, within!.lagMs], ["fresh", "host-probe", "core", HOST_PROBE_BUDGET_MS]);
  const [late] = handle.judge([probe], T0 + HOST_PROBE_BUDGET_MS + 1_000);
  assert.deepEqual({ state: late!.state, phase: late!.phase, budgetMs: late!.budgetMs, reason: late!.reason }, {
    state: "stale", phase: "behind", budgetMs: HOST_PROBE_BUDGET_MS, reason: "host-probe 181 s old (budget 180 s)",
  });
  const [warming] = handle.judge([{ name: "ledger:core", asOf: null, state: "fresh" }], T0);
  assert.deepEqual([warming!.state, warming!.phase, warming!.kind], ["stale", "warming", "ledger"], "a ledger source with no worker state yet is warming");
});

test("the source judge passes through what it cannot age", () => {
  assert.equal(sourceKindOf("inbox-classification"), undefined);
  assert.deepEqual(describeSource({ name: "inbox-classification", asOf: null, state: "unavailable" }), { name: "inbox-classification", asOf: null, state: "unavailable" });
  assert.deepEqual(judgeSource({ name: "repositories:core", asOf: iso(T0), state: "fresh" }, T0 + 86_400_000), { name: "repositories:core", asOf: iso(T0), state: "fresh", kind: "repositories", instance: "core", lagMs: 86_400_000 }, "a kind with no budget is never aged stale");
  const stale = judgeSource({ name: "github:core", asOf: iso(T0), state: "stale", reason: "open pull requests last saved 400 s ago", phase: "refreshing" }, T0 + 400_000);
  assert.deepEqual([stale.state, stale.phase, stale.reason], ["stale", "refreshing", "open pull requests last saved 400 s ago"], "a producer's own stale reading keeps its phase and words");
  assert.equal(judgeSource({ name: "github:core", asOf: iso(T0 + 5_000), state: "fresh" }, T0).lagMs, 0, "a reading from the future lags zero");
});

/** A view whose one source reports whatever `asOf` says. */
function clockView(asOf: { value: string }): ReadModelView {
  return { name: "clocked", version: 1, materialize: () => [{ key: "", data: { same: true }, sources: [{ name: "host-probe:core", asOf: asOf.value, state: "fresh" }] }] };
}

test("a body whose data did not move still posts its newer source readings once", (t) => {
  const ledgerDir = scratch(t, "vf-clock-ledger");
  const stateDir = scratch(t, "vf-clock-state");
  writeFileSync(join(ledgerDir, "ledger.ndjson"), "");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  writeFileSync(join(stateDir, "read-model", "switches.json"), JSON.stringify({ projector: "on", views: { clocked: "serve" } }));
  const asOf = { value: iso(T0) };
  const posted: ReadModelWorkerMessage[] = [];
  let now = T0;
  const ticker = createReadModelTicker({
    stateDir, instances: [{ name: "core", ledgerDir }], holder: "vf-clock", oracle: "off", views: [clockView(asOf)],
    clock: { now: () => now, date: () => new Date(now), iso: () => new Date(now).toISOString() }, post: (m) => void posted.push(m),
  });
  t.after(() => ticker.release());
  ticker.start();
  const kinds = (): string[] => posted.map((m) => m.type).filter((type) => type === "body" || type === "sources");
  ticker.tick();
  assert.deepEqual(kinds(), ["body", "sources"]);
  now += 60_000;
  ticker.tick();
  assert.deepEqual(kinds(), ["body", "sources"], "an unchanged reading posts nothing");
  asOf.value = iso(now);
  now += 60_000;
  ticker.tick();
  assert.deepEqual(kinds(), ["body", "sources", "sources"], "a newer reading of the same data is posted without the body");
  const last = posted.filter((m) => m.type === "sources").at(-1);
  assert.equal(last?.type === "sources" ? last.sources[0]?.asOf : undefined, iso(T0 + 60_000));
});

test("serve judges a source by the newest reading its worker posted", async (t) => {
  const dir = scratch(t, "vf-worker");
  const path = join(dir, "worker.mjs");
  writeFileSync(path, `import { parentPort } from "node:worker_threads";
parentPort.postMessage({ type: "sources", sources: [{ name: "host-probe:core", asOf: ${JSON.stringify(iso(T0 + 600_000))}, state: "fresh" }] });
setInterval(() => {}, 1000);
`);
  const handle = createReadModelWorker({ stateDir: dir, instances: [{ name: "core", ledgerDir: dir }], workerUrl: pathToFileURL(path), every: () => () => {} });
  t.after(() => void handle.stop());
  const frozen: ViewSource = { name: "host-probe:core", asOf: iso(T0), state: "fresh" };
  assert.equal(handle.judge([frozen], T0 + 700_000)[0]!.state, "stale", "before any reading, the body's own frozen time ages out");
  handle.start();
  const deadline = Date.now() + 10_000;
  while (handle.judge([frozen], T0 + 700_000)[0]!.state !== "fresh" && Date.now() < deadline) await sleep(10);
  const [judged] = handle.judge([frozen], T0 + 700_000);
  assert.deepEqual([judged!.state, judged!.asOf, judged!.lagMs], ["fresh", iso(T0 + 600_000), 100_000], "the worker's newer reading keeps a quiet body fresh");
});
