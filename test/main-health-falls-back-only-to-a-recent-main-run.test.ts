// W1-T6023 — main-health falls back only to a RECENT main run.
//
// W1-T5490's fallback read `actions/runs?branch=main&event=push&status=completed`, and on
// 2026-10-06 GitHub sometimes answered that call with runs from days earlier. main's head a6a28515
// read GREEN at 13:46Z on the evidence of 22397b6d (#7047, merged 2026-09-24, 1856 first-parent
// commits back) and RED at 13:56Z on ca9be1f7 (#9381, merged 2026-10-05, 124 back). The same call
// without `status=completed` returned current runs. So the history is read without that filter
// (completed runs are kept client-side) and a run may decide only when its head sha is one of main's
// newest first-parent commits; otherwise main stays `undetermined`, naming the sha it skipped.
//
// The fixtures are routed at the `fetch` level, so the rung's production readers run for real.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMainHealthRung, mainPushRunHistoryRestArgs } from "../src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HEAD = "a6a2851509b610144b82e8d8ff165df3e65750a7";
const PARENT = "d".repeat(40);
const GRANDPARENT = "e".repeat(40);
/** #7047's merge, 2026-09-24: the sha the 13:46Z green rested on. */
const STALE_GREEN = "22397b6d85bdcf95c611d345b3a3541f8596cf86";
/** #9381's merge, 2026-10-05: the sha the 13:56Z red rested on. */
const STALE_RED = "ca9be1f7d70ac91a398d99002f62e50a990f8cb4";

type Run = { id: number; name: string; head_sha: string; status: string; conclusion: string | null };
const run = (id: number, head_sha: string, conclusion: string | null, status = "completed"): Run => ({
  id,
  name: "CI",
  head_sha,
  status,
  conclusion,
});
/** The head's own CI was cancelled by the next push, so the head concluded nothing. */
const HEAD_RUNS: Run[] = [run(10, HEAD, null, "in_progress"), run(9, HEAD, "cancelled")];

/** GitHub's `commits?sha=` page, newest first, each naming its parents. */
const commitsPage = (shas: readonly string[]) =>
  shas.map((sha, i) => ({ sha, parents: shas[i + 1] ? [{ sha: shas[i + 1] }] : [] }));

interface Options {
  runs: Run[];
  jobs?: Record<number, string>;
  commits?: () => unknown;
}

