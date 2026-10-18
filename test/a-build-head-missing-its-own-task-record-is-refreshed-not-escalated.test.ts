// W1-T9232 — #11374 (W1-T9071) was built on a branch cut before its shard merged. Review read the plan AT THE HEAD,
// found no record, skipped the reviewer and failed with no criteria; the sweep escalated it as "contradictory" until
// a hand merge of main. The head is now PENDING with a named cause and the sweep refreshes it from main.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { gitRepo } from "#test/helpers/git-repo.js";
import { appendLedger } from "#src/lib/ledger.js";
import { readLedgerLines } from "#src/lib/status.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import {
  DEFAULT_SWEEP_POLICY,
  OWN_TASK_RECORD_MISSING_CAUSE,
  OWN_TASK_RECORD_REFRESH_STEP,
  headLacksOwnTaskRecord,
  runSweep,
  type OpenPrView,
  type SweepDeps,
  type UpdateBranchOutcome,
} from "#test/helpers/sweep-test.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TASK_TS = join(REPO_ROOT, "src", "run-task.ts");

const taskYaml = (id: string): string =>
  [
    `- id: ${id}`, `  title: ${id.toLowerCase()}`, "  repo: remudero", "  type: implement", "  depends_on: []",
    "  verify: auto", "  risk: low", "  budget_usd: 1.00", "  status: queued", "  attempts: 0",
    "  acceptance:", `    - claim: "${id} claim"`, `      proof: "${id} claim, per the PR body"`,
  ].join("\n");

interface Scenario { name: string; headRefOid: string; body: string; headRefName?: string }
interface ProbeRow { name: string; code?: number; reviewRan: boolean; pendingPosts: number; ledger: Record<string, unknown>[]; error?: string }

/** Drive the REAL reviewCommand in a child pinned to `scratch` (`--repo-root`), once per scenario. */
function drive(scratch: string, scenarios: Scenario[]): ProbeRow[] {
  const stateRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9232-state-`));
  const scriptDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9232-probe-`));
  const script = join(scriptDir, "probe.ts");
  try {
    writeFileSync(script, [
      "console.log = () => {}; console.error = () => {};",
      `import { reviewCommand } from ${JSON.stringify(RUN_TASK_TS)};`,
      `import { existsSync, readFileSync } from "node:fs";`,
      `const scenarios = ${JSON.stringify(scenarios)};`,
      `const stateRoot = ${JSON.stringify(stateRoot)};`,
      "async function main() {",
      "  const out = [];",
      "  for (const s of scenarios) {",
      "    let reviewRan = false; let pendingPosts = 0;",
      "    const row = { name: s.name, reviewRan: false, pendingPosts: 0, ledger: [] };",
      "    try {",
      '      row.code = await reviewCommand("w1t9232-branch", ["--repo", "o/r"], {',
      '        fetchView: () => ({ headRefOid: s.headRefOid, headRefName: s.headRefName ?? "b", body: s.body, url: "https://github.com/o/r/pull/7", number: 7 }),',
      "        loadConfig: () => ({ root: stateRoot }),",
      '        materialize: () => ({ worktreePath: undefined, failure: { errorClass: "test", message: "skip" } }),',
      "        postReviewPending: async () => { pendingPosts += 1; return { posted: true }; },",
      '        runReview: async () => { reviewRan = true; return { state: "failure", headSha: s.headRefOid, reviewerOutcome: "not_attempted", criteria: [] }; },',
      "      });",
      "    } catch (e) { row.error = String((e && e.stack) || e); }",
      "    row.reviewRan = reviewRan; row.pendingPosts = pendingPosts;",
      '    const p = stateRoot + "/state/ledger.ndjson";',
      '    row.ledger = existsSync(p) ? readFileSync(p, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];',
      "    out.push(row);",
      "  }",
      "  process.stdout.write(JSON.stringify(out));",
      "}",
      "main();",
    ].join("\n"));
    const env = { ...process.env };
    env.NODE_V8_COVERAGE = undefined;
    const r = spawnSync(process.execPath, ["--import", "tsx", script, "--repo-root", scratch], { cwd: REPO_ROOT, encoding: "utf8", env });
    assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
    return JSON.parse(r.stdout) as ProbeRow[];
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

/** main = c1 (shard W1-T9999 present); the build head = c0 (cut before the shard merged). */
function fixture(): { dir: string; c0: string; c1: string } {
  const repo = gitRepo({ kind: "w1t9232-git", seedCommit: false });
  const { dir } = repo;
  repo.addRemote("origin", "https://github.com/o/r.git");
  mkdirSync(join(dir, "plan"), { recursive: true });
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ".remudero", "mounts.yaml"), join(dir, ".remudero", "mounts.yaml"));
  const commit = (msg: string): string => {
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "-m", msg, "--allow-empty");
    return repo.git("rev-parse", "HEAD");
  };
  writeFileSync(join(dir, "plan", "tasks.yaml"), taskYaml("W1-T9000") + "\n");
  const c0 = commit("the build head's base: no shard yet");
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.d", "w1-t9999.yaml"), taskYaml("W1-T9999") + "\n");
  const c1 = commit("the shard merges");
  repo.git("update-ref", "refs/remotes/origin/main", c1);
  return { dir, c0, c1 };
}

