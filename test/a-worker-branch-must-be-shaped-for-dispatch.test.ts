// test/a-worker-branch-must-be-shaped-for-dispatch.test.ts — W1-T2491.
//
// THE DEFECT. `run-<taskId>-<epochMs>` is how an in-flight task becomes visible to dispatch
// (`taskIdFromRunBranch`/`ownsBranch`, src/lib/status.ts) and how a merge is credited when the
// `Remudero-Task:` trailer is missing (`findMergedByHeadBranch`) — SEVEN modules read this shape
// and nothing anywhere refuses a branch that fails to carry it. 52 of 143 remote heads (measured
// at filing) do not match it — but most of those are legitimately outside the convention (`main`,
// `heartbeat-mini`, diagnostics, an operator's own scratch branches), so a gate that reddened all
// of them would measure the wrong population. What is checkable, and all `scripts/worker-branch-
// shape.mjs` checks, is narrower: a branch whose diff CLAIMS a task — by an anchored
// `Remudero-Task:` trailer on a commit it adds, or by filing a `plan/tasks.d/*.yaml` shard
// declaring that task's `id:` — must carry the `run-<id>-<epochMs>` shape that makes that claim
// visible. A branch claiming no task is never refused, whatever its name.
//
// WHAT IS REAL HERE: every function under test is imported straight from the production script
// (`scripts/worker-branch-shape.mjs`) via a dynamic import — `scripts/**` sits outside tsconfig's
// `include` (see tsconfig.json), so a static specifier is a TS7016, the same reason
// `test/credit-surface-gate.test.ts` reaches its own sibling script the same way. Nothing here is
// re-implemented or mocked; `readFile`/`commitMessages`/`addedFiles` are the script's own declared
// seams, exercised with fixture values rather than a real git repo (git plumbing itself is smoke-
// tested once at the bottom, against THIS repo's own real checkout).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FAST_GATE_STEPS } from "../src/lib/ci-parity.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "scripts", "worker-branch-shape.mjs");
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");
// Acceptance 7 is about what the CODE does, not what its own prose says about itself (the file's
// banner comment names "node --test" and "gh api"/"gh pr" IN ORDER TO DISCLAIM them — a bare text
// grep over the whole file would fail on its own honesty). Strip `//` line comments and `/* */`
// block comments (safe here: the script contains no string literal with `//` or `/*` in it —
// pinned by the CONTROL test below) before asking whether the remaining CODE ever spawns a test
// runner or opens a network connection.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const SCRIPT_CODE_ONLY = stripComments(SCRIPT_SOURCE);

const mod = (await import(pathToFileURL(SCRIPT_PATH).href)) as {
  matchesRunBranchShape: (head: string | undefined, taskId: string) => boolean;
  trailerTaskIds: (commitMessages: string | undefined) => string[];
  shardTaskIds: (addedFiles: readonly string[], readFile: (path: string) => string | undefined) => string[];
  claimedTaskIds: (input: {
    commitMessages: string | undefined;
    addedFiles: readonly string[];
    readFile: (path: string) => string | undefined;
  }) => string[];
  evaluateWorkerBranchShape: (input: {
    headRef: string | undefined;
    commitMessages: string | undefined;
    addedFiles: readonly string[];
    readFile: (path: string) => string | undefined;
  }) => { ok: boolean; defect?: string; message: string };
  resolveMergeBase: (worktreePath: string, baseRef: string) => string | undefined;
  commitMessagesSinceBase: (worktreePath: string, mergeBase: string | undefined) => string;
  addedFilesSinceBase: (worktreePath: string, mergeBase: string | undefined) => string[];
  resolveHeadRef: (flagValue: string | undefined, worktreePath: string, env?: Record<string, string | undefined>) => string | undefined;
  main: (argv: string[]) => void;
};
const {
  matchesRunBranchShape,
  claimedTaskIds,
  evaluateWorkerBranchShape,
  resolveMergeBase,
  commitMessagesSinceBase,
  addedFilesSinceBase,
  resolveHeadRef,
} = mod;

const TASK_ID = "W1-T2491";
const TRAILER = `Remudero-Task: ${TASK_ID}`;
const noFile = () => undefined;

function shardYaml(id: string) {
  return `- id: ${id}\n  title: "a filed shard"\n  repo: remudero\n  status: queued\n`;
}

// ── acceptance 1: a branch claiming a task by trailer with a non-conforming name is refused ────

