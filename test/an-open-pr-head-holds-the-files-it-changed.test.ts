import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChangedFilesCache } from "#src/lib/changed-files-cache.js";
import type { DaemonDeps, DaemonSummary } from "#src/lib/daemon.js";
import { runDaemon } from "#src/lib/daemon.js";
import { partitionByFileOverlap } from "#src/lib/dispatch-overlap.js";
import { loadPlan, type Plan, type Task } from "#src/lib/plan.js";
import { parseObservedOverlapMode } from "#src/lib/policy.js";
import type { RunResult } from "#src/lib/run-result.js";
import type { GitHub, PrRef } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { gitRepo } from "#test/helpers/git-repo.js";
// A NAMESPACE import, read inside each test: at a base without the producer the file still LOADS
// and every test fails on its own assertion, so the proof discriminates instead of erroring.
import * as observedOverlap from "#src/lib/observed-overlap.js";
import { daemonCommand } from "#src/run-task.js";

/**
 * Open PR heads' changed files as dispatch's observed scope, shadow first.
 *
 * 2026-11-01: #15656, #15638 and #15679 (W1-T9794/9795/9796) conflicted pairwise on
 * src/run-task.ts and a shared compress test while each declared disjoint `files:`, and nothing
 * produced `observedScopeByTask`, so dispatch judged overlap on declarations alone.
 */

const URL = (n: number) => `https://github.com/acme/remudero/pull/${n}`;
const openPr = (n: number, head: string, body = ""): PrRef => ({ number: n, url: URL(n), state: "OPEN", headRefName: head, body, headRefOid: "a".repeat(40) });

function task(id: string, files: string[]): Task {
  return { id, title: id, repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "medium", status: "queued", attempts: 0, files };
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" });

function twoTaskPlan(): { plan: Plan; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-plan-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f,
    "- id: W1-T1\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/a.ts]\n" +
    "- id: W1-T2\n  title: b\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n  files: [src/b.ts]\n");
  return { plan: loadPlan(f), dir };
}

test("observed scope producer: an open PR head's changed files join its task's observed scope, by run branch or trailer", () => {
  assert.equal(typeof observedOverlap.observedScopeFromOpenPrs, "function", "a producer for observedScopeByTask exists");
  const files: Record<string, string[]> = {
    [URL(15679)]: ["src/run-task.ts", "test/compress.test.ts"],
    [URL(15656)]: ["src/run-task.ts"],
    [URL(15700)]: ["src/x.ts"],
  };
  const scope = observedOverlap.observedScopeFromOpenPrs([
    openPr(15679, "run-W1-T9796-1793544678400"),
    openPr(15656, "claude/hand-built", "Body\n\nRemudero-Task: W1-T9794\n"),
    openPr(15700, "dependabot/npm/x"),
    openPr(15701, "run-W1-T9795-1793544678401"),
  ], (url) => files[url]);
  assert.ok(scope);
  assert.deepEqual(scope.observedByTask.get("W1-T9796")?.files, ["src/run-task.ts", "test/compress.test.ts"]);
  assert.deepEqual(scope.observedByTask.get("W1-T9794")?.files, ["src/run-task.ts"], "the trailer maps a PR whose head is not a run branch");
  assert.equal(scope.observedByTask.has("W1-T9795"), false, "an unread list is absent, never a guess");
  assert.deepEqual(scope.unreadablePrs, [15701]);
  assert.equal(scope.openPrsMapped, 3, "a PR naming no task is not mapped");
  assert.equal(observedOverlap.observedScopeFromOpenPrs(null, () => []), undefined, "an unreadable board produces no scope");
});

