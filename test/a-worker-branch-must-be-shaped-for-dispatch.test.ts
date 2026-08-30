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
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  trailerTaskIds,
  claimedTaskIds,
  evaluateWorkerBranchShape,
  resolveMergeBase,
  commitMessagesSinceBase,
  addedFilesSinceBase,
  resolveHeadRef,
  main,
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

// ── control: each git-plumbing seam's OWN degrade-on-failure branch, forced rather than hoped for ─
//
// Every seam above (resolveMergeBase, commitMessagesSinceBase, resolveHeadRef,
// addedFilesSinceBase) has a `try { execFileSync(...) } catch { return <empty> }` shape — the file
// banner's "a setup gap degrades to nothing claimed, not a crash" guarantee. The tests above only
// ever exercise the TRY arm (this repo's own real, resolvable git state); these force the CATCH arm
// directly, the only way to prove the degrade actually fires rather than merely reading as intent.

test("control: resolveMergeBase's catch arm — an unresolvable baseRef degrades to undefined, not a throw", () => {
  assert.doesNotThrow(() => resolveMergeBase(REPO_ROOT, "refs/heads/definitely-not-a-real-ref-w1-t2491"));
  assert.equal(resolveMergeBase(REPO_ROOT, "refs/heads/definitely-not-a-real-ref-w1-t2491"), undefined);
});

test("control: commitMessagesSinceBase's catch arm — a syntactically valid but non-existent mergeBase sha degrades to \"\", not a throw", () => {
  const bogusSha = "0".repeat(40);
  assert.doesNotThrow(() => commitMessagesSinceBase(REPO_ROOT, bogusSha));
  assert.equal(commitMessagesSinceBase(REPO_ROOT, bogusSha), "");
});

test("control: addedFilesSinceBase's catch arm — the same bogus mergeBase sha degrades to [], not a throw", () => {
  const bogusSha = "0".repeat(40);
  assert.doesNotThrow(() => addedFilesSinceBase(REPO_ROOT, bogusSha));
  assert.deepEqual(addedFilesSinceBase(REPO_ROOT, bogusSha), []);
});

test("control: resolveHeadRef's catch arm — a worktree path that is not a git repo at all degrades to undefined, not a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-branch-shape-nogit-"));
  try {
    assert.doesNotThrow(() => resolveHeadRef(undefined, dir, {}));
    assert.equal(resolveHeadRef(undefined, dir, {}), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── control: main()'s own two branches, in-process ───────────────────────────────────────────────
//
// Every test above calls `evaluateWorkerBranchShape` (or a single plumbing seam) directly with
// fixture values — `main` itself (the CLI wiring: parseArgs, resolving every seam against a real
// worktree, and printing/exit-coding the verdict) was never once invoked. process.exitCode/
// console.log/console.error are saved and monkey-patched around each call — leaving them
// patched would corrupt this suite's own process — the same `withExitCode` shape
// test/credit-surface-gate.test.ts uses for its own analogous entry point.

async function withExitCode(fn: () => void): Promise<{ exitCode: typeof process.exitCode; err: string[]; out: string[] }> {
  const priorExit = process.exitCode;
  const err: string[] = [];
  const out: string[] = [];
  const realErr = console.error;
  const realOut = console.log;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    fn();
    return { exitCode: process.exitCode, err, out };
  } finally {
    console.error = realErr;
    console.log = realOut;
    process.exitCode = priorExit;
  }
}

test("control: main() refuses with exit 1 and its own REFUSED message when an explicit --head-ref does not carry the shape this real branch's own trailer claims", async () => {
  const mergeBase = resolveMergeBase(REPO_ROOT, "origin/main");
  if (mergeBase === undefined) return; // no local origin/main in this environment — nothing to pin
  const claimed = trailerTaskIds(commitMessagesSinceBase(REPO_ROOT, mergeBase));
  if (claimed.length === 0) return; // this checkout's own new commits claim nothing right now — nothing to refuse
  const r = await withExitCode(() =>
    main(["--base", "origin/main", "--head-ref", "totally-not-run-shaped", "--worktree-path", REPO_ROOT]),
  );
  assert.equal(r.exitCode, 1);
  assert.equal(r.err.length, 1, "the refusal is reported once, on stderr");
  assert.match(r.err[0], /worker-branch-shape: REFUSED/);
  assert.deepEqual(r.out, [], "a refusal prints no OK line");
});

test("control: main() passes with exit 0 and its own OK message when --base cannot be resolved locally (degrades to \"claims nothing\")", async () => {
  const r = await withExitCode(() =>
    main(["--base", "refs/heads/definitely-not-a-real-ref-w1-t2491", "--head-ref", "whatever-name", "--worktree-path", REPO_ROOT]),
  );
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.err, [], "a pass prints nothing on stderr");
  assert.equal(r.out.length, 1);
  assert.match(r.out[0], /worker-branch-shape: OK/);
});

