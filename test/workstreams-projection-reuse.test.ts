// The workstreams view's per-task projection reuse: every pass below is checked against a no-reuse projectPlan over
// the same inputs, so "reused" can only ever mean "the same projection, derived for less".
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalProjection } from "../src/lib/board-projection.js";
import type { Clock } from "../src/lib/clock.js";
import type { Task } from "../src/lib/plan.js";
import { createReadModelTicker, ledgerSource, type ReadModelInstanceState } from "../src/lib/read-model-worker.js";
import {
  buildBatchedGithub,
  DEFAULT_LIVENESS_BOUND_MS,
  ENVIRONMENTAL_BLOCK_COOLDOWN_MS,
  projectPlan,
  readLedgerLines,
  SERVE_KEEPS_CREDITS_IN_MEMORY,
  type BatchedPr,
  type GitHub,
  type StatusProjection,
} from "../src/lib/status.js";
import { threadPlan } from "../src/lib/thread-plan.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { createWorkstreamsProjectionReuse, fileIdentity, WORKSTREAMS_REUSE_AUDIT_MS } from "../src/lib/workstreams-projection-reuse.js";
import { createWorkstreamsView, WORKSTREAMS_DEBOUNCE_MS, WORKSTREAMS_VIEW_NAME } from "../src/lib/workstreams-view.js";
import { switchViewsOn } from "./helpers/read-model-switches.js";

type TestCtx = { after: (fn: () => void) => void };
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const REPO = "craigoley/remudero";
const iso = (ms: number) => new Date(ms).toISOString();
const TASKS = ["A", "B", "C", "D", "E", "F"];
const PLAN_YAML = TASKS.map((id) => `- id: ${id}\n  title: task ${id}\n  repo: ${REPO}\n  type: implement\n  depends_on: []\n  status: queued\n`).join("");

/** A merged PR credits A off its run branch; nothing else is merged. */
function gateway(): GitHub {
  const pr: BatchedPr = { number: 11, url: `https://github.com/${REPO}/pull/11`, state: "MERGED", headRefName: "run-A-1700000000000", title: "build A", body: "build A\n" };
  return buildBatchedGithub("craigoley", "remudero", {
    ttlMs: Number.MAX_SAFE_INTEGER,
    fetchAll: () => [pr],
    fetchAllIssues: () => [],
    commitTrailerIndex: () => new Map(),
    exec: () => {
      throw new Error("offline: this fixture answers no GitHub read");
    },
  });
}

interface Harness {
  root: string;
  ledgerPath: string;
  creditPath: string;
  overridePath: string;
  planPath: string;
  append(row: Record<string, unknown>): void;
  /** One reuse pass and one no-reuse derive over the same inputs; asserts they agree and returns the reused ids. */
  pass(opts?: { github?: GitHub; now?: number; audit?: boolean }): { reusedIds: string[]; reused: number; derived: number; audit?: ReturnType<ReturnType<ReturnType<typeof createWorkstreamsProjectionReuse>["pass"]>["capture"]>["audit"]; projection: Map<string, StatusProjection> };
}

