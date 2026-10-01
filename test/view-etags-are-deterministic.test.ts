// P2-04 (arch Phase 2 design D2, risk R4): a view's version on the push stream IS its ETag, so a serve
// restart over an unchanged read model must materialize every view to the SAME ETag. A materializer
// whose key order, float formatting or clock reading varied run to run would make every restart look
// like "everything changed" to every open console: a refetch storm. Two tickers, a restart apart, over
// one store and one ledger, each materialize every registered view; their ETags must agree, and so must
// the bodies a restarted serve warm-loads from the read model.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/lib/clock.js";
import { daemonInstanceRegistryPath } from "../src/lib/deployer.js";
import { createInstancesView } from "../src/lib/instances-view.js";
import { createNowView } from "../src/lib/now-view.js";
import type { Plan } from "../src/lib/plan.js";
import {
  createReadModelTicker,
  ledgerSource,
  loadCommittedViewBodies,
  READ_MODEL_VIEWS,
  readModelStatusView,
  readModelSwitchesPath,
  type ReadModelWorkerMessage,
} from "../src/lib/read-model-worker.js";
import type { ViewBodyEntry } from "../src/lib/views.js";
import { createNavBadgeReadModelView } from "../src/lib/nav-badge-view.js";
import { createRepositoriesReadModelView, createRepositoriesSourcePublisher } from "../src/lib/repositories-view.js";
import { repositoriesSources, type ServeDeps } from "../src/lib/serve.js";
import { makeTempDir } from "../src/lib/tmp.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const T0 = Date.parse("2026-09-30T12:00:00.000Z");
type TestCtx = { after: (fn: () => void) => void };

function clockAt(ms: number): Clock {
  return { now: () => ms, date: () => new Date(ms), iso: () => new Date(ms).toISOString() };
}

function iso(msAgo: number): string {
  return new Date(T0 - msAgo).toISOString();
}

function plan(): Plan {
  const tasks = ["W1-T1", "W1-T2", "W1-T3"].map((id) => ({ id, title: `task ${id}`, repo: "craigoley/remudero", depends_on: [], type: "implement", risk: "medium", verify: "auto", status: "queued", attempts: 0 }) as Plan["tasks"][number]);
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** Core with a merge, a running task, spend and a heartbeat, every view switched to `serve`. */
function fixture(t: TestCtx): { root: string; stateDir: string } {
  const root = makeTempDir("view-etags-deterministic");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  mkdirSync(join(stateDir, "read-model"), { recursive: true });
  mkdirSync(join(root, ".remudero"), { recursive: true });
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), ["W1-T1", "W1-T2", "W1-T3"].map((id) => `- id: ${id}\n  title: task ${id}\n  repo: craigoley/remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  files: [src/x.ts]\n  status: queued\n  acceptance:\n    - claim: c\n      proof: "grep: x in y"\n`).join(""));
  writeFileSync(daemonInstanceRegistryPath(root), "instances:\n  core:\n    github_repo: craigoley/remudero\n    project: remudero\n");
  const rows: Array<Record<string, unknown>> = [
    { ts: iso(6 * 3_600_000), step: "run.start", run_id: "r1", task_id: "W1-T1", repo: "craigoley/remudero", run_type: "implement" },
    { ts: iso(5 * 3_600_000), step: "pr.opened", run_id: "r1", task_id: "W1-T1", pr_url: "https://github.com/craigoley/remudero/pull/1" },
    { ts: iso(4 * 3_600_000), step: "verdict", run_id: "r1", task_id: "W1-T1", verdict: "merged", pr_url: "https://github.com/craigoley/remudero/pull/1" },
    { ts: iso(3 * 3_600_000), step: "implement.done", run_id: "r1", billing_mode: "api", total_cost_usd: 1.5, served_model: "claude-opus-5-5", tokens: { input: 10, output: 5 } },
    { ts: iso(2 * 3_600_000), step: "run.start", run_id: "r2", task_id: "W1-T2", repo: "craigoley/remudero", run_type: "implement" },
    { ts: iso(60_000), step: "daemon.tick" },
  ];
  writeFileSync(join(stateDir, "ledger.ndjson"), rows.map((r) => `${JSON.stringify({ host: "h1", ...r })}\n`).join(""));
  writeFileSync(readModelSwitchesPath(stateDir), JSON.stringify({ views: { "nav-badge": "serve", repositories: "serve", now: "serve" } }));
  const ledgerPath = join(stateDir, "ledger.ndjson");
  createRepositoriesSourcePublisher({ stateDir, instances: () => repositoriesSources({ ledgerPath, fleetControlRoot: root, questionsRoot: root, panelGraph: { planPath: join(root, "plan", "tasks.yaml") }, instances: { stateBase: join(root, "instances") } } as unknown as ServeDeps) })();
  return { root, stateDir };
}

