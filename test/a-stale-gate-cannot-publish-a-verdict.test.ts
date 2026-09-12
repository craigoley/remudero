import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import type { Mount } from "../src/lib/mounts.js";
import type { CriterionVerdict } from "../src/lib/review.js";
import { readLedgerLines } from "../src/lib/status.js";
import type { GitHub } from "../src/lib/status.js";
import { postReviewStatusGuarded, type PrLifecycleState } from "../src/lib/review.js";
import { checkReviewerCodeFreshness, SELF_SYNC_GUARD_ENV } from "../src/lib/self-sync.js";
import { reviewCommand, runFixRung, runReview, runTask, type ReviewRunResult } from "../src/run-task.js";
import type { WorkerResult, spawnWorker } from "../src/lib/worker.js";
import { gitRepo } from "./helpers/git-repo.js";
import { ghShim } from "./helpers/gh-shim.js";

// @source-text-subject — this test's subject is the complete production terminal-review call-site
// set. A behavioral seam can prove one path, but not that all three paths install the same guard.
const OLD = "a".repeat(40);
const MAIN = "b".repeat(40);
const OPEN: PrLifecycleState = { merged: false, closed: false };
const REPO_ROOT = process.cwd();
const REVIEWER_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function criterion(over: Partial<CriterionVerdict> & Pick<CriterionVerdict, "claim" | "met">): CriterionVerdict {
  return { proof: "proof", reason: "", proof_exec: "not_executable", ...over };
}

function reviewResult(over: Partial<ReviewRunResult> = {}): ReviewRunResult {
  return {
    state: "failure",
    criteria: [criterion({ claim: "the fixture must fail", met: false, reason: "fixture" })],
    testTheater: false,
    summary: "fixture failure",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha: "c".repeat(40),
    reviewerOutcome: "success",
    ...over,
  };
}

function workerResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "fixture-session",
    costUsd: 0,
    numTurns: 1,
    text: "REPORT\n",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "sonnet",
    effort: "medium",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function materialStale() {
  return checkReviewerCodeFreshness("/unused", {}, {
    checkServiceFreshness: () => ({
      status: "assessed",
      dirty: true,
      behind: { oldSha: OLD, newSha: MAIN, changedPaths: ["src/lib/review.ts"] },
    }),
  });
}

function immaterialAdvance() {
  return checkReviewerCodeFreshness("/unused", {}, {
    checkServiceFreshness: () => ({
      status: "assessed",
      dirty: true,
      behind: { oldSha: OLD, newSha: MAIN, changedPaths: ["docs/review-gate.md"] },
    }),
  });
}