function harness(t: TestCtx, opts: { identity?: (path: string) => string; rows?: Array<Record<string, unknown>> } = {}): Harness {
  const root = makeTempDir("workstreams-projection-reuse");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, (opts.rows ?? [{ ts: iso(NOW - 3_600_000), step: "daemon.tick" }]).map((r) => `${JSON.stringify(r)}\n`).join(""));
  const reuse = createWorkstreamsProjectionReuse(opts.identity ? { identity: opts.identity } : {});
  const defaultGithub = gateway();
  return {
    root,
    ledgerPath,
    planPath,
    creditPath: join(root, "state", "merge-credit.json"),
    overridePath: join(root, "plan", "credit-overrides.yaml"),
    append: (row) => appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`),
    pass(p = {}) {
      const github = p.github ?? defaultGithub;
      const now = p.now ?? NOW;
      const plan = threadPlan(planPath);
      const live = readLedgerLines(ledgerPath);
      const deps = { ledgerPath, github, readLedger: () => live, now: () => now, writeCreditStore: SERVE_KEEPS_CREDITS_IN_MEMORY, skipUncreditedBuildWarning: true };
      const pass = reuse.pass("core", { plan, github, live, creditStorePath: join(root, "state", "merge-credit.json"), creditOverridePath: join(root, "plan", "credit-overrides.yaml") }, { audit: p.audit === true });
      const reusedIds: string[] = [];
      const projection = projectPlan(plan, { ...deps, reuseProjection: (task: Task) => {
        const held = pass.reuseProjection(task);
        if (held !== undefined) reusedIds.push(task.id);
        return held;
      } });
      const held = pass.capture(projection);
      const fresh = projectPlan(plan, deps);
      for (const id of new Set([...fresh.keys(), ...projection.keys()])) {
        assert.equal(canonicalProjection(projection.get(id)), canonicalProjection(fresh.get(id)), `task ${id}: the reused pass must equal a no-reuse derive`);
      }
      return { reusedIds, reused: held.reused, derived: held.derived, ...(held.audit ? { audit: held.audit } : {}), projection };
    },
  };
}

test("an unchanged pass reuses every settled task and answers what a full derive answers", (t) => {
  const h = harness(t);
  const first = h.pass();
  assert.deepEqual([first.reused, first.derived], [0, TASKS.length], "control: nothing is held before the first pass");
  assert.equal(first.projection.get("A")?.merged, true, "positive control: the gateway credits A");
  const second = h.pass();
  assert.deepEqual(second.reusedIds, TASKS);
  assert.deepEqual([second.reused, second.derived], [TASKS.length, 0]);
});

test("a row naming a task in task_id or only in task re-derives that task and no other", (t) => {
  const h = harness(t);
  h.pass();
  h.append({ ts: iso(NOW - 60_000), step: "dispatch.blocked_independent", task: "C", verdict: "blocked", run_id: "r-c" });
  const byAlias = h.pass();
  assert.deepEqual(byAlias.reusedIds, TASKS.filter((id) => id !== "C"));
  assert.equal(byAlias.projection.get("C")?.status, "blocked", "the alias row moved C");
  h.append({ ts: iso(NOW - 50_000), step: "verdict", task_id: "D", run_id: "r-d", verdict: "no_pr" });
  assert.deepEqual(h.pass().reusedIds, TASKS.filter((id) => id !== "C" && id !== "D"), "C's block reads the clock; D's own row moved D");
});

test("a credit store or override change, a store that cannot be read, and its recovery each re-derive every task", (t) => {
  const h = harness(t);
  h.pass();
  const creditB = JSON.stringify({ B: { trailer: { source: "trailer", prUrl: `https://github.com/${REPO}/pull/99`, prNumber: 99, prState: "MERGED" } } });
  const steps: Array<[string, () => void, boolean]> = [
    ["the store credits B", () => writeFileSync(h.creditPath, creditB), true],
    ["the store is corrupt", () => writeFileSync(h.creditPath, "{corrupt"), false],
    ["the store recovers", () => writeFileSync(h.creditPath, creditB), true],
    ["the store is a directory", () => { rmSync(h.creditPath); mkdirSync(h.creditPath); }, false],
    ["the store is back", () => { rmSync(h.creditPath, { recursive: true }); writeFileSync(h.creditPath, creditB); }, true],
  ];
  for (const [label, mutate, bMerged] of steps) {
    mutate();
    const r = h.pass();
    assert.deepEqual(r.reusedIds, [], `${label}: nothing is reused`);
    assert.equal(r.projection.get("B")?.merged, bMerged, `${label}: B's credit follows the store`);
    assert.deepEqual(h.pass().reusedIds, TASKS, `${label}: and the pass after it reuses again`);
  }
  writeFileSync(h.overridePath, JSON.stringify([{ task: "A", pr: 11, action: "remove-credit", reason: "fixture ruling", author_class: "operator" }]));
  const ruled = h.pass();
  assert.deepEqual(ruled.reusedIds, [], "an override edit re-derives every task");
  assert.equal(ruled.projection.get("A")?.merged, false, "the override un-credits A");
});

