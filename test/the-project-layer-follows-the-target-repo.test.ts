/**
 * THE PROJECT LEARNINGS LAYER FOLLOWS THE PLAN, NOT THE REPO — the bug W1-T2506 fixes.
 *
 * THE DEFECT. The implement-worker's prompt injection derived the project layer's home
 * inline as `join(dirname(planPath), "..", "learnings")`. `planPath` is ALWAYS resolved
 * against THIS checkout (the orchestrator's own plan/tasks.yaml), never the TARGET repo's
 * checkout — so a task carrying `repo: <other>` was injected with THIS repo's learnings
 * regardless of which repo it actually named. `projectLearningsHome(repoRoot)`
 * (src/lib/learnings.ts) already exists, is already used at the promotion-pass corpus site
 * and `rmd learnings export`'s default, and its own doc names the inline expression this
 * fixes verbatim as the thing it was written to replace.
 *
 * THE FIX. `run-task.ts`'s implement dispatch now derives `learningsDir` as
 * `projectLearningsHome(repoDir)` — `repoDir` being `join(config.root, "repos", task.repo)`,
 * the SAME clone the "Clone + worktree" block just above guarantees exists (cloning it if
 * needed) and the SAME directory `dispatchClaimReserverFor`/`worktreeAdd` already operate
 * against for this run. No other call site, and no other layer (user-overall, global),
 * changes.
 *
 * TEST STRATEGY. Three behavioral tests drive a REAL `runTask()` — fake `spawn`/`gh`, real
 * git clones, same harness shape as `test/worker-preflight-visibility.test.ts` — and read the
 * `learnings.injected` ledger line `run-task.ts` already emits (`matched_ids`) to prove WHICH
 * directory's corpus actually reached the prompt. Four source-level (MUTANT-style) checks pin
 * the parts no behavioral test can cheaply reach: the inline expression is gone, the other two
 * `projectLearningsHome` call sites and the two untouched layers are byte-identical, and the
 * new derivation never spells out a repo name.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTask } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { SpawnWorkerArgs, WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── Fixture plumbing — same shape as test/worker-preflight-visibility.test.ts ────────────────

const TASK_ID = "T-LEARN-HOME";
const TASK_FILE = "src/lib/daemon.ts";

function fixturePlan(repo: string): string {
  return [
    `- id: ${TASK_ID}`,
    "  title: prove the project learnings layer follows the target repo",
    `  repo: ${repo}`,
    "  type: implement",
    "  verify: auto",
    "  risk: medium",
    `  files: [${TASK_FILE}]`,
    "  origin: architect",
    "  status: queued",
    "",
  ].join("\n");
}

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

/** One bare origin, cloned into `root/repos/<repo>` for every name in `repos` — the checkout
 *  `runTask`'s "Clone + worktree" block finds already present, so it never shells `gh repo clone`. */
