import assert from "node:assert/strict";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAIN_RUN_GAP_STEP,
  dispatchMainRunGaps,
  findMainCommitsWithNoRuns,
  firstParentChain,
  mainRunGapHistoryFromLedger,
  parseWorkflowPushTrigger,
  readWorkflowPushTriggers,
  workflowsForPaths,
  type MainCommitRef,
  type MainRunGapDispatch,
} from "../src/lib/main-run-gaps.js";
import { DEFAULT_SWEEP_POLICY, buildSweepEffects, runSweep } from "../src/lib/sweep.js";

// ── W1-T4817: a main commit NO workflow ran on ─────────────────────────────────────────────
//
// OBSERVED 2026-09-29: main commits 30f3c7b58 and 9b694d664 had zero workflow runs of any kind —
// each merged seconds before another fleet auto-merge and GitHub fired no push event for it. The
// shape below reproduces it: the head and the commit two back have runs, the one between them has
// none. A finder that let the successor's runs cover its predecessor reads this history as clean.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const linear = (...shas: string[]): MainCommitRef[] =>
  shas.map((sha, i) => ({ sha, parents: i + 1 < shas.length ? [shas[i + 1]!] : [] }));

const readerOf = (commits: MainCommitRef[], runs: Record<string, number | undefined>, asked: string[] = []) => ({
  listMainCommits: async () => commits,
  countRunsForSha: async (sha: string) => {
    asked.push(sha);
    return runs[sha];
  },
});

test("W1-T4817: a main commit with zero workflow runs is found", async () => {
  // 30f3c7b58's shape: newer and older commits ran, the one between did not.
  const gaps = await findMainCommitsWithNoRuns(
    readerOf(linear("head", "30f3c7b58", "older"), { head: 2, "30f3c7b58": 0, older: 3 }),
  );
  assert.deepEqual(gaps, ["30f3c7b58"]);

  // Two such commits, neither covered by a successor's runs.
  assert.deepEqual(
    await findMainCommitsWithNoRuns(
      readerOf(linear("h", "9b694d664", "mid", "30f3c7b58", "old"), { h: 1, "9b694d664": 0, mid: 4, "30f3c7b58": 0, old: 2 }),
    ),
    ["9b694d664", "30f3c7b58"],
  );

  // The head is never judged, and a zero with no newer run proves nothing: the events may still
  // be in flight. Neither is a gap.
  assert.deepEqual(await findMainCommitsWithNoRuns(readerOf(linear("head", "mid", "old"), { head: 0, mid: 0, old: 5 })), []);

  // A commit whose count could not be read is neither a gap nor the evidence that convicts one.
  assert.deepEqual(
    await findMainCommitsWithNoRuns(readerOf(linear("head", "mid", "old"), { head: undefined, mid: 0, old: 5 })),
    [],
  );

  // A commit already handled costs no read and is not reported again.
  const asked: string[] = [];
  assert.deepEqual(
    await findMainCommitsWithNoRuns(readerOf(linear("head", "30f3c7b58", "older"), { head: 2, "30f3c7b58": 0, older: 3 }, asked), {
      skip: new Set(["30f3c7b58"]),
    }),
    [],
  );
  assert.ok(!asked.includes("30f3c7b58"), "a skipped commit is never read");
});

test("W1-T4817: only first-parent commits are judged, never a merged side branch", () => {
  const commits: MainCommitRef[] = [
    { sha: "merge", parents: ["main1", "side1"] },
    { sha: "side1", parents: ["main1"] },
    { sha: "main1", parents: ["root"] },
    { sha: "root", parents: [] },
  ];
  assert.deepEqual(firstParentChain(commits), ["merge", "main1", "root"]);
});

