/**
 * W1-T9690 — THE FIRST-RED BOUNDARY NEVER TAKES A NON-REQUIRED WORKFLOW'S GREEN.
 *
 * The walk back is where the rung learns which workflows carry the required checks, and it runs only when
 * main's head is inconclusive. A head that is itself the completed red never walked back, so the boundary
 * read every workflow: a CodeQL green on a commit whose CI was cancelled became main's last green.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AsyncIssueGateway } from "#src/lib/escalate.js";
import { buildMainHealthRung } from "#src/lib/main-health-rung.js";
import type { GhApiFetcher } from "#src/lib/open-prs-rest.js";
import { mainHealthFirstRedCommitFromRunHistory, type CiFailure } from "#src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const OWNER = "craigoley";
const REPO = "remudero";
const REPO_PATH = `repos/${OWNER}/${REPO}`;
const sha = (prefix: string): string => prefix.padEnd(40, "0");
const GREEN = sha("cd482d43");
const CANCELLED = sha("131248633"); // its CI run was cancelled; its CodeQL run completed green
const RED = sha("037a58d8f"); // main's head, and the completed red

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

/** Newest first, as GitHub lists main's push runs. */
const history = (headCi: string | null): Run[] => [
  run(905, "CI", RED, headCi),
  run(904, "CodeQL", CANCELLED, "success"),
  run(903, "CI", CANCELLED, "cancelled"),
  run(902, "CodeQL", GREEN, "success"),
  run(901, "CI", GREEN, "success"),
];

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Rig {
  observe: () => Promise<void>;
  bodies: string[];
  jobsRead: number[];
  state: { headCi: string | null; jobsUnreadable: boolean };
}

function rig(root: string): Rig {
  let clock = Date.parse("2026-10-15T13:30:00Z");
  const chain = [GREEN, CANCELLED, RED];
  const state = { headCi: "failure" as string | null, jobsUnreadable: false };
  const bodies: string[] = [];
  const jobsRead: number[] = [];
  const fetch = ((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    const runs = history(state.headCi);
    if (args.includes("--method")) return {};
    if (path === REPO_PATH) return { default_branch: "main" };
    if (path === `${REPO_PATH}/commits/main`) return { sha: RED };
    if (path === `${REPO_PATH}/commits/${RED}/check-runs?per_page=100`) {
      const ci = runs[0]!;
      return { check_runs: [{ id: 1, name: "ci", status: ci.status, ...(ci.conclusion ? { conclusion: ci.conclusion } : {}) }] };
    }
    if (path === `${REPO_PATH}/commits/${RED}/status`) return { statuses: [] };
    if (path === `${REPO_PATH}/commits?sha=${RED}&per_page=100`) {
      return [...chain].reverse().map((commit, i, page) => ({
        sha: commit,
        parents: page[i + 1] ? [{ sha: page[i + 1] }] : [],
        commit: { committer: { date: new Date(clock - (i + 1) * 60_000).toISOString() } },
      }));
    }
    if (path.startsWith(`${REPO_PATH}/actions/runs?`)) return { workflow_runs: runs };
    const jobs = /actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path)?.[1];
    if (jobs) {
      jobsRead.push(Number(jobs));
      if (state.jobsUnreadable) throw new Error("HTTP 502 reading the jobs page");
      const entry = runs.find((candidate) => candidate.id === Number(jobs))!;
      const name = entry.name === "CI" ? "ci" : `${entry.name} (no required check)`;
      return { jobs: [{ id: entry.id * 10, name, status: entry.status, ...(entry.conclusion ? { conclusion: entry.conclusion } : {}) }] };
    }
    throw new Error(`unrouted gh api call: ${args.join(" ")}`);
  }) as GhApiFetcher;
  const issues: AsyncIssueGateway = {
    create: async (...args: unknown[]) => {
      bodies.push(JSON.stringify(args));
      return `https://github.com/${OWNER}/${REPO}/issues/12110`;
    },
    listOpen: async () => [],
    comment: async () => {},
    closeWithComment: async () => {},
  };
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "DAEMON-BOUNDARY",
    log: () => {},
    now: () => clock,
    readRequiredChecks: () => ["ci"],
    readCiFailures: (rollup) =>
      (rollup ?? []).map((entry): CiFailure => ({ name: entry.name ?? "", conclusion: "FAILURE", logTail: "not ok 2 - a test main broke" })),
    mergeReader: { prMerge: () => undefined, mergeBase: () => GREEN, prsMergedBetween: () => [] },
  });
  return {
    observe: async () => {
      clock += 60_000;
      await rung();
      await flush();
    },
    bodies,
    jobsRead,
    state,
  };
}

async function withRig(body: (r: Rig) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}boundary-`));
  try {
    await body(rig(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T9690: a red head learns the required workflows from its own runs, so a codeql green is not the last green", async () => {
  await withRig(async (r) => {
    await r.observe();
    assert.equal(r.bodies.length, 1, "the red head escalates once");
    const body = r.bodies[0]!;
    assert.match(body, new RegExp(`first red main push run: ${RED}`));
    assert.match(body, new RegExp(`after ${GREEN} was green`), "the last green is the grandparent's CI run");
    assert.doesNotMatch(body, new RegExp(`after ${CANCELLED} was green`), "never the CodeQL green on the cancelled-CI commit");
    assert.ok(r.jobsRead.includes(905), "the head's own CI run taught the rung which workflow carries the required checks");
  });
});

test("W1-T9690: an unknown required set names no first-red commit", async () => {
  await withRig(async (r) => {
    r.state.jobsUnreadable = true;
    await r.observe();
    assert.equal(r.bodies.length, 1);
    const body = r.bodies[0]!;
    assert.doesNotMatch(body, /first red main push run/, "no boundary is named on an unknown set");
    assert.doesNotMatch(body, /after [0-9a-f]{40} was green/);
    assert.match(body, /the workflows carrying required checks are unknown, so no first-red commit is named/);
  });
  const named = (headSha: string, workflowName: string, conclusion: string) => ({ headSha, workflowName, conclusion, status: "completed", runId: 1 });
  const replay = [named(RED, "CI", "failure"), named(CANCELLED, "CodeQL", "success"), named(GREEN, "CI", "success")];
  assert.equal(mainHealthFirstRedCommitFromRunHistory(replay, { requiredWorkflows: new Set() }), undefined, "an empty set takes no green");
  assert.deepEqual(mainHealthFirstRedCommitFromRunHistory(replay, { requiredWorkflows: new Set(["CI"]) }), { headSha: RED, afterGreenSha: GREEN });
});

test("W1-T9690: a set already learned reads no jobs page for the red head and keeps the boundary", async () => {
  await withRig(async (r) => {
    // Positive control: the head's CI is still running, so the walk back learns the set first.
    r.state.headCi = null;
    await r.observe();
    assert.equal(r.bodies.length, 0, "a running head escalates nothing");
    assert.ok(r.jobsRead.length > 0, "the walk back read jobs pages to learn the set");
    r.state.headCi = "failure";
    const before = r.jobsRead.length;
    await r.observe();
    assert.deepEqual(r.jobsRead.slice(before), [], "a learned set costs the red head no jobs read");
    assert.equal(r.bodies.length, 1);
    assert.match(r.bodies[0]!, new RegExp(`after ${GREEN} was green`));
  });
});
