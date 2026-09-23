import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageInboxProposalOnce } from "../src/run-task.js";
import {
  auditMachineReleases,
  RELEASE_AUDIT_MIN_DECIDED,
  RELEASE_AUDIT_MIN_RELEASES,
  runReleaseAudit,
  type ReleaseAuditState,
} from "../src/lib/verify-human-release.js";

// W1-T4083 — the first live verify-human sweep (2026-09-22) released 38 of 38 automate verdicts
// with zero escalations. The audit joins each machine release to what the task became.

const release = (taskId: string, ts: string, author = "machine") => ({ step: "ratify.approved", task_id: taskId, ts, author_class: author });
const verdict = (taskId: string, ts: string, v: string) => ({ step: "verdict", task_id: taskId, ts, verdict: v });

test("W1-T4083: each release is joined to its outcome", () => {
  const rows = [
    release("A", "2026-09-22T22:00:00Z"),
    release("B", "2026-09-22T22:00:00Z"),
    release("C", "2026-09-22T22:00:00Z"),
    release("OP", "2026-09-22T22:00:00Z", "operator"),
    verdict("A", "2026-09-22T21:00:00Z", "blocked_ci"), // before the release: not the release's outcome
    verdict("A", "2026-09-23T01:00:00Z", "merged"),
    verdict("B", "2026-09-23T01:00:00Z", "blocked_ci"),
    verdict("B", "2026-09-23T02:00:00Z", "merged"), // the LATEST decisive verdict wins
    verdict("C", "2026-09-23T01:00:00Z", "blocked_transient"), // infrastructure never counts
  ];
  const { audit } = auditMachineReleases(rows);
  assert.equal(audit.releases, 3, "an operator release is not the machine judge's");
  assert.equal(audit.merged, 2);
  assert.equal(audit.failed, 0);
  assert.equal(audit.pending, 1, "C has no decisive verdict yet");
  assert.equal(audit.failureRate, 0);
});

test("W1-T4083: a judge that never escalates raises one alert", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-release-audit-"));
  try {
    const registry = join(dir, "inbox-proposals.json");
    const rows = Array.from({ length: RELEASE_AUDIT_MIN_RELEASES }, (_, i) => release(`T${i}`, "2026-09-22T22:00:00Z"));
    let state: ReleaseAuditState | undefined;
    const ledger: Record<string, unknown>[] = [];
    const hooks = {
      appendRow: (row: Record<string, unknown>) => ledger.push(row),
      stageProposal: (p: Parameters<typeof stageInboxProposalOnce>[1]) => void stageInboxProposalOnce(registry, p),
      runId: "AUDIT",
      readState: () => state ?? { released: {}, escalationKeys: [], outcomes: {} },
      writeState: (s: ReleaseAuditState) => void (state = s),
    };
    const first = runReleaseAudit(rows, hooks);
    runReleaseAudit(rows, hooks); // the same condition on the next cadence
    assert.deepEqual(first.alerts.map((a) => a.kind), ["never-escalates"]);
    const staged = readFileSync(registry, "utf8").match(/"verify-human-release-audit-never-escalates"/g) ?? [];
    assert.equal(staged.length, 1, "one alert, not one per cadence");
    assert.equal(ledger[0].step, "verify_human.release_audit");

    const oneEscalation = auditMachineReleases([...rows, { step: "verify_human.release_escalated", task_id: "X", ts: "2026-09-22T23:00:00Z" }]);
    assert.deepEqual(oneEscalation.audit.alerts, [], "a single escalation shows the judge still discriminates");
    assert.deepEqual(auditMachineReleases(rows.slice(1)).audit.alerts, [], `below ${RELEASE_AUDIT_MIN_RELEASES} releases there is not enough evidence`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T4083: released tasks failing above the base rate raise one alert", () => {
  const n = RELEASE_AUDIT_MIN_DECIDED;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(release(`R${i}`, "2026-09-22T22:00:00Z"));
    rows.push(verdict(`R${i}`, "2026-09-23T01:00:00Z", i < n / 2 ? "blocked_ci" : "merged")); // 50% fail
    rows.push(verdict(`O${i}`, "2026-09-23T01:00:00Z", i === 0 ? "no_pr" : "merged")); // base 10% fail
  }
  const { audit } = auditMachineReleases(rows);
  assert.equal(audit.failureRate, 0.5);
  assert.equal(audit.baseFailureRate, 0.1);
  assert.deepEqual(audit.alerts.map((a) => a.kind), ["failing-above-base"]);

  const healthy = rows.map((r) => (r.step === "verdict" && String(r.task_id).startsWith("R") ? { ...r, verdict: "merged" } : r));
  assert.deepEqual(auditMachineReleases(healthy).audit.alerts, [], "releases failing no more than the base raise nothing");
});

