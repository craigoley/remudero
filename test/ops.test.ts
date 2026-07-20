import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  alertTaskId,
  buildAlertEscalation,
  newCriticalAlerts,
  normalizeCodeScanningAlert,
  normalizeDependabotAlert,
  normalizeSecretScanningAlert,
  pollAlerts,
  priorEscalatedAlertIds,
  renderAlertsSummary,
  summarizeAlerts,
  type AlertGateway,
  type RawAlert,
} from "../src/lib/ops.js";
import { summarize as summarizeDigest, renderDigest } from "../src/lib/digest.js";
import type { IssueGateway } from "../src/lib/escalate.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-ops-")), "ledger.ndjson");
}

function fakeIssues(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  let n = 0;
  return {
    calls,
    create(title, body, labels) {
      calls.push({ title, body, labels });
      n++;
      return `https://github.com/craigoley/remudero/issues/${100 + n}`;
    },
  };
}

// ── Seeded payloads (fixture-driven, per the acceptance's own proof shape) ──
// Shapes mirror the real `gh api repos/<owner>/<repo>/{code-scanning,dependabot,
// secret-scanning}/alerts` responses (field names per GitHub's REST docs) — a
// critical code-scanning alert, a high dependabot alert, an open secret-scanning
// alert (no severity field — always treated as critical, see normalizeSecretScanningAlert),
// plus one LOW code-scanning alert and one CLOSED dependabot alert that must NOT
// escalate, proving the severity + open-state gates actually gate.

const NOW = Date.parse("2026-07-20T12:00:00Z");

const CODE_SCANNING_RAW = [
  {
    number: 5,
    state: "open",
    created_at: "2026-07-15T12:00:00Z", // 5 days old
    html_url: "https://github.com/craigoley/remudero/security/code-scanning/5",
    rule: { id: "js/sql-injection", description: "SQL injection", security_severity_level: "critical" },
  },
  {
    number: 6,
    state: "open",
    created_at: "2026-07-19T12:00:00Z", // 1 day old
    html_url: "https://github.com/craigoley/remudero/security/code-scanning/6",
    rule: { id: "js/unused-var", description: "Unused variable", security_severity_level: "low" },
  },
];

const DEPENDABOT_RAW = [
  {
    number: 12,
    state: "open",
    created_at: "2026-07-10T12:00:00Z", // 10 days old
    html_url: "https://github.com/craigoley/remudero/security/dependabot/12",
    security_advisory: { severity: "high", summary: "prototype pollution in lodash" },
    dependency: { package: { name: "lodash" } },
  },
  {
    number: 13,
    state: "fixed", // closed — must not count as open, must not escalate
    created_at: "2026-07-01T12:00:00Z",
    html_url: "https://github.com/craigoley/remudero/security/dependabot/13",
    security_advisory: { severity: "critical", summary: "already fixed" },
    dependency: { package: { name: "old-pkg" } },
  },
];

const SECRET_SCANNING_RAW = [
  {
    number: 3,
    state: "open",
    created_at: "2026-07-20T06:00:00Z", // 0.25 days old
    html_url: "https://github.com/craigoley/remudero/security/secret-scanning/3",
    secret_type_display_name: "AWS Access Key",
    secret_type: "aws_access_key_id",
  },
];

function seededGateway(): AlertGateway {
  return {
    codeScanning: () => CODE_SCANNING_RAW.map(normalizeCodeScanningAlert),
    dependabot: () => DEPENDABOT_RAW.map(normalizeDependabotAlert),
    secretScanning: () => SECRET_SCANNING_RAW.map(normalizeSecretScanningAlert),
  };
}

// ── Normalizers ──────────────────────────────────────────────────────────

test("normalizeCodeScanningAlert reads security_severity_level, falls back to rule.severity, else unknown", () => {
  assert.equal(normalizeCodeScanningAlert(CODE_SCANNING_RAW[0]).severity, "critical");
  assert.equal(normalizeCodeScanningAlert({ rule: { severity: "error" } }).severity, "high");
  assert.equal(normalizeCodeScanningAlert({ rule: { severity: "warning" } }).severity, "medium");
  assert.equal(normalizeCodeScanningAlert({ rule: { severity: "note" } }).severity, "low");
  assert.equal(normalizeCodeScanningAlert({}).severity, "unknown");
});

test("normalizeDependabotAlert maps GitHub's 'moderate' to this module's 'medium'", () => {
  assert.equal(normalizeDependabotAlert(DEPENDABOT_RAW[0]).severity, "high");
  assert.equal(normalizeDependabotAlert({ security_advisory: { severity: "moderate" } }).severity, "medium");
  assert.equal(normalizeDependabotAlert({ security_advisory: { severity: "MODERATE" } }).severity, "medium");
});