test("W1-T4817: the gap dispatches its workflows once, at main head", async () => {
  // The REAL workflow files, so the assertion is what the repo actually declares.
  const triggers = readWorkflowPushTriggers(REPO_ROOT);
  const byFile = new Map(triggers.map((t) => [t.file, t]));
  assert.equal(byFile.get("ci.yml")?.dispatchable, true, "ci.yml must be dispatchable to be re-run at all");
  assert.equal(byFile.get("main-tripwire.yml")?.dispatchable, true, "main-tripwire.yml must be dispatchable");
  assert.equal(byFile.get("ci-gate.yml")?.push, undefined, "ci-gate.yml must never gain a push trigger");

  const commits = linear("head-sha", "gap-sha", "older-sha");
  const runs = { "head-sha": 3, "gap-sha": 0, "older-sha": 2 };
  const calls: Array<{ file: string; ref: string }> = [];
  let ledger: Array<Record<string, unknown>> = [];

  const pass = async (changed: string[]) => {
    const history = mainRunGapHistoryFromLedger(ledger);
    const gaps = await findMainCommitsWithNoRuns(readerOf(commits, runs), { skip: history.complete });
    const done = await dispatchMainRunGaps({
      gaps,
      head: "head-sha",
      history,
      triggers,
      changedFiles: async () => changed,
      dispatch: (file, ref) => {
        calls.push({ file, ref });
      },
    });
    ledger = [
      ...ledger,
      ...done.map((d) => ({ step: MAIN_RUN_GAP_STEP, commit: d.commit, workflows: d.workflows, failed: d.failed })),
    ];
    return done;
  };

  // A source-only commit: the path-less push workflows, not the image build.
  const first = await pass(["src/lib/x.ts"]);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.commit, "gap-sha");
  assert.equal(first[0]!.head, "head-sha");
  const dispatched = calls.map((c) => c.file).sort();
  assert.ok(dispatched.includes("ci.yml") && dispatched.includes("main-tripwire.yml"), `got ${dispatched.join(",")}`);
  assert.ok(!dispatched.includes("acr-build.yml"), "acr-build's path filter does not match src/");
  assert.ok(calls.every((c) => c.ref === "main"), "every dispatch is at main's head ref");
  assert.equal(new Set(dispatched).size, dispatched.length, "one dispatch per workflow");

  // The next pass sees the same gap (its own runs never appear) and dispatches NOTHING.
  const before = calls.length;
  assert.deepEqual(await pass(["src/lib/x.ts"]), []);
  assert.equal(calls.length, before, "never dispatched twice for one commit");

  // A commit touching a baked path calls for the image build as well.
  const image = await dispatchMainRunGaps({
    gaps: ["deploy-sha"],
    head: "head-sha",
    history: mainRunGapHistoryFromLedger([]),
    triggers,
    changedFiles: async () => ["deploy/Dockerfile"],
    dispatch: () => {},
  });
  assert.ok(image[0]!.workflows.includes("acr-build.yml"));
});

test("W1-T4817: a refused dispatch is retried alone, and never re-sent once it lands", async () => {
  const triggers = [
    parseWorkflowPushTrigger("a.yml", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"),
    parseWorkflowPushTrigger("b.yml", "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"),
  ];
  const sent: string[] = [];
  let refuseB = true;
  const run = (history: ReturnType<typeof mainRunGapHistoryFromLedger>) =>
    dispatchMainRunGaps({
      gaps: ["gap"],
      head: "h",
      history,
      triggers,
      changedFiles: async () => ["x"],
      dispatch: (file) => {
        if (file === "b.yml" && refuseB) throw new Error("HTTP 422");
        sent.push(file);
      },
    });

  const first = await run(mainRunGapHistoryFromLedger([]));
  assert.deepEqual(first[0]!.workflows, ["a.yml"]);
  assert.deepEqual(first[0]!.failed, ["b.yml"]);
  assert.match(first[0]!.errors["b.yml"]!, /422/);

  const row = (d: MainRunGapDispatch) => ({ step: MAIN_RUN_GAP_STEP, ...d });
  const history = mainRunGapHistoryFromLedger([row(first[0]!)]);
  assert.equal(history.complete.has("gap"), false, "a row with a failure is not complete");

  refuseB = false;
  const second = await run(history);
  assert.deepEqual(second[0]!.workflows, ["b.yml"]);
  assert.deepEqual(sent, ["a.yml", "b.yml"], "a.yml was sent once, not again on the retry");
  assert.equal(mainRunGapHistoryFromLedger([row(first[0]!), row(second[0]!)]).complete.has("gap"), true);
});

test("W1-T4817: path filters decide which workflows a commit calls for", () => {
  const acr = parseWorkflowPushTrigger(
    "acr-build.yml",
    "on:\n  push:\n    branches: [main]\n    paths:\n      - deploy/Dockerfile\n      - deploy/**/*.json\n  workflow_dispatch:\n",
  );
  const ignoring = parseWorkflowPushTrigger(
    "docs.yml",
    "on:\n  push:\n    branches: [main]\n    paths-ignore:\n      - 'docs/**'\n  workflow_dispatch:\n",
  );
  const noDispatch = parseWorkflowPushTrigger("nd.yml", "on:\n  push:\n    branches: [main]\n");
  const otherBranch = parseWorkflowPushTrigger("rel.yml", "on:\n  push:\n    branches: [release]\n  workflow_dispatch:\n");
  const pr = parseWorkflowPushTrigger("pr.yml", "on:\n  pull_request:\n  workflow_dispatch:\n");
  const all = [acr, ignoring, noDispatch, otherBranch, pr];

  assert.deepEqual(workflowsForPaths(all, ["src/a.ts"]), ["docs.yml"]);
  assert.deepEqual(workflowsForPaths(all, ["deploy/Dockerfile"]), ["acr-build.yml", "docs.yml"]);
  assert.deepEqual(workflowsForPaths(all, ["deploy/x/y.json"]), ["acr-build.yml", "docs.yml"]);
  assert.deepEqual(workflowsForPaths(all, ["docs/a.md"]), [], "an all-ignored commit calls for nothing");
  assert.deepEqual(workflowsForPaths(all, ["docs/a.md", "src/a.ts"]), ["docs.yml"]);
});

test("W1-T4817: runSweep hands the effect the ledger's history and records what it dispatched", async () => {
  const ledger: Array<Record<string, unknown>> = [];
  const seenComplete: string[][] = [];
  const effect = async (history: ReturnType<typeof mainRunGapHistoryFromLedger>): Promise<MainRunGapDispatch[]> => {
    seenComplete.push([...history.complete]);
    if (history.complete.has("gap")) return [];
    return [{ commit: "gap", head: "head", ref: "main", workflows: ["ci.yml"], failed: [], errors: {} }];
  };
  const pass = (surface?: "light" | "full") =>
    runSweep(
      [],
      {
        arm: () => {},
        close: () => {},
        dispatchFix: () => {},
        escalate: () => {},
        ledgerPath: "/dev/null/ledger.ndjson",
        runId: "t4817",
        readLedger: () => [...ledger],
        appendLine: (_p, line) => {
          ledger.push(line);
        },
        now: () => 1_000,
        log: () => {},
        reconcileMainRunGaps: effect,
        repairAdmissionSurface: surface,
      },
      DEFAULT_SWEEP_POLICY,
    );

  await pass("light");
  assert.equal(seenComplete.length, 0, "a light pass fans out per PR and never reads main");

  await pass();
  const rows = ledger.filter((l) => l.step === MAIN_RUN_GAP_STEP);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.commit, "gap");
  assert.deepEqual(rows[0]!.workflows, ["ci.yml"]);
  assert.equal(rows[0]!.head, "head");

  await pass();
  assert.deepEqual(seenComplete[1], ["gap"], "the second pass is handed the first pass's row");
  assert.equal(ledger.filter((l) => l.step === MAIN_RUN_GAP_STEP).length, 1, "nothing recorded twice");
});