test("observed overlap shadow: names the candidate an open PR's files would hold, with the PR and file, and leaves the declared partition alone", () => {
  assert.equal(typeof observedOverlap.observedOverlapShadow, "function");
  const candidates = [task("W1-T1", ["src/run-task.ts"]), task("W1-T2", ["src/b.ts"])];
  const base = partitionByFileOverlap(candidates);
  assert.equal(base.dispatch.length, 2, "control: the declarations are disjoint");
  const scope = observedOverlap.observedScopeFromOpenPrs([openPr(15679, "run-W1-T9796-1793544678400")], () => ["src/run-task.ts"]);
  assert.ok(scope);
  const shadow = observedOverlap.observedOverlapShadow(candidates, [], scope, base);
  assert.deepEqual(shadow.holds, [{ task: "W1-T1", blockedBy: "W1-T9796", pr: 15679, paths: ["src/run-task.ts"] }]);
  assert.deepEqual(shadow.dispatch.map((t) => t.id), ["W1-T2"]);
  assert.equal(base.dispatch.length, 2, "the base partition is not mutated");
});

async function daemonWithOpenPr(mode: "shadow" | "enforce") {
  const { plan, dir } = twoTaskPlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let ticks = 0;
  const scope = observedOverlap.observedScopeFromOpenPrs?.([openPr(15679, "run-W1-T9796-1793544678400")], () => ["src/a.ts"]);
  try {
    await runDaemon(plan, {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 3 ? "tick cap" : undefined),
      log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, extra }),
      runOne: async (id: string) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: async () => {},
      observedOpenPrScope: () => scope,
      observedOverlapMode: () => mode,
    } as unknown as DaemonDeps, { max: 2, laneCount: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ran, lines };
}

test("dispatch.overlap_shadow: the daemon ledgers the task an open PR's changed file would hold, and still dispatches it in shadow mode", async () => {
  const { ran, lines } = await daemonWithOpenPr("shadow");
  const rows = lines.filter((l) => l.step === "dispatch.overlap_shadow");
  assert.equal(rows.length, 1, "one row for an unchanged hold set");
  assert.equal(rows[0].extra?.mode, "shadow");
  assert.equal(rows[0].extra?.acted, false);
  assert.deepEqual(rows[0].extra?.holds, [{ task: "W1-T1", blocked_by: "W1-T9796", pr: 15679, paths: ["src/a.ts"], path_count: 1 }]);
  assert.deepEqual([...ran].sort(), ["W1-T1", "W1-T2"], "shadow changes no dispatch");
});

test("dispatch.overlap_shadow: enforce mode holds the named task out of the pass", async () => {
  const { ran, lines } = await daemonWithOpenPr("enforce");
  assert.equal(lines.find((l) => l.step === "dispatch.overlap_shadow")?.extra?.acted, true);
  assert.deepEqual(ran, ["W1-T2"]);
});

test("sweep.observedOverlap.mode: absent reads shadow, so the act switch is off by default", () => {
  assert.equal(parseObservedOverlapMode(undefined), "shadow");
  assert.equal(parseObservedOverlapMode({}), "shadow");
  assert.equal(parseObservedOverlapMode({ observedOverlap: { mode: { value: "enforce", origin: "proposal" } } }), "enforce");
  assert.throws(() => parseObservedOverlapMode({ observedOverlap: { mode: { value: "on", origin: "proposal" } } }));
});