test("normalizeSecretScanningAlert always assigns critical — the API reports no severity", () => {
  const a = normalizeSecretScanningAlert(SECRET_SCANNING_RAW[0]);
  assert.equal(a.severity, "critical");
  assert.equal(a.summary, "AWS Access Key");
});

// ── summarizeAlerts: counts + ages (acceptance: "the digest block (counts + ages)") ──

test("summarizeAlerts folds open alerts into per-source counts + oldest-age-days, excluding closed ones", () => {
  const all = [
    ...CODE_SCANNING_RAW.map(normalizeCodeScanningAlert),
    ...DEPENDABOT_RAW.map(normalizeDependabotAlert),
    ...SECRET_SCANNING_RAW.map(normalizeSecretScanningAlert),
  ];
  const s = summarizeAlerts(all, NOW);
  assert.equal(s.totalOpen, 4); // #13 (fixed) excluded — 2 code-scanning + 1 dependabot + 1 secret-scanning
  assert.deepEqual(s.bySource["code-scanning"].counts, { critical: 1, high: 0, medium: 0, low: 1, unknown: 0 });
  assert.equal(s.bySource["code-scanning"].total, 2);
  assert.ok(s.bySource["code-scanning"].oldestOpenAgeDays! >= 4.9 && s.bySource["code-scanning"].oldestOpenAgeDays! <= 5.1);
  assert.deepEqual(s.bySource.dependabot.counts, { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 });
  assert.equal(s.bySource.dependabot.total, 1); // #13 excluded (closed)
  assert.deepEqual(s.bySource["secret-scanning"].counts, { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 });
});

test("summarizeAlerts on an empty list renders (none open) per source via renderAlertsSummary", () => {
  const s = summarizeAlerts([], NOW);
  assert.equal(s.totalOpen, 0);
  const text = renderAlertsSummary(s);
  assert.match(text, /code-scanning \(none open\)/);
  assert.match(text, /dependabot \(none open\)/);
  assert.match(text, /secret-scanning \(none open\)/);
});

test("renderAlertsSummary names severities + oldest age per source", () => {
  const all = [...CODE_SCANNING_RAW.map(normalizeCodeScanningAlert), ...SECRET_SCANNING_RAW.map(normalizeSecretScanningAlert)];
  const text = renderAlertsSummary(summarizeAlerts(all, NOW));
  assert.match(text, /code-scanning 1 critical, 1 low \(oldest 5d\)/);
  assert.match(text, /secret-scanning 1 critical/);
});

// ── newCriticalAlerts: severity + open-state gate, dedup against prior escalations ──

test("newCriticalAlerts keeps only OPEN critical/high alerts not already escalated", () => {
  const all = [
    ...CODE_SCANNING_RAW.map(normalizeCodeScanningAlert), // #5 critical/open, #6 low/open
    ...DEPENDABOT_RAW.map(normalizeDependabotAlert), // #12 high/open, #13 critical/fixed
    ...SECRET_SCANNING_RAW.map(normalizeSecretScanningAlert), // #3 critical/open
  ];
  const fresh = newCriticalAlerts(all, new Set());
  const ids = fresh.map(alertTaskId).sort();
  assert.deepEqual(ids, ["alert-code-scanning-5", "alert-dependabot-12", "alert-secret-scanning-3"]);

  // Already escalated once -> excluded next time.
  const afterDedup = newCriticalAlerts(all, new Set(["alert-code-scanning-5"]));
  assert.deepEqual(
    afterDedup.map(alertTaskId).sort(),
    ["alert-dependabot-12", "alert-secret-scanning-3"],
  );
});

test("buildAlertEscalation is class MANUAL, carries fix/dismiss options, recommends fix", () => {
  const alert = normalizeCodeScanningAlert(CODE_SCANNING_RAW[0]);
  const e = buildAlertEscalation(alert);
  assert.equal(e.class, "MANUAL");
  assert.equal(e.taskId, "alert-code-scanning-5");
  assert.equal(e.recommendation, "fix");
  assert.deepEqual(
    e.options.map((o) => o.label),
    ["fix", "dismiss"],
  );
  assert.match(e.detail, /SQL injection/);
});

// ── priorEscalatedAlertIds ────────────────────────────────────────────────