// ── control: main()'s own `readFile` seam — the closure at its bottom that hands shardTaskIds a ──
// ── real filesystem read, exercised through BOTH of its own try/catch arms ──────────────────────

test("control: main()'s own readFile seam's TRY arm — a filed shard genuinely present on disk is read and refused when its branch is not run-shaped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-branch-shape-shard-present-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "chore: base commit"]);

    const shardRelPath = join("plan", "tasks.d", "W1-T9998-something.yaml");
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(dir, shardRelPath), "- id: W1-T9998\n  title: filed\n  repo: remudero\n  status: queued\n");
    execFileSync("git", ["-C", dir, "add", shardRelPath]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "chore(plan): file W1-T9998"]);

    const r = await withExitCode(() =>
      main(["--base", "HEAD~1", "--head-ref", "chore/file-w1-t9998", "--worktree-path", dir]),
    );
    assert.equal(r.exitCode, 1, "the shard genuinely declares W1-T9998, and this head ref is not run-shaped for it");
    assert.match(r.err[0], /worker-branch-shape: REFUSED.*W1-T9998/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control: main()'s own readFile seam's CATCH arm — an added shard path git reports but the working tree no longer has on disk degrades to no claim, not a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-branch-shape-shard-missing-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "chore: base commit"]);

    const shardRelPath = join("plan", "tasks.d", "W1-T9997-something.yaml");
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(dir, shardRelPath), "- id: W1-T9997\n  title: filed\n  repo: remudero\n  status: queued\n");
    execFileSync("git", ["-C", dir, "add", shardRelPath]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "chore(plan): file W1-T9997"]);
    // Committed, but now removed from the working tree — forces readFileSync in main()'s own
    // readFile closure to throw, so this pins its catch arm degrades to "no claim", not a crash.
    rmSync(join(dir, shardRelPath), { force: true });

    const r = await withExitCode(() =>
      main(["--base", "HEAD~1", "--head-ref", "chore/file-w1-t9997", "--worktree-path", dir]),
    );
    assert.equal(r.exitCode, 0, "the shard's own file is unreadable, so shardTaskIds sees no claim and the branch is never refused for it");
    assert.doesNotThrow(() =>
      main(["--base", "HEAD~1", "--head-ref", "chore/file-w1-t9997", "--worktree-path", dir]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the real CLI process, end-to-end ─────────────────────────────────────────────────────────
//
// Every `main()` call above runs in-process, so the direct-execution guard at the very bottom of
// the script (`if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)`) was never
// observed true — that condition only holds when the file is the process's OWN entry point. This
// spawns the real script exactly as `worker-branch-shape:check` (package.json) does, matching
// test/credit-surface-gate.test.ts's own `runGate` shape for its analogous CLI.

function runScript(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd: REPO_ROOT, encoding: "utf8" });
}

test("control: the real CLI process exits 0 and prints OK for a branch that claims nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-branch-shape-cli-noclaim-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "chore: routine housekeeping"]);

    const run = runScript(["--head-ref", "some-operators-scratch-branch", "--worktree-path", dir]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /worker-branch-shape: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control: the real CLI process exits 1 for a branch whose new commit claims a task its own head ref is not shaped for", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-branch-shape-cli-refused-"));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "chore: base commit"]);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "-q", "-m", "fix(drain): stop a stuck run branch\n\nRemudero-Task: W1-T9999\n"]);

    const run = runScript(["--base", "HEAD~1", "--head-ref", "fix/drain-stuck-run-branch", "--worktree-path", dir]);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /worker-branch-shape: REFUSED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
