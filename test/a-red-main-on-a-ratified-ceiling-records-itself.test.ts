/**
 * A RED MAIN ON A RATIFIED CEILING RECORDS ITSELF.
 *
 * 2026-10-10: #10695 and #10697 each passed comment-load-ratchet against their own base, and together
 * took src/lib/daemon.ts to 1760 comment lines over a recorded 1750. Main's push lane went red on
 * `main-ceiling-drift: comment-load-signal BLOCKED on main itself` with every test passing, and every
 * open PR was held as base-red behind it. The repair lane read only the `ci` aggregator's log ("a test
 * shard FAILED"), dispatched three fix workers at three wrong offending merges, and none opened a PR;
 * a human opened #10712 to record the ceiling. These fixtures replay that red: the failing shard's own
 * log decides it is ratchet-only, the fenced writer records it in ONE PR, and an open PR that already
 * records it (the #10712 shape) makes the lane stand down.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import type { AsyncIssueGateway } from "../src/lib/escalate.js";
import {
  buildMainHealthRung,
  classifyMainRatchetRed,
  mainCeilingLogReducer,
  type MainCeilingLogVerdict,
  type MainHealthRungDeps,
  type MainRatchetRecordOutcome,
  type MainRatchetRecordRequest,
  type MainRepairFixRequest,
  type MainRepairLane,
} from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import { readLedgerLines } from "../src/lib/status.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import {
  MAIN_RATCHET_RECORD_BRANCH_PREFIX,
  readMainCeilingVerdictAsync,
  recordMainRatchetBaseline,
  runNpmScriptAsync,
  type MainRatchetRecordDeps,
} from "../src/run-task.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

const OWNER = "craigoley";
const REPO = "remudero";
const HEAD = "688f222c".padEnd(40, "0"); // main's red head on 2026-10-10
const RED_MERGE = "de219e4f".padEnd(40, "0"); // #10697, the merge that crossed the ceiling
const GREEN = "4f2a2ee8".padEnd(40, "0");
const SHARD = "ci-shard (1/8)";
const SHARD_JOB = "114279786736";
const HAND_FIX = `https://github.com/${OWNER}/${REPO}/pull/10712`;
const LANE_PR = `https://github.com/${OWNER}/${REPO}/pull/10720`;

/** The tail of the real ci-shard (1/8) job log of 688f222c6's push run, as GitHub serves it. */
const SHARD_LOG = [
  "2026-10-10T18:14:07.6505095Z \u001b[36;1m      echo \"::group::main-ceiling-drift:${gate}\"\u001b[0m",
  "2026-10-10T18:14:07.6505621Z \u001b[36;1m        echo \"main-ceiling-drift: ${gate} BLOCKED on main itself\"\u001b[0m",
  "2026-10-10T18:16:19.9708802Z 1..2585",
  "2026-10-10T18:16:19.9708967Z # tests 2621",
  "2026-10-10T18:16:19.9709369Z # pass 2621",
  "2026-10-10T18:16:19.9709541Z # fail 0",
  "2026-10-10T18:16:19.9710225Z # duration_ms 131919.6516",
  "2026-10-10T18:16:20.0067606Z ##[group]main-ceiling-drift:learnings-budget-ratchet",
  "2026-10-10T18:16:20.1529513Z learnings-budget-ratchet: OK -- active corpus 36362 chars is under the runaway hard cap 126000.",
  "2026-10-10T18:16:20.1648270Z ##[endgroup]",
  "2026-10-10T18:16:20.2725256Z ##[group]main-ceiling-drift:comment-load-signal",
  "2026-10-10T18:16:20.4756799Z comment-load-ratchet: BLOCKED -- 1 file(s) carry more comment lines than their recorded ceiling:",
  "2026-10-10T18:16:20.4757425Z   - src/lib/daemon.ts: 1760 comment lines > ceiling 1750 (+10)",
  "2026-10-10T18:16:20.4759465Z     \"src/lib/daemon.ts\": 2000,",
  "2026-10-10T18:16:20.4923054Z main-ceiling-drift: comment-load-signal BLOCKED on main itself",
  "2026-10-10T18:16:20.4923639Z ##[endgroup]",
  "2026-10-10T18:16:20.4923980Z ##[group]main-ceiling-drift:expiring-fixture-census",
  "2026-10-10T18:16:23.3133664Z ##[endgroup]",
  "2026-10-10T18:16:23.3133999Z main-ceiling-drift: main may be past a recorded ceiling or the test shard failed.",
  "2026-10-10T18:16:23.3200000Z ##[error]Process completed with exit code 1.",
];