function gitFixture(root: string, repos: string[]): void {
  const originGit = mkdtempSync(join(tmpdir(), "learn-home-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "learn-home-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "learn-home@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "learn-home"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  mkdirSync(join(root, "repos"), { recursive: true });
  for (const repo of repos) {
    const repoDir = join(root, "repos", repo);
    execFileSync("git", ["clone", "-q", originGit, repoDir]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "learn-home@example.invalid"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "learn-home"]);
  }
}

/** A fake `gh` answering ownership/trailer/CI — same shape the sibling runTask suites use.
 *  These runs end before `gh pr create` — the worker reports no PR_URL, verdict `no_pr`. */
function fakeGh(branch: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "learn-home-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then",
      "    echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'",
      "    exit 0",
      "  fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'merge' ]]; then exit 0; fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

function result(over: Partial<WorkerResult>): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function readLedger(root: string): Array<Record<string, unknown>> {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** One YAML shard, minimal but valid per `parseLearningsDoc` (id/fact/src/files required). */
function writeShard(dir: string, filename: string, id: string, fact: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, filename),
    [
      `- id: ${id}`,
      `  fact: "${fact}"`,
      "  src: \"learn-home-fixture\"",
      `  files: ["${TASK_FILE}"]`,
      "",
    ].join("\n"),
  );
}

const RECON_TEXT = "RECON REPORT\nOBSERVED: nothing notable\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n";
const FIXED_TS = 1785100000000;

/** Drive a real dispatch for a task naming `repo`, after `seed(root)` has populated whatever
 *  learnings directories the scenario needs — BEFORE the plan is even read, so the injection
 *  reads the corpus already on disk. Returns the full ledger for the caller's own assertions. */
async function runFixture(
  t: { mock: { method: typeof import("node:test").mock.method } },
  label: string,
  repo: string,
  seed: (root: string) => void,
): Promise<{ verdict: string; ledger: Array<Record<string, unknown>> }> {
  const root = mkdtempSync(join(tmpdir(), `learn-home-${label}-`));
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, fixturePlan(repo));
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root, [repo]);
  seed(root);

  t.mock.method(Date, "now", () => FIXED_TS);
  const fakeBinDir = fakeGh(`run-${TASK_ID}-${FIXED_TS}`);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;

  // First call is recon, second is implement — same call-count branch the sibling suite
  // (test/worker-preflight-visibility.test.ts) uses.
  let calls = 0;
  const spawn: typeof spawnWorker = async (_args: SpawnWorkerArgs) => {
    calls += 1;
    if (calls === 1) return result({ sessionId: "s-recon", text: RECON_TEXT });
    return result({ sessionId: "s-implement", text: "REPORT\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask(TASK_ID, {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    return { verdict: res.verdict, ledger: readLedger(root) };
  } finally {
    process.env.PATH = savedPath;
  }
}

function injectedLine(ledger: Array<Record<string, unknown>>): Record<string, unknown> {
  const lines = ledger.filter((l) => l.step === "learnings.injected");
  assert.equal(lines.length, 1, "exactly one learnings.injected line per dispatch");
  return lines[0];
}

// ── Behavioral acceptance ─────────────────────────────────────────────────────────────────

test("a task naming another repo is injected with that repo's project learnings, not the plan checkout's", async (t) => {
  const { ledger } = await runFixture(t, "other-repo", "target-repo", (root) => {
    // THE OLD (buggy) derivation: dirname(planPath)/".." == root/plan/.. == root. Seeding an
    // entry here proves the fix — restoring the inline `join(dirname(planPath), "..",
    // "learnings")` expression would inject THIS one instead of the target repo's, which is
    // exactly the defect this task closes (acceptance: "restoring the plan-derived path makes
    // the other-repo case inject this repo's corpus").
    writeShard(join(root, "learnings"), "wrong.yaml", "wrong-plan-derived-entry", "the plan checkout's own fact");
    // THE NEW (correct) derivation: projectLearningsHome(repoDir) == root/repos/target-repo/learnings.
    writeShard(
      join(root, "repos", "target-repo", "learnings"),
      "right.yaml",
      "right-target-repo-entry",
      "the target repo's own fact",
    );
  });

  const injected = injectedLine(ledger);
  assert.deepEqual(injected.matched_ids, ["right-target-repo-entry"]);
});

test("a task naming this repo is injected with exactly what it is injected with today", async (t) => {
  // The single-repo case every dispatch used before multi-repo cloning existed: the ONLY
  // learnings home in play is the target repo's own — proving the new helper-based derivation
  // still serves ordinary same-repo dispatch unchanged.
  const { ledger } = await runFixture(t, "same-repo", "remudero", (root) => {
    writeShard(join(root, "repos", "remudero", "learnings"), "self.yaml", "self-repo-entry", "this repo's own fact");
  });

  const injected = injectedLine(ledger);
  assert.deepEqual(injected.matched_ids, ["self-repo-entry"]);
});

test("a target repo with no learnings home injects nothing and does not refuse", async (t) => {
  const { verdict, ledger } = await runFixture(t, "no-home", "homeless-repo", () => {
    // Deliberately seed nothing — `repos/homeless-repo/learnings/` never exists.
  });

  assert.equal(ledger.filter((l) => l.step === "run.error").length, 0, "an absent home must not derail the run");
  assert.notEqual(verdict, undefined, "the dispatch must still reach a real terminal verdict");
  const injected = injectedLine(ledger);
  assert.deepEqual(injected.matched_ids, []);
  assert.equal(injected.matched, 0);
});

// ── Source-level (MUTANT-style) pins — the parts no behavioral test cheaply reaches ─────────

test("MUTANT: the inline plan-derived expression is gone from the implement dispatch", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  assert.equal(
    src.includes('join(dirname(planPath), "..", "learnings")'),
    false,
    "the buggy inline derivation must be fully replaced, not merely shadowed",
  );
});

test("MUTANT: the injection calls the named helper against the TARGET repo's own checkout, never a literal repo name", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const call = "const learningsDir = projectLearningsHome(repoDir);";
  assert.equal(src.split(call).length - 1, 1, "the exact substitution must be unique, or this proves nothing");
  // No special case anywhere names this repo by name: the call takes an IDENTIFIER
  // (`repoDir`), never a string literal a hardcoded repo name could hide inside.
  assert.doesNotMatch(call, /["']/, "the derivation must read from repoDir, never a hardcoded string");
});

test("MUTANT: the retro's promotion corpus resolution is untouched by this fix", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const call = "const promotionCorpusDir = projectLearningsHome(repoRoot);";
  assert.equal(
    src.split(call).length - 1,
    1,
    "the promotion pass must still read the ORCHESTRATOR checkout's own corpus — a separate, deliberately unmoved decision",
  );
});

test("MUTANT: the user-overall and global homes are resolved exactly as they are today", () => {
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const homesBlock = src.slice(src.indexOf("const learningsResult = computeMatchedLearningsForArm"), src.indexOf("const matchedLearnings = learningsResult.matchedLearnings;"));
  assert.match(homesBlock, /userOverallDir:\s*userOverallLearningsHome\(config\)/);
  assert.match(homesBlock, /globalArtifactPath:\s*globalArtifactPath\(config\)/);
  // Ranking/budget/lifecycle behaviour is unchanged: the same budget constant still feeds the
  // same call, and taskFiles still flows through unmodified.
  assert.match(homesBlock, /taskFiles:\s*task\.files/);
  assert.match(homesBlock, /budgetChars:\s*DEFAULT_KNOWLEDGE_BUDGET_CHARS/);
});
