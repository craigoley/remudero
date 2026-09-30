import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  MERGE_PROBE_STEP,
  defaultMergeProbeGit,
  probeMerge,
  probeOpenPrMerges,
  stackedOnNumbers,
  type MergeProbeGit,
  type MergeProbeGitResult,
} from "../src/lib/merge-probe.js";
import { appendLedger } from "../src/lib/ledger.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { OpenPrView } from "../src/lib/sweep.js";

const MAIN_A = "a".repeat(40);
const MAIN_B = "b".repeat(40);
const TREE = "c".repeat(40);

function view(over: Partial<OpenPrView> & { prNumber: number; headSha: string }): OpenPrView {
  return { prUrl: `https://example.test/pull/${over.prNumber}`, lastActivityAt: "0001", ...over } as OpenPrView;
}

function scriptedGit(handler: (args: readonly string[]) => Partial<MergeProbeGitResult>): {
  git: MergeProbeGit;
  calls: string[][];
} {
  const calls: string[][] = [];
  const git: MergeProbeGit = (args) => {
    calls.push([...args]);
    return { status: 0, stdout: "", ...handler(args) };
  };
  return { git, calls };
}

function mergeTreeGit(mainSha: string, mergeTree: Partial<MergeProbeGitResult>) {
  return scriptedGit((args) => {
    if (args[0] === "fetch") return {};
    if (args[0] === "rev-parse") return { stdout: `${mainSha}\n` };
    return mergeTree;
  });
}

function recorder() {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "rmd-merge-probe-ledger-")), "ledger.ndjson");
  const log = (step: string, extra: Record<string, unknown> = {}) =>
    appendLedger(ledgerPath, { run_id: "SWEEP-1", task_id: "SWEEP", step, ...extra });
  return { ledgerPath, log, get rows() { return readLedgerLines(ledgerPath) as Array<Record<string, unknown>>; } };
}

function probe(
  prs: readonly OpenPrView[],
  fx: ReturnType<typeof recorder>,
  opts: Parameters<typeof probeOpenPrMerges>[4] = {},
) {
  return probeOpenPrMerges(prs, fx.ledgerPath, fx.log, "unused-cwd", opts);
}

test("W1-T4914: a clean test merge is recorded as clean with no conflicting paths", () => {
  const { git } = mergeTreeGit(MAIN_A, { status: 0, stdout: `${TREE}\n` });
  const fx = recorder();
  const summary = probe([view({ prNumber: 7, headSha: "h7" })], fx, { git });
  assert.equal(summary.probed, 1);
  const rows = fx.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, MERGE_PROBE_STEP);
  assert.equal(rows[0]!.verdict, "clean");
  assert.deepEqual(rows[0]!.conflict_paths, []);
  assert.equal(rows[0]!.pr_number, 7);
  assert.equal(rows[0]!.head_sha, "h7");
  assert.equal(rows[0]!.main_sha, MAIN_A);
});

test("W1-T4914: a conflicting test merge is recorded with its paths", () => {
  const out = `${TREE}\nsrc/a.ts\nsrc/b.ts\nsrc/a.ts\n`;
  const { git } = mergeTreeGit(MAIN_A, { status: 1, stdout: out });
  const fx = recorder();
  probe([view({ prNumber: 8, headSha: "h8" })], fx, { git });
  assert.equal(fx.rows[0]!.verdict, "conflict");
  assert.deepEqual(fx.rows[0]!.conflict_paths, ["src/a.ts", "src/b.ts"]);
});

test("W1-T4914: a conflict's paths are capped", () => {
  const names = Array.from({ length: 30 }, (_, i) => `f${i}.ts`).join("\n");
  const result = probeMerge({ headSha: "h", mainSha: "m", git: () => ({ status: 1, stdout: `${TREE}\n${names}\n` }) });
  assert.equal(result.verdict, "conflict");
  assert.equal(result.verdict === "conflict" ? result.paths.length : -1, 20);
});