test("a release that has rotated out of the ledger is still counted from the remembered state", () => {
  const first = auditMachineReleases([release("OLD", "2026-09-20T00:00:00Z"), verdict("OLD", "2026-09-20T05:00:00Z", "merged")]);
  const later = auditMachineReleases([release("NEW", "2026-09-22T00:00:00Z")], first.state);
  assert.equal(later.audit.releases, 2, "OLD rotated out of the ledger but stays in the audit");
  assert.equal(later.audit.merged, 1);
});

test("the production verify-human cadence runs the audit and remembers it", async () => {
  const { copyFileSync, mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const { defaultVerifyHumanCadenceResult } = await import("../src/run-task.js");
  const stateRoot = mkdtempSync(join(tmpdir(), "rmd-release-audit-prod-"));
  try {
    const checkout = join(stateRoot, "remudero");
    mkdirSync(join(checkout, "plan", "tasks.d"), { recursive: true });
    mkdirSync(join(checkout, ".remudero"), { recursive: true });
    copyFileSync(join(import.meta.dirname, "..", ".remudero", "mounts.yaml"), join(checkout, ".remudero", "mounts.yaml"));
    // No parked verify:human shard, so no judge is ever spawned.
    writeFileSync(join(checkout, "plan", "tasks.yaml"), "- id: W1-T9002\n  title: t\n  repo: remudero\n  type: implement\n  verify: auto\n  status: queued\n  depends_on: []\n");
    mkdirSync(join(stateRoot, "state"), { recursive: true });
    const ledger = Array.from({ length: RELEASE_AUDIT_MIN_RELEASES }, (_, i) => JSON.stringify({ ...release(`T${i}`, "2026-09-22T22:00:00Z"), run_id: "R" }));
    writeFileSync(join(stateRoot, "state", "ledger.ndjson"), `${ledger.join("\n")}\n`);

    const result = await defaultVerifyHumanCadenceResult(checkout, { claudeBin: "/unused", root: stateRoot } as never, "VH-TEST");
    assert.notEqual(result.status, "refused", result.refusedReason);
    assert.deepEqual(result.releaseAudit?.alerts, ["never-escalates"]);
    assert.equal(result.releaseAudit?.releases, RELEASE_AUDIT_MIN_RELEASES);
    assert.ok(existsSync(join(stateRoot, "state", "verify-human-release-audit.json")), "the audit remembers what it saw");
    assert.match(readFileSync(join(stateRoot, "state", "ledger.ndjson"), "utf8"), /"step":"verify_human\.release_audit"/);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("the audit state reader starts empty on a missing or corrupt file", async () => {
  const { writeFileSync } = await import("node:fs");
  const { readReleaseAuditState } = await import("../src/run-task.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-release-audit-state-"));
  try {
    const path = join(dir, "state.json");
    assert.deepEqual(readReleaseAuditState(path), { released: {}, escalationKeys: [], outcomes: {} });
    writeFileSync(path, "{ not json");
    assert.deepEqual(readReleaseAuditState(path), { released: {}, escalationKeys: [], outcomes: {} });
    writeFileSync(path, JSON.stringify({ released: { A: "2026-09-22" } }));
    assert.deepEqual(readReleaseAuditState(path), { released: { A: "2026-09-22" }, escalationKeys: [], outcomes: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
