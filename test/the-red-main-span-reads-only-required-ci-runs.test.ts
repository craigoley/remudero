/**
 * W1-T9678 — THE RED-MAIN SPAN READS ONLY REQUIRED CI RUNS.
 *
 * 2026-10-15: 131248633's CI run was cancelled, but a CodeQL run on it completed. The span between the last
 * green and the first completed red (037a58d8f) counted that CodeQL run as a verdict, came back empty, and the
 * lane named plan-only 037a58d8f by first-red-run instead of probing 131248633. These fixtures replay that
 * shape against the real rung: a non-required workflow's run never takes a commit out of the span.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import { buildMainHealthRung, type MainRepairFixRequest, type MainRepairLane } from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { readLedgerLines } from "#src/lib/status.js";
import type { CiFailure } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const OWNER = "craigoley";
const REPO = "remudero";
const REPO_PATH = `repos/${OWNER}/${REPO}`;
const sha = (prefix: string): string => prefix.padEnd(40, "0");
const GREEN = sha("cd482d43");
const CANCELLED = sha("131248633"); // its CI run was cancelled; its CodeQL run completed
const RED = sha("037a58d8f"); // the first completed red
const NEWER = sha("4ead0000"); // a later head whose CI is still running

interface Run {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
}

const run = (id: number, name: string, head: string, conclusion: string | null): Run => ({
  id,
  name,
  head_sha: head,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
});

/** Newest first, as GitHub lists main's push runs. `other` is the non-required run that completed on the cancelled-CI commit. */
function historyOf(head: string, other: Run): Run[] {
  return [
    ...(head === NEWER ? [run(906, "CI", NEWER, null)] : []),
    run(905, "CI", RED, "failure"),
    other,
    run(903, "CI", CANCELLED, "cancelled"),
    run(902, "CodeQL", GREEN, "success"),
    run(901, "CI", GREEN, "success"),
  ];
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function rig(head: string, other: Run, lane: MainRepairLane, ledgerPath: string) {
  let clock = Date.parse("2026-10-15T13:30:00Z");
  const chain = [GREEN, CANCELLED, RED, ...(head === NEWER ? [NEWER] : [])];
  const history = historyOf(head, other);
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (args.includes("--method")) return {};
    if (path === REPO_PATH) return { default_branch: "main" };
    if (path === `${REPO_PATH}/commits/main`) return { sha: head };
    if (path === `${REPO_PATH}/commits/${head}/check-runs?per_page=100`) {
      const ci = history.find((entry) => entry.head_sha === head && entry.name === "CI")!;
      return { check_runs: [{ id: 1, name: "ci", status: ci.status, ...(ci.conclusion ? { conclusion: ci.conclusion } : {}) }] };
    }
    if (path === `${REPO_PATH}/commits/${head}/status`) return { statuses: [] };
    if (path === `${REPO_PATH}/commits?sha=${head}&per_page=100`) {
      return [...chain].reverse().map((commit, i, page) => ({
        sha: commit,
        parents: page[i + 1] ? [{ sha: page[i + 1] }] : [],
        commit: { committer: { date: new Date(clock - (i + 1) * 60_000).toISOString() } },
      }));
    }
    if (path.startsWith(`${REPO_PATH}/actions/runs?`)) return { workflow_runs: history };
    const jobs = /actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (jobs) {
      const entry = history.find((candidate) => candidate.id === Number(jobs))!;
      const name = entry.name === "CI" ? "ci" : `${entry.name} (no required check)`;
      return { jobs: [{ id: entry.id * 10, name, status: entry.status, ...(entry.conclusion ? { conclusion: entry.conclusion } : {}) }] };
    }
    const commit = /^repos\/craigoley\/remudero\/commits\/([0-9a-f]{40})$/.exec(path)?.[1];
    if (commit) {
      const index = chain.indexOf(commit);
      return { sha: commit, parents: index > 0 ? [{ sha: chain[index - 1] }] : [], files: [{ filename: "src/lib/ci-friction-remedy.ts", additions: 1, deletions: 0 }] };
    }
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const issues: AsyncIssueGateway = {
    create: async () => `https://github.com/${OWNER}/${REPO}/issues/12030`,
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath,
    runId: "DAEMON-SPAN",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: (rollup) =>
      (rollup ?? []).map((entry): CiFailure => ({ name: entry.name ?? "", conclusion: "FAILURE", logTail: "not ok 2 - W1-T9503: a cause owned by a test alone escalates as no-owner" })),
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
    repair: lane,
  });
  return async () => {
    clock += 60_000;
    await rung();
    await flush();
  };
}

function probingLane(): MainRepairLane & { fixes: MainRepairFixRequest[]; probed: string[] } {
  const fixes: MainRepairFixRequest[] = [];
  const probed: string[] = [];
  return {
    fixes,
    probed,
    openFixPr: async (request) => {
      fixes.push(request);
      return `https://github.com/${OWNER}/${REPO}/pull/12031`;
    },
    openRevertPr: async () => ({ refused: "not exercised" }),
    probes: {
      dispatch: (probeSha) => {
        probed.push(probeSha);
        return { sha: probeSha, ref: `rmd-attribution/${probeSha}` };
      },
      read: () => ({ status: "running" }),
      release: () => {},
      readRunnerLoad: () => ({ queuedJobs: 0, idleRunners: 1 }),
    },
  };
}

async function observeOnce(head: string, other: Run): Promise<{ lane: ReturnType<typeof probingLane>; rows: Record<string, unknown>[] }> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}span-`));
  try {
    const ledgerPath = join(root, "ledger.ndjson");
    const lane = probingLane();
    await rig(head, other, lane, ledgerPath)();
    return { lane, rows: readLedgerLines(ledgerPath) }; // ledger-read-intent: live
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T9678: a codeql run on a cancelled ci commit keeps it in the span, so the lane probes it", async () => {
  // A newer head is still running CI, so the rung walks back and learns that CI carries the required
  // checks and CodeQL does not: the boundary is the green CI run, and the span filters by that same set.
  const { lane, rows } = await observeOnce(NEWER, run(904, "CodeQL", CANCELLED, "success"));
  assert.deepEqual(lane.probed, [CANCELLED], "the cancelled-CI commit is probed, its completed CodeQL run notwithstanding");
  const [bisecting] = rows.filter((row) => row.step === "main.repair.bisecting");
  assert.equal(bisecting?.first_red_sha, RED);
  assert.equal(bisecting?.after_green_sha, GREEN);
  assert.deepEqual(bisecting?.span, [CANCELLED]);
  assert.equal(rows.filter((row) => row.step === "main.repair.located").length, 0, "nothing is named by first-red-run");
  assert.equal(lane.fixes.length, 0, "no fix goes at the plan-only red while its parent is unattributed");
});

test("W1-T9678: with the required workflows unknown, no run is a verdict in the span and the probes decide", async () => {
  // Main's head is the completed red itself, so no walk back has learned which workflows carry the
  // required checks. A neutral guard run on the cancelled-CI commit neither bounds the red nor attributes it.
  const { lane, rows } = await observeOnce(RED, run(904, "Main tripwire", CANCELLED, "neutral"));
  assert.deepEqual(lane.probed, [CANCELLED]);
  const [bisecting] = rows.filter((row) => row.step === "main.repair.bisecting");
  assert.equal(bisecting?.after_green_sha, GREEN);
  assert.deepEqual(bisecting?.span, [CANCELLED]);
  assert.equal(rows.filter((row) => row.step === "main.repair.located").length, 0, "never a fall back to first-red-run");
});
