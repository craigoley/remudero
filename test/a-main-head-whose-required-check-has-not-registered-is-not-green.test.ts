// W1-T13130 — a main head whose required check has not registered yet is not green.
//
// 2026-11-15 18:06:06Z: main health read green on 99a71759f. Its `ci` check had passed at 18:02:56Z, but
// `test-slow` (a required name) did not exist yet: it waits for its shards, and test-slow-shard (2/4) ran
// until 18:18:07Z. test-slow registered at 18:18:10Z and failed at 18:18:14Z. The green reading closed the
// located repair of 580877d7c ("resolved by other"), and main stayed red for nine more hours.
// mainHealthFromRollup judged only the required names that had an entry. Now an absent required name is
// pending while some other check on the head still runs. When every check has concluded, an absent name
// is settled: seven names of ci-gate.yml REQUIRED come from pull_request-only workflows and never register
// on a push, so they must not hold main undetermined for good.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { readCiGateRequiredChecks } from "#src/lib/ci-gate-required.js";
import { buildMainHealthRung, type MainRepairLane } from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import { mainHealthFromRollup, type RollupCheckEntry } from "#src/lib/sweep.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const REQUIRED = readCiGateRequiredChecks(REPO_ROOT);
const HEAD = "99a71759f".padEnd(40, "0");
const CULPRIT = "580877d7c".padEnd(40, "6");
const PARENT = "d5722e1fe".padEnd(40, "1");
const NOW = Date.parse("2026-11-15T18:06:06Z");

/** The names a push run on main registers: ci-gate.yml MERGE_GROUP_REQUIRED, the subset ci.yml runs there. */
const PUSH_REGISTERED = [
  "ci", "coverage-ratchet", "rule-checks", "leak-grep", "learnings-budget-ratchet", "jscpd-gate", "claims",
  "assertion-discrimination", "lint-plan", "depcruise", "containment-probe", "api-client-drift",
  "no-hand-rolled-fetch", "task-id-existence", "source-size", "comment-load-ratchet", "baseline-monotonic",
];

const done = (name: string, conclusion: string): RollupCheckEntry => ({ name, status: "COMPLETED", conclusion });
const running = (name: string): RollupCheckEntry => ({ name, status: "IN_PROGRESS" });
const SHARDS_DONE = ["test-slow-plan", "test-slow-shard (1/4)", "test-slow-shard (3/4)", "test-slow-shard (4/4)"];

/** 99a71759f at 18:06Z: every push-registered required check passed, test-slow absent, shard 2/4 running. */
const AT_1806: RollupCheckEntry[] = [
  ...PUSH_REGISTERED.map((name) => done(name, "SUCCESS")),
  ...SHARDS_DONE.map((name) => done(name, "SUCCESS")),
  running("test-slow-shard (2/4)"),
];
/** 99a71759f at 18:18:14Z: the shard failed, and test-slow registered and failed. */
const AT_1818: RollupCheckEntry[] = [
  ...PUSH_REGISTERED.map((name) => done(name, "SUCCESS")),
  ...SHARDS_DONE.map((name) => done(name, "SUCCESS")),
  done("test-slow-shard (2/4)", "FAILURE"),
  done("test-slow", "FAILURE"),
];

test("the required set is ci-gate.yml REQUIRED, and test-slow and pull_request-only names are in it", () => {
  assert.ok(REQUIRED.includes("test-slow"));
  const prOnly = REQUIRED.filter((name) => !PUSH_REGISTERED.includes(name) && name !== "test-slow");
  assert.ok(prOnly.length >= 7, `pull_request-only required names: ${prOnly.join(", ")}`);
});

test("W1-T13130 criterion 1: the 18:06Z head with test-slow absent and its shard running reads undetermined, not green", () => {
  const observation = mainHealthFromRollup(HEAD, AT_1806, REQUIRED, undefined, { cancelledIsPending: true });
  assert.equal(observation.state, "undetermined");
  assert.ok(observation.pendingChecks.includes("test-slow"), `pending: ${observation.pendingChecks.join(", ")}`);
  assert.match(observation.reason, /not registered yet/);
  assert.match(observation.reason, /test-slow/);
  assert.equal(observation.failingChecks.length, 0);
});

function lane(): MainRepairLane & { fixes: number; reverts: number } {
  const calls = { fixes: 0, reverts: 0 };
  return Object.assign(calls, {
    openFixPr: () => {
      calls.fixes += 1;
      return undefined;
    },
    openRevertPr: () => {
      calls.reverts += 1;
      return { refused: "the test lane opens no pull request" };
    },
  }) as MainRepairLane & { fixes: number; reverts: number };
}

