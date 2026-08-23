import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStaleGateWorkflowsByPr, updatedForWorkflowFromLedger } from "../src/run-task.js";
import type { OpenPrView } from "../src/lib/sweep.js";

// ── W1-T1212: the READ HALF's real wiring ───────────────────────────────────────────────────
//
// `buildStaleGateWorkflowsByPr` and `updatedForWorkflowFromLedger` are the ONLY two exported
// names in this lane (`staleGateFailureNames`/`blobShaAtRef` are private helpers reached only
// through the former) — see run-task.ts's own docs on each. These tests exercise the
// PATH-stubbed-`gh` pattern the rest of this suite already uses (e.g.
// "buildSweepHook: the daemon sweep closure runs EVERY rung" in run-task.test.ts) rather than
// mocking `child_process` directly, so every branch — the stale/not-stale compare, a failed
// blob read on either ref, and an unmapped check name that never spends a `gh` call at all —
// runs through the SAME code path production does.

function pr(over: Partial<OpenPrView>): OpenPrView {
  return {
    prNumber: 1,
    prUrl: "https://github.com/o/r/pull/1",
    reviewState: "none",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: "2026-08-21T12:00:00Z",
    headSha: "aaaa111",
    autoMergeArmed: false,
    ...over,
  };
}

test("buildStaleGateWorkflowsByPr: reads each red PR's own merge-ref blob against main, over real gh calls", async (t) => {
  const bin = mkdtempSync(join(tmpdir(), "gh-stale-gate-"));
  // `gh api repos/<o>/<r>/contents/<path> -f ref=<ref> --jq .sha` — argv: $1 api, $2 the repos
  // path, $3 -f, $4 ref=<ref>, $5 --jq, $6 .sha. Branches purely on the ref (the path is always
  // `.github/workflows/ci-gate.yml`, the sole STALE_GATE_WORKFLOW_FILE entry — see that map's
  // own doc for why), so one stub script covers every PR in this test.
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'ref="${4#ref=}"',
      'case "$ref" in',
      "  pull/300/merge) echo AAA1111 ;;", // stale: differs from main below
      "  pull/301/merge) echo MMM9999 ;;", // not stale: identical to main below
      "  pull/302/merge) exit 1 ;;", // simulates a gh failure on the PR's OWN ref
      "  main) echo MMM9999 ;;",
      "  *) exit 1 ;;",
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  });

  const stale = pr({ prNumber: 300, checksState: "red", ciFailures: [{ name: "ci-gate", logTail: "x" }] });
  const notStale = pr({ prNumber: 301, checksState: "red", ciFailures: [{ name: "ci-gate", logTail: "x" }] });
  const readFails = pr({ prNumber: 302, checksState: "red", ciFailures: [{ name: "ci-gate", logTail: "x" }] });
  const unmappedName = pr({ prNumber: 303, checksState: "red", ciFailures: [{ name: "other-check", logTail: "x" }] });
  const notRed = pr({ prNumber: 304, checksState: "green", ciFailures: [] });
  const noFailures = pr({ prNumber: 305, checksState: "red" }); // ciFailures left undefined

  const out = buildStaleGateWorkflowsByPr("o", "r", [stale, notStale, readFails, unmappedName, notRed, noFailures]);

  assert.deepEqual([...out.entries()], [[300, ["ci-gate"]]], "only the genuinely stale PR gets a map entry");
});

test("updatedForWorkflowFromLedger: reads back the same 'pr_number:workflow' dedup key runSweep wrote", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-stale-gate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  try {
    const rows = [
      { run_id: "R1", task_id: "SWEEP", step: "sweep.update_branch.updated", pr_number: 2440, stale_workflow: "ci-gate" },
      // a DIFFERENT step name is skipped entirely, whatever shape its own fields carry
      { run_id: "R1", task_id: "SWEEP", step: "sweep.dispose.mergeable", pr_number: 9999, stale_workflow: "ci-gate" },
      // the right step but a malformed pair (wrong types) contributes nothing rather than a
      // corrupt key
      { run_id: "R1", task_id: "SWEEP", step: "sweep.update_branch.updated", pr_number: "not-a-number", stale_workflow: "ci-gate" },
      { run_id: "R1", task_id: "SWEEP", step: "sweep.update_branch.updated", pr_number: 2441 },
    ];
    for (const row of rows) appendFileSync(ledgerPath, JSON.stringify(row) + "\n");

    assert.deepEqual([...updatedForWorkflowFromLedger(ledgerPath)], ["2440:ci-gate"]);

    // No ledger on disk at all — fails toward "nothing spent yet", never a throw.
    assert.deepEqual([...updatedForWorkflowFromLedger(join(dir, "missing.ndjson"))], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