test("W1-T4914: an unreadable probe is never recorded as clean", () => {
  const exit128 = probeMerge({ headSha: "h", mainSha: "m", git: () => ({ status: 128, stdout: "" }) });
  assert.deepEqual(exit128, { verdict: "unreadable", reason: "git merge-tree exited 128 without a tree" });
  const missingObject = probeMerge({ headSha: "h", mainSha: "m", git: () => ({ status: 1, stdout: "" }) });
  assert.equal(missingObject.verdict, "unreadable", "merge-tree exits 1 with no tree for an unknown object");
  const cleanNoTree = probeMerge({ headSha: "h", mainSha: "m", git: () => ({ status: 0, stdout: "\n" }) });
  assert.equal(cleanNoTree.verdict, "unreadable");
  const otherExitWithTree = probeMerge({ headSha: "h", mainSha: "m", git: () => ({ status: 2, stdout: `${TREE}\n` }) });
  assert.equal(otherExitWithTree.verdict, "unreadable");
  const killed = probeMerge({ headSha: "h", mainSha: "m", git: () => ({ status: null, stdout: "" }) });
  assert.equal(killed.verdict, "unreadable");
  const thrown = probeMerge({
    headSha: "h",
    mainSha: "m",
    git: () => {
      throw new Error("spawn boom");
    },
  });
  assert.deepEqual(thrown, { verdict: "unreadable", reason: "spawn boom" });
  const thrownNonError = probeMerge({
    headSha: "h",
    mainSha: "m",
    git: () => {
      throw "plain string";
    },
  });
  assert.deepEqual(thrownNonError, { verdict: "unreadable", reason: "plain string" });
  const { git } = mergeTreeGit(MAIN_A, { status: 128, stdout: "" });
  const fx = recorder();
  probe([view({ prNumber: 9, headSha: "h9" })], fx, { git });
  assert.equal(fx.rows[0]!.verdict, "unreadable");
  assert.equal(fx.rows[0]!.reason, "git merge-tree exited 128 without a tree");
  assert.deepEqual(fx.rows[0]!.conflict_paths, []);
});

test("W1-T4914: the row carries GitHub mergeable state beside the verdict", () => {
  const { git } = mergeTreeGit(MAIN_A, { status: 1, stdout: `${TREE}\nx.ts\n` });
  const fx = recorder();
  probe(
    [
      view({ prNumber: 10, headSha: "h10", mergeableState: "dirty", body: "Stacked on #4 -> #5\nbody text" }),
      view({ prNumber: 11, headSha: "h11", lastActivityAt: "0002" }),
    ],
    fx,
    { git, behindMainByPr: new Map([[10, 6]]) },
  );
  const rows = fx.rows;
  assert.equal(rows[0]!.github_mergeable_state, "dirty");
  assert.equal(rows[0]!.verdict, "conflict");
  assert.deepEqual(rows[0]!.stacked_on, [4, 5]);
  assert.equal(rows[0]!.behind_by, 6);
  assert.equal(rows[1]!.github_mergeable_state, "absent");
  assert.deepEqual(rows[1]!.stacked_on, []);
  assert.equal("behind_by" in rows[1]!, false);
});

test("W1-T4914: stackedOnNumbers reads only a Stacked on line", () => {
  assert.deepEqual(stackedOnNumbers(undefined), []);
  assert.deepEqual(stackedOnNumbers("closes #12, no stack"), []);
  assert.deepEqual(stackedOnNumbers("- **Stacked on #3\nfixes #99"), [3]);
});

test("W1-T4914: an unchanged head and main pair is not probed again", () => {
  let main = MAIN_A;
  const { git, calls } = scriptedGit((args) => {
    if (args[0] === "rev-parse") return { stdout: `${main}\n` };
    if (args[0] === "merge-tree") return { stdout: `${TREE}\n` };
    return {};
  });
  const fx = recorder();
  const prs = [view({ prNumber: 20, headSha: "h20" }), view({ prNumber: 21, headSha: "h21", isDraft: true })];

  assert.equal(probe(prs, fx, { git }).probed, 1);
  assert.equal(fx.rows.length, 1);
  assert.equal(fx.rows[0]!.pr_number, 20);
  assert.equal(
    calls.some((c) => c.join(" ").includes("refs/pull/21/head")),
    false,
    "a draft is never fetched or probed",
  );

  assert.equal(probe(prs, fx, { git }).probed, 0, "same head and same main: no second probe");
  assert.equal(fx.rows.length, 1);

  main = MAIN_B;
  assert.equal(probe(prs, fx, { git }).probed, 1, "main advanced: the pair is new");
  assert.equal(fx.rows.length, 2);
  assert.equal(fx.rows[1]!.main_sha, MAIN_B);

  assert.equal(probe([view({ prNumber: 22, headSha: "h22", isDraft: true })], fx, { git }).probed, 0);
  assert.equal(fx.rows.length, 2);
});

test("W1-T4914: a pass probes at most the cap, oldest activity first", () => {
  const { git } = mergeTreeGit(MAIN_A, { status: 0, stdout: `${TREE}\n` });
  const fx = recorder();
  const prs = [
    view({ prNumber: 3, headSha: "h3", lastActivityAt: "0003" }),
    view({ prNumber: 1, headSha: "h1", lastActivityAt: "0001" }),
    view({ prNumber: 2, headSha: "h2", lastActivityAt: "0001" }),
  ];
  probe(prs, fx, { git, limit: 2 });
  assert.deepEqual(
    fx.rows.map((r) => r.pr_number),
    [1, 2],
  );
});