test("acceptance 1: a fix/ branch whose new commit carries the trailer, but is not run-shaped, is refused", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "fix/light-pass-tick-not-bounded-by-ci",
    commitMessages: `fix(drain): stop a stuck run branch\n\n${TRAILER}\n`,
    addedFiles: [],
    readFile: noFile,
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unshaped-worker-branch");
});

test("acceptance 1: the trailer may sit on an EARLIER checkpoint commit, not just the tip — commitMessages is the whole range", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "chore/scratch",
    commitMessages: `wip: decided the approach\n\n${TRAILER}\n\x00chore: tidy up\n`,
    addedFiles: [],
    readFile: noFile,
  });
  assert.equal(result.ok, false, "a trailer anywhere in the branch's own new commits is a claim, not only the tip");
});

// ── acceptance 2: a branch claiming a task by declaring a shard with a non-conforming name ─────
// ── is refused ───────────────────────────────────────────────────────────────────────────────

test("acceptance 2: a chore/ branch that files a new plan/tasks.d/ shard, but is not run-shaped, is refused", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "chore/file-a-new-task",
    commitMessages: "chore(plan): file W1-T2491\n",
    addedFiles: ["plan/tasks.d/W1-T2491-something.yaml"],
    readFile: (path) => (path === "plan/tasks.d/W1-T2491-something.yaml" ? shardYaml(TASK_ID) : undefined),
  });
  assert.equal(result.ok, false);
  assert.equal(result.defect, "unshaped-worker-branch");
});

test("acceptance 2: a shard filed under a NON-plan/tasks.d/ path is never read as a claim", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "chore/whatever",
    commitMessages: "chore: docs\n",
    addedFiles: ["docs/notes/W1-T2491-something.yaml"],
    readFile: () => shardYaml(TASK_ID),
  });
  assert.equal(result.ok, true, "only plan/tasks.d/*.yaml additions are shard declarations");
});

test("acceptance 2: a MODIFIED (not newly added) shard is never re-claimed by this branch", () => {
  // addedFiles is the diff's ADDED-path list only (never a full plan/tasks.d/ walk) — a branch that
  // merely edits an existing shard (e.g. flipping its status) did not FILE it and makes no new claim.
  const result = evaluateWorkerBranchShape({
    headRef: "chore/status-flip",
    commitMessages: "chore(plan): mark blocked\n",
    addedFiles: [],
    readFile: () => shardYaml(TASK_ID),
  });
  assert.equal(result.ok, true);
});

// ── acceptance 3: a conforming worker branch passes ─────────────────────────────────────────────

test("acceptance 3: run-<taskId>-<epochMs> with a matching trailer passes", () => {
  const result = evaluateWorkerBranchShape({
    headRef: `run-${TASK_ID}-1787887966537`,
    commitMessages: `feat(x): implement it\n\n${TRAILER}\n`,
    addedFiles: [],
    readFile: noFile,
  });
  assert.equal(result.ok, true);
});

test("acceptance 3: run-<taskId>-<epochMs> with a matching FILED SHARD (no trailer at all — a plan filing carries none by rule) passes", () => {
  const result = evaluateWorkerBranchShape({
    headRef: `run-${TASK_ID}-1787887966537`,
    commitMessages: "chore(plan): file the shard\n",
    addedFiles: [`plan/tasks.d/${TASK_ID}-something.yaml`],
    readFile: () => shardYaml(TASK_ID),
  });
  assert.equal(result.ok, true);
});