const verdictOf = (lines: readonly string[]): MainCeilingLogVerdict => {
  const reducer = mainCeilingLogReducer();
  for (const line of lines) reducer.push(line);
  return reducer.finish();
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const rowsOf = (ledgerPath: string, step: string) => readLedgerLines(ledgerPath).filter((row) => row.step === step); // ledger-read-intent: live
const tmpRoot = (): string => mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}main-ratchet-`));

test("the real shard log of 688f222c6 reads as comment-load-signal BLOCKED with zero failed tests", () => {
  assert.deepEqual(verdictOf(SHARD_LOG), { blockedGates: ["comment-load-signal"], testsFailed: 0 });
  // A retry's later summary decides; a summary printed after the ceilings began is not the tests'.
  const retried = ["# fail 2", "# fail 0", "##[group]main-ceiling-drift:x", "# fail 9"];
  assert.equal(verdictOf(retried).testsFailed, 0);
  assert.equal(verdictOf(["# fail 0", "# fail 3"]).testsFailed, 3);
  assert.deepEqual(verdictOf(["no summary at all"]), { blockedGates: [] });
});

test("a red outside the shard matrix, a failed test or an unratified ceiling is never ratchet-only", () => {
  const ratchet = new Map([[SHARD, verdictOf(SHARD_LOG)]]);
  assert.deepEqual(classifyMainRatchetRed(["ci", SHARD], ratchet), {
    kind: "ratchet-only",
    scripts: ["comment-load-ratchet"],
    gates: ["comment-load-signal"],
  });
  const reasons = [
    classifyMainRatchetRed(["ci", SHARD, "main-tripwire"], ratchet),
    classifyMainRatchetRed(["ci"], ratchet),
    classifyMainRatchetRed(["ci", SHARD], new Map([[SHARD, undefined]])),
    classifyMainRatchetRed(["ci", SHARD], new Map([[SHARD, { blockedGates: ["comment-load-signal"] }]])),
    classifyMainRatchetRed(["ci", SHARD], new Map([[SHARD, { blockedGates: ["comment-load-signal"], testsFailed: 1 }]])),
    classifyMainRatchetRed(["ci", SHARD], new Map([[SHARD, { blockedGates: [], testsFailed: 0 }]])),
    // The fence: only W1-T4004's registry may be recorded unattended. A learnings budget is not in it,
    // and neither is any floor (coverage, mutation) -- those never print a main-ceiling-drift line.
    classifyMainRatchetRed(["ci", SHARD], new Map([[SHARD, { blockedGates: ["comment-load-signal", "learnings-budget-ratchet"], testsFailed: 0 }]])),
    classifyMainRatchetRed(["ci", SHARD], new Map([[SHARD, { blockedGates: ["mutation-ratchet"], testsFailed: 0 }]])),
  ].map((verdict) => (verdict.kind === "not-ratchet" ? verdict.reason : "RATCHET-ONLY"));
  assert.deepEqual(reasons, [
    "failing outside the ci shard matrix: main-tripwire",
    "no failing ci shard names what failed",
    `${SHARD}'s log was not read`,
    `${SHARD}'s log printed no test summary`,
    `${SHARD} failed 1 test(s)`,
    `${SHARD} failed with no failed test and no ceiling named`,
    "ceiling(s) not ratified for recording: learnings-budget-ratchet",
    "ceiling(s) not ratified for recording: mutation-ratchet",
  ]);
});