/** One serve process's worker: materialize every registered view, return `<view>\0<key>` → its body entry. */
function materialize(root: string, stateDir: string, at: number, holder: string): Map<string, ViewBodyEntry> {
  const clock = clockAt(at);
  const now = createNowView({
    instances: [{ name: "core", ledgerDir: stateDir, repo: "craigoley/remudero", feedbackRoot: root }],
    clock, readPlan: plan, github: () => ({ github: fakeGitHub(), generation: "g", source: { asOf: iso(0), state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 10_000 },
  });
  const posted: ReadModelWorkerMessage[] = [];
  // A RESTART re-imports the worker, so every view's in-memory state starts empty: build them afresh.
  const views = [createNavBadgeReadModelView(ledgerSource), createRepositoriesReadModelView(ledgerSource), readModelStatusView];
  assert.deepEqual(views.map((v) => v.name), READ_MODEL_VIEWS.map((v) => v.name), "the same views the worker registers");
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views: [...views, now, createInstancesView({ instances: [{ name: "core", ledgerDir: stateDir }], repoPath: daemonInstanceRegistryPath(root), ledgerSource })], clock, holder, post: (m) => void posted.push(m) });
  try {
    ticker.tick();
  } finally {
    ticker.release();
  }
  const bodies = new Map<string, ViewBodyEntry>();
  for (const m of posted) if (m.type === "body") bodies.set(`${m.entry.view}\u0000${m.entry.key}`, m.entry);
  return bodies;
}

function etags(bodies: Map<string, ViewBodyEntry>, except?: string): Record<string, string> {
  return Object.fromEntries([...bodies].filter(([, b]) => b.view !== except).map(([id, b]) => [id, b.etag]));
}

/** The dotted paths at which two JSON values differ. */
function differingPaths(a: unknown, b: unknown, at = ""): string[] {
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => differingPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [at];
}

test("every read-model view materializes the same etag after a serve restart", (t) => {
  const { root, stateDir } = fixture(t);
  const first = materialize(root, stateDir, T0, "serve-a");
  // CORPUS CONTROL: every registered view materialized, so none passes by being absent on both sides.
  assert.deepEqual([...new Set([...first.values()].map((b) => b.view))].sort(), ["instances", "nav-badge", "now", "read-model", "repositories"]);

  const repos = first.get("repositories\u0000")!.body.data as { instances: Array<{ summary?: { repos: unknown[] } }> };
  assert.equal(repos.instances[0]?.summary?.repos.length, 1, `control: a real repositories summary, not an error body: ${JSON.stringify(repos)}`);

  const restarted = materialize(root, stateDir, T0, "serve-b");
  assert.deepEqual(etags(restarted), etags(first), "a second process over the same store computes every version identically");

  const warm = loadCommittedViewBodies(stateDir, "core");
  assert.equal(warm.reason, undefined);
  assert.deepEqual(Object.fromEntries(warm.bodies.map((b) => [`${b.view}\u0000${b.key}`, b.etag])), etags(first), "the bodies a restarted serve warm-loads carry the same versions");
});