test("a cross-task row, a new plan, a new gateway, a dark read and a rotated ledger each reuse nothing", (t) => {
  const h = harness(t);
  h.pass();
  h.append({ ts: iso(NOW - 40_000), step: "daemon.boot", host: "elsewhere", head_sha: "b".repeat(40) });
  assert.deepEqual(h.pass().reusedIds, [], "daemon.boot is read whole-ledger");
  h.pass();
  h.append({ ts: iso(NOW - 30_000), step: "review.posted", plan_only: true, pr_url: `https://github.com/${REPO}/pull/11`, head_sha: "c".repeat(40), task_id: "Z" });
  assert.deepEqual(h.pass().reusedIds, [], "a plan_only row is looked up by PR url");
  h.pass();
  writeFileSync(h.planPath, `${PLAN_YAML}# edited\n`);
  assert.deepEqual(h.pass().reusedIds, [], "a new plan object");
  assert.deepEqual(h.pass({ github: gateway() }).reusedIds, [], "a new gateway object");
  // ONE gateway object that goes dark and recovers, as a real one does: identity alone cannot see it.
  let dark: "failed" | "truncated" | undefined;
  const base = gateway();
  const flaky = new Proxy(base, { get: (target, key, receiver) =>
    key === "readFailed" ? () => dark === "failed" : key === "readTruncated" ? () => dark === "truncated" : Reflect.get(target, key, receiver) });
  h.pass({ github: flaky });
  assert.deepEqual(h.pass({ github: flaky }).reusedIds, TASKS, "control: the same gateway reuses");
  for (const state of ["failed", "truncated"] as const) {
    dark = state;
    const under = h.pass({ github: flaky });
    assert.deepEqual(under.reusedIds, [], `a ${state} read reuses nothing`);
    assert.ok([...under.projection.values()].some((p) => p.indeterminate === true), `positive control: the ${state} read is indeterminate`);
    dark = undefined;
    assert.deepEqual(h.pass({ github: flaky }).reusedIds, [], `nothing derived under the ${state} read is reused once it recovers`);
    assert.deepEqual(h.pass({ github: flaky }).reusedIds, TASKS, `and the pass after the recovery reuses again`);
  }
  writeFileSync(h.ledgerPath, `${JSON.stringify({ ts: iso(NOW - 7_200_000), step: "daemon.tick" })}\n`);
  assert.deepEqual(h.pass({ github: flaky }).reusedIds, [], "a live file whose newest row went back was rotated");
});

test("a live file whose newest row went back reuses nothing, even when no task's own rows moved", (t) => {
  const tick = { ts: iso(NOW - 3_600_000), step: "daemon.tick" };
  const h = harness(t, { rows: [tick, { ts: iso(NOW - 5_000), step: "sweep.pass" }] });
  h.pass();
  assert.deepEqual(h.pass().reusedIds, TASKS, "control: an unchanged file reuses");
  // Rotated to a file holding only the older untasked row: no task stamp and no cross-task row moved.
  writeFileSync(h.ledgerPath, `${JSON.stringify(tick)}\n`);
  assert.deepEqual(h.pass().reusedIds, [], "the ledger's newest row went back, so nothing held describes it");
});

test("a projection that ages with the clock, or holds an environmental block, is never reused and still follows the clock", (t) => {
  const h = harness(t, { rows: [
    { ts: iso(NOW - 60_000), step: "run.start", task_id: "E", run_id: "r-e", phase: "implement" },
    { ts: iso(NOW - 30_000), step: "dispatch.blocked_independent", task_id: "F", verdict: "blocked_transient", run_id: "r-f" },
  ] });
  const first = h.pass();
  assert.equal(first.projection.get("E")?.status, "running", "positive control: E is in flight");
  assert.equal(first.projection.get("F")?.independentFailureBlocked, true, "positive control: F is blocked");
  assert.deepEqual(h.pass().reusedIds, ["A", "B", "C", "D"]);
  const later = h.pass({ now: NOW + ENVIRONMENTAL_BLOCK_COOLDOWN_MS });
  assert.notEqual(later.projection.get("E")?.status, "running", "the run went quiet past its bound");
  assert.notEqual(later.projection.get("F")?.independentFailureBlocked, true, "the block's cooldown elapsed");
});

test("a lone run.start is re-derived when a newer row moves the ledger's own clock", (t) => {
  const start = NOW - DEFAULT_LIVENESS_BOUND_MS - 10 * 60_000;
  const h = harness(t, { rows: [{ ts: iso(start), step: "run.start", task_id: "E", run_id: "r-e", phase: "implement" }] });
  h.pass();
  assert.deepEqual(h.pass().reusedIds, TASKS, "control: a quiet orphan is reusable while the ledger is still");
  h.append({ ts: iso(NOW - 5_000), step: "sweep.pass" });
  assert.deepEqual(h.pass().reusedIds, TASKS.filter((id) => id !== "E"), "the newer row re-derives E alone");
});

