import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { scopeAdvisorySection, type UnwiredAdvisory } from "../src/lib/review.js";
import { runTask, scopeGuardOutOfScopeFiles } from "../src/run-task.js";
import type { GitHub } from "../src/lib/status.js";
import type { ProbeExecResult as IsolationProbeExecResult } from "../src/lib/isolation.js";
import type { ProbeExecResult } from "../src/lib/containment.js";
import type { WorkerResult } from "../src/lib/worker.js";
import type { spawnWorker } from "../src/lib/worker.js";
import type { Config } from "../src/lib/config.js";

/**
 * W1-T434 — THE SCOPE GUARD'S PUSH-SITE REFUSAL BECOMES A FLAGGED PUSH.
 *
 * `scopeGuardOutOfScopeFiles` (src/run-task.ts) used to answer an out-of-scope diff at
 * `runTask`'s fallback push site by returning verdict `"failed"` with no push. THAT ANSWER
 * DESTROYED ITS OWN EVIDENCE: the branch never reached origin and died with the reaped worktree,
 * so nobody could afterwards tell a phantom revert from an under-declared `files:` — the two
 * shapes produce an IDENTICAL file list, and the refusal deleted the only artifact that separates
 * them. Meanwhile the class it exists to contain merged anyway through the worker's OWN sandbox
 * push (W1-T393's implementation, #1521), because this guard reaches ONE of `gitPushRunBranch`'s
 * nine call sites and only when the branch is ABSENT from origin.
 *
 * WHAT CHANGED IS ONLY WHAT THE ANSWER DOES. The detector is untouched — exact-match, fail-closed
 * on an undeclared scope, W1-T401's "it is correct" settlement stands — and the first test below
 * re-pins it so a future edit to the DETECTOR cannot hide behind a change to the ACTION.
 *
 * WHY THESE LIVE HERE AND NOT IN test/run-task.test.ts, where their W1-T142 ancestors did:
 * CLAUDE.md's coverage rule — that file intermittently crashes at FILE level under
 * `--experimental-test-coverage`, zeroing the coverage record for everything in it, and these are
 * the ONLY tests that reach the new push-and-flag arms.
 *
 * THE FIXTURES REACH THE GUARD, ASSERTED RATHER THAN ASSUMED. Every behavioural test below drives
 * the REAL `runTask` and returns a worker report carrying NO `PR_URL`, which is what makes the run
 * fall through to the orchestrator's own push fallback (`if (!branchOnOrigin)`) — the one guarded
 * site. Each then asserts a ledger line only that branch can write, so a fixture that silently
 * took another path fails rather than passing green over nothing.
 */

// ── THE HARNESS: a real throwaway git origin, a fake `gh` on PATH, zero network, zero real
// Claude spawn. Mirrors test/run-task.test.ts's W1-T105 follow-up fixture. ────────────────────

const FIXTURE_PLAN = [
  "- id: T-SCOPE",
  "  title: scope guard push-and-flag probe",
  "  repo: remudero",
  "  type: implement",
  "  verify: auto",
  "  risk: medium",
  "  files: [src/lib/daemon.ts]",
  "  origin: architect",
  "  status: queued",
  "",
].join("\n");

/** An offline GitHub gateway: projectPlan runs with zero network round-trips. */
const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** A containmentExec reporting the outside-cwd write OS-DENIED — containment PASSES. */
const holdingContainmentExec = (token: string): Promise<ProbeExecResult> =>
  Promise.resolve({
    transcript: `touch ../${token}.txt: Operation not permitted`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    costUsd: 0,
  });

/** An isolationExec reporting zero inherited operator aliases/functions — isolation PASSES. */
const cleanIsolationExec = (): Promise<IsolationProbeExecResult> =>
  Promise.resolve({
    transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -",
    aliasCount: 0,
    functionCount: 0,
    functionNames: "-",
    costUsd: 0,
  });

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

/** A real, throwaway BARE "origin" + a real clone at `repoDir` — the run's `git push origin HEAD`
 *  really runs, so "did the branch reach origin?" is answered by `ls-remote`, not by a recorder
 *  that could agree with a push that never happened. */
