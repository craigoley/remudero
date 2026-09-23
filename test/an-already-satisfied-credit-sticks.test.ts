import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Task } from "../src/lib/plan.js";
import {
  defaultCreditStorePath,
  deriveStatus,
  loadCreditStore,
  persistVerifiedCredit,
  type GitHub,
} from "../src/lib/status.js";

// MEASURED 2026-09-22 on the fleet: W1-T3990 (4 runs, $526) and W1-T3991 (4 runs, $42) were each
// re-dispatched as `already_satisfied` — the worker's verifier credited the merged PR, the
// dispatcher's projection refused it, and nothing reconciled the two.

function task(id: string): Task {
  return { id, title: "t", repo: "remudero", depends_on: [], type: "implement", verify: "auto", risk: "high", status: "queued", attempts: 0 } as unknown as Task;
}

function gatewayFor(taskId: string, head: string): GitHub {
  const pr = { number: 6569, url: "https://github.com/o/r/pull/6569", state: "MERGED", headRefName: head };
  return {
    prByRef: () => null,
    findMergedByTrailer: (id: string) => (id === taskId ? pr : null),
    findMergedByHeadBranch: () => [],
    headRefName: () => head,
    prBody: () => `fix(transport): coordinate reads\n\nRemudero-Task: ${taskId}\n`,
    changedFiles: () => ["src/lib/github-transport.ts", "test/x.test.ts"],
  } as unknown as GitHub;
}

function derive(taskId: string, github: GitHub, readCreditStore = () => ({})) {
  return deriveStatus(task(taskId), {
    ledgerPath: "/tmp/does-not-exist/ledger.ndjson",
    github,
    readLedger: () => [],
    readCreditStore,
    writeCreditStore: () => {},
  });
}

test("a trailered merged PR on a run-unfiled- branch credits its task", () => {
  const proj = derive("W9-T3991", gatewayFor("W9-T3991", "run-unfiled-transport-floor-1790079900000"));
  assert.equal(proj.merged, true, "run-unfiled- names no task, so it must not veto the trailer");
  assert.equal(proj.prNumber, 6569);
});

test("control: a branch that names ANOTHER task still vetoes the trailer credit", () => {
  const proj = derive("W9-T3990", gatewayFor("W9-T3990", "run-W9-T3995-1790042443477"));
  assert.equal(proj.merged, false, "the W1-T69 ownership guard is unchanged for a real other-task branch");
});

test("a verified already_satisfied credit is persisted where the dispatcher reads it first", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-verified-credit-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  try {
    const pr = { number: 6492, url: "https://github.com/o/r/pull/6492" };
    assert.equal(persistVerifiedCredit(ledgerPath, "W9-T3990", pr, ["src/lib/feedback-landing.ts"]), "recorded");
    const storePath = defaultCreditStorePath(ledgerPath);
    assert.equal(loadCreditStore(storePath)["W9-T3990"]?.trailer?.prNumber, 6492);

    // The same branch-veto case as above, which refused live — now resolved by the durable rung.
    // No live evidence anywhere, so a merged #6492 can only have come from the durable store.
    const nothingLive = { prByRef: () => null, findMergedByTrailer: () => null, findMergedByHeadBranch: () => [], headRefName: () => undefined, prBody: () => undefined } as unknown as GitHub;
    assert.equal(derive("W9-T3990", nothingLive).merged, false, "control: without the persisted credit the task reads unbuilt");
    const proj = derive("W9-T3990", nothingLive, () => loadCreditStore(storePath));
    assert.equal(proj.merged, true, "the next projection must credit the task instead of re-dispatching it");
    assert.equal(proj.prNumber, 6492);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plan-only or unreadable file list persists nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-verified-credit-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  try {
    const pr = { number: 7000, url: "https://github.com/o/r/pull/7000" };
    assert.equal(persistVerifiedCredit(ledgerPath, "W9-T1", pr, ["plan/tasks.d/W9-T1-x.yaml"]), "plan-only");
    assert.equal(persistVerifiedCredit(ledgerPath, "W9-T1", pr, undefined), "unreadable");
    assert.equal(persistVerifiedCredit(ledgerPath, "W9-T1", pr, []), "unreadable");
    assert.deepEqual(loadCreditStore(defaultCreditStorePath(ledgerPath)), {}, "a filing PR must never become a durable credit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