interface FakeLane extends MainRepairLane {
  fixes: MainRepairFixRequest[];
  records: MainRatchetRecordRequest[];
}

function fakeLane(outcome: () => MainRatchetRecordOutcome): FakeLane {
  const fixes: MainRepairFixRequest[] = [];
  const records: MainRatchetRecordRequest[] = [];
  return {
    fixes,
    records,
    openFixPr: async (request) => {
      fixes.push(request);
      return `https://github.com/${OWNER}/${REPO}/pull/10799`;
    },
    openRevertPr: async () => ({ prUrl: `https://github.com/${OWNER}/${REPO}/pull/10798` }),
    recordRatchet: async (request) => {
      records.push(request);
      return outcome();
    },
  };
}

interface World {
  ci: "failure" | "success";
  prs: Map<string, { state: "open" | "closed"; merged: boolean }>;
  mutations: string[][];
}

function rig(w: World, lane: MainRepairLane, ledgerPath: string, shardLog: readonly string[], overrides: Partial<MainHealthRungDeps> = {}) {
  let clock = Date.parse("2026-10-10T18:20:00Z");
  const logReads: string[] = [];
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("--method")) {
      w.mutations.push(args);
      const pr = /pulls\/(\d+)$/.exec(path)?.[1];
      if (pr && args.includes("state=closed")) w.prs.get(pr)!.state = "closed";
      return {};
    }
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: HEAD };
    if (path === `repos/${OWNER}/${REPO}/commits/${HEAD}/check-runs?per_page=100`) {
      return {
        check_runs: [
          { name: "ci", status: "completed", conclusion: w.ci },
          {
            name: SHARD,
            status: "completed",
            conclusion: w.ci,
            details_url: `https://github.com/${OWNER}/${REPO}/actions/runs/38074361932/job/${SHARD_JOB}`,
          },
          { name: "ci-shard (2/8)", status: "completed", conclusion: "success" },
        ],
      };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${HEAD}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) {
      return {
        workflow_runs: [
          { id: 3, name: "ci", head_sha: HEAD, status: "completed", conclusion: w.ci },
          { id: 2, name: "ci", head_sha: RED_MERGE, status: "completed", conclusion: "failure", pull_requests: [{ number: 10697 }] },
          { id: 1, name: "ci", head_sha: GREEN, status: "completed", conclusion: "success" },
        ],
      };
    }
    if (path === `repos/${OWNER}/${REPO}/commits/${RED_MERGE}`) return { files: [{ filename: "src/lib/daemon.ts", additions: 9, deletions: 0 }] };
    const pull = /^repos\/craigoley\/remudero\/pulls\/(\d+)$/.exec(path)?.[1];
    if (pull && w.prs.has(pull)) return { state: w.prs.get(pull)!.state, merged: w.prs.get(pull)!.merged, head: { sha: "f".repeat(40) } };
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const created: string[] = [];
  const issues: AsyncIssueGateway = {
    create: async (title) => {
      created.push(title);
      return `https://github.com/${OWNER}/${REPO}/issues/1`;
    },
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-RATCHET",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: () => [{ name: "ci", conclusion: "FAILURE", logTail: "ci: a test shard FAILED (matrix result: failure)" }],
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
    readCeilingVerdict: (check) =>
      readMainCeilingVerdictAsync(OWNER, REPO, check, async (args, onLine) => {
        logReads.push(args[1]!);
        for (const line of shardLog) onLine(line);
      }),
    ...overrides,
  });
  return {
    created,
    logReads,
    observe: async (advanceMs = 60_000) => {
      clock += advanceMs;
      await rung();
      await flush();
      await flush();
    },
  };
}

function world(): World {
  return {
    ci: "failure",
    prs: new Map([
      ["10712", { state: "open", merged: false }],
      ["10720", { state: "open", merged: false }],
    ]),
    mutations: [],
  };
}