function gitFixture(root: string): { repoDir: string } {
  const originGit = mkdtempSync(join(tmpdir(), "scope-overrun-origin-"));
  execFileSync("git", ["init", "-q", "--bare", "--initial-branch=main", originGit]);
  const seed = mkdtempSync(join(tmpdir(), "scope-overrun-seed-"));
  execFileSync("git", ["clone", "-q", originGit, seed]);
  execFileSync("git", ["-C", seed, "config", "user.email", "scope-test@example.invalid"]);
  execFileSync("git", ["-C", seed, "config", "user.name", "scope-test"]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  execFileSync("git", ["-C", seed, "add", "-A"]);
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);

  const repoDir = join(root, "repos", "remudero");
  mkdirSync(join(root, "repos"), { recursive: true });
  execFileSync("git", ["clone", "-q", originGit, repoDir]);
  execFileSync("git", ["-C", repoDir, "config", "user.email", "scope-test@example.invalid"]);
  execFileSync("git", ["-C", repoDir, "config", "user.name", "scope-test"]);
  return { repoDir };
}

/** A fake `gh` answering only what this run reaches: `pr view --json headRefName`
 *  (checkPrOwnership), `--json body` + `pr edit` (ensureTaskTrailer), `--json statusCheckRollup`
 *  (answered RED on the first poll, so the run reaches its terminal blocked_ci verdict with no
 *  sleep and no review spawn) and the REST create `gh api --method POST repos/.../pulls`
 *  (every run below now gets far enough to need it — W1-T1202 moved this off `gh pr create
 *  --fill`/GraphQL onto REST, so the PR url now comes back as `html_url` in a JSON response,
 *  never scraped off human-readable stdout). */
function fakeGh(branch: string, prUrl: string): string {
  const fakeBinDir = mkdtempSync(join(tmpdir(), "scope-overrun-bin-"));
  const fakeGhPath = join(fakeBinDir, "gh");
  writeFileSync(
    fakeGhPath,
    [
      "#!/bin/bash",
      "set -e",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'view' ]]; then",
      `  if [[ "$5" == 'headRefName' ]]; then echo '{"headRefName":"${branch}"}'; exit 0; fi`,
      "  if [[ \"$5\" == 'body' ]]; then echo '{\"body\":\"\"}'; exit 0; fi",
      "  if [[ \"$5\" == 'statusCheckRollup' ]]; then echo '{\"statusCheckRollup\":[{\"name\":\"ci\",\"conclusion\":\"FAILURE\"}]}'; exit 0; fi",
      "fi",
      "if [[ \"$1\" == 'pr' && \"$2\" == 'edit' ]]; then exit 0; fi",
      `if [[ "$1" == 'api' && "$2" == '--method' && "$3" == 'POST' ]]; then echo '{"html_url":"${prUrl}","number":99}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGhPath, 0o755);
  return fakeBinDir;
}

type LedgerLine = { step: string; [k: string]: unknown };

function readLedger(root: string): LedgerLine[] {
  return readFileSync(join(root, "state", "ledger.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LedgerLine);
}

function branchOnOrigin(root: string, branch: string): boolean {
  try {
    execFileSync("git", ["-C", join(root, "repos", "remudero"), "ls-remote", "--exit-code", "origin", branch], {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

// ── THE DETECTOR IS UNTOUCHED (design (i)/(vi)) ───────────────────────────────────────────────

test("the DETECTOR still names exactly what it always did — only the ACTION changed", () => {
  // Re-pinned HERE, in the file that retires the refusal, so a future edit loosening the
  // comparison cannot pass by pointing at "W1-T434 relaxed the guard". It relaxed the answer.
  assert.deepEqual(scopeGuardOutOfScopeFiles(["test/foo.ts", "src/lib/issues-intake.ts"], ["test/foo.ts"]), [
    "src/lib/issues-intake.ts",
  ]);
  assert.deepEqual(scopeGuardOutOfScopeFiles(["src/a.ts"], ["src/a.ts", "docs/unused.md"]), []);
  // Still fail-CLOSED on an undeclared scope — the one place the push-site comparison and the
  // review-side one deliberately DISAGREE. See the last test in this file for what that costs.
  assert.deepEqual(scopeGuardOutOfScopeFiles(["src/a.ts"], undefined), ["src/a.ts"]);
  assert.deepEqual(scopeGuardOutOfScopeFiles(["src/a.ts"], []), ["src/a.ts"]);
});

// ── scopeAdvisorySection: the pure renderer, both directions ──────────────────────────────────

const scopeAdvisory = (paths: string[]): UnwiredAdvisory => ({
  reasonCode: "scope_violation",
  symbols: paths,
  detail: `diff touches file(s) outside the task's declared scope: ${paths.join(", ")}`,
});