test("changed-files cache: an open PR's list is keyed on its head, so a push re-reads it once", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-cache-`));
  try {
    let reads = 0;
    const cache = createChangedFilesCache(root, "acme", "remudero", { fetch: async () => [`v${++reads}.ts`] });
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    cache.lookup(URL(7), "OPEN", headA);
    await cache.settle();
    assert.deepEqual(cache.lookup(URL(7), "OPEN", headA), ["v1.ts"]);
    await cache.settle();
    assert.equal(reads, 1, "the same head is never re-read");
    assert.deepEqual(cache.lookup(URL(7), "OPEN", headB), ["v1.ts"], "the older list is served meanwhile");
    await cache.settle();
    assert.equal(reads, 2, "a moved head re-reads once");
    assert.deepEqual(cache.lookup(URL(7), "OPEN", headB), ["v2.ts"]);
    await cache.settle();
    assert.equal(reads, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observed scope producer: the daemon composition root builds it from the projection's open rows", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-home-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ["- id: W1-T1", "  title: wiring fixture", "  repo: remudero", "  type: implement", "  verify: auto", "  risk: medium", "  files: [src/a.ts]", "  origin: test", "  status: queued", ""].join("\n"));
  const origin = gitRepo({ bare: true, kind: "observed-overlap-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "observed-overlap-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repoRoot = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoRoot]);
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const previous = { HOME: process.env.HOME, CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS };
  process.env.HOME = home;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  const changedFilesAsked: string[] = [];
  const github: GitHub = {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    listOpenHeadBranches: () => [openPr(15679, "run-W1-T9796-1793544678400")],
    changedFiles: (url) => { changedFilesAsked.push(url); return ["src/a.ts"]; },
  };
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--repo", "acme/remudero", "--plan", planPath, "--max", "0"], {
      repoRoot,
      githubFactory: () => github,
      readObservedOverlapMode: () => "shadow",
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured);
    assert.equal(typeof captured.observedOpenPrScope, "function", "the composition root supplies a producer");
    captured.refreshMerged();
    const scope = captured.observedOpenPrScope?.();
    assert.deepEqual(scope?.observedByTask.get("W1-T9796")?.files, ["src/a.ts"]);
    assert.equal(scope?.sourcesByTask.get("W1-T9796")?.[0]?.pr, 15679);
    assert.equal(captured.observedOverlapMode?.(), "shadow");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("observed overlap policy: the mode is read from a real policy file, and a malformed row or file is refused", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RMD_TMP_PREFIX } = await import("#src/lib/tmp.js");
  const policy = await import("#src/lib/policy.js");
  assert.throws(() => policy.parseObservedOverlapMode({ observedOverlap: { mode: { value: "enforce", origin: "net-new" } } }),
    /origin' must be "proposal"/);
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-policy-`));
  try {
    const file = join(dir, "policy.yaml");
    writeFileSync(file, "sweep:\n  observedOverlap:\n    mode:\n      value: enforce\n      origin: proposal\n");
    assert.equal(policy.loadObservedOverlapMode(file), "enforce");
    writeFileSync(file, "sweep: [unclosed\n");
    assert.throws(() => policy.loadObservedOverlapMode(file), /not valid YAML/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch.overlap_shadow: a file only the second of two overlapping open PRs changed is still held on that PR", async () => {
  // The reviewer's counterexample: PR A changes x, PR B changes x and y, the candidate declares y.
  // Both PRs are open, so both hold their files; B overlapping A must not release y.
  const { plan, dir } = twoTaskPlan();
  const merged = new Set<string>();
  const ran: string[] = [];
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let ticks = 0;
  const files: Record<string, string[]> = { [URL(16001)]: ["src/x.ts"], [URL(16002)]: ["src/a.ts", "src/x.ts"] };
  const scope = observedOverlap.observedScopeFromOpenPrs?.([
    openPr(16001, "run-W1-T9001-1793544678400"),
    openPr(16002, "run-W1-T9002-1793544678401"),
  ], (url) => files[url]);
  try {
    await runDaemon(plan, {
      refreshMerged: () => (id: string) => merged.has(id),
      checkStop: () => (++ticks > 3 ? "tick cap" : undefined),
      log: (step: string, extra?: Record<string, unknown>) => lines.push({ step, extra }),
      runOne: async (id: string) => { ran.push(id); merged.add(id); return okResult(id); },
      sleep: async () => {},
      observedOpenPrScope: () => scope,
      observedOverlapMode: () => "shadow",
    } as unknown as DaemonDeps, { max: 2, laneCount: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const rows = lines.filter((l) => l.step === "dispatch.overlap_shadow");
  assert.equal(rows.length, 1, "the hold is ledgered");
  assert.deepEqual(rows[0].extra?.holds, [{ task: "W1-T1", blocked_by: "W1-T9002", pr: 16002, paths: ["src/a.ts"], path_count: 1 }]);
  assert.deepEqual([...ran].sort(), ["W1-T1", "W1-T2"], "shadow changes no dispatch");
});

test("observed scope producer: the async read-plane refresh publishes the open rows the producer reads", async () => {
  // Production ticks call `refreshMergedAsync` (the read plane), never the synchronous `refreshMerged`.
  // No `githubFactory` here, so the read plane is live; its read is injected, and the changed-files
  // read goes through the shared `gh` shim on PATH.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-async-root-`));
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}observed-overlap-async-home-`));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, ["- id: W1-T1", "  title: wiring fixture", "  repo: remudero", "  type: implement", "  verify: auto", "  risk: medium", "  files: [src/a.ts]", "  origin: test", "  status: queued", ""].join("\n"));
  const origin = gitRepo({ bare: true, kind: "observed-overlap-async-origin" });
  const seed = gitRepo({ seedCommit: false, kind: "observed-overlap-async-seed" });
  seed.addRemote("origin", origin.dir);
  writeFileSync(join(seed.dir, "README.md"), "seed\n");
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "seed");
  seed.git("push", "-q", "-u", "origin", "main");
  const repoRoot = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin.dir, repoRoot]);
  mkdirSync(join(home, ".config", "remudero"), { recursive: true });
  writeFileSync(join(home, ".config", "remudero", "config.json"), JSON.stringify({ claudeBin: "/bin/true", root }));
  const gh = ghShim([{ when: "pulls/15679/files", stdout: "src/a.ts\n" }], { kind: "observed-overlap-async-gh" });
  const previous = { HOME: process.env.HOME, CI: process.env.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS, PATH: process.env.PATH };
  process.env.HOME = home;
  process.env.PATH = `${gh.dir}:${process.env.PATH ?? ""}`;
  delete process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  let reads = 0;
  try {
    let captured: DaemonDeps | undefined;
    const code = await daemonCommand(["--repo", "acme/remudero", "--plan", planPath, "--max", "0"], {
      repoRoot,
      readObservedOverlapMode: () => "shadow",
      wireSweepWake: () => ({ sleep: async () => "timeout", acknowledge: () => {}, close: () => {} }),
      startGitCredentialSocket: async () => ({ socketPath: "/fixture/socket", close: async () => {} }),
      startMemoryCensus: () => () => {},
      startReadPlane: (() => ({
        read: async (input: { plan?: Plan }) => {
          reads++;
          return { generation: reads, source: "inline", publishedAtMs: Date.now(), settledAtMs: Date.now(),
            facts: { plan: input.plan, projection: [], openBranches: [openPr(15679, "run-W1-T9796-1793544678400")],
              creditUpdates: [] } };
        },
        stop: async () => {},
      })) as never,
      runDaemon: async (_plan, deps): Promise<DaemonSummary> => {
        captured = deps;
        return { attempted: [], merged: [], stopReason: "stopped", costUsd: 0, ticks: 0 };
      },
    });
    assert.equal(code, 0);
    assert.ok(captured?.refreshMergedAsync, "the read plane is live, so production's async refresh is wired");
    await captured.refreshMergedAsync();
    assert.equal(reads, 1, "the async refresh read the plane");
    let scope = captured.observedOpenPrScope?.();
    assert.ok(scope, "the async publish handed the producer this pass's open rows");
    // The first lookup schedules the off-loop files read; it lands on a later turn.
    for (let i = 0; i < 200 && !scope?.observedByTask.has("W1-T9796"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      scope = captured.observedOpenPrScope?.();
    }
    assert.deepEqual(scope?.observedByTask.get("W1-T9796")?.files, ["src/a.ts"]);
    assert.equal(scope?.sourcesByTask.get("W1-T9796")?.[0]?.pr, 15679);
    assert.ok(gh.calls().some((c) => c.includes("pulls/15679/files")), "the files came from the gateway's own read");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});