test("a main red only on a ratified ceiling opens one recorded-baseline PR and spends no fix worker", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    const lane = fakeLane(() => ({ opened: LANE_PR }));
    const daemon = rig(w, lane, ledgerPath, SHARD_LOG);
    await daemon.observe();
    assert.deepEqual(daemon.logReads, [`repos/${OWNER}/${REPO}/actions/jobs/${SHARD_JOB}/logs`], "the failing shard's own log is read");
    assert.deepEqual(lane.records, [{ branch: "main", headSha: HEAD, scripts: ["comment-load-ratchet"], gates: ["comment-load-signal"] }]);
    assert.equal(lane.fixes.length, 0, "no fix worker is dispatched for a red the gate's own remedy records");
    assert.equal(rowsOf(ledgerPath, "main.repair.located").length, 0, "no offending merge is blamed");
    assert.deepEqual(rowsOf(ledgerPath, "main.repair.ratchet_opened").map((row) => row.pr_url), [LANE_PR]);

    // The red observed again: the open PR still owns it. No second record, no worker, no escalation.
    await daemon.observe();
    await daemon.observe();
    assert.equal(lane.records.length, 1, "one recorded-baseline PR at a time");
    assert.equal(lane.fixes.length, 0);
    assert.equal(daemon.created.length, 0, "a red the lane records raises no MAIN-HEALTH escalation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed test beside the ceiling keeps the red on the fix-then-revert path", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const lane = fakeLane(() => ({ opened: LANE_PR }));
    const failedTest = SHARD_LOG.map((line) => line.replace("# fail 0", "# fail 1"));
    await rig(world(), lane, ledgerPath, failedTest).observe();
    assert.equal(lane.records.length, 0, "a failed test is never recorded away");
    assert.equal(lane.fixes.length, 1, "the ordinary fix worker keeps the red");
    assert.equal(rowsOf(ledgerPath, "main.repair.ratchet_dispatched").length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unratified ceiling is never recorded by the lane", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const lane = fakeLane(() => ({ opened: LANE_PR }));
    const learnings = [...SHARD_LOG, "main-ceiling-drift: learnings-budget-ratchet BLOCKED on main itself"];
    await rig(world(), lane, ledgerPath, learnings).observe();
    assert.equal(lane.records.length, 0);
    assert.equal(lane.fixes.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an open PR that already records the ceiling makes the lane stand down", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    const lane = fakeLane(() => ({ standing: HAND_FIX }));
    const daemon = rig(w, lane, ledgerPath, SHARD_LOG);
    await daemon.observe();
    await daemon.observe();
    assert.equal(lane.records.length, 1, "the hand fix owns the red while it is open");
    assert.equal(lane.fixes.length, 0);
    assert.deepEqual(rowsOf(ledgerPath, "main.repair.ratchet_standing").map((row) => row.pr_url), [HAND_FIX]);

    // The hand fix closes unmerged while main stays red: the lane takes the red back up.
    w.prs.get("10712")!.state = "closed";
    await daemon.observe();
    assert.equal(lane.records.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declined record hands the same red to the fix worker", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const lane = fakeLane(() => ({ declined: "comment-load-signal is green at main's tip" }));
    const daemon = rig(world(), lane, ledgerPath, SHARD_LOG);
    await daemon.observe();
    assert.equal(lane.fixes.length, 0);
    assert.deepEqual(rowsOf(ledgerPath, "main.repair.ratchet_declined").map((row) => row.reason), ["comment-load-signal is green at main's tip"]);
    await daemon.observe();
    assert.equal(lane.records.length, 1, "a declined red is not re-recorded");
    assert.equal(lane.fixes.length, 1, "the fix worker takes it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lane's own recorded-baseline PR is closed when main turns green without it", async () => {
  const root = tmpRoot();
  const ledgerPath = join(root, "ledger.ndjson");
  try {
    const w = world();
    const lane = fakeLane(() => ({ opened: LANE_PR }));
    const daemon = rig(w, lane, ledgerPath, SHARD_LOG);
    await daemon.observe();
    w.ci = "success"; // the hand fix merged first
    await daemon.observe();
    assert.equal(w.prs.get("10720")!.state, "closed", "the now-redundant record is closed");
    assert.equal(w.prs.get("10712")!.state, "open", "a PR the lane did not open is never closed by it");
    assert.deepEqual(rowsOf(ledgerPath, "main.repair.ratchet_resolved").map((row) => [row.pr_url, row.by]), [[LANE_PR, "other"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the production opener, against real git -------------------------------------------------

const BASELINE = "scripts/comment-load-baseline.json";
const MEASURED = 1760;
const execFileAsync = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};
const baselineText = (row: number, sweepRow = 4000): string =>
  `${JSON.stringify({ _comment: "per-file ceilings", "src/lib/daemon.ts": row, "src/lib/sweep.ts": sweepRow }, null, 2)}\n`;

interface OpenPr {
  number: number;
  ref: string;
  row: number;
  /** An unrelated PR records a different file's row and leaves daemon.ts where main has it. */
  sweepRow?: number;
}

function openerFixture(openPrs: readonly OpenPr[] = []) {
  const origin = gitRepo({ bare: true, kind: "ratchet-origin" });
  const seed = gitRepo({ kind: "ratchet-seed" });
  mkdirSync(join(seed.dir, "scripts"), { recursive: true });
  writeFileSync(
    join(seed.dir, "package.json"),
    JSON.stringify({ scripts: { "comment-load-ratchet": "node record.mjs", "comment-load-signal": "node signal.mjs" } }),
  );
  writeFileSync(join(seed.dir, BASELINE), baselineText(1750));
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "main at 1750");
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const shas = new Map<number, string>();
  for (const pr of openPrs) {
    seed.git("checkout", "--quiet", "-b", pr.ref, "main");
    writeFileSync(join(seed.dir, BASELINE), baselineText(pr.row, pr.sweepRow));
    seed.git("commit", "--quiet", "-am", `pr ${pr.number}`);
    seed.git("push", "--quiet", "origin", `HEAD:refs/pull/${pr.number}/head`);
    shas.set(pr.number, seed.git("rev-parse", "HEAD"));
    seed.git("checkout", "--quiet", "main");
  }
  const checkout = gitRepo({ cloneFrom: origin.dir, kind: "ratchet-checkout" });
  const mainBefore = origin.git("rev-parse", "main");
  const worktreePath = join(checkout.dir, "..", `${checkout.dir.split("/").pop()}-wt`);
  const created: Array<{ title: string; body: string; head: string; base: string }> = [];
  const closed: string[] = [];
  const scriptsRun: string[] = [];
  let strayWrite = false;
  const field = (args: string[], name: string): string => args.find((a) => a.startsWith(`${name}=`))!.slice(name.length + 1);
  const deps: MainRatchetRecordDeps = {
    fetch: ((args: string[]) => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path === `repos/${OWNER}/${REPO}/pulls?state=open&per_page=100`) {
        return openPrs.map((pr) => ({
          number: pr.number,
          html_url: `https://github.com/${OWNER}/${REPO}/pull/${pr.number}`,
          head: { ref: pr.ref, sha: shas.get(pr.number) },
        }));
      }
      if (path === `repos/${OWNER}/${REPO}/pulls` && args.includes("POST")) {
        created.push({ title: field(args, "title"), body: field(args, "body"), head: field(args, "head"), base: field(args, "base") });
        return { html_url: LANE_PR, number: 10720 };
      }
      if (args.includes("PATCH")) {
        closed.push(path);
        return {};
      }
      if (args.includes("POST")) return {};
      throw new Error(`unrouted gh api call: ${args.join(" ")}`);
    }) as GhApiFetcher,
    git: async (cwd, args) => (await execFileAsync("git", ["-C", cwd, ...args], { env: GIT_ENV })).stdout,
    // The writer and its signal, as comment-load-ratchet behaves on main: src/lib/daemon.ts measures 1760.
    runScript: async (script, cwd, args = []) => {
      scriptsRun.push([script, ...args].join(" "));
      const rows = JSON.parse(readFileSync(join(cwd, BASELINE), "utf8")) as Record<string, number>;
      // Off a branch cut from main the bare signal reads main's own crossing as inherited and passes;
      // only main's --strict form sees it, exactly as the real comment-load-ratchet.mjs does.
      if (script === "comment-load-signal" && !args.includes("--strict")) return { status: 0 };
      if (script === "comment-load-signal") return { status: rows["src/lib/daemon.ts"]! >= MEASURED ? 0 : 1 };
      writeFileSync(join(cwd, BASELINE), baselineText(MEASURED));
      if (strayWrite) writeFileSync(join(cwd, "src-stray.ts"), "// not a baseline\n");
      return { status: 0 };
    },
    worktreeAdd: async (repoDir, path, branch) => {
      await execFileAsync("git", ["-C", repoDir, "worktree", "add", "--quiet", "-b", branch, path, "origin/main"], { env: GIT_ENV });
    },
    worktreeRemove: async (repoDir, path) => {
      await execFileAsync("git", ["-C", repoDir, "worktree", "remove", "--force", path], { env: GIT_ENV });
    },
    push: async (path) => {
      await execFileAsync("git", ["-C", path, "push", "--quiet", "origin", "HEAD"], { env: GIT_ENV });
    },
  };
  const branch = `${MAIN_RATCHET_RECORD_BRANCH_PREFIX}${"0".repeat(12)}-1`;
  const run = (scripts: readonly string[] = ["comment-load-ratchet"]) =>
    recordMainRatchetBaseline(
      {
        owner: OWNER,
        repo: REPO,
        repoDir: checkout.dir,
        worktreePath,
        branch,
        request: { branch: "main", headSha: HEAD, scripts: scripts as MainRatchetRecordRequest["scripts"], gates: ["comment-load-signal"] },
        log: () => {},
      },
      deps,
    );
  return {
    run,
    created,
    closed,
    scriptsRun,
    branch,
    mainBefore,
    strayWrites: () => {
      strayWrite = true;
    },
    makeMainGreen: () => {
      seed.git("checkout", "--quiet", "main");
      writeFileSync(join(seed.dir, BASELINE), baselineText(2000));
      seed.git("commit", "--quiet", "-am", "the hand fix merged");
      seed.git("push", "--quiet", "origin", "main");
      checkout.git("fetch", "--quiet", "origin");
    },
    originMain: () => origin.git("rev-parse", "main"),
    originBranches: () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean),
    fileOnBranch: (ref: string, path: string) => origin.git("show", `${ref}:${path}`),
    changedOnBranch: (ref: string) => origin.git("diff", "--name-only", `main...${ref}`).split("\n").filter(Boolean),
    cleanup: () => {
      for (const repo of [origin, seed, checkout]) repo.cleanup();
      rmSync(worktreePath, { recursive: true, force: true });
    },
  };
}

test("the recorded-baseline PR carries only the baseline path at the value the fenced writer records", async () => {
  const fx = openerFixture([{ number: 10650, ref: "run-W1-T7001-1", row: 1750, sweepRow: 4250 }]);
  try {
    assert.deepEqual(await fx.run(), { opened: LANE_PR });
    const mainForm = "comment-load-signal --base HEAD^ --strict";
    assert.deepEqual(fx.scriptsRun, [mainForm, "comment-load-ratchet", mainForm], "re-measured red in main's form, recorded, verified green");
    assert.equal(fx.originMain(), fx.mainBefore, "main itself is never written");
    assert.deepEqual(fx.originBranches().filter((b) => b !== "main"), [fx.branch]);
    assert.deepEqual(fx.changedOnBranch(fx.branch), [BASELINE], "nothing but the baseline rides the PR");
    assert.equal(fx.fileOnBranch(fx.branch, BASELINE), baselineText(MEASURED).trimEnd());
    const [pr] = fx.created;
    assert.equal(pr?.base, "main");
    assert.equal(pr?.head, fx.branch);
    assert.ok(pr!.title.length <= 100);
    assert.match(pr!.title, /^chore\(ci\): record the ceiling main crossed on comment-load-signal$/);
    assert.match(pr!.body, /^## Acceptance$/m);
    assert.match(pr!.body, /^- main's ceiling for src\/lib\/daemon\.ts is recorded at 1760 \| grep: "src\/lib\/daemon\.ts": 1760 in scripts\/comment-load-baseline\.json$/m);
    assert.doesNotMatch(pr!.body, /src\/lib\/sweep\.ts/, "a row the writer did not raise is no claim");
    assert.deepEqual(fx.closed, [], "an unrelated open PR is never closed");
  } finally {
    fx.cleanup();
  }
});

test("an open hand fix carrying the ceiling (#10712's shape) stands the opener down before any push", async () => {
  const fx = openerFixture([
    { number: 10650, ref: "run-W1-T7001-1", row: 1750, sweepRow: 4250 },
    { number: 10712, ref: "run-unfiled-1791650000000", row: 2000 },
  ]);
  try {
    assert.deepEqual(await fx.run(), { standing: HAND_FIX });
    assert.deepEqual(fx.originBranches(), ["main"], "nothing is pushed");
    assert.equal(fx.created.length, 0, "no second PR is opened");
  } finally {
    fx.cleanup();
  }
});

test("an older recorded-baseline PR of the lane that no longer covers is closed as superseded", async () => {
  const fx = openerFixture([{ number: 10715, ref: `${MAIN_RATCHET_RECORD_BRANCH_PREFIX}aaaaaaaaaaaa-1`, row: 1755 }]);
  try {
    assert.deepEqual(await fx.run(), { opened: LANE_PR });
    assert.deepEqual(fx.closed, [`repos/${OWNER}/${REPO}/pulls/10715`]);
  } finally {
    fx.cleanup();
  }
});

test("a ceiling already green at main's tip is declined, never recorded", async () => {
  const fx = openerFixture();
  try {
    fx.makeMainGreen();
    const outcome = await fx.run();
    assert.ok("declined" in outcome && /comment-load-signal is green at main's tip/.test(outcome.declined));
    assert.deepEqual(fx.scriptsRun, ["comment-load-signal --base HEAD^ --strict"], "the writer never runs");
    assert.deepEqual(fx.originBranches(), ["main"]);
  } finally {
    fx.cleanup();
  }
});

test("a writer that touches a path outside its baseline, or a writer outside the registry, is declined", async () => {
  const fx = openerFixture();
  try {
    fx.strayWrites();
    const stray = await fx.run();
    assert.ok("declined" in stray && /changed more than their baselines: src-stray\.ts/.test(stray.declined));
    assert.deepEqual(fx.originBranches(), ["main"]);
    const floor = await fx.run(["mutation-ratchet"]);
    assert.deepEqual(floor, { declined: "not a ratified baseline writer: mutation-ratchet" });
  } finally {
    fx.cleanup();
  }
});

test("runNpmScriptAsync reports a real npm script's exit status off the event loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}npm-async-`));
  try {
    writeFileSync(join(dir, "argv.js"), "process.exit(process.argv.includes('--strict') ? 0 : 4);\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { green: "node -e 0", red: "node -e process.exit(3)", argv: "node argv.js" } }));
    assert.deepEqual(await runNpmScriptAsync("green", dir), { status: 0 });
    assert.deepEqual(await runNpmScriptAsync("argv", dir, ["--strict"]), { status: 0 }, "args reach the script after --");
    assert.notEqual((await runNpmScriptAsync("red", dir)).status, 0);
    assert.deepEqual(await runNpmScriptAsync("green", join(dir, "absent")), { status: 1 }, "a script that cannot start reads red");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