test("scopeAdvisorySection: a clean PR renders NOTHING — no section, on any shape of empty input", () => {
  // THE HALF A ONE-SIDED FIX WOULD BREAK. Rendering a section is easy; rendering it only when
  // there is something to say is the actual requirement, and it is what the in-scope behavioural
  // test below depends on.
  assert.equal(scopeAdvisorySection(undefined), undefined, "no advisories computed at all");
  assert.equal(scopeAdvisorySection([]), undefined, "advisories computed, none found");
  assert.equal(
    scopeAdvisorySection([{ reasonCode: "inverse_scope", symbols: ["src/never-touched.ts"], detail: "d" }]),
    undefined,
    "a DIFFERENT advisory code is not this section's business — inverse_scope is the opposite direction",
  );
});

test("scopeAdvisorySection: an overrun names every offending path and marks itself non-binding in the rendered text", () => {
  const section = scopeAdvisorySection([scopeAdvisory(["src/lib/ledger.ts", "test/retro.test.ts"])]);
  assert.ok(section, "an overrun must render something");
  assert.match(section, /`src\/lib\/ledger\.ts`/, "names the first path");
  assert.match(section, /`test\/retro\.test\.ts`/, "names the second path");
  // W1-T186 emitter discipline: never a bare "flagged" with nothing named.
  assert.ok(!/\bflagged\b(?![\s\S]*ledger\.ts)/.test(section), "never announces a flag without naming it");
  assert.match(section, /advisory/i);
  assert.match(section, /does not affect remudero-review/i, "a reader must not mistake it for a gate");
  // The legitimate-widening reading is offered FIRST — W1-T401 measured that as the majority.
  assert.match(section, /legitimate/i);
});

test("scopeAdvisorySection: reads the advisory, never a second walk — it renders the symbols it is given verbatim", () => {
  // The comparison has exactly one home (scopeViolationFiles). If this recomputed, the PR comment
  // and the `review.unwired_advisory` ledger line could disagree about the same PR.
  const odd = ["a b/c.ts", "weird name.ts"];
  const section = scopeAdvisorySection([scopeAdvisory(odd)]);
  assert.ok(section);
  for (const p of odd) assert.ok(section.includes(p), `${p} rendered verbatim, not re-derived`);
});

// ── THE COMMENT PATH CONSUMES IT (design (iii)) ───────────────────────────────────────────────

