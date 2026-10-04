// W1-T5630 — the main-health rung reads main's completed run history ONCE PER HEAD, not once per
// observation. #8961/W1-T5490 made `buildMainHealthRung` read the 100-run `actions/runs?…
// status=completed` page on every observation that cleared the 10 s `freshMs` window: the live
// ledger showed 72 observations over 7 heads in 88 minutes, each head's page refetched ~10 times,
// and each fallback-decided one also re-reading up to five completed runs' jobs pages that cannot
// change unless re-run. The cache is keyed on the head sha plus its COMPLETED rollup entries, aged
// by the injected clock (never the wall clock), and stamps `run_history_source` on the row.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMainHealthRung, MAIN_HEALTH_RUN_HISTORY_TTL_MS } from "../src/lib/main-health-rung.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const HEAD = "a".repeat(40);
const NEXT = "c".repeat(40);
const LAST = "b".repeat(40);
const FRESH_MS = 10_000;

type Check = { name: string; status: string; conclusion: string | null };
const check = (name: string, conclusion: string | null): Check => ({
  name,
  conclusion,
  status: conclusion ? "completed" : "in_progress",
});

interface Harness {
  /** Mutable world the fake GitHub answers from. */
  head: string;
  checks: Check[];
  statuses: { context: string; state: string }[];
  historyFails: boolean;
  historyUndefined: boolean;
  jobsFail: boolean;
  nowMs: number;
  historyReads: number;
  jobsReads: number;
  rows: Record<string, unknown>[];
  rung: () => Promise<void>;
  /** Advance the injected clock past `freshMs` and observe once. */
  observe: (advanceMs?: number) => Promise<Record<string, unknown>>;
  cleanup: () => void;
}

