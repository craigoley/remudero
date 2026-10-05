import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollupFor, rollupForAsync, rollupFromRest } from "../src/lib/open-prs-rest.js";
import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import {
  buildSweepEffects, cancelledRequiredCheckNames, checkJobId, checksStateFromRollup,
  classifyRollupSupersession, dedupeRollupByLatestAttempt, redQualityGateNames,
  stillRedRequiredNames, type OpenPrView,
} from "../src/lib/sweep.js";

const NAME = "coverage-ratchet";
const OLD = 37217449601;
const NEW = 37218417499;
const workflows = [{ id: OLD, workflow_id: 10 }, { id: NEW, workflow_id: 10 }];
const check = (run: number, id: number, conclusion: string, minute: string) => ({
  id, name: NAME, status: "completed", conclusion,
  started_at: `2026-10-04T${minute}:00Z`, completed_at: `2026-10-04T${minute}:30Z`,
  details_url: `https://github.com/o/r/actions/runs/${run}/job/${id}`,
});
const triple = [check(OLD, 101, "failure", "16:54"), check(NEW, 102, "success", "17:13"), check(OLD, 103, "failure", "17:45")];

test("test/a-superseded-runs-rerun-never-overrides-the-newest-run.test.ts: #9124 triple, same-run retry, and lone failure", () => {
  const rollup = rollupFromRest(triple, [], workflows);
  for (const rows of [rollup, [...rollup].reverse()]) {
    assert.deepEqual(stillRedRequiredNames([NAME], rows), []);
    assert.equal(checksStateFromRollup(rows, [NAME]), "green");
    assert.deepEqual(redQualityGateNames(rows, [NAME]), []);
    assert.equal(dedupeRollupByLatestAttempt(rows)[0].checkRunId, 102);
    assert.equal(classifyRollupSupersession(rows).superseded.length, 2);
  }
  const retry = rollupFromRest([triple[0], check(OLD, 104, "success", "17:45")], [], workflows);
  assert.deepEqual(stillRedRequiredNames([NAME], retry), []);
  assert.equal(dedupeRollupByLatestAttempt(retry)[0].checkRunId, 104);
  const lone = rollupFromRest([triple[0]], [], workflows);
  assert.deepEqual(stillRedRequiredNames([NAME], lone), [NAME]);
  assert.equal(checksStateFromRollup(lone, [NAME]), "red");
});

test("REST identity records workflow, run, job, and external id without losing commit statuses", () => {
  const row = { ...triple[0], external_id: "job:101" };
  const [mapped, status] = rollupFromRest([row], [{ context: "remudero-review", state: "success" }], workflows);
  assert.equal(mapped.workflowRunId, OLD);
  assert.equal(mapped.workflowId, 10);
  assert.equal(mapped.jobId, "101");
  assert.equal(mapped.externalId, "job:101");
  assert.equal(checkJobId(mapped), "101");
  assert.deepEqual(status, { context: "remudero-review", state: "SUCCESS" });
});

test("different workflows sharing ci-gate use latest completion after each selects its newest run", () => {
  const rows = rollupFromRest([
    { ...check(NEW, 201, "failure", "16:53"), name: "ci-gate" },
    { ...check(OLD, 202, "success", "16:00"), name: "ci-gate", completed_at: "2026-10-04T17:45:00Z" },
  ], [], [{ id: OLD, workflow_id: 10 }, { id: NEW, workflow_id: 20 }]);
  for (const order of [rows, [...rows].reverse()]) {
    assert.equal(checksStateFromRollup(order, ["ci-gate"]), "green");
    assert.equal(dedupeRollupByLatestAttempt(order)[0].checkRunId, 202);
  }
  rows[0].completedAt = "2026-10-04T18:00:00Z";
  assert.equal(checksStateFromRollup(rows, ["ci-gate"]), "red");
});

test("posted run-scoped gates select newest run even when GitHub rewrites the details URL", () => {
  const rows = rollupFromRest(triple.map((c, index) => ({
    ...c, details_url: `https://github.com/o/r/runs/${c.id}`,
    external_id: `run:${index === 1 ? NEW : OLD}:${index === 2 ? 2 : 1}:job:${c.id}`,
  })), [], workflows);
  assert.equal(rows[0].workflowRunId, OLD);
  assert.equal(rows[2].jobId, "103");
  assert.deepEqual(stillRedRequiredNames([NAME], rows), []);
  assert.equal(checkJobId(dedupeRollupByLatestAttempt(rows)[0]), "102");
});

test("legacy job-only posted gates remain a separate producer from Actions checks", () => {
  const rows = rollupFromRest([
    check(NEW, 301, "failure", "17:00"),
    { ...check(OLD, 302, "success", "16:00"), external_id: "job:302", completed_at: "2026-10-04T18:00:00Z" },
  ], [], workflows);
  assert.equal(checksStateFromRollup(rows, [NAME]), "green");
});

test("a superseded cancellation never supplies the requeue target and skipped stays green", () => {
  const rows = rollupFromRest([check(OLD, 401, "cancelled", "18:00"), check(NEW, 402, "skipped", "17:00")], [], workflows);
  assert.deepEqual(cancelledRequiredCheckNames(rows, [NAME]), []);
  assert.equal(checksStateFromRollup(rows, [NAME]), "green");
});