test("acceptance 3: claiming the SAME id by both trailer and shard on a conforming branch still passes (dedup, not a double refusal)", () => {
  const result = evaluateWorkerBranchShape({
    headRef: `run-${TASK_ID}-1787887966537`,
    commitMessages: `feat: x\n\n${TRAILER}\n`,
    addedFiles: [`plan/tasks.d/${TASK_ID}-something.yaml`],
    readFile: () => shardYaml(TASK_ID),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    claimedTaskIds({
      commitMessages: `feat: x\n\n${TRAILER}\n`,
      addedFiles: [`plan/tasks.d/${TASK_ID}-something.yaml`],
      readFile: () => shardYaml(TASK_ID),
    }),
    [TASK_ID],
  );
});

// ── acceptance 4: a branch claiming no task is never refused, whatever its name ─────────────────

test("acceptance 4: main, a diagnostic branch, and an operator scratch branch all pass — none claims anything", () => {
  for (const headRef of ["main", "heartbeat-mini", "some-operators-scratch-branch", "fix-instrument-entanglement-baseline-carveout"]) {
    const result = evaluateWorkerBranchShape({
      headRef,
      commitMessages: "chore: routine housekeeping\n",
      addedFiles: [],
      readFile: noFile,
    });
    assert.equal(result.ok, true, `${headRef}: claims nothing, so it must never be refused`);
  }
});

test("acceptance 4: even an entirely un-run-shaped name with no head ref at all (undefined) passes when it claims nothing", () => {
  const result = evaluateWorkerBranchShape({ headRef: undefined, commitMessages: undefined, addedFiles: [], readFile: noFile });
  assert.equal(result.ok, true);
});

// ── acceptance 5: the refusal names the shape dispatch expects, not a bare rejection ────────────

test("acceptance 5: the refusal message spells out run-<taskId>-<epochMs>, the exact shape name, plus the claimed id", () => {
  const result = evaluateWorkerBranchShape({
    headRef: "feat/whatever",
    commitMessages: `feat: x\n\n${TRAILER}\n`,
    addedFiles: [],
    readFile: noFile,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /run-<taskId>-<epochMs>/, "names the shape, not just REFUSED");
  assert.match(result.message, new RegExp(TASK_ID), "names which id it failed to be shaped for");
  assert.doesNotMatch(result.message.trim(), /^REFUSED$/, "control: never a bare, unexplained rejection");
});

// ── acceptance 6: the step is a member of the habitual fast gate ───────────────────────────────

test("acceptance 6: FAST_GATE_STEPS carries an entry wired to scripts/worker-branch-shape.mjs's npm script", () => {
  const step = FAST_GATE_STEPS.find((s) => s.script === "worker-branch-shape:check");
  assert.ok(step, "worker-branch-shape:check must be a FAST_GATE_STEPS entry");
  assert.equal(step!.job, "worker-branch-shape");
  assert.match(step!.reason, /^required-core|^same-class/, "states one of the two admitted curation reasons, like every other entry");
});

test("acceptance 6: package.json actually declares the worker-branch-shape:check script the gate names", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.ok(pkg.scripts?.["worker-branch-shape:check"], "the npm script FAST_GATE_STEPS names must actually exist");
  assert.match(pkg.scripts!["worker-branch-shape:check"], /worker-branch-shape\.mjs/);
});

// ── acceptance 7: the step opens no network connection and spawns no test runner ────────────────

test("control: sanity — the comment strip actually removed prose text, so acceptance 7 below is not vacuously checking an unchanged file", () => {
  assert.ok(SCRIPT_CODE_ONLY.length > 0 && SCRIPT_CODE_ONLY.length < SCRIPT_SOURCE.length, "the strip must shrink the file (it has comments) but not empty it (it has real code)");
});

test("acceptance 7: the script's own CODE (comments stripped) never spawns node --test, npm test, or the test-with-retry runner", () => {
  assert.doesNotMatch(SCRIPT_CODE_ONLY, /node\s+--test\b/, "no direct node --test spawn");
  assert.doesNotMatch(SCRIPT_CODE_ONLY, /\bnpm\s+(run\s+)?test\b/, "no npm test invocation");
  assert.doesNotMatch(SCRIPT_CODE_ONLY, /test-with-retry/, "no test-with-retry runner");
});

test("acceptance 7: the script's own CODE (comments stripped) never fetches or opens a socket", () => {
  assert.doesNotMatch(SCRIPT_CODE_ONLY, /\bfetch\s*\(/, "no fetch()");
  assert.doesNotMatch(SCRIPT_CODE_ONLY, /node:https?\b|node:net\b|node:dgram\b/, "no HTTP/socket module import");
  assert.doesNotMatch(SCRIPT_CODE_ONLY, /\bgh\s+(api|pr)\b/, "no gh CLI network call");
  assert.doesNotMatch(SCRIPT_CODE_ONLY, /git\s+fetch\b|--fetch\b/, "never fetches a remote — every ref is read exactly as it stands locally");
});

test("acceptance 7: the only child process this script ever spawns, anywhere in its code, is git", () => {
  const spawns = [...SCRIPT_CODE_ONLY.matchAll(/execFileSync\s*\(\s*(["'])(.*?)\1/g)].map((m) => m[2]);
  assert.ok(spawns.length > 0, "sanity: the script does spawn something (git) — this is not a vacuous pass");
  for (const bin of spawns) assert.equal(bin, "git", `unexpected non-git spawn target: ${bin}`);
});

test("acceptance 7: the npm script itself is a plain node invocation of the file above, not a wrapper that could shell out further", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["worker-branch-shape:check"], "node scripts/worker-branch-shape.mjs");
});

// ── acceptance 8: dropping the claims-a-task condition makes an innocent branch fail ────────────

test("acceptance 8: matchesRunBranchShape alone (no claims-gate) fails an innocent branch against ANY id — proving the gate above it is load-bearing", () => {
  // If evaluateWorkerBranchShape asked matchesRunBranchShape directly, without first checking
  // whether the branch claims anything, every innocent branch in the repo would be judged against
  // some arbitrary id and fail — exactly the "reddens the wrong population" failure the rationale
  // warns against. This pins that the underlying shape predicate, on its own, has no notion of
  // "innocent" — the claims condition in evaluateWorkerBranchShape is what supplies it.
  for (const headRef of ["main", "heartbeat-mini", "chore/cleanup-docs"]) {
    assert.equal(matchesRunBranchShape(headRef, TASK_ID), false, `${headRef} does not carry ANY task's run-shape, including one it never claimed`);
  }
});

test("acceptance 8: evaluateWorkerBranchShape, which DOES gate on claims first, passes those same innocent branches clean", () => {
  for (const headRef of ["main", "heartbeat-mini", "chore/cleanup-docs"]) {
    const result = evaluateWorkerBranchShape({ headRef, commitMessages: "chore: cleanup\n", addedFiles: [], readFile: noFile });
    assert.equal(result.ok, true, `${headRef}: the claims-gate exempts it even though the bare shape predicate would have failed it`);
  }
});

// ── control: git-plumbing seams, smoke-tested against this repo's own real checkout ─────────────

test("control: commitMessagesSinceBase/addedFilesSinceBase never throw against this repo's real HEAD, and degrade to empty on an unresolvable base", () => {
  const mergeBase = resolveMergeBase(REPO_ROOT, "origin/main");
  assert.doesNotThrow(() => commitMessagesSinceBase(REPO_ROOT, mergeBase));
  assert.doesNotThrow(() => addedFilesSinceBase(REPO_ROOT, mergeBase));
  assert.deepEqual(commitMessagesSinceBase(REPO_ROOT, undefined), "", "an unresolvable base degrades to no new commits seen, not a throw");
  assert.deepEqual(addedFilesSinceBase(REPO_ROOT, undefined), [], "an unresolvable base degrades to no added files seen, not a throw");
});

test("control: resolveHeadRef reads the worktree's OWN current branch when no flag/env is given, matching real git", () => {
  const real = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(resolveHeadRef(undefined, REPO_ROOT, {}), real);
  assert.equal(resolveHeadRef("explicit-flag", REPO_ROOT, {}), "explicit-flag", "an explicit flag always wins");
  assert.equal(resolveHeadRef(undefined, REPO_ROOT, { GITHUB_HEAD_REF: "from-env" }), "from-env", "env wins over the local branch when no flag is given");
});

// ── coverage: the four git-plumbing seams' own DEGRADE (catch) branches ─────────────────────────
// Each seam below (design note above each production function) swallows a failing `git`
// invocation and returns the documented "nothing new seen" fallback rather than throwing. The
// control test above already exercises the SUCCESS path of each against this repo's real HEAD;
// these force the FAILURE path with a ref/path `git` itself cannot resolve.

test("resolveMergeBase: an unresolvable base ref degrades to undefined, not a throw", () => {
  assert.equal(resolveMergeBase(REPO_ROOT, "totally-nonexistent-ref-xyz-123"), undefined);
});

test("commitMessagesSinceBase: an unresolvable mergeBase ref degrades to the empty string, not a throw", () => {
  assert.equal(commitMessagesSinceBase(REPO_ROOT, "0000000000000000000000000000000000dead"), "");
});

test("addedFilesSinceBase: an unresolvable mergeBase ref degrades to an empty array, not a throw", () => {
  assert.deepEqual(addedFilesSinceBase(REPO_ROOT, "0000000000000000000000000000000000dead"), []);
});

test("resolveHeadRef: an unresolvable worktree path degrades to undefined, not a throw", () => {
  assert.equal(resolveHeadRef(undefined, "/definitely/does/not/exist/xyz-abc-123", {}), undefined);
});

// ── coverage: main(), the CLI entrypoint, exercised end to end against a REAL throwaway repo ────
// `main` is never called directly by the tests above (every other test drives its exported pieces
// individually) — it is exercised here by actually spawning `node scripts/worker-branch-shape.mjs`
// against a disposable git repo built fresh per test, so `parseArgs`, the OK/REFUSED branches,
// `process.exitCode`, and the console output are all real, not simulated.

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** A throwaway repo with one base commit on `base-branch`, ready for a caller to branch from. */
function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wbs-main-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Fixture"]);
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: base"]);
  git(dir, ["branch", "-q", "base-branch"]);
  return dir;
}

function runScript(dir: string, extraArgs: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH, "--base", "base-branch", "--worktree-path", dir, ...extraArgs], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

test("main(): a run-shaped branch whose new commit carries the trailer prints OK and exits 0", () => {
  const dir = initRepo();
  git(dir, ["checkout", "-q", "-b", `run-${TASK_ID}-1787887966537`]);
  writeFileSync(join(dir, "note.txt"), "x\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `feat: implement\n\n${TRAILER}`]);

  const { status, stdout } = runScript(dir);
  assert.equal(status, 0);
  assert.match(stdout, /worker-branch-shape: OK/);
  assert.match(stdout, new RegExp(TASK_ID));
});

test("main(): a claiming branch whose head ref is NOT run-shaped prints REFUSED to stderr and exits 1", () => {
  const dir = initRepo();
  git(dir, ["checkout", "-q", "-b", "fix/whatever"]);
  writeFileSync(join(dir, "note.txt"), "x\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", `fix: something\n\n${TRAILER}`]);

  const { status, stderr } = runScript(dir);
  assert.equal(status, 1);
  assert.match(stderr, /worker-branch-shape: REFUSED/);
  assert.match(stderr, new RegExp(TASK_ID));
});

test("main(): a run-shaped branch that FILES a shard reads it off disk through its own readFile closure and passes", () => {
  const dir = initRepo();
  git(dir, ["checkout", "-q", "-b", `run-${TASK_ID}-1787887966537`]);
  const shardDir = join(dir, "plan", "tasks.d");
  execFileSync("mkdir", ["-p", shardDir]);
  writeFileSync(join(shardDir, `${TASK_ID}-something.yaml`), shardYaml(TASK_ID));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore(plan): file the shard"]);

  const { status, stdout } = runScript(dir);
  assert.equal(status, 0);
  assert.match(stdout, /worker-branch-shape: OK/);
  assert.match(stdout, new RegExp(TASK_ID));
});

test("main(): an added path git reports but that no longer exists on disk degrades to no claim from it, not a crash", () => {
  // The diff's added-file list compares COMMITS, not the working tree — deleting the file from
  // disk afterward (without a further commit) leaves it "added" in the diff but unreadable by
  // main()'s own readFile closure, forcing that closure's catch branch (an ENOENT it must
  // swallow, per shardTaskIds's contract of treating an unreadable file as no declaration).
  const dir = initRepo();
  git(dir, ["checkout", "-q", "-b", `run-${TASK_ID}-1787887966537`]);
  const shardDir = join(dir, "plan", "tasks.d");
  execFileSync("mkdir", ["-p", shardDir]);
  const shardPath = join(shardDir, `${TASK_ID}-something.yaml`);
  writeFileSync(shardPath, shardYaml(TASK_ID));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore(plan): file the shard"]);
  unlinkSync(shardPath);

  const { status, stdout } = runScript(dir);
  assert.equal(status, 0, "no claim was actually readable, so the branch is exempt, not refused");
  assert.match(stdout, /exempt from the run-<taskId>-<epochMs> shape check/);
});

test("control: this repo's OWN current branch, run right now, does not regress to a false refusal — the bug this suite's own dev loop found and fixed", () => {
  // Reading only the TIP commit's message (rather than every commit this branch itself adds since
  // base) would misread the PREVIOUS PR's own trailer — already on origin/main's tip — as THIS
  // branch's claim, on the very first run right after `git checkout -b`, before any new commit
  // exists. commitMessagesSinceBase excludes the base itself, so a freshly branched worktree with
  // no new commit yet reports no claim at all, never a spurious refusal.
  const mergeBase = resolveMergeBase(REPO_ROOT, "origin/main");
  if (mergeBase === undefined) return; // no local origin/main in this environment — nothing to pin
  const headCommit = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (headCommit === mergeBase) {
    assert.equal(commitMessagesSinceBase(REPO_ROOT, mergeBase), "", "at the base itself, there is no new commit to claim anything");
  }
});