// ── the real effect, driven through buildSweepEffects with fake gh seams ─────────────────────

interface EffectWorld {
  list?: unknown;
  listThrows?: boolean;
  runs?: Record<string, unknown>;
  runsThrow?: boolean;
  files?: unknown;
  filesThrow?: boolean;
  repoRoot?: string;
}

async function driveMainRunGapEffect(world: EffectWorld) {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const posts: string[][] = [];
  const reads: string[] = [];
  const effects = buildSweepEffects({
    owner: "acme",
    repo: "widgets",
    config: { root: REPO_ROOT } as never,
    repoRoot: world.repoRoot ?? REPO_ROOT,
    ledgerPath: "/dev/null/ledger.ndjson",
    runId: "t4817-effect",
    plan: { tasks: [], byId: new Map() } as never,
    log: (step, extra) => void logs.push({ step, extra }),
    policy: DEFAULT_SWEEP_POLICY,
    readJsonImpl: async (args) => {
      const path = String(args[1]);
      reads.push(path);
      if (path.includes("/actions/runs?")) {
        if (world.runsThrow) throw new Error("runs 500");
        const sha = path.split("head_sha=")[1]!.split("&")[0]!;
        const count = world.runs?.[sha];
        return count === "absent" ? {} : { total_count: count };
      }
      if (path.includes("/commits?sha=main")) {
        if (world.listThrows) throw new Error("list 500");
        return world.list;
      }
      if (world.filesThrow) throw new Error("files 500");
      return world.files;
    },
    ghRunImpl: (_file, args) => {
      posts.push([...args]);
    },
  });
  const done = await effects.reconcileMainRunGaps!(mainRunGapHistoryFromLedger([]));
  return { done, logs, posts, reads };
}

const LINEAR_LIST = [
  { sha: "head", parents: [{ sha: "gap" }] },
  { sha: "gap", parents: [{ sha: "older" }] },
  { sha: "older", parents: [] },
  { parents: [] },
];