test("W1-T3337: the CLI self-reexec guard never suppresses the reviewer code probe", () => {
  const calls: string[] = [];
  const result = checkReviewerCodeFreshness("/unused", { [SELF_SYNC_GUARD_ENV]: "1" }, {
    checkServiceFreshness: () => ({ status: "guarded" }),
    git: (args) => {
      calls.push(args.join(" "));
      if (args[0] === "fetch") return "";
      if (args.join(" ") === "rev-parse HEAD") return OLD;
      if (args.join(" ") === "rev-parse origin/main") return MAIN;
      if (args[0] === "diff") return "src/lib/review.ts\n";
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  });
  assert.equal(result.status, "stale");
  assert.deepEqual(calls, ["fetch --quiet origin", "rev-parse HEAD", "rev-parse origin/main", `diff --name-only ${OLD}..${MAIN}`]);
});

test("W1-T3337: an unreadable guarded diff withholds the terminal verdict", () => {
  const result = checkReviewerCodeFreshness("/unused", { [SELF_SYNC_GUARD_ENV]: "1" }, {
    checkServiceFreshness: () => ({ status: "guarded" }),
    git: (args) => {
      if (args[0] === "fetch") return "";
      if (args.join(" ") === "rev-parse HEAD") return OLD;
      if (args.join(" ") === "rev-parse origin/main") return MAIN;
      throw new Error("diff unavailable");
    },
  });
  assert.equal(result.status, "unreadable");
  assert.match(result.reason, /could not inspect reviewer code advance: Error: diff unavailable/);
});

test("W1-T3337: every unreadable Git observation and a no-advance head have distinct freshness outcomes", () => {
  const guarded = { [SELF_SYNC_GUARD_ENV]: "1" };
  const fetchFailure = checkReviewerCodeFreshness("/unused", guarded, {
    checkServiceFreshness: () => ({ status: "guarded" }),
    git: () => {
      throw new Error("origin unavailable");
    },
  });
  assert.deepEqual(fetchFailure, {
    status: "unreadable",
    reason: "git fetch origin failed in /unused: Error: origin unavailable",
  });

  const refFailure = checkReviewerCodeFreshness("/unused", guarded, {
    checkServiceFreshness: () => ({ status: "guarded" }),
    git: (args) => {
      if (args[0] === "fetch") return "";
      throw new Error("ref unavailable");
    },
  });
  assert.deepEqual(refFailure, {
    status: "unreadable",
    reason: "could not resolve HEAD/origin/main in /unused: Error: ref unavailable",
  });

  const noAdvance = checkReviewerCodeFreshness("/unused", {}, {
    checkServiceFreshness: () => ({ status: "assessed", dirty: false, behind: null }),
    resolveHeadSha: () => OLD,
  });
  assert.deepEqual(noAdvance, { status: "fresh", codeSha: OLD, originMainSha: OLD, advance: "none" });

  const headFailure = checkReviewerCodeFreshness("/unused", {}, {
    checkServiceFreshness: () => ({ status: "assessed", dirty: false, behind: null }),
    resolveHeadSha: () => {
      throw new Error("head unavailable");
    },
  });
  assert.deepEqual(headFailure, {
    status: "unreadable",
    reason: "could not resolve the reviewer code sha: Error: head unavailable",
  });
});

function postOpts(ledgerPath: string, reviewerCodeFreshness: ReturnType<typeof materialStale>) {
  return {
    owner: "acme",
    repo: "remudero",
    sha: "c".repeat(40),
    state: "failure" as const,
    description: "remudero-review: FAIL — this deliberately long verdict describes a failure while preserving its producer provenance",
    taskId: "W1-T3337",
    evidence: "executed" as const,
    ledgerPath,
    runId: "W1-T3337-test",
    prUrl: "https://github.com/acme/remudero/pull/3337",
    fetchLifecycle: () => OPEN,
    reviewerCodeFreshness,
  };
}

test("W1-T3337: a material source advance withholds the stale reviewer's failure instead of publishing a binding verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-review-"));
  try {
    const stale = materialStale();
    assert.deepEqual(stale, {
      status: "stale",
      codeSha: OLD,
      originMainSha: MAIN,
      changedPaths: ["src/lib/review.ts"],
      diffUnreadable: undefined,
    });
    let postCalls = 0;
    const result = await postReviewStatusGuarded({
      ...postOpts(join(root, "ledger.ndjson"), stale),
      post: () => {
        postCalls++;
      },
    });
    assert.equal(result.posted, false);
    assert.match(result.reason ?? "", /materially behind origin\/main/);
    assert.equal(postCalls, 0, "a stale review process must not POST a failure status");
    const refusal = readLedgerLines(join(root, "ledger.ndjson")).find((line) => line.step === "review.post_refused");
    assert.deepEqual(
      { state: refusal?.attempted_state, code: refusal?.reviewer_code_sha, main: refusal?.origin_main_sha },
      { state: "failure", code: OLD, main: MAIN },
      "the withheld verdict remains attributable to the exact stale evaluator and main advance",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3337: an immaterial advance still publishes and makes the reviewer's loaded code SHA visible on the verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-review-"));
  try {
    const fresh = immaterialAdvance();
    assert.deepEqual(fresh, { status: "fresh", codeSha: OLD, originMainSha: MAIN, advance: "immaterial" });
    const posted: Array<{ state: string; description?: string }> = [];
    const result = await postReviewStatusGuarded({
      ...postOpts(join(root, "ledger.ndjson"), fresh),
      post: ({ state, description }) => {
        posted.push({ state, description });
      },
    });
    assert.equal(result.posted, true);
    assert.deepEqual(posted.map((entry) => entry.state), ["failure"]);
    assert.match(posted[0]?.description ?? "", new RegExp(`\\[review code ${OLD.slice(0, 12)}\\]$`));
    assert.ok((posted[0]?.description?.length ?? Infinity) <= 140, "the provenance must survive GitHub's status-description cap");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3337: a throwing just-in-time reader is converted to an unreadable refusal before the review status can post", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-review-run-"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const gh = ghShim(
    [
      { when: "api repos/", stdout: JSON.stringify({ number: 1, html_url: "https://github.com/acme/remudero/pull/1", updated_at: "t", body: "", head: { ref: "fixture", sha: head }, state: "open" }) },
      { when: "pr diff", stdout: "diff --git a/README.md b/README.md" },
      { when: "pr view", stdout: JSON.stringify({ state: "OPEN" }) },
    ],
    { kind: "stale-review-run" },
  );
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${gh.dir}:${priorPath}`;
    const steps: string[] = [];
    const verdict = await runReview({
      owner: "acme",
      repo: "remudero",
      prUrl: "https://github.com/acme/remudero/pull/1",
      task: { id: "W1-T3337", acceptance: [{ claim: "the deterministic fixture reaches the terminal post", proof: "manual fixture" }] },
      report: "The deterministic fixture reaches the terminal post.",
      settingsFile: "",
      config: { root, claudeBin: "/bin/true" } as Config,
      log: (step) => steps.push(step),
      say: () => {},
      account: (result) => result,
      headCheckoutDir: REPO_ROOT,
      reviewerCodeFreshness: () => {
        throw new Error("freshness reader unavailable");
      },
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "W1-T3337-reader-throw",
      arm: () => "no-task-id",
      disarm: () => "not-armed",
    });
    assert.match(verdict.codeFreshnessWithheld ?? "", /could not assess reviewer code freshness: Error: freshness reader unavailable/);
    assert.ok(
      readLedgerLines(join(root, "ledger.ndjson")).some((line) => line.step === "review.post_refused"),
      "the refusal must be durable and precede every binding status post",
    );
    assert.ok(!steps.includes("review.posted"), "an unreadable reviewer must not publish a terminal status");
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});

test("W1-T3337: a withheld re-review stands the fix rung down without another worker strike", async () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const withheld = reviewResult({ codeFreshnessWithheld: "reviewer code is materially behind origin/main" });
  const worktree = gitRepo({ kind: "stale-review-fix-rung" });
  try {
    const result = await runFixRung({
      taskId: "W1-T3337",
      runId: "W1-T3337-fix-rung",
      task: { id: "W1-T3337", title: "withhold stale review verdicts" },
      prUrl: "https://github.com/acme/remudero/pull/3337",
      branch: "run-W1-T3337-fixture",
      worktreePath: worktree.dir,
      initialSessionId: "initial-session",
      mount: REVIEWER_MOUNT,
      settingsFile: "/tmp/rmd-stale-review-settings.json",
      config: {} as Config,
      budgetUsd: 10,
      strikeCap: 2,
      initialReview: reviewResult(),
      reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: worktree.dir, reviewerMount: REVIEWER_MOUNT },
      reviewerCodeFreshness: () => ({ status: "stale", codeSha: OLD, originMainSha: MAIN, changedPaths: ["src/lib/review.ts"] }),
      deps: {
        spawn: async () => workerResult({ sessionId: "fix-session" }),
        waitForCiGreen: async () => "green",
        runReview: async () => withheld,
        push: () => {},
        issues: { create: () => "", listOpen: () => [], comment: () => {} },
        ledgerPath: join(mkdtempSync(join(tmpdir(), "rmd-stale-review-fix-ledger-")), "ledger.ndjson"),
        log: (step, extra) => logs.push({ step, extra }),
        say: () => {},
        account: (worker) => worker,
        spawnWallClockBoundMs: 5_000,
      },
    });
    assert.equal(result.outcome, "stood_down");
    assert.equal(result.reason, withheld.codeFreshnessWithheld);
    assert.deepEqual(
      logs.filter((entry) => entry.step === "fix.stood_down").map((entry) => entry.extra?.site),
      ["rung.reviewer_code_freshness"],
    );
  } finally {
    worktree.cleanup();
  }
});

test("W1-T3337: rmd review exits non-zero and names a withheld terminal verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-review-command-"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => printed.push(String(message));
  try {
    const code = await reviewCommand("3337", ["--repo", "acme/remudero"], {
      fetchView: () => ({
        number: 3337,
        html_url: "https://github.com/acme/remudero/pull/3337",
        head: { ref: "fixture", sha: head },
        updated_at: new Date(0).toISOString(),
        body: "## Acceptance\n- the reviewer refuses stale code | manual fixture",
      }),
      loadConfig: () => ({ root, claudeBin: "/bin/true" }) as Config,
      fetchHead: () => {},
      materialize: () => ({ worktreePath: undefined, failure: { errorClass: "other", message: "not needed" } }),
      postReviewPending: async () => ({ posted: false }),
      runReview: async () => reviewResult({ codeFreshnessWithheld: "reviewer code is materially behind origin/main" }),
    });
    assert.equal(code, 2);
    assert.ok(printed.some((line) => /remudero-review=failure WITHHELD/.test(line) && /materially behind origin\/main/.test(line)));
  } finally {
    console.log = originalLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3337: the implementation run records a blocked verdict when its injected terminal review was withheld", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "rmd-stale-review-run-task-"));
  const origin = gitRepo({ bare: true, kind: "stale-review-run-origin" });
  const seed = gitRepo({ cloneFrom: origin.dir, kind: "stale-review-run-seed" });
  const planPath = join(root, "tasks.yaml");
  const repoDir = join(root, "repos", "remudero");
  const fixedNow = 1_785_000_000_000;
  const branch = `run-W1-T3337-${fixedNow}`;
  const gh = ghShim(
    [
      { when: "--json headRefName", stdout: JSON.stringify({ headRefName: branch }) },
      { when: "--json body", stdout: JSON.stringify({ body: "" }) },
      { when: "api repos/acme/remudero/pulls/", stdout: JSON.stringify({ number: 3337, state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } }) },
      { when: "/check-runs", stdout: JSON.stringify({ check_runs: [{ name: "ci", status: "completed", conclusion: "success" }] }) },
      { when: "/status", stdout: JSON.stringify({ statuses: [] }) },
    ],
    { kind: "stale-review-run-task" },
  );
  const priorPath = process.env.PATH;
  const dateNowSpy = t.mock.method(Date, "now", () => fixedNow);
  try {
    writeFileSync(join(seed.dir, "README.md"), "seed\n");
    seed.git("add", ".");
    seed.git("commit", "-m", "seed");
    seed.git("push", "origin", "main");
    mkdirSync(join(root, "repos"), { recursive: true });
    execFileSync("git", ["clone", "--quiet", origin.dir, repoDir]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "stale-review@example.invalid"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "stale review fixture"]);
    writeFileSync(
      planPath,
      [
        "- id: W1-T3337",
        "  title: withhold stale terminal reviews",
        "  repo: remudero",
        "  type: implement",
        "  verify: auto",
        "  risk: high",
        "  files: [src/lib/review.ts]",
        "  origin: fixture",
        "  status: queued",
        "",
      ].join("\n"),
    );
    process.env.PATH = `${gh.dir}:${priorPath}`;

    const github: GitHub = {
      prByRef: () => null,
      findMergedByTrailer: () => null,
      headRefName: () => branch,
      prBody: () => undefined,
    };
    let spawnCount = 0;
    const spawn: typeof spawnWorker = async () => {
      spawnCount++;
      return spawnCount === 1
        ? workerResult({ sessionId: "recon", text: "RECON REPORT\nOBSERVED: fixture\nINFERRED: none\nCOULDN'T-VERIFY: none\n" })
        : workerResult({ sessionId: "implement", text: "REPORT\nPR_URL: https://github.com/acme/remudero/pull/3337\n" });
    };
    const result = await withLiveWritesAllowed(() =>
      runTask("W1-T3337", {
        skipGitSync: true,
        planPath,
        config: { root, claudeBin: "/bin/true" } as Config,
        github,
        spawn,
        containmentExec: (token) =>
          Promise.resolve({ transcript: `touch ../${token}: Operation not permitted`, outsideWriteCreated: false, insideWriteCreated: true, costUsd: 0 }),
        isolationExec: () =>
          Promise.resolve({ transcript: "REPORT\naliases: 0\nfunctions: 0\nalias_names: -\nfunction_names: -", aliasCount: 0, functionCount: 0, functionNames: "-", costUsd: 0 }),
        runReview: async () => reviewResult({ codeFreshnessWithheld: "reviewer code is materially behind origin/main" }),
      }),
    );
    assert.equal(result.verdict, "blocked");
    assert.equal(spawnCount, 2, "the withheld review must stop before any fix-worker dispatch");
    const verdict = readLedgerLines(join(root, "state", "ledger.ndjson")).find(
      (line) => line.step === "verdict" && line.verdict === "blocked",
    );
    assert.equal(verdict?.reason, "reviewer code is materially behind origin/main");
  } finally {
    dateNowSpy.mock.restore();
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    origin.cleanup();
    seed.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(gh.dir, { recursive: true, force: true });
  }
});

test("W1-T3337 wiring: every production terminal-review path supplies a just-in-time code-freshness reader", () => {
  const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  const readers = source.match(/reviewerCodeFreshness: \(\) => checkReviewerCodeFreshness\(repoRoot, process\.env\)/g) ?? [];
  assert.equal(readers.length, 3, "run-task, its fix-rung re-reviews, and rmd review must all use the same freshness reader");
  assert.match(source, /if \(review\.codeFreshnessWithheld\)/, "a withheld result must stand down before the primary fix rung");
  assert.match(source, /site: "rung\.reviewer_code_freshness"/, "a re-review inside the fix rung must also stand down");
});
