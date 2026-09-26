import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  decideAutomaticBranchReap,
  nextMergedHeadCache,
  readAutomaticBranchReapState,
  readNamedInSource,
  readRemoteBranchTips,
  readTipInMainMembership,
  tipInMainFor,
  writeAutomaticBranchReapState,
} from "../src/lib/branch-reaper.js";
import { reapBranchesCommand } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

test("a restart with an unchanged branch set does not rerun the branch reap", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-state-`));
  try {
    const path = join(root, "state", "branch-reap-state.repo.json");
    const first = decideAutomaticBranchReap({}, ["main", "old"], 1_000);
    assert.equal(first.fire, true);
    writeAutomaticBranchReapState(path, { lastRunAtMs: 1_000, lastBranchFingerprint: first.branchFingerprint });
    const afterRestart = readAutomaticBranchReapState(path);
    assert.equal(decideAutomaticBranchReap(afterRestart, ["old", "main"], 1_001).fire, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable branch reap state fires a first pass", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-unreadable-`));
  try {
    const path = join(root, "branch-reap-state.json");
    writeFileSync(path, "not JSON");
    assert.deepEqual(readAutomaticBranchReapState(path), {});
    assert.equal(decideAutomaticBranchReap(readAutomaticBranchReapState(path), ["main", "old"], 1_000).reason, "first-pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted merged-head cache keeps only string shas", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}reap-cache-`));
  try {
    const path = join(root, "branch-reap-state.json");
    writeFileSync(path, JSON.stringify({
      lastRunAtMs: 1_000,
      mergedHeadShas: { merged: "tip-merged", malformed: 42 },
    }));
    assert.deepEqual(readAutomaticBranchReapState(path), {
      lastRunAtMs: 1_000,
      mergedHeadShas: { merged: "tip-merged" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function batchExec(names: readonly string[], calls: string[][], headAnswer = ""): (cmd: string, args: string[]) => string {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "gh") return args.join(" ").includes("head=") ? headAnswer : "";
    if (args[0] === "ls-remote") return names.map((name) => `tip-${name}\trefs/heads/${name}`).join("\n");
    if (args[0] === "for-each-ref") return args.includes("--merged=origin/main")
      ? "origin/main\n"
      : names.map((name) => `origin/${name}\ttip-${name}\t1`).join("\n");
    if (args[0] === "grep" && args.includes("-F")) throw new Error("no source match");
    if (args[0] === "grep" && args.includes("-E")) return "";
    return "";
  };
}

test("the branch reap reads local facts in a fixed number of git calls", () => {
  const counts = [2, 8].map((size) => {
    const names = ["main", ...Array.from({ length: size - 1 }, (_, i) => `old-${i}`)];
    const calls: string[][] = [];
    const cache = new Map(names.map((name) => [name, `tip-${name}`]));
    reapBranchesCommand([], { exec: batchExec(names, calls), mergedHeadShaCache: cache, quiet: true });
    return calls.filter(([cmd]) => cmd === "git").length;
  });
  assert.deepEqual(counts, [counts[0], counts[0]], "the git fact reads cannot grow with branch count");
  assert.ok(counts[0] >= 4, "the control saw the remote listing and three batched local reads");
});

test("batched branch facts equal the per-branch facts", () => {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): string => {
    calls.push([cmd, ...args]);
    if (args[0] === "for-each-ref") return args.includes("--merged=origin/main")
      ? "origin/main\norigin/merged\n"
      : "origin/main\tsha-main\t1\norigin/merged\tsha-merged\t2\norigin/unique\tsha-unique\t3\n";
    if (args[0] === "grep") return "src/lib/where.ts:1:unique\n";
    return "";
  };
  const tips = readRemoteBranchTips(exec);
  const merged = readTipInMainMembership(exec);
  const named = readNamedInSource(exec, ["merged", "unique", "unfetched"]);
  assert.deepEqual(["merged", "unique", "unfetched"].map((name) => tipInMainFor(name, tips, merged)), [true, false, "unknown"]);
  assert.deepEqual([...named], ["unique"]);
  assert.equal(tips.get("merged")?.sha, "sha-merged");
  assert.equal(calls.filter(([, verb]) => verb === "for-each-ref").length, 2);
  assert.equal(calls.filter(([, verb]) => verb === "grep").length, 1);
});

test("a cached merged verdict skips the per-head pull request read", () => {
  const calls: string[][] = [];
  let nextCache: Readonly<Record<string, string>> | undefined;
  reapBranchesCommand([], {
    exec: batchExec(["main", "old"], calls),
    mergedHeadShaCache: new Map([["old", "tip-old"]]),
    onMergedHeadCacheUpdate: (next) => { nextCache = next; },
    quiet: true,
  });
  assert.equal(calls.some(([cmd, ...args]) => cmd === "gh" && args.join(" ").includes("head=") && args.join(" ").includes("old")), false);
  assert.equal(nextCache?.old, "tip-old");
});

test("a reopened pull request head survives a cached verdict", () => {
  const cache = nextMergedHeadCache([
    { name: "reopened", prState: "closed" },
    { name: "actually-merged", prState: "merged" },
  ], new Map([["reopened", "tip-reopened"], ["actually-merged", "tip-merged"]]));
  assert.deepEqual(cache, { "actually-merged": "tip-merged" }, "closed is mutable and must never be cached");
  const calls: string[][] = [];
  let nextCache: Readonly<Record<string, string>> | undefined;
  reapBranchesCommand([], {
    exec: batchExec(["main", "reopened"], calls, "open\tfalse"),
    mergedHeadShaCache: new Map(Object.entries(cache)),
    onMergedHeadCacheUpdate: (next) => { nextCache = next; },
    quiet: true,
  });
  assert.ok(calls.some(([cmd, ...args]) => cmd === "gh" && args.join(" ").includes("head=")), "reopened PR is read again");
  assert.equal(nextCache?.reopened, undefined, "an open PR never enters the immutable merged cache");
});