test("wiring: runReview computes the scope section AND pushes it into the comment body — computing it is not consuming it", () => {
  // A source-structure check, the same idiom test/review.test.ts uses for W1-T359's rubric
  // wiring, because the failure it guards is INVISIBLE to a renderer test: a section that is
  // computed, gated on, and then never appended renders perfectly in isolation and reaches no PR.
  const src = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const start = src.indexOf("async function runReview(");
  const end = src.indexOf("// ── THE blocked_review FIX RUNG");
  assert.ok(start > -1 && end > start, "could not locate runReview's body in run-task.ts");
  const runReviewSrc = src.slice(start, end);

  assert.match(runReviewSrc, /const scopeSection = scopeAdvisorySection\(/, "runReview must render the section");
  assert.match(runReviewSrc, /if \(hasUnmet \|\| rubricSection \|\| scopeSection\)/, "…gate the comment on it…");
  assert.match(runReviewSrc, /if \(scopeSection\) parts\.push\(scopeSection\)/, "…and actually append it to the body");

  // INDEPENDENCE: the binding verdict never sees it. Advisory means advisory.
  const judgeIdx = runReviewSrc.indexOf("const computed = judgeReview(");
  assert.ok(judgeIdx > -1, "could not locate the judgeReview call site");
  const judgeArgs = runReviewSrc.slice(judgeIdx, runReviewSrc.indexOf("});", judgeIdx) + 3);
  assert.doesNotMatch(judgeArgs, /\bscope(Section|AdvisorySection)\b/, "judgeReview's inputs never reference it");
});

// ── THE PUSH SITE, driven through the REAL runTask ────────────────────────────────────────────

async function runFixture(opts: {
  ts: number;
  prefix: string;
  /** Runs inside the implement worker's worktree; makes the commit whose diff the guard reads. */
  implement: (cwd: string) => void;
  /** The implement worker's report. Defaults to one carrying NO `PR_URL`, which is what makes the
   *  run fall through to the orchestrator's push fallback. The unreadable-diff fixture overrides
   *  it, because breaking `origin/main` also breaks the SILENT NO-OP GUARD's own
   *  `commitsAhead(worktreePath, "origin/main")` — which fails to 0 and would divert the run to
   *  `no_pr` BEFORE the guarded site, masking the branch under test. */
  report?: string;
}): Promise<{ root: string; branch: string; verdict: string; prUrl?: string; ledger: LedgerLine[] }> {
  const root = mkdtempSync(join(tmpdir(), opts.prefix));
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, FIXTURE_PLAN); // declares files: [src/lib/daemon.ts]
  const config: Config = { claudeBin: "/bin/true", root };
  gitFixture(root);

  const branch = `run-T-SCOPE-${opts.ts}`;
  const fakeBinDir = fakeGh(branch, "https://github.com/acme/remudero/pull/99");
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${savedPath}`;
  const savedNow = Date.now;
  Date.now = () => opts.ts;

  let spawnCalls = 0;
  const spawn: typeof spawnWorker = async (args) => {
    spawnCalls++;
    if (spawnCalls === 1) {
      return result({
        sessionId: "s-recon",
        text: "RECON REPORT\nOBSERVED: nothing\nINFERRED: nothing\nCOULDN'T-VERIFY: nothing\n",
      });
    }
    opts.implement(args.cwd);
    // NO PR_URL in the report — this is what makes the run fall through to the orchestrator's
    // own push fallback, the ONE site the guard is wired at.
    return result({ sessionId: "s-implement", text: opts.report ?? "REPORT\nno PR opened yet\n" });
  };

  try {
    const res = await withLiveWritesAllowed(() =>
      runTask("T-SCOPE", {
        skipGitSync: true,
        planPath,
        config,
        github: OFFLINE_GITHUB,
        spawn,
        containmentExec: holdingContainmentExec,
        isolationExec: cleanIsolationExec,
      }),
    );
    return { root, branch, verdict: res.verdict, prUrl: res.prUrl, ledger: readLedger(root) };
  } finally {
    Date.now = savedNow;
    process.env.PATH = savedPath;
  }
}

function commitFile(cwd: string, relPath: string, body: string): void {
  const g = (a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
  mkdirSync(join(cwd, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(cwd, relPath), body);
  g(["add", "."]);
  g(["commit", "--quiet", "-m", `change ${relPath}`]);
}

test("BEHAVIORAL: an OUT-OF-SCOPE diff is PUSHED and ledgered as an overrun naming its paths — the evidence survives", async () => {
  const r = await runFixture({
    ts: 1785000100001,
    prefix: "scope-overrun-flagged-",
    // The reset --soft near-miss shape, minus the forged merge-base machinery (irrelevant to
    // THIS guard, which only ever sees the resulting diff).
    implement: (cwd) => commitFile(cwd, "src/lib/issues-intake.ts", "out-of-scope-edit\n"),
  });
  try {
    const overrun = r.ledger.find((l) => l.step === "scope_guard.overrun");
    assert.ok(overrun, "the overrun is ledgered, named — and its presence proves the run reached the guarded site");
    assert.deepEqual(overrun.out_of_scope, ["src/lib/issues-intake.ts"]);
    assert.deepEqual(overrun.declared_files, ["src/lib/daemon.ts"]);
    // The #981 rule: the line carries the reason from THIS decision, not from a neighbouring gate.
    assert.equal(typeof overrun.reason, "string");
    assert.match(String(overrun.reason), /pushed and flagged rather than refused/);

    // THE POINT OF THE WHOLE CHANGE: the branch reached origin. Under the old refusal it died
    // with the reaped worktree, and every refused run branch that week is gone.
    assert.equal(branchOnOrigin(r.root, r.branch), true, "the branch reached origin — the evidence survives");
    assert.equal(r.prUrl, "https://github.com/acme/remudero/pull/99", "and a PR exists for a human to look at");
    // NOT halting: the run continues to its own terminal verdict (ci answers RED on the first
    // poll), rather than the `failed` the refusal used to return.
    assert.equal(r.verdict, "blocked_ci");
    assert.notEqual(r.verdict, "failed", "an overrun is no longer a verdict");
    assert.equal(
      r.ledger.find((l) => l.step === "scope_guard.refused"),
      undefined,
      "the refusal step is gone from the wire entirely — not merely unreached",
    );
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: an IN-SCOPE diff pushes with NO overrun line at all — the false-positive containment", async () => {
  const r = await runFixture({
    ts: 1785000100002,
    prefix: "scope-overrun-clean-",
    implement: (cwd) => commitFile(cwd, "src/lib/daemon.ts", "in-scope-edit\n"),
  });
  try {
    // A guard that flagged everything would pass the test above and fail this one. This is the
    // direction the change could break, and it is the reason `scopeAdvisorySection` must return
    // undefined on an empty result rather than an empty section.
    assert.equal(
      r.ledger.find((l) => l.step === "scope_guard.overrun"),
      undefined,
      "an in-scope diff never trips the guard",
    );
    assert.equal(
      scopeAdvisorySection([]),
      undefined,
      "and the advisory this run would carry to the PR renders nothing",
    );
    // PRECONDITION, so a run that never reached the push fallback cannot pass by absence: the
    // branch really did go up through the guarded site.
    assert.equal(branchOnOrigin(r.root, r.branch), true, "the branch reached origin");
    assert.equal(r.prUrl, "https://github.com/acme/remudero/pull/99");
    assert.equal(r.verdict, "blocked_ci");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("BEHAVIORAL: an UNREADABLE diff no longer discards the work — it ledgers the real git error and pushes", async () => {
  const r = await runFixture({
    ts: 1785000100003,
    prefix: "scope-overrun-unreadable-",
    // Carries a PR_URL so the silent no-op guard's own commitsAhead("origin/main") — which the
    // sabotage below also breaks, and which fails to 0 — cannot divert the run to `no_pr` before
    // the guarded site. The ancestor test in run-task.test.ts did the same, for the same reason.
    report: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/99\n",
    implement: (cwd) => {
      commitFile(cwd, "src/lib/daemon.ts", "in-scope-edit\n");
      // DELETE THE REMOTE-TRACKING REF, NOT THE REMOTE. `git diff origin/main...HEAD` now fails
      // with "unknown revision" — the one catch branch the other two tests never reach — while
      // `origin` itself stays reachable, so the PUSH that follows can still succeed. Removing the
      // whole remote (the ancestor test's method) would have conflated an unreadable diff with an
      // unreachable origin, and this arm now pushes rather than returning before it.
      execFileSync("git", ["-C", cwd, "update-ref", "-d", "refs/remotes/origin/main"], { encoding: "utf8" });
    },
  });
  try {
    const unreadable = r.ledger.find((l) => l.step === "scope_guard.diff_unreadable");
    assert.ok(unreadable, "the unreadable-diff branch is ledgered, named — and reaching it is the fixture's target");
    assert.equal(typeof unreadable.error, "string");
    assert.ok(String(unreadable.error).length > 0, "the real git error is captured, not swallowed");
    assert.match(String(unreadable.reason), /says nothing about the work/);
    // UNKNOWN IS NOT AN OVERRUN. Nothing was compared, so the line carries no `out_of_scope` key
    // at all — an empty list would read as "compared, found nothing".
    assert.ok(!Object.hasOwn(unreadable, "out_of_scope"), "no out_of_scope key: nothing was compared");
    assert.equal(
      r.ledger.find((l) => l.step === "scope_guard.overrun"),
      undefined,
      "and it is not reported as an overrun it never observed",
    );
    assert.notEqual(r.verdict, "failed", "an unreadable orchestrator-side diff no longer discards completed work");
    // THE WORK SURVIVED: the branch went up despite the guard being unable to read its diff.
    assert.equal(branchOnOrigin(r.root, r.branch), true, "the branch reached origin");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

// ── THE reset --soft PHANTOM REVERT: still detected, and what push-and-flag costs ─────────────

test("the reset --soft phantom revert is STILL NAMED by the real three-dot diff — the detection is not what changed", async () => {
  // A REAL git repro, not a hand-typed file list. #1535 established that `reset --soft
  // origin/main` makes origin/main the PARENT — hence the merge base — so the two dot forms
  // agree here, which is why the three-dot fix never weakened the case the guard was built for.
  // This test re-derives that at the SAME moment the refusal is retired, because "the detection
  // survives" is the whole claim on which retiring it rests.
  const root = mkdtempSync(join(tmpdir(), "scope-overrun-phantom-"));
  const g = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  try {
    const origin = join(root, "origin");
    mkdirSync(origin, { recursive: true });
    g(origin, ["init", "--quiet", "-b", "main"]);
    g(origin, ["config", "user.email", "scope-test@example.invalid"]);
    g(origin, ["config", "user.name", "scope-test"]);
    mkdirSync(join(origin, "src", "lib"), { recursive: true });
    writeFileSync(join(origin, "src", "lib", "issues-intake.ts"), "original\n");
    g(origin, ["add", "."]);
    g(origin, ["commit", "--quiet", "-m", "c1"]);

    const worker = join(root, "worker");
    execFileSync("git", ["clone", "--quiet", origin, worker], { encoding: "utf8" });
    g(worker, ["config", "user.email", "scope-test@example.invalid"]);
    g(worker, ["config", "user.name", "scope-test"]);
    mkdirSync(join(worker, "test"), { recursive: true });
    writeFileSync(join(worker, "test", "foo.ts"), "worker-change\n");
    g(worker, ["add", "."]);
    g(worker, ["commit", "--quiet", "-m", "worker: test/foo.ts"]);

    // origin/main advances — a different, already-merged PR touches the SAME file the stale
    // worker checkout still holds the OLD content for.
    writeFileSync(join(origin, "src", "lib", "issues-intake.ts"), "newer-content-from-a-merged-pr\n");
    g(origin, ["commit", "-a", "--quiet", "-m", "c2"]);

    // The near-miss: `reset --soft` moves HEAD but leaves index/worktree as they were, then
    // collapses that into one commit whose diff SILENTLY REVERTS issues-intake.ts.
    g(worker, ["fetch", "--quiet", "origin"]);
    g(worker, ["reset", "--soft", "origin/main"]);
    g(worker, ["commit", "--quiet", "-m", "refresh: collapsed onto origin/main"]);

    const diffFiles = g(worker, ["diff", "--name-only", "origin/main...HEAD"])
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
    assert.deepEqual(
      diffFiles.sort(),
      ["src/lib/issues-intake.ts", "test/foo.ts"].sort(),
      "the forged refresh's real diff touches BOTH the legit change and the phantom revert",
    );

    const outOfScope = scopeGuardOutOfScopeFiles(diffFiles, ["test/foo.ts"]);
    assert.deepEqual(outOfScope, ["src/lib/issues-intake.ts"], "the push site still names ONLY the reverted file");

    // AND IT NOW REACHES A HUMAN rather than dying with the worktree: the review side computes
    // the SAME comparison per PR (scopeViolationFiles), and this renders it into the comment.
    const section = scopeAdvisorySection([scopeAdvisory(outOfScope)]);
    assert.ok(section);
    assert.match(section, /src\/lib\/issues-intake\.ts/, "the phantom-reverted file is named at the gate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("WHAT IS LOST, pinned rather than argued: an UNDECLARED scope still ledgers an overrun but earns NO PR advisory", () => {
  // The one asymmetry between the two comparisons, and the honest cost of adopting the review
  // side's posture at the push site. `scopeGuardOutOfScopeFiles` treats an absent/empty declared
  // scope as "everything is out of scope" and used to refuse on it; the review-side
  // `scopeViolationFiles` deliberately does the OPPOSITE and never fires on an empty scope (its
  // own doc says a task declaring nothing is not treated as declaring everything).
  //
  // So for a task with no `files:` the change is not block → flag, it is block → LEDGER-ONLY.
  // The push site still records it (the detector is untouched); the PR comment stays silent.
  const diff = ["src/lib/a.ts", "src/lib/b.ts"];
  assert.deepEqual(scopeGuardOutOfScopeFiles(diff, undefined), diff, "the push site still sees it");
  assert.deepEqual(scopeGuardOutOfScopeFiles(diff, []), diff);
  // …and the advisory the review would build for that same PR is empty, so nothing renders.
  assert.equal(scopeAdvisorySection([]), undefined, "the PR comment says nothing — this is the gap, named");
});
