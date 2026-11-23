import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  DEPENDABOT_STUCK_PR_AGE_MS,
  prioritizeDepReviewRepairs,
  reconcileDependabotOwnRed,
  type DepReviewRepairSnapshot,
} from "#src/lib/dep-review.js";
import { appendProducerLedger } from "#src/lib/ledger.js";

const NOW = Date.parse("2026-11-17T04:34:19Z");
const FEEDBACK_ID = "fb-dep-review-sdk";
const CANDIDATES = ["older-incident", FEEDBACK_ID];
const OWNER = "craigoley";
const REPO = "remudero";
const PR = 42;
const HEAD = "a".repeat(40);

function repairFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-dep-repair-fold-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "dep-review-holds", OWNER, REPO);
  mkdirSync(dir, { recursive: true });
  const registryPath = join(dir, "own-red-proposals.json");
  const proposal = {
    feedbackId: FEEDBACK_ID, submissionKey: "dep-review:own-red:craigoley/remudero:sdk@1.0.1",
    bumps: ["sdk@1.0.1"], prNumbers: [41], filedAtMs: NOW,
  };
  const writeRegistry = (value: unknown) => writeFileSync(registryPath, JSON.stringify(value));
  writeRegistry({ proposals: [proposal] });
  const snapshot: DepReviewRepairSnapshot = { owner: OWNER, repo: REPO, asOfMs: NOW, prs: [{
    prNumber: PR, headSha: HEAD, headRefName: "dependabot/npm_and_yarn/sdk", checksState: "red",
    createdAt: new Date(NOW - DEPENDABOT_STUCK_PR_AGE_MS).toISOString(),
  }] };
  const reconcile = () => reconcileDependabotOwnRed({
    statePath: join(dir, `PR${PR}.json`), owner: OWNER, repo: REPO, prNumber: PR,
    prUrl: `https://github.com/${OWNER}/${REPO}/pull/${PR}`, headSha: HEAD,
    title: "build(deps): bump sdk from 1.0.0 to 1.0.1", body: "",
    result: {
      decision: "hold", semverLevel: "patch", pinOnly: false, offendingFiles: [],
      redChecks: ["ci"], migrationBumps: [], reason: "required check is red",
    },
    signal: "main-passes", nowMs: NOW,
    capture: () => assert.fail("a folded PR must reuse its proposal"),
    log: () => {},
  });
  return { root, registryPath, proposal, writeRegistry, snapshot, reconcile };
}

test("W1-T13098: auto_triage.repair_priority_unavailable no longer recurs", async (t) => {
  const f = repairFixture(t);
  const assertPriority = async () => {
    const events: string[] = [];
    const ordered = await prioritizeDepReviewRepairs(CANDIDATES, f.root, f.snapshot, NOW, step => events.push(step));
    assert.deepEqual(ordered, [FEEDBACK_ID, "older-incident"]);
    assert.deepEqual(events, ["auto_triage.repair_priority"]);
  };

  assert.equal(f.reconcile(), "observed");
  assert.equal(f.reconcile(), "folded");
  await assertPriority();

  // Recreate the registry left by a fold before the PR number was persisted.
  f.writeRegistry({ proposals: [f.proposal] });
  assert.equal(f.reconcile(), "proposed");
  assert.equal(f.reconcile(), "proposed");
  assert.deepEqual(JSON.parse(readFileSync(f.registryPath, "utf8")).proposals, [
    { ...f.proposal, prNumbers: [41, PR] },
  ]);
  await assertPriority();

  const otherProposal = { ...f.proposal, feedbackId: "fb-other-repair" };
  f.writeRegistry({ proposals: [otherProposal] });
  assert.equal(f.reconcile(), "proposed");
  assert.deepEqual(JSON.parse(readFileSync(f.registryPath, "utf8")).proposals, [otherProposal]);
});

test("W1-T13098: the symptom is still recorded when its failure occurs", async (t) => {
  const f = repairFixture(t);
  writeFileSync(f.registryPath, "{broken");
  const ledgerPath = join(f.root, "ledger.ndjson");
  const ordered = await prioritizeDepReviewRepairs(CANDIDATES, f.root, f.snapshot, NOW, (step, extra) =>
    appendProducerLedger(ledgerPath, "daemon", { run_id: "AUTO-TRIAGE", step, ...extra }));

  assert.deepEqual(ordered, CANDIDATES);
  const rows = readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.step, row.reasonCode, row.candidate_count]), [
    ["auto_triage.repair_priority_unavailable", "binding-unreadable", CANDIDATES.length],
  ]);
});