async function observe(options: Options) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6023-`));
  const rows: Record<string, unknown>[] = [];
  const calls: string[] = [];
  try {
    const rung = buildMainHealthRung("o", "r", {
      fetch: async (args) => {
        const path = args[1]!;
        calls.push(path);
        if (path === "repos/o/r") return { default_branch: "trunk" };
        if (path === "repos/o/r/commits/trunk") return { sha: HEAD };
        if (path.includes("/check-runs?")) return { check_runs: [{ name: "ci", status: "completed", conclusion: "cancelled" }] };
        if (path.endsWith("/status")) return { statuses: [] };
        if (path.includes("/actions/runs?")) return { workflow_runs: options.runs };
        if (path.startsWith("repos/o/r/commits?")) {
          return (options.commits ?? (() => commitsPage([HEAD, PARENT, GRANDPARENT])))();
        }
        const jobsOf = /actions\/runs\/(\d+)\/jobs\?/.exec(path)?.[1];
        if (jobsOf) {
          const conclusion = options.jobs?.[Number(jobsOf)] ?? "success";
          return { jobs: [{ id: Number(jobsOf), name: "ci", status: "completed", conclusion }] };
        }
        throw new Error(`unrouted: ${path}`);
      },
      issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], closeWithComment: () => {} },
      ledgerPath: join(root, "ledger.ndjson"),
      runId: "T6023",
      log: (step, extra) => {
        rows.push({ step, ...extra });
      },
      readRequiredChecks: () => ["ci"],
    });
    await rung();
    const observed = rows.find((r) => r.step === "main.health.observed");
    assert.ok(observed, "the observation writes its main.health.observed row");
    return { observed, rows, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T6023: the run history request carries no status filter", async () => {
  const [, path] = mainPushRunHistoryRestArgs("o", "r", "trunk");
  assert.equal(path, "repos/o/r/actions/runs?branch=trunk&event=push&per_page=100");
  const { calls } = await observe({ runs: [...HEAD_RUNS, run(1, PARENT, "success")] });
  const historyReads = calls.filter((p) => p.includes("/actions/runs?"));
  assert.deepEqual(historyReads, ["repos/o/r/actions/runs?branch=trunk&event=push&per_page=100"]);
  assert.equal(historyReads.some((p) => p.includes("status=")), false);
});

test("W1-T6023: a completed run for a sha in main's recent first-parent window decides as today", async () => {
  const green = await observe({ runs: [...HEAD_RUNS, run(1, GRANDPARENT, "success")] });
  assert.equal(green.observed.state, "green");
  assert.equal(green.observed.decided_by_sha, GRANDPARENT);
  assert.match(String(green.observed.reason), new RegExp(`the latest completed main run \\(${GRANDPARENT}\\) decides`));

  const red = await observe({ runs: [...HEAD_RUNS, run(1, PARENT, "failure")], jobs: { 1: "failure" } });
  assert.equal(red.observed.state, "red");
  assert.equal(red.observed.decided_by_sha, PARENT);
});

test("W1-T6023: the 22397b6d run from 2026-09-24 leaves main undetermined and is named, never green", async () => {
  const r = await observe({ runs: [...HEAD_RUNS, run(7047, STALE_GREEN, "success")] });
  assert.equal(r.observed.state, "undetermined");
  assert.equal(r.observed.decided_by_sha, HEAD);
  assert.match(String(r.observed.reason), new RegExp(STALE_GREEN));
  assert.match(String(r.observed.reason), /first-parent/);
  assert.equal(r.calls.some((p) => p.includes("/runs/7047/jobs?")), false, "a run outside the window is never read");
});

test("W1-T6023: the ca9be1f7 run from 2026-10-05 leaves main undetermined, never red", async () => {
  const r = await observe({ runs: [...HEAD_RUNS, run(9381, STALE_RED, "failure")], jobs: { 9381: "failure" } });
  assert.equal(r.observed.state, "undetermined");
  assert.equal(r.observed.decided_by_sha, HEAD);
  assert.match(String(r.observed.reason), new RegExp(STALE_RED));
  assert.equal(r.rows.some((row) => row.step === "main.health.escalated"), false);
});

test("W1-T6023: a stale run ahead of a recent one is skipped and the recent one decides", async () => {
  const r = await observe({ runs: [...HEAD_RUNS, run(7047, STALE_GREEN, "success"), run(1, PARENT, "failure")], jobs: { 1: "failure" } });
  assert.equal(r.observed.state, "red");
  assert.equal(r.observed.decided_by_sha, PARENT);
});

test("W1-T6023: an unreadable first-parent window leaves main undetermined and names the failed read", async () => {
  const cases: Array<[string, () => unknown]> = [
    ["thrown", () => {
      throw new Error("commits unavailable");
    }],
    ["head absent", () => commitsPage([PARENT, GRANDPARENT])],
    ["not a list", () => ({ message: "Not Found" })],
  ];
  for (const [label, commits] of cases) {
    const r = await observe({ runs: [...HEAD_RUNS, run(1, PARENT, "success")], commits });
    assert.equal(r.observed.state, "undetermined", label);
    assert.equal(r.observed.decided_by_sha, HEAD, label);
    assert.match(String(r.observed.reason), /first-parent commits were not read/, label);
    assert.ok(r.rows.some((row) => row.step === "main.health.recent_commits_unreadable"), label);
  }
});
