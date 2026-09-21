/**
 * Automatic branch reaping: the expensive classifier is level-triggered, while the remote branch
 * set is checked cheaply on every full sweep. The light in-flight pass never reaches the delete.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  AUTOMATIC_BRANCH_REAP_INTERVAL_MS,
  decideAutomaticBranchReap,
  type AutomaticBranchReapState,
} from "../src/lib/branch-reaper.js";
import { runAutomaticBranchReapRung } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");

test("automatic branch cadence: first pass fires, an unchanged set is throttled, a changed set fires, and the time bound re-arms it", () => {
  const state: AutomaticBranchReapState = {};
  const first = decideAutomaticBranchReap(state, ["main", "old"], 1000);
  assert.deepEqual(first, { fire: true, reason: "first-pass", branchFingerprint: "main\u0000old" });
  state.lastRunAtMs = 1000;
  state.lastBranchFingerprint = first.branchFingerprint;

  assert.equal(decideAutomaticBranchReap(state, ["old", "main"], 1001).fire, false);
  assert.equal(decideAutomaticBranchReap(state, ["main", "new"], 1001).reason, "branch-set-changed");
  assert.equal(
    decideAutomaticBranchReap(state, ["main", "old"], 1000 + AUTOMATIC_BRANCH_REAP_INTERVAL_MS).reason,
    "interval-elapsed",
  );
});

test("automatic branch cadence: the pure helper exposes an empty fingerprint, while the production rung owns the refusal", () => {
  const state: AutomaticBranchReapState = {};
  const decision = decideAutomaticBranchReap(state, [], 1000);
  assert.equal(decision.fire, true, "the pure decision does not invent an I/O refusal");
  assert.equal(decision.branchFingerprint, "");
});

test("automatic branch cadence: an empty remote listing is refused before the classifier or deleter", () => {
  const calls: string[][] = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  const state: AutomaticBranchReapState = {};
  runAutomaticBranchReapRung(
    "other-owner",
    "target-repo",
    { root: REPO_ROOT, claudeBin: "/bin/true" } as Config,
    join(REPO_ROOT, "state", "test-ledger.ndjson"),
    "SWEEP-EMPTY",
    (step, extra = {}) => logs.push([step, extra]),
    state,
    { root: REPO_ROOT, exec: fakeExec(() => [], calls), clock: { now: () => 1000 } },
  );
  assert.deepEqual(calls.filter((call) => call.includes("--delete")), []);
  assert.equal(state.lastRunAtMs, undefined);
  assert.deepEqual(logs, [["branch_reap.sweep.failed", { outcome: "unreadable", reason: "remote branch listing was empty" }]]);
});

function fakeExec(names: () => string[], calls: string[][]): (cmd: string, args: string[]) => string {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "ls-remote") return names().map((name) => `sha-${name}\trefs/heads/${name}`).join("\n");
    if (args[0] === "merge-base") return "";
    if (args[0] === "log") return "1\n";
    if (args[0] === "rev-parse") return "deadbeef\n";
    if (args[0] === "grep" && args.includes("-o")) return "";
    if (args[0] === "grep") throw new Error("exit 1: no source match");
    if (cmd === "gh") return "";
    return "";
  };
}

test("automatic branch cadence: the full rung prunes through the existing manifest deleter once, then suppresses an unchanged repeat", () => {
  const calls: string[][] = [];
  let names = ["main", "old"];
  const state: AutomaticBranchReapState = {};
  const logs: Array<[string, Record<string, unknown>]> = [];
  const log = (step: string, extra: Record<string, unknown> = {}) => logs.push([step, extra]);
  const exec = fakeExec(() => names, calls);
  const config = { root: REPO_ROOT, claudeBin: "/bin/true" } as Config;

  runAutomaticBranchReapRung("other-owner", "target-repo", config, join(REPO_ROOT, "state", "test-ledger.ndjson"), "SWEEP-1", log, state, {
    exec,
    root: REPO_ROOT,
    clock: { now: () => 1000 },
  });
  assert.equal(calls.filter((call) => call.includes("--delete")).length, 1, "the first pass reaches the existing guarded deleter");
  assert.ok(calls.some((call) => call.some((arg) => arg.includes("repos/other-owner/target-repo"))), "the automatic rung uses the supplied target owner/repo");
  assert.ok(logs.some(([step]) => step === "branch_reap.sweep.started"));
  assert.ok(logs.some(([step]) => step === "branch_reap.sweep.completed"));

  calls.length = 0;
  runAutomaticBranchReapRung("other-owner", "target-repo", config, join(REPO_ROOT, "state", "test-ledger.ndjson"), "SWEEP-2", log, state, {
    exec,
    root: REPO_ROOT,
    clock: { now: () => 1001 },
  });
  assert.deepEqual(calls.filter((call) => call.includes("--delete")), [], "an unchanged corpus is throttled");

  names = ["main", "old", "new"];
  runAutomaticBranchReapRung("other-owner", "target-repo", config, join(REPO_ROOT, "state", "test-ledger.ndjson"), "SWEEP-3", log, state, {
    exec,
    root: REPO_ROOT,
    clock: { now: () => 1002 },
  });
  assert.equal(calls.filter((call) => call.includes("--delete")).length, 1, "a changed branch set re-arms the classifier");
});

test("automatic branch cadence contains a classifier exception and records the failed pass", () => {
  let branchReads = 0;
  const logs: Array<[string, Record<string, unknown>]> = [];
  const exec = (cmd: string, args: string[]): string => {
    if (args[0] === "ls-remote") {
      branchReads += 1;
      if (branchReads > 1) throw new Error("classifier unavailable");
      return "a1\trefs/heads/main\nb2\trefs/heads/old\n";
    }
    return "";
  };
  runAutomaticBranchReapRung(
    "other-owner",
    "target-repo",
    { root: REPO_ROOT, claudeBin: "/bin/true" } as Config,
    join(REPO_ROOT, "state", "test-ledger.ndjson"),
    "SWEEP-EXCEPTION",
    (step, extra = {}) => logs.push([step, extra]),
    {},
    { root: REPO_ROOT, exec, clock: { now: () => 1000 } },
  );
  assert.deepEqual(logs.at(-1), [
    "branch_reap.sweep.failed",
    { outcome: "exception", reason: "first-pass", error: "classifier unavailable" },
  ]);
});

test("automatic branch cadence: the remote write is wired to the full sweep hook, never the light hook", () => {
  const fullStart = runTaskSrc.indexOf("export function buildSweepHook(");
  const lightStart = runTaskSrc.indexOf("export function buildSweepLightHook(");
  const full = runTaskSrc.slice(fullStart, lightStart);
  const light = runTaskSrc.slice(lightStart);
  assert.match(full, /runAutomaticBranchReapRung\(/);
  assert.doesNotMatch(light, /runAutomaticBranchReapRung\(/);
});