test("W1-T4817: the sweep effect finds the gap through the REST reads and dispatches at main", async () => {
  const { done, posts, reads } = await driveMainRunGapEffect({
    list: LINEAR_LIST,
    runs: { head: 2, gap: 0, older: 1 },
    files: { files: [{ filename: "src/lib/x.ts" }, {}] },
  });
  assert.equal(done.length, 1);
  assert.equal(done[0]!.commit, "gap");
  assert.equal(done[0]!.head, "head");
  assert.ok(done[0]!.workflows.includes("ci.yml"));
  assert.ok(reads.some((r) => r.includes("/commits/gap")), "the gap's changed files were read");
  assert.ok(posts.length >= 2 && posts.every((p) => p.includes("ref=main") && p.includes("POST")));
  assert.ok(posts.some((p) => p.some((a) => a.endsWith("/workflows/ci.yml/dispatches"))));
});

test("W1-T4817: a listing that is not an array, or has no commits, finds no gap", async () => {
  assert.deepEqual((await driveMainRunGapEffect({ list: { message: "nope" } })).done, []);
  assert.deepEqual((await driveMainRunGapEffect({ list: [] })).done, []);
});

test("W1-T4817: a failed commit listing degrades to no gap and is logged", async () => {
  const { done, logs, posts } = await driveMainRunGapEffect({ listThrows: true });
  assert.deepEqual(done, []);
  assert.equal(posts.length, 0);
  assert.equal(logs.find((l) => l.step === "sweep.main_run_gap.error")?.extra?.phase, "list_commits");
});

test("W1-T4817: an unreadable run count is never a gap, and is logged", async () => {
  const thrown = await driveMainRunGapEffect({ list: LINEAR_LIST, runsThrow: true });
  assert.deepEqual(thrown.done, []);
  assert.ok(thrown.logs.some((l) => l.extra?.phase === "count_runs"));
  const malformed = await driveMainRunGapEffect({ list: LINEAR_LIST, runs: { head: "absent", gap: "absent", older: "absent" } });
  assert.deepEqual(malformed.done, []);
  assert.equal(malformed.posts.length, 0);
});

test("W1-T4817: unreadable changed files leave the gap for a later pass, and are logged", async () => {
  const runs = { head: 2, gap: 0, older: 1 };
  const thrown = await driveMainRunGapEffect({ list: LINEAR_LIST, runs, filesThrow: true });
  assert.deepEqual(thrown.done, []);
  assert.equal(thrown.posts.length, 0);
  assert.ok(thrown.logs.some((l) => l.extra?.phase === "changed_files" && l.extra?.commit === "gap"));
  // A body with no `files` is a readable commit that touched nothing this repo's filters match.
  const empty = await driveMainRunGapEffect({ list: LINEAR_LIST, runs, files: {} });
  assert.equal(empty.done.length, 1);
  assert.deepEqual(empty.done[0]!.workflows.includes("acr-build.yml"), false);
});

test("W1-T4817: unreadable workflow files degrade to no dispatch and are logged", async () => {
  const { done, logs } = await driveMainRunGapEffect({
    list: LINEAR_LIST,
    runs: { head: 2, gap: 0, older: 1 },
    repoRoot: join(REPO_ROOT, "no-such-checkout"),
  });
  assert.deepEqual(done, []);
  assert.ok(logs.some((l) => l.extra?.phase === "read_workflows"));
});

test("W1-T4817: list-form and string-form `on:` triggers are read", () => {
  const listed = parseWorkflowPushTrigger("l.yml", "on: [push, workflow_dispatch]\njobs: {}\n");
  assert.equal(listed.dispatchable, true);
  assert.deepEqual(listed.push, {});
  const noPush = parseWorkflowPushTrigger("m.yml", "on: [pull_request]\njobs: {}\n");
  assert.equal(noPush.dispatchable, false);
  assert.equal(noPush.push, undefined);
  assert.deepEqual(workflowsForPaths([listed, noPush], ["x"]), ["l.yml"]);
  const single = parseWorkflowPushTrigger("s.yml", "on: push\njobs: {}\n");
  assert.equal(single.dispatchable, false);
  assert.deepEqual(single.push, {});
});

test("W1-T4817: a throwing effect never fails the pass", async () => {
  const logged: string[] = [];
  const summary = await runSweep(
    [],
    {
      arm: () => {},
      close: () => {},
      dispatchFix: () => {},
      escalate: () => {},
      ledgerPath: "/dev/null/ledger.ndjson",
      runId: "t4817",
      readLedger: () => [],
      appendLine: () => {},
      now: () => 1_000,
      log: (event) => {
        logged.push(String(event));
      },
      reconcileMainRunGaps: async () => {
        throw new Error("boom");
      },
    },
    DEFAULT_SWEEP_POLICY,
  );
  assert.ok(summary);
  assert.ok(logged.includes("sweep.main_run_gap.error"));
});