test("a later successful retry of an older run cannot hide the newest run's real failure", () => {
  const rows = rollupFromRest([check(NEW, 402, "failure", "17:00"), check(OLD, 403, "success", "18:00")], [], workflows);
  assert.deepEqual(stillRedRequiredNames([NAME], rows), [NAME]);
  assert.equal(checksStateFromRollup(rows, [NAME]), "red");
  assert.equal(dedupeRollupByLatestAttempt(rows)[0].checkRunId, 402);
});

test("same-run timestamp ties still use numeric check-run ids", () => {
  const rows = rollupFromRest([check(NEW, 502, "success", "17:00"), check(NEW, 501, "failure", "17:00")], [], workflows);
  assert.equal(dedupeRollupByLatestAttempt(rows)[0].checkRunId, 502);
  assert.equal(checksStateFromRollup(rows, [NAME]), "green");
});

function fetcher(checks = triple) {
  const calls: string[] = [];
  const fetch = (args: string[]): unknown => {
    calls.push(args[1]);
    if (args[1].includes("/check-runs?")) return { check_runs: checks };
    if (args[1].endsWith("/status")) return { statuses: [{ context: "remudero-review", state: "success" }] };
    if (args[1].includes("/actions/runs?head_sha=")) return { workflow_runs: workflows };
    throw new Error(`unexpected endpoint ${args[1]}`);
  };
  return { calls, fetch };
}

test("sync and async REST readers hydrate competing run identities from the head's workflow listing", async () => {
  const sync = fetcher();
  const asynchronous = fetcher();
  const first = rollupFor("o", "r", "head", sync.fetch);
  const second = await rollupForAsync("o", "r", "head", async (args) => asynchronous.fetch(args));
  assert.deepEqual(first, second);
  for (const rows of [first, second]) {
    assert.equal(rows[1].workflowId, 10);
    assert.deepEqual(stillRedRequiredNames([NAME], rows), []);
    assert.ok(rows.some((row) => row.context === "remudero-review"));
  }
  assert.equal(sync.calls.filter((url) => url.includes("/actions/runs?head_sha=")).length, 1);
  assert.deepEqual(sync.calls, asynchronous.calls);
});

test("workflow listing errors propagate rather than inventing a healthy rollup", async () => {
  const source = fetcher();
  const fetch = (args: string[]) => {
    if (args[1].includes("/actions/runs?")) throw new Error("workflow identity unavailable");
    return source.fetch(args);
  };
  assert.throws(() => rollupFor("o", "r", "head", fetch), /workflow identity unavailable/);
  await assert.rejects(rollupForAsync("o", "r", "head", async (args) => fetch(args)), /workflow identity unavailable/);
});

test("missing workflow identity retains legacy ordering rather than comparing unrelated run ids", () => {
  const rows = rollupFromRest(triple, [], []);
  assert.equal(rows[0].workflowId, undefined);
  assert.deepEqual(stillRedRequiredNames([NAME], rows), [NAME]);
  assert.equal(rollupFromRest([{ name: NAME, details_url: "https://github.com/o/r/runs/123" }], [], [])[0].workflowRunId, undefined);
});

test("uncontested runs and same-run retries need no extra workflow read", async () => {
  for (const checks of [[triple[0]], [triple[0], check(OLD, 104, "success", "18:00")], []]) {
    const source = fetcher(checks);
    const rows = await rollupForAsync("o", "r", "head", async (args) => source.fetch(args));
    assert.equal(source.calls.length, 2);
    assert.equal(rows.at(-1)?.context, "remudero-review");
  }
});

test("raw run-scoped posted checks carry run identity without a workflow listing", () => {
  const rows = rollupFromRest(triple.map((c, index) => ({
    ...c, details_url: null,
    external_id: `run:${index === 1 ? NEW : OLD}:1:job:${c.id}`,
  })), []);
  assert.deepEqual(stillRedRequiredNames([NAME], rows), []);
  assert.equal(rows[0].workflowRunId, OLD);
});

test("the production arm fact reader resolves the superseded run on its exact head", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-run-identity-"));
  const calls: string[] = [];
  try {
    const effects = buildSweepEffects({
      owner: "o", repo: "r", config: { root } as Config,
      ledgerPath: join(root, "ledger.ndjson"), runId: "identity-test",
      plan: { tasks: [], byId: new Map() } as unknown as Plan, log: () => {},
      readJsonImpl: async (args) => {
        const path = args[1];
        calls.push(path);
        if (path.endsWith("/pulls/10")) return {
          number: 10, state: "open", auto_merge: null, merged: false, draft: false,
          head: { sha: "head" }, base: { sha: "base", ref: "main" },
          mergeable: true, mergeable_state: "clean",
        };
        if (path.includes("/protection/")) return { contexts: [NAME, "remudero-review"] };
        if (path.includes("/check-runs?")) return { total_count: 3, check_runs: triple };
        if (path.endsWith("/status")) return {
          sha: "head", total_count: 1, statuses: [{ context: "remudero-review", state: "success" }],
        };
        if (path.includes("/actions/runs?")) return { workflow_runs: workflows };
        throw new Error(`unexpected endpoint ${path}`);
      },
    });
    const facts = await effects.readArmFacts!({ prNumber: 10, headSha: "head" } as OpenPrView);
    assert.equal(facts?.headSha, "head");
    assert.equal(facts?.checksGreen, true);
    assert.equal(facts?.reviewPublished, true);
    assert.ok(calls.includes("repos/o/r/actions/runs?head_sha=head&per_page=100"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