const body = (id: string) => `REPORT\n\nRemudero-Task: ${id}\n`;

test("W1-T9232: a head missing its own task record is pending, not failed", () => {
  const { dir, c0, c1 } = fixture();
  try {
    const [missing, control] = drive(dir, [
      { name: "missing", headRefOid: c0, body: body("W1-T9999") },
      // The control: the same task read at a head that HAS the record is judged normally.
      { name: "control", headRefOid: c1, body: body("W1-T9999") },
    ]);
    assert.equal(missing.error, undefined);
    assert.equal(missing.reviewRan, false, "no verdict is judged on a plan that lacks the task's own record");
    assert.equal(missing.code, 2);
    assert.equal(missing.pendingPosts, 1, "the pending status stands");
    const skip = missing.ledger.find((r) => r.step === "review.reviewer.skipped");
    assert.equal(skip?.reason, OWN_TASK_RECORD_MISSING_CAUSE);
    assert.equal(skip?.head_sha, c0);
    assert.equal(skip?.derived_repair, "refresh the branch from main");
    assert.ok(!missing.ledger.some((r) => r.step === "review.posted"), "no FAIL is posted");
    assert.equal(control.reviewRan, true, "a head that carries its record still reaches the verdict");
    assert.ok(!control.ledger.some((r) => r.reason === OWN_TASK_RECORD_MISSING_CAUSE && r.head_sha === c1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9232: a task with no record anywhere still fails as before", () => {
  const { dir, c0 } = fixture();
  try {
    const [nowhere, triage, unfiled] = drive(dir, [
      { name: "nowhere", headRefOid: c0, body: body("W1-T4242") },
      { name: "triage", headRefOid: c0, body: "no trailer\n", headRefName: "run-TRIAGE-1-1791000000000" },
      { name: "unfiled", headRefOid: c0, body: "no trailer\n", headRefName: "run-unfiled-1791211800000" },
    ]);
    for (const row of [nowhere, triage, unfiled]) {
      assert.equal(row.error, undefined, row.name);
      assert.ok(!row.ledger.some((r) => r.reason === OWN_TASK_RECORD_MISSING_CAUSE), `${row.name}: no new cause`);
    }
    assert.equal(nowhere.reviewRan, true, "an id absent from main too keeps today's verdict path");
    assert.equal(nowhere.code, 1);
    assert.equal(unfiled.reviewRan, true, "an untasked PR is unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T9232: headLacksOwnTaskRecord separates a missing record from an unreadable plan", () => {
  const present = { criteria: [{}], taskRisk: "low" };
  const absent = { criteria: [] as unknown[] };
  assert.equal(headLacksOwnTaskRecord(absent, present), true);
  assert.equal(headLacksOwnTaskRecord(absent, absent), false, "absent from main too is a real fault");
  assert.equal(headLacksOwnTaskRecord(present, present), false);
  assert.equal(headLacksOwnTaskRecord({ criteria: [], divergence: { reason: "duplicate id" } }, present), false);
  assert.equal(headLacksOwnTaskRecord(absent, { criteria: [], divergence: {} }), false);
});

// ── the sweep ───────────────────────────────────────────────────────────────────────────────────
const HEAD = "c0c0c0c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PR_URL = "https://github.com/craigoley/remudero/pull/11374";

function pr(overrides: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 11374, prUrl: PR_URL, taskId: "W1-T9071", reviewState: "failure", checksState: "green",
    unmetCriteria: [], priorStrikes: 0, headSha: HEAD, headRefName: "run-W1-T9071-1791893167140", autoMergeArmed: false,
    lastActivityAt: "2026-10-13T15:00:00Z", // expiring-fixture: exempt -- every runSweep injects `now` ten minutes later
    ...overrides,
  };
}

function skipRow(head = HEAD): Record<string, unknown> {
  return { run_id: "review-PR11374-1", task_id: "W1-T9071", step: "review.reviewer.skipped", lane: "review",
    reason: OWN_TASK_RECORD_MISSING_CAUSE, pr_number: 11374, pr_url: PR_URL, head_sha: head };
}

function harness(path: string, outcome: UpdateBranchOutcome | undefined = "updated") {
  const h = { updated: [] as string[], escalated: [] as string[], fixed: 0 };
  const d: SweepDeps = {
    arm: () => {}, close: () => {},
    dispatchFix: () => { h.fixed += 1; },
    escalate: (_pr, reason) => { h.escalated.push(reason); },
    readLiveState: (p) => ({ ok: true, state: "OPEN", headSha: p.headSha }),
    ...(outcome === undefined ? {} : { updateBranch: (p: { headSha: string }) => { h.updated.push(p.headSha); return outcome; } }),
    ledgerPath: path, runId: "SWEEP-W1-T9232", now: () => Date.parse("2026-10-13T15:10:00Z"),
  };
  return { h, d };
}

function ledgerPath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t9232-${label}-`)), "ledger.ndjson");
}

test("W1-T9232: the sweep refreshes a head missing its own task record", async () => {
  const path = ledgerPath("refresh");
  appendLedger(path, skipRow() as never);
  const { h, d } = harness(path);
  await runSweep([pr()], d, DEFAULT_SWEEP_POLICY);

  assert.deepEqual(h.updated, [HEAD], "one base refresh from main");
  assert.equal(h.escalated.length, 0, "never escalated as contradictory");
  assert.equal(h.fixed, 0);
  const rows = readLedgerLines(path);
  const refresh = rows.find((r) => r.step === OWN_TASK_RECORD_REFRESH_STEP);
  assert.equal(refresh?.outcome, "updated");
  assert.equal(refresh?.cause, OWN_TASK_RECORD_MISSING_CAUSE);
  const disposed = rows.findLast((r) => r.step === "sweep.disposed" && r.head_sha === HEAD);
  assert.ok(!/contradictory/.test(JSON.stringify(disposed)), "the contradictory reason is not used");
  assert.match(JSON.stringify(disposed), /own-task-record-missing-at-head → base refresh/);
});

test("W1-T9232: a refresh that conflicts, or a second miss after one, escalates naming the cause", async () => {
  const conflictPath = ledgerPath("conflict");
  appendLedger(conflictPath, skipRow() as never);
  const conflict = harness(conflictPath, "conflict");
  await runSweep([pr()], conflict.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(conflict.h.updated, [HEAD]);
  const named = readLedgerLines(conflictPath).findLast((r) => r.step === "sweep.disposed");
  assert.match(JSON.stringify(named), /own-task-record-missing-at-head: base refresh did not take \(conflict\)/);
  assert.ok(!/contradictory/.test(JSON.stringify(named)));

  // A second miss: the refreshed head (new sha) still lacks the record.
  const again = ledgerPath("again");
  appendLedger(again, { run_id: "SWEEP", task_id: "W1-T9071", step: OWN_TASK_RECORD_REFRESH_STEP, pr_number: 11374, head_sha: "old", outcome: "updated" } as never);
  appendLedger(again, skipRow() as never);
  const second = harness(again);
  await runSweep([pr()], second.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(second.h.updated, [], "no second refresh");
  const reason = readLedgerLines(again).findLast((r) => r.step === "sweep.disposed");
  assert.match(JSON.stringify(reason), /own-task-record-missing-at-head persists after a base refresh/);

  // Control: with no skip row the same PR keeps today's contradictory disposition.
  const plain = ledgerPath("plain");
  const control = harness(plain);
  await runSweep([pr()], control.d, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(control.h.updated, []);
  assert.match(JSON.stringify(readLedgerLines(plain).findLast((r) => r.step === "sweep.disposed")), /contradictory/);
});