test("priorEscalatedAlertIds reads every escalation.issue_opened task_id, any class/source", () => {
  const ids = priorEscalatedAlertIds([
    { step: "escalation.issue_opened", task_id: "alert-dependabot-12", class: "MANUAL" },
    { step: "escalation.issue_opened", task_id: "W1-TX", class: "BLOCKED" }, // non-alert escalation, still counted
    { step: "verdict", task_id: "alert-dependabot-12" }, // wrong step — ignored
  ]);
  assert.deepEqual([...ids].sort(), ["W1-TX", "alert-dependabot-12"]);
});

// ── pollAlerts: the end-to-end acceptance shape ─────────────────────────────
// "seeded alert payloads produce the digest block (counts + ages) and exactly
// ONE escalation per NEW critical, with NO duplicate on re-poll."

test("pollAlerts escalates exactly one issue per new critical/high alert, and a re-poll of the SAME payloads escalates nothing new", async () => {
  const path = ledgerPath();
  const issues = fakeIssues();
  const deps = {
    alerts: seededGateway(),
    issues,
    ledgerPath: path,
    runId: "OPS-1",
    now: () => NOW,
  };

  const first = await pollAlerts("craigoley", "remudero", deps);
  assert.equal(first.newCritical.length, 3); // #5 code-scanning, #12 dependabot, #3 secret-scanning
  assert.equal(first.escalated.length, 3);
  assert.equal(issues.calls.length, 3);
  assert.deepEqual(
    first.escalated.map((e) => e.alert.source).sort(),
    ["code-scanning", "dependabot", "secret-scanning"],
  );
  // Every escalation issue carries the needs-human queue label (escalate.ts's own invariant).
  for (const call of issues.calls) assert.ok(call.labels.includes("needs-human"));

  const second = await pollAlerts("craigoley", "remudero", { ...deps, runId: "OPS-2" });
  assert.equal(second.newCritical.length, 0, "re-poll of the SAME payloads must find nothing new to escalate");
  assert.equal(second.escalated.length, 0, "re-poll must open ZERO new issues");
  assert.equal(issues.calls.length, 3, "no additional gh issue create calls happened on the re-poll");

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const polled = lines.filter((l) => l.step === "ops.alerts_polled");
  assert.equal(polled.length, 2, "one ops.alerts_polled ledger line per real poll");
  assert.equal(polled[1].new_critical_count, 0);
  const opened = lines.filter((l) => l.step === "escalation.issue_opened");
  assert.equal(opened.length, 3, "exactly one escalation.issue_opened line per new critical, never duplicated");
});

test("pollAlerts --dry-run previews newCritical but escalates nothing and writes no ledger line", async () => {
  const path = ledgerPath();
  const issues = fakeIssues();
  const result = await pollAlerts("craigoley", "remudero", {
    alerts: seededGateway(),
    issues,
    ledgerPath: path,
    runId: "OPS-DRY",
    now: () => NOW,
    dryRun: true,
  });
  assert.equal(result.newCritical.length, 3);
  assert.equal(result.escalated.length, 0);
  assert.equal(issues.calls.length, 0);
  assert.equal(existsSync(path), false, "a dry-run poll must leave no ledger trace (not even an empty file) — a real poll afterward still acts");

  // A REAL poll after the dry-run still escalates normally (no phantom dedup entry).
  const real = await pollAlerts("craigoley", "remudero", {
    alerts: seededGateway(),
    issues,
    ledgerPath: path,
    runId: "OPS-REAL",
    now: () => NOW,
  });
  assert.equal(real.escalated.length, 3);
});

// ── digest.ts integration: the ops.alerts_polled ledger line surfaces in the digest ──

test("digest.summarize picks up the latest ops.alerts_polled snapshot inside its window, and renderDigest prints an alerts: line", async () => {
  const path = ledgerPath();
  const issues = fakeIssues();
  await pollAlerts("craigoley", "remudero", {
    alerts: seededGateway(),
    issues,
    ledgerPath: path,
    runId: "OPS-1",
    now: () => NOW,
  });
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const s = summarizeDigest(lines, "2026-07-01T00:00:00.000Z");
  assert.ok(s.alerts, "digest summary must carry the alerts snapshot");
  assert.equal(s.alerts!.totalOpen, 4);
  const text = renderDigest(s);
  assert.match(text, /alerts: code-scanning 1 critical/);
  assert.match(text, /alerts: .*secret-scanning 1 critical/);
});

test("digest renders '(no poll this window)' when rmd ops never ran inside the window", () => {
  const s = summarizeDigest([], "2026-07-01T00:00:00.000Z");
  assert.equal(s.alerts, undefined);
  assert.match(renderDigest(s), /alerts: \(no poll this window\)/);
});
