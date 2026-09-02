import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readCiGateRequiredChecks } from "../src/lib/ci-gate-required.js";
import { DEFAULT_SWEEP_POLICY, runSweep, type CiFailure, type SweepDeps } from "../src/lib/sweep.js";
import { buildOpenPrViews } from "../src/run-task.js";

const OWNER = "craigoley";
const REPO = "remudero";
const HEAD = "3555deadbeef3555deadbeef3555deadbeef3555";

function ledgerPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "rmd-red-gate-")), "ledger.ndjson");
  writeFileSync(path, "");
  return path;
}

function boardFetch(args: string[]): unknown {
  const path = args[args.length - 1] ?? "";
  if (/state=open/.test(path)) {
    return [{
      number: 3555,
      html_url: `https://github.com/${OWNER}/${REPO}/pull/3555`,
      head: { ref: "run-W1-T2598-1", sha: HEAD },
      updated_at: "2026-09-01T22:53:12Z",
      body: "Remudero-Task: W1-T2598",
      auto_merge: null,
      state: "open",
    }];
  }
  if (/check-runs/.test(path)) {
    return { check_runs: [
      { name: "ci-gate", status: "in_progress", started_at: "2026-09-01T22:50:00Z" },
      { name: "coverage-ratchet", status: "completed", conclusion: "failure", started_at: "2026-09-01T22:51:00Z", details_url: "https://github.com/craigoley/remudero/actions/runs/1/job/11" },
      { name: "optional-scanner", status: "completed", conclusion: "failure", started_at: "2026-09-01T22:51:30Z", details_url: "https://github.com/craigoley/remudero/actions/runs/1/job/12" },
      { name: "ci", status: "in_progress", started_at: "2026-09-01T22:52:00Z" },
    ] };
  }
  if (/\/status$/.test(path)) return { statuses: [] };
  return [];
}

test("the checked-out ci-gate REQUIRED contract parses a JSON string and malformed input fails closed", () => {
  const reads: string[] = [];
  const valid = readCiGateRequiredChecks("/checkout", (path) => {
    reads.push(path);
    return `jobs:\n  ci-gate:\n    env:\n      REQUIRED: >-\n        [\"ci\", \"coverage-ratchet\"]\n`;
  });
  assert.deepEqual(valid, ["ci", "coverage-ratchet"]);
  assert.deepEqual(reads, [join("/checkout", ".github", "workflows", "ci-gate.yml")]);
  assert.deepEqual(readCiGateRequiredChecks("/checkout", () => "jobs: ["), []);
  assert.deepEqual(readCiGateRequiredChecks("/checkout", () => "jobs: { ci-gate: { env: { REQUIRED: [ci] } } }"), []);
  assert.ok(
    readCiGateRequiredChecks(join(import.meta.dirname, "..")).includes("coverage-ratchet"),
    "the production reader parses this checkout's actual folded REQUIRED value",
  );
});

test("the ci-gate contract is read once for a board containing multiple PRs", () => {
  let contractReads = 0;
  const fetch = (args: string[]): unknown => {
    const value = boardFetch(args);
    if (/state=open/.test(args[args.length - 1] ?? "")) {
      const first = (value as Array<Record<string, unknown>>)[0];
      return [first, {
        ...first,
        number: 3556,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/3556`,
        head: { ref: "run-W1-T2598-2", sha: `${HEAD.slice(0, -1)}6` },
      }];
    }
    return value;
  };
  const views = buildOpenPrViews(OWNER, REPO, ledgerPath(), {
    fetch,
    requiredContexts: () => ["ci-gate", "remudero-review"],
    readCiGateRequired: () => { contractReads++; return ["coverage-ratchet"]; },
    fetchCiFailureEvidence: () => [],
  });
  assert.equal(views.length, 2);
  assert.equal(contractReads, 1, "one filesystem contract read serves both PR views");
});

test("pending ci-gate plus a red required child builds fixable evidence once and excludes optional failures", async () => {
  let contractReads = 0;
  const evidenceInputs: string[][] = [];
  const views = buildOpenPrViews(OWNER, REPO, ledgerPath(), {
    fetch: boardFetch,
    requiredContexts: () => ["ci-gate", "remudero-review"],
    readCiGateRequired: () => {
      contractReads++;
      return ["ci", "coverage-ratchet"];
    },
    fetchCiFailureEvidence: (_owner, _repo, rollup): CiFailure[] => {
      evidenceInputs.push((rollup ?? []).map((check) => check.name ?? check.context ?? "unknown"));
      return (rollup ?? []).map((check) => ({
        name: check.name ?? check.context ?? "unknown",
        logTail: "Uncovered Lines: 42-47",
      }));
    },
  });

  assert.equal(contractReads, 1, "the workflow contract is read once for the whole board, never once per PR");
  assert.equal(views[0].checksState, "pending", "the aggregate itself is still pending");
  assert.deepEqual(views[0].redRequiredChecks, ["coverage-ratchet"]);
  assert.deepEqual(evidenceInputs, [["coverage-ratchet"]], "only the red REQUIRED child reaches evidence collection");
  assert.deepEqual(views[0].ciFailures?.map((failure) => failure.name), ["coverage-ratchet"]);

  const dispatched: CiFailure[][] = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (_pr, evidence) => { dispatched.push(evidence.ciFailures ?? []); },
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-W1-T2599",
    now: () => Date.parse("2026-09-01T22:54:00Z"),
  };
  await runSweep(views, deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(dispatched.map((failures) => failures.map((failure) => failure.name)), [["coverage-ratchet"]]);
});

test("optional red checks and all-pending required checks remain wait states and fetch no evidence", async () => {
  for (const required of [["ci"], ["ci", "coverage-ratchet"]]) {
    let evidenceFetches = 0;
    const fetch = (args: string[]): unknown => {
      const value = boardFetch(args);
      if (/check-runs/.test(args[args.length - 1] ?? "") && required.includes("coverage-ratchet")) {
        return { check_runs: [
          { name: "ci-gate", status: "in_progress" },
          { name: "ci", status: "in_progress" },
          { name: "coverage-ratchet", status: "in_progress" },
          { name: "optional-scanner", status: "completed", conclusion: "failure" },
        ] };
      }
      return value;
    };
    const views = buildOpenPrViews(OWNER, REPO, ledgerPath(), {
      fetch,
      requiredContexts: () => ["ci-gate", "remudero-review"],
      readCiGateRequired: () => required,
      fetchCiFailureEvidence: () => { evidenceFetches++; return []; },
    });
    assert.equal(views[0].checksState, "pending");
    assert.deepEqual(views[0].redRequiredChecks, []);
    assert.equal(views[0].ciFailures, undefined);
    assert.equal(evidenceFetches, 0);

    let dispatches = 0;
    await runSweep(views, {
      arm: () => {}, close: () => {}, dispatchFix: () => { dispatches++; }, escalate: () => {},
      ledgerPath: ledgerPath(), runId: "SWEEP-WAIT", now: () => Date.parse("2026-09-01T22:54:00Z"),
    }, DEFAULT_SWEEP_POLICY);
    assert.equal(dispatches, 0);
  }
});