function rung(world: { rollup: RollupCheckEntry[]; runConclusion: string | null }, ledgerPath: string) {
  const rows: Record<string, unknown>[] = [];
  let tick = 0;
  const restCheck = (c: RollupCheckEntry) => ({
    name: c.name,
    status: (c.status ?? "").toLowerCase(),
    conclusion: c.conclusion ? c.conclusion.toLowerCase() : null,
    started_at: new Date(NOW - 600_000).toISOString(),
  });
  const fetch: GhApiFetcher = async (args) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("--method")) return {};
    if (path === "repos/o/r") return { default_branch: "main" };
    if (path === "repos/o/r/commits/main") return { sha: HEAD };
    if (path.startsWith(`repos/o/r/commits/${HEAD}/check-runs?`)) return { check_runs: world.rollup.map(restCheck) };
    if (path.endsWith("/status")) return { statuses: [] };
    if (path.startsWith("repos/o/r/actions/runs?")) {
      return {
        workflow_runs: [
          {
            id: 7,
            name: "CI",
            head_sha: HEAD,
            status: world.runConclusion ? "completed" : "in_progress",
            conclusion: world.runConclusion,
          },
        ],
      };
    }
    if (path.startsWith("repos/o/r/commits?")) {
      return [HEAD, CULPRIT, PARENT].map((sha, i, all) => ({
        sha,
        parents: all[i + 1] ? [{ sha: all[i + 1] }] : [],
        commit: { committer: { date: new Date(NOW - (i + 1) * 600_000).toISOString() } },
      }));
    }
    if (/actions\/runs\/7\/jobs\?/.test(path)) return { jobs: world.rollup.map((c, i) => ({ id: 700 + i, ...restCheck(c) })) };
    throw new Error(`unrouted: ${path}`);
  };
  const observe = buildMainHealthRung("o", "r", {
    fetch,
    issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], closeWithComment: () => {} },
    ledgerPath,
    runId: "T13130",
    now: () => NOW + 1_000 * tick++,
    log: (step, extra) => {
      rows.push({ step, ...extra });
    },
    readRequiredChecks: () => REQUIRED,
    repair: lane(),
  });
  return { rows, observe };
}

test("W1-T13130 criterion 2: a pass over the not-yet-registered head keeps the located repair open; the concluded red reads red", async () => {
  const ledger = writeLedger([
    {
      ts: new Date(NOW - 2 * 3_600_000).toISOString(),
      run_id: "DAEMON-T13130",
      step: "main.repair.located",
      surface: "main",
      offending_sha: CULPRIT,
      failing_checks: ["test-slow"],
    },
  ]);
  try {
    const world = { rollup: AT_1806, runConclusion: null as string | null };
    const daemon = rung(world, ledger.path);
    await daemon.observe();
    const resolvedRows = () => readLedgerLines(ledger.path).filter((row) => row.step === "main.repair.resolved"); // ledger-read-intent: live
    assert.equal(resolvedRows().length, 0, "the located repair is not resolved on a head whose test-slow has not registered");
    const first = daemon.rows.filter((row) => row.step === "main.health.observed").at(-1);
    assert.ok(first, "the pass writes its main.health.observed row");
    assert.notEqual(first.state, "green");

    world.rollup = AT_1818;
    world.runConclusion = "failure";
    await daemon.observe();
    const second = daemon.rows.filter((row) => row.step === "main.health.observed").at(-1);
    assert.equal(second?.state, "red");
    assert.ok((second?.failing_checks as string[]).includes("test-slow"));
    assert.equal(resolvedRows().length, 0, "a red reading resolves nothing");
  } finally {
    rmSync(ledger.dir, { recursive: true, force: true });
  }
});

test("W1-T13130 criterion 3: a settled head with the pull_request-only names absent still reads green", () => {
  const settled: RollupCheckEntry[] = [
    ...PUSH_REGISTERED.map((name) => done(name, "SUCCESS")),
    ...SHARDS_DONE.map((name) => done(name, "SUCCESS")),
    done("test-slow-shard (2/4)", "SUCCESS"),
    done("test-slow", "SUCCESS"),
  ];
  const absent = REQUIRED.filter((name) => !settled.some((c) => c.name === name));
  assert.ok(absent.length >= 7, `absent required names: ${absent.join(", ")}`);
  const observation = mainHealthFromRollup(HEAD, settled, REQUIRED, undefined, { cancelledIsPending: true });
  assert.equal(observation.state, "green", observation.reason);
  assert.equal(observation.pendingChecks.length, 0);
});

test("W1-T13130 criterion 4: a registered failing required check reads red while test-slow has not registered", () => {
  const rollup = AT_1806.map((c) => (c.name === "lint-plan" ? done("lint-plan", "FAILURE") : c));
  const observation = mainHealthFromRollup(HEAD, rollup, REQUIRED, undefined, { cancelledIsPending: true });
  assert.equal(observation.state, "red", observation.reason);
  assert.deepEqual(observation.failingChecks, ["lint-plan"]);
});
