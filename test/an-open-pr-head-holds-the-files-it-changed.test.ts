import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DaemonDeps } from "#src/lib/daemon.js";
import { runDaemon } from "#src/lib/daemon.js";
import { partitionByFileOverlap } from "#src/lib/dispatch-overlap.js";
import { loadPlan, type Plan, type Task } from "#src/lib/plan.js";
import { parseObservedOverlapMode } from "#src/lib/policy.js";
import type { RunResult } from "#src/lib/run-result.js";
import type { PrRef } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
// A NAMESPACE import, read inside each test: at a base without the producer the file still LOADS
// and every test fails on its own assertion, so the proof discriminates instead of erroring.
import * as observedOverlap from "#src/lib/observed-overlap.js";

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