test("W1-T4914: a main that cannot be read records no verdict and a throw never escapes", () => {
  const fx = recorder();
  const prs = [view({ prNumber: 30, headSha: "h30" })];
  const fetchFails = scriptedGit(() => ({ status: 128 }));
  assert.equal(probe(prs, fx, { git: fetchFails.git }).probed, 0);
  const emptySha = scriptedGit((args) => (args[0] === "rev-parse" ? { stdout: "\n" } : {}));
  assert.equal(probe(prs, fx, { git: emptySha.git }).probed, 0);
  assert.deepEqual(
    fx.rows.map((r) => r.step),
    [`${MERGE_PROBE_STEP}.main_unreadable`, `${MERGE_PROBE_STEP}.main_unreadable`],
  );
  assert.equal(fx.rows[0]!.git_status, 128);

  const exploding: MergeProbeGit = () => {
    throw new Error("fetch exploded");
  };
  assert.equal(probe(prs, fx, { git: exploding }).probed, 0);
  assert.equal(fx.rows[2]!.step, `${MERGE_PROBE_STEP}.error`);
  assert.equal(fx.rows[2]!.error, "fetch exploded");
  const explodingPlain: MergeProbeGit = () => {
    throw "plain";
  };
  probe(prs, fx, { git: explodingPlain });
  assert.equal(fx.rows[3]!.error, "plain");
});

test("W1-T4914: a dry run and a pass with no eligible PR touch no git", () => {
  const { git, calls } = mergeTreeGit(MAIN_A, { status: 0, stdout: `${TREE}\n` });
  const fx = recorder();
  assert.equal(probe([view({ prNumber: 40, headSha: "h40" })], fx, { git, dryRun: true }).probed, 0);
  assert.equal(probe([], fx, { git }).probed, 0);
  assert.equal(probe([view({ prNumber: 41, headSha: "h41", isDraft: true })], fx, { git }).probed, 0);
  assert.equal(calls.length, 0);
  assert.equal(fx.rows.length, 0);
});

test("W1-T4914: the probe issues no push and no update-branch", () => {
  const { git, calls } = mergeTreeGit(MAIN_A, { status: 1, stdout: `${TREE}\nx.ts\n` });
  probe([view({ prNumber: 50, headSha: "h50" })], recorder(), { git });
  assert.ok(calls.length >= 3, "the probe did run");
  const verbs = new Set(calls.map((c) => c[0]));
  assert.deepEqual([...verbs].sort(), ["fetch", "merge-tree", "rev-parse"]);
  assert.equal(calls.some((c) => c.some((a) => /push|update-branch|worktree|checkout/.test(a))), false);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

test("W1-T4914: the default seam classifies a real conflict", () => {
  const repo = mkdtempSync(join(tmpdir(), "rmd-merge-probe-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "f.txt"), "base\n");
  writeFileSync(join(repo, "g.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-q", "-b", "clean-head");
  writeFileSync(join(repo, "g.txt"), "head edit\n");
  git(repo, "commit", "-q", "-am", "clean head");
  const cleanHead = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-q", "-b", "conflict-head", base);
  writeFileSync(join(repo, "f.txt"), "head edit\n");
  git(repo, "commit", "-q", "-am", "conflicting head");
  const conflictHead = git(repo, "rev-parse", "HEAD");

  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "f.txt"), "main edit\n");
  git(repo, "commit", "-q", "-am", "main moves");
  const mainSha = git(repo, "rev-parse", "HEAD");

  const real = defaultMergeProbeGit(repo);
  const clean = probeMerge({ headSha: cleanHead, mainSha, git: real });
  assert.equal(clean.verdict, "clean");
  assert.match(clean.verdict === "clean" ? clean.tree : "", /^[0-9a-f]{40}$/);
  assert.deepEqual(probeMerge({ headSha: conflictHead, mainSha, git: real }), {
    verdict: "conflict",
    paths: ["f.txt"],
  });
  assert.equal(probeMerge({ headSha: "f".repeat(40), mainSha, git: real }).verdict, "unreadable");

  const missing = defaultMergeProbeGit(join(repo, "does-not-exist"));
  assert.deepEqual(missing(["rev-parse", "HEAD"]), { status: null, stdout: "" });
  assert.equal(probeMerge({ headSha: cleanHead, mainSha, git: missing }).verdict, "unreadable");

  git(repo, "remote", "add", "origin", repo);
  git(repo, "update-ref", "refs/pull/60/head", conflictHead);
  git(repo, "update-ref", "refs/pull/61/head", cleanHead);
  const fx = recorder();
  const summary = probeOpenPrMerges(
    [view({ prNumber: 60, headSha: conflictHead }), view({ prNumber: 61, headSha: cleanHead, lastActivityAt: "0002" })],
    fx.ledgerPath,
    fx.log,
    repo,
  );
  assert.equal(summary.probed, 2);
  assert.equal(summary.mainSha, mainSha);
  assert.deepEqual(
    fx.rows.map((r) => [r.pr_number, r.verdict, r.conflict_paths]),
    [
      [60, "conflict", ["f.txt"]],
      [61, "clean", []],
    ],
  );
});