test("a later restart gives every view the same etag when only the clock moved", (t) => {
  const { root, stateDir } = fixture(t);
  const first = materialize(root, stateDir, T0, "serve-a");
  const later = materialize(root, stateDir, T0 + 90_000, "serve-b");
  // CORPUS CONTROL: the clock-sensitive views are really compared, not absent on both sides.
  assert.ok(first.has("now\u0000instance=core") && first.has("repositories\u0000"), [...first.keys()].join(","));
  // Version 2 moved every clock stamp out of `data` (board.generated_at, health.sampledAt, health.lastPollAgeMs,
  // each summary's generated_at): 90 s later nothing a consumer renders changed, so no version may either.
  const paths = (id: string): string[] => differingPaths(first.get(id)!.body.data, later.get(id)!.body.data);
  assert.deepEqual(paths("now\u0000instance=core"), []);
  assert.deepEqual(paths("repositories\u0000"), []);
  assert.deepEqual(paths("instances\u0000"), []);
  assert.deepEqual(etags(later), etags(first), "every view keeps its version across a restart 90 s later");
  // The times did move: they live in the envelope, which the etag ignores.
  assert.notEqual(later.get("now\u0000instance=core")!.body.generatedAt, first.get("now\u0000instance=core")!.body.generatedAt);
});

test("a re-materialize over unchanged content posts no new body and a real change posts a new etag", (t) => {
  const { root, stateDir } = fixture(t);
  const clock = { at: T0 };
  const now = createNowView({
    instances: [{ name: "core", ledgerDir: stateDir, repo: "craigoley/remudero", feedbackRoot: root }],
    clock: { now: () => clock.at, date: () => new Date(clock.at), iso: () => new Date(clock.at).toISOString() },
    readPlan: plan, github: () => ({ github: fakeGitHub(), generation: "g", source: { asOf: iso(0), state: "fresh" } }),
    hostProbe: { rateLimit: () => 4321, diskFree: () => 10_000 },
  });
  const posted: ReadModelWorkerMessage[] = [];
  const views = [createRepositoriesReadModelView(ledgerSource), now];
  const ticker = createReadModelTicker({ stateDir, instances: [{ name: "core", ledgerDir: stateDir }], views,
    clock: { now: () => clock.at, date: () => new Date(clock.at), iso: () => new Date(clock.at).toISOString() }, holder: "serve-a", post: (m) => void posted.push(m) });
  t.after(() => ticker.release());
  const bodies = (): ViewBodyEntry[] => posted.flatMap((m) => (m.type === "body" ? [m.entry] : []));
  /** The worker ticks every 250 ms; stepping 5 s keeps each projector inside its 10 s stale bound, as in production. */
  const runTo = (ms: number): void => {
    while (clock.at < ms) {
      clock.at = Math.min(ms, clock.at + 5_000);
      ticker.tick();
    }
  };
  ticker.tick();
  const first = new Map(bodies().map((b) => [b.view, b.etag]));
  assert.deepEqual([...first.keys()].sort(), ["now", "repositories"], "control: both clock-sensitive views posted a first body");

  // Past both views' refresh cadences (now 30 s, repositories 60 s), with no new row: each re-materializes, and
  // the worker posts only a body whose etag moved.
  const before = bodies().length;
  runTo(T0 + 120_000);
  assert.deepEqual(bodies().slice(before).map((b) => b.view), [], "an unchanged view posts nothing on a re-materialize");

  // A real change: W1-T2's run merges. The board and the portfolio both move.
  runTo(T0 + 240_000);
  appendFileSync(join(stateDir, "ledger.ndjson"), `${JSON.stringify({ host: "h1", ts: iso(-200_000), step: "verdict", run_id: "r2", task_id: "W1-T2", verdict: "merged", pr_url: "https://github.com/craigoley/remudero/pull/2" })}\n`);
  const mark = bodies().length;
  runTo(T0 + 400_000);
  const moved = new Map(bodies().slice(mark).map((b) => [b.view, b.etag]));
  assert.ok(moved.has("now") && moved.get("now") !== first.get("now"), "the merge gives now a new etag");
  assert.ok(moved.has("repositories") && moved.get("repositories") !== first.get("repositories"), "the merge gives repositories a new etag");
});