function harness(options: { injectReader?: boolean } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5630-`));
  const h = {
    head: HEAD,
    checks: [check("ci", "cancelled")],
    statuses: [],
    historyFails: false,
    historyUndefined: false,
    jobsFail: false,
    nowMs: 1_000,
    historyReads: 0,
    jobsReads: 0,
    rows: [],
  } as unknown as Harness;
  const history = () => ({
    workflow_runs: [
      { id: 2, name: "CI", head_sha: HEAD, conclusion: "cancelled" },
      { id: 1, name: "CI", head_sha: LAST, conclusion: "success" },
    ],
  });
  const fetch = async (args: string[]) => {
    const path = args[1]!;
    if (path === "repos/o/r") return { default_branch: "trunk" };
    if (path === "repos/o/r/commits/trunk") return { sha: h.head };
    if (path.includes("/check-runs?")) return { check_runs: h.checks };
    if (path.endsWith("/status")) return { statuses: h.statuses };
    if (path.includes("/actions/runs?")) {
      h.historyReads++;
      if (h.historyFails) throw new Error("history unavailable");
      return history();
    }
    if (path.includes("/jobs?")) {
      h.jobsReads++;
      if (h.jobsFail) throw new Error("jobs unavailable");
      return { jobs: [{ ...check("ci", "success"), id: 7 }] };
    }
    throw new Error(`unrouted: ${path}`);
  };
  h.rung = buildMainHealthRung("o", "r", {
    fetch,
    issues: { create: () => "https://github.com/o/r/issues/1", listOpen: () => [], closeWithComment: () => {} },
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "T5630",
    log: (step, extra) => {
      h.rows.push({ step, ...extra });
    },
    freshMs: FRESH_MS,
    now: () => h.nowMs,
    readRequiredChecks: () => ["ci"],
    ...(options.injectReader
      ? {
          readMainRunHistory: async () => {
            h.historyReads++;
            if (h.historyFails) throw new Error("history unavailable");
            if (h.historyUndefined) return undefined;
            return [
              { headSha: HEAD, workflowName: "CI", runId: 2, conclusion: "cancelled" },
              { headSha: LAST, workflowName: "CI", runId: 1, conclusion: "success" },
            ];
          },
        }
      : {}),
  });
  h.observe = async (advanceMs = FRESH_MS + 1) => {
    h.nowMs += advanceMs;
    const before = h.rows.length;
    await h.rung();
    const observed = h.rows.slice(before).find((r) => r.step === "main.health.observed");
    assert.ok(observed, "every observation writes its main.health.observed row");
    return observed;
  };
  h.cleanup = () => rmSync(root, { recursive: true, force: true });
  return h;
}

test("W1-T5630: two observations of one head with an unchanged rollup fetch the run history once", async () => {
  const h = harness();
  try {
    const first = await h.observe();
    const second = await h.observe();
    assert.equal(h.historyReads, 1, "the second observation past freshMs reuses the first head's history");
    assert.equal(h.jobsReads, 1, "a completed run's jobs are read once under the same key");
    assert.equal(first.run_history_source, "fetched");
    assert.equal(second.run_history_source, "cache");
    assert.equal(second.state, "green", "the cached fallback evidence still decides the verdict");
    assert.equal(second.decided_by_sha, LAST);
  } finally {
    h.cleanup();
  }
});

test("W1-T5630: a new head refetches the run history", async () => {
  const h = harness();
  try {
    await h.observe();
    h.head = NEXT;
    const observed = await h.observe();
    assert.equal(h.historyReads, 2);
    assert.equal(h.jobsReads, 2, "the jobs cache is keyed with the history, so a new head re-reads it");
    assert.equal(observed.run_history_source, "fetched");
  } finally {
    h.cleanup();
  }
});

test("W1-T5630: a newly completed check on the same head refetches the run history", async () => {
  const h = harness();
  try {
    h.checks = [check("ci", "cancelled"), check("main-plan-guard", null)];
    await h.observe();
    h.checks = [check("ci", "cancelled"), check("main-plan-guard", "success")];
    const observed = await h.observe();
    assert.equal(h.historyReads, 2, "a guard workflow finishing on the head changes the key");
    assert.equal(observed.run_history_source, "fetched");
  } finally {
    h.cleanup();
  }
});

test("W1-T5630: a commit status leaving pending changes the key, while one still pending does not", async () => {
  const h = harness();
  try {
    h.statuses = [{ context: "external", state: "pending" }];
    await h.observe();
    await h.observe();
    assert.equal(h.historyReads, 1, "a still-pending status is not a completed entry");
    h.statuses = [{ context: "external", state: "success" }];
    await h.observe();
    assert.equal(h.historyReads, 2, "a status that concluded joins the key");
  } finally {
    h.cleanup();
  }
});

test("W1-T5630: TTL expiry refetches the run history, and one millisecond short of it does not", async () => {
  assert.equal(MAIN_HEALTH_RUN_HISTORY_TTL_MS, 5 * 60_000);
  for (const [ageMs, reads, source] of [
    [MAIN_HEALTH_RUN_HISTORY_TTL_MS - 1, 1, "cache"],
    [MAIN_HEALTH_RUN_HISTORY_TTL_MS, 2, "fetched"],
  ] as const) {
    const h = harness();
    try {
      await h.observe();
      const observed = await h.observe(ageMs);
      assert.equal(h.historyReads, reads, `history reads at age ${ageMs} ms`);
      assert.equal(observed.run_history_source, source);
    } finally {
      h.cleanup();
    }
  }
});

test("W1-T5630: a clock that steps backwards refetches instead of trusting a negative age", async () => {
  const h = harness();
  try {
    await h.observe();
    h.nowMs -= 60_000;
    const observed = await h.observe(0);
    assert.equal(h.historyReads, 2);
    assert.equal(observed.run_history_source, "fetched");
  } finally {
    h.cleanup();
  }
});

test("W1-T5630: an unreadable history read is never cached; the next observation reads again", async () => {
  const h = harness();
  try {
    h.historyFails = true;
    const failed = await h.observe();
    assert.equal(failed.state, "undetermined");
    assert.equal(failed.run_history_source, "fetched");
    assert.ok(h.rows.some((r) => r.step === "main.health.run_history_unreadable"));
    h.historyFails = false;
    const recovered = await h.observe();
    assert.equal(h.historyReads, 2, "the failed read left nothing to reuse");
    assert.equal(recovered.run_history_source, "fetched");
    assert.equal(recovered.state, "green");
    await h.observe();
    assert.equal(h.historyReads, 2, "the recovered read is cached");
  } finally {
    h.cleanup();
  }
});

test("W1-T5630: an injected reader that returns no evidence is never cached either", async () => {
  const h = harness({ injectReader: true });
  try {
    h.historyUndefined = true;
    const empty = await h.observe();
    assert.equal(empty.state, "undetermined");
    h.historyUndefined = false;
    await h.observe();
    await h.observe();
    assert.equal(h.historyReads, 2, "only the reader's real evidence is cached");
  } finally {
    h.cleanup();
  }
});

test("W1-T5630: an unreadable jobs page is never cached; cached history still re-reads the jobs", async () => {
  const h = harness();
  try {
    h.jobsFail = true;
    const failed = await h.observe();
    assert.equal(failed.state, "undetermined");
    assert.ok(h.rows.some((r) => r.step === "main.health.completed_run_unreadable"));
    h.jobsFail = false;
    const recovered = await h.observe();
    assert.equal(recovered.run_history_source, "cache");
    assert.equal(h.historyReads, 1);
    assert.equal(h.jobsReads, 2, "the failed jobs read left nothing to reuse");
    assert.equal(recovered.state, "green");
    await h.observe();
    assert.equal(h.jobsReads, 2, "the recovered jobs read is cached");
  } finally {
    h.cleanup();
  }
});