test("an audit pass reuses nothing, names what reuse would have got wrong, and holds what it derived", (t) => {
  // A blind identity: the store's edits are invisible to the stamp, the drift an audit exists to catch.
  const h = harness(t, { identity: () => "blind" });
  h.pass();
  const clean = h.pass({ audit: true });
  assert.deepEqual([clean.reusedIds, clean.audit], [[], { compared: TASKS.length, mismatches: 0, sample: [] }]);
  writeFileSync(h.creditPath, JSON.stringify({ B: { trailer: { source: "trailer", prUrl: `https://github.com/${REPO}/pull/99`, prNumber: 99, prState: "MERGED" } } }));
  const audited = h.pass({ audit: true });
  assert.equal(audited.audit?.mismatches, 1);
  assert.equal(audited.audit?.sample[0]?.taskId, "B");
  assert.ok(audited.audit?.sample[0]?.fields.includes("merged"), JSON.stringify(audited.audit));
  assert.equal(h.pass().projection.get("B")?.merged, true, "healed: the next pass reuses what the audit derived");
});

test("a file's identity moves on a rewrite and names a missing path or a directory", (t) => {
  const root = makeTempDir("workstreams-file-identity");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "merge-credit.json");
  assert.equal(fileIdentity(path), "!ENOENT");
  writeFileSync(path, "{}");
  const first = fileIdentity(path);
  writeFileSync(`${path}.tmp`, "{}");
  renameSync(`${path}.tmp`, path);
  assert.notEqual(fileIdentity(path), first, "the same bytes in a new file are a new identity");
  rmSync(path);
  mkdirSync(path);
  assert.notEqual(fileIdentity(path), first);
  assert.ok(!fileIdentity(path).startsWith("!"));
});

function movingClock(start: number): Clock & { set(ms: number): void } {
  let at = start;
  return { now: () => at, date: () => new Date(at), iso: () => new Date(at).toISOString(), set: (ms) => void (at = ms) };
}

test("the view counts what each build reused and audits its reuse on a cadence", (t) => {
  const root = makeTempDir("workstreams-reuse-view");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, PLAN_YAML);
  const ledgerPath = join(stateDir, "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify({ ts: iso(NOW - 60_000), step: "worker.activity", task_id: "A", run_id: "r-a" })}\n`);
  const instances = [{ name: "core", ledgerDir: stateDir, repo: REPO, planPath }];
  const clock = movingClock(NOW);
  const rows: Array<[string, Record<string, unknown>]> = [];
  const view = createWorkstreamsView<ReadModelInstanceState>({ instances, ledgerSource, clock, log: (step, extra) => rows.push([step, extra]) });
  switchViewsOn(stateDir, [WORKSTREAMS_VIEW_NAME]);
  const ticker = createReadModelTicker({ stateDir, instances, views: [view], clock, holder: "workstreams-reuse-test", oracle: "off", post: () => {} });
  t.after(() => ticker.release());
  ticker.start();
  ticker.tick();
  const insert = (at: number) => {
    appendFileSync(ledgerPath, `${JSON.stringify({ ts: iso(at - 10), step: "worker.activity", task_id: "B", run_id: "r-b", n: at })}\n`);
    clock.set(at);
    ticker.tick();
    clock.set(at + WORKSTREAMS_DEBOUNCE_MS);
    ticker.tick();
  };
  insert(NOW + 1_000);
  const built = rows.filter(([step]) => step === "workstreams.built").map(([, extra]) => extra);
  assert.equal(built.length, 2, JSON.stringify(rows));
  assert.deepEqual(built[0], { instances: 1, reused: 0, derived: TASKS.length });
  assert.equal(built[1]!.reused, TASKS.length - 1, "B's own row re-derives B alone");
  assert.equal(rows.filter(([step]) => step === "workstreams.reuse_audit").length, 0, "control: no audit inside its cadence");
  insert(NOW + WORKSTREAMS_REUSE_AUDIT_MS + 5_000);
  const audits = rows.filter(([step]) => step === "workstreams.reuse_audit").map(([, extra]) => extra);
  assert.deepEqual(audits, [{ instance: "core", compared: TASKS.length - 1, mismatches: 0, sample: [] }]);
  assert.equal(rows.filter(([step]) => step === "workstreams.built").at(-1)![1].reused, 0, "an audited build reuses nothing");
});
