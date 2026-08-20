import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGithubPosture,
  classifyGithubPosture,
  decideGithubPostureCheck,
  ghPostureGateway,
  githubPosturePath,
  loadGithubPostureBaseline,
  readGithubPosture,
  saveGithubPostureBaseline,
  GITHUB_POSTURE_ALLOWLIST,
  GITHUB_POSTURE_DEFAULT_MIN_INTERVAL_MINUTES,
  type GithubPostureBaseline,
  type GithubPostureGateway,
  type GithubPostureSnapshot,
} from "../src/lib/github-posture.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { RunResult } from "../src/lib/run-result.js";

// A single-task, always-runnable plan — the minimum daemon.ts's loop needs to keep dispatching
// while the posture hook runs alongside it (same shape as test/daemon.test.ts's fixturePlan).
function onTaskPlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "github-posture-plan-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(
    f,
    `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`,
  );
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0.1, verdict: "merged" });

/** A fake `security_and_analysis` + `enforce_admins` gateway over hand-built JSON — no `gh`
 *  process ever spawns in these tests. */
function fakeGateway(opts: { repo?: unknown; enforceAdmins?: unknown } = {}): GithubPostureGateway {
  return {
    getRepo: () => opts.repo,
    getEnforceAdmins: () => opts.enforceAdmins,
  };
}

function securityAndAnalysis(statuses: Record<string, "enabled" | "disabled">): unknown {
  return {
    security_and_analysis: Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, { status: v }])),
  };
}

// ── W1-T1040 design (v): "THE FIRST TEST WRITTEN MUST BE THE UNCHANGED-POSTURE PATH." ──────

test("W1-T1040: an unchanged posture emits nothing the second time", () => {
  let baseline: GithubPostureBaseline | undefined;
  const snapshot: GithubPostureSnapshot = { dependabot_security_updates: "disabled" };
  const t0 = new Date("2026-08-19T00:00:00.000Z");
  const deps = {
    owner: "craigoley",
    repo: "remudero",
    configRoot: "/unused",
    minIntervalMinutes: 60,
    loadBaseline: () => baseline,
    saveBaseline: (_path: string, b: GithubPostureBaseline) => {
      baseline = b;
    },
    read: () => snapshot,
  };
  const first = checkGithubPosture({ ...deps, now: t0 });
  assert.ok(first.length > 0, "the first read (no recorded baseline) reports the current posture");

  const t1 = new Date(t0.getTime() + 61 * 60_000); // past the interval, so cadence fires again
  const second = checkGithubPosture({ ...deps, now: t1 });
  assert.deepEqual(second, [], "an unread-changed posture on the SECOND read emits nothing");
});

test("W1-T1040: a changed posture emits once and not again", () => {
  const t0 = new Date("2026-08-19T00:00:00.000Z");
  let baseline: GithubPostureBaseline | undefined = {
    checkedAt: t0.toISOString(),
    snapshot: { dependabot_security_updates: "disabled" },
  };
  // secret_scanning newly reads disabled too — a real change from the recorded baseline.
  const changedSnapshot: GithubPostureSnapshot = { dependabot_security_updates: "disabled", secret_scanning: "disabled" };
  const deps = {
    owner: "craigoley",
    repo: "remudero",
    configRoot: "/unused",
    minIntervalMinutes: 60,
    loadBaseline: () => baseline,
    saveBaseline: (_path: string, b: GithubPostureBaseline) => {
      baseline = b;
    },
    read: () => changedSnapshot,
  };

  const t1 = new Date(t0.getTime() + 61 * 60_000);
  const first = checkGithubPosture({ ...deps, now: t1 });
  assert.ok(first.length > 0, "a posture that differs from the recorded baseline emits");

  const t2 = new Date(t1.getTime() + 61 * 60_000);
  const second = checkGithubPosture({ ...deps, now: t2 });
  assert.deepEqual(second, [], "the SAME (now-recorded) posture on the next read emits nothing — the change fired exactly once");
});

// ── (i) DETECTION ONLY — never a write, not even to probe ──────────────────────────────────

test("W1-T1040: the posture read never calls a write endpoint", () => {
  const calls: string[][] = [];
  const execSpy = (args: string[]): string => {
    calls.push(args);
    if (args[1]?.includes("branches/")) return JSON.stringify({ enabled: false });
    return JSON.stringify(
      securityAndAnalysis({
        secret_scanning: "enabled",
        secret_scanning_push_protection: "enabled",
        // The exact case the task's rationale measured: an available-and-off capability.
        dependabot_security_updates: "disabled",
        secret_scanning_ai_detection: "disabled",
        secret_scanning_non_provider_patterns: "disabled",
        secret_scanning_validity_checks: "disabled",
        secret_scanning_delegated_alert_dismissal: "disabled",
        secret_scanning_delegated_bypass: "disabled",
      }),
    );
  };
  const snapshot = readGithubPosture("craigoley", "remudero", { gateway: ghPostureGateway(execSpy) });

  assert.ok(snapshot, "the read succeeded");
  assert.equal(snapshot?.dependabot_security_updates, "disabled", "the disabled capability is still read, not skipped");
  assert.ok(calls.length >= 2, "both the repo read and the enforce_admins read happened");
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 1), ["api"], "every call is a bare `gh api` read");
    for (const flag of ["-X", "--method", "-f", "-F", "--input", "PUT", "POST", "PATCH", "DELETE"]) {
      assert.ok(!args.includes(flag), `no write flag/verb (${flag}) is ever passed, even though a capability read disabled`);
    }
  }
});

// ── (ii)/(iii) THE THREE STATES ─────────────────────────────────────────────────────────────

test("W1-T1040: an allowlisted capability produces no finding", () => {
  for (const key of Object.keys(GITHUB_POSTURE_ALLOWLIST).filter((k) => GITHUB_POSTURE_ALLOWLIST[k].kind === "unavailable")) {
    const findings = classifyGithubPosture({ [key]: "disabled" });
    assert.deepEqual(findings, [], `${key} is UNAVAILABLE-ON-THIS-TIER (0 of 14 org repos ever on) — never flagged`);
  }
});

test("W1-T1040: an available-and-off capability is named", () => {
  // The task rationale's own worked example: dependabot_security_updates reads disabled here
  // while 8 sibling repos in the org read it enabled — genuinely available, genuinely off.
  const findings = classifyGithubPosture({ dependabot_security_updates: "disabled" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].capability, "dependabot_security_updates");
  assert.equal(findings[0].kind, "free");
});

test("W1-T1040: a paid capability carries its cost", () => {
  const findings = classifyGithubPosture({ code_quality: "disabled" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].capability, "code_quality");
  assert.equal(findings[0].kind, "paid", "flagged as PAID, never as a plain free toggle");
  assert.ok(findings[0].cost && findings[0].cost.length > 0, "the finding itself carries the cost text");

  // Contrast: a free-off finding carries no cost at all — the two kinds are not the same shape.
  const free = classifyGithubPosture({ dependabot_security_updates: "disabled" });
  assert.equal(free[0].cost, undefined, "a free-off finding never carries a cost field");
});

// ── (v)/(vii) DEGRADE, NEVER A FALSE ALL-CLEAR ──────────────────────────────────────────────

test("W1-T1040: an unreadable posture read reports nothing rather than clean", () => {
  const t0 = new Date("2026-08-19T00:00:00.000Z");
  const priorBaseline: GithubPostureBaseline = {
    checkedAt: new Date(t0.getTime() - 2 * 24 * 60 * 60_000).toISOString(),
    snapshot: { dependabot_security_updates: "disabled" },
  };
  let saved: GithubPostureBaseline | undefined;
  const findings = checkGithubPosture({
    owner: "craigoley",
    repo: "remudero",
    configRoot: "/unused",
    now: t0,
    loadBaseline: () => priorBaseline,
    saveBaseline: (_path, b) => {
      saved = b;
    },
    read: () => undefined, // simulates a failed/unreachable `gh api` round-trip
  });
  assert.deepEqual(findings, [], "an unreadable read produces NO findings — never a false all-clear either");
  assert.equal(saved, undefined, "the recorded baseline is left untouched — an outage can't manufacture tomorrow's false clean diff");

  // readGithubPosture itself degrades the same way when the primary (repo) read fails.
  const snapshot = readGithubPosture("craigoley", "remudero", { gateway: fakeGateway({ repo: undefined }) });
  assert.equal(snapshot, undefined);
});

// ── (viii) CADENCE — at most once a day ─────────────────────────────────────────────────────

test("W1-T1040: the posture read is rate-limited to once a day", () => {
  assert.equal(GITHUB_POSTURE_DEFAULT_MIN_INTERVAL_MINUTES, 24 * 60, "the default interval is exactly one day");

  const now = new Date("2026-08-19T12:00:00.000Z");
  const underInterval = decideGithubPostureCheck({
    now,
    lastCheckedIso: new Date(now.getTime() - 60 * 60_000).toISOString(), // 1h ago
    minIntervalMinutes: GITHUB_POSTURE_DEFAULT_MIN_INTERVAL_MINUTES,
  });
  assert.equal(underInterval.fire, false, "under a day since the last check — does not fire");

  const overInterval = decideGithubPostureCheck({
    now,
    lastCheckedIso: new Date(now.getTime() - 25 * 60 * 60_000).toISOString(), // 25h ago
    minIntervalMinutes: GITHUB_POSTURE_DEFAULT_MIN_INTERVAL_MINUTES,
  });
  assert.equal(overInterval.fire, true, "past a day since the last check — fires");

  // And end to end: two checkGithubPosture calls inside the same day call the injected `read`
  // exactly once, never once per call (never once per dispatch).
  let reads = 0;
  let baseline: GithubPostureBaseline | undefined;
  const deps = {
    owner: "craigoley",
    repo: "remudero",
    configRoot: "/unused",
    loadBaseline: () => baseline,
    saveBaseline: (_path: string, b: GithubPostureBaseline) => {
      baseline = b;
    },
    read: () => {
      reads += 1;
      return { dependabot_security_updates: "disabled" as const };
    },
  };
  checkGithubPosture({ ...deps, now });
  checkGithubPosture({ ...deps, now: new Date(now.getTime() + 5 * 60_000) }); // 5 minutes later
  assert.equal(reads, 1, "the second call, minutes later, is throttled — no second network read");
});

// ── (vii) IT MUST NOT BLOCK — proven at the daemon loop, same discipline as sweepOrphans ───

test("W1-T1040: a posture finding never blocks a dispatch", async () => {
  const plan = onTaskPlan();
  const merged = new Set<string>();
  let checks = 0;
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), "daemon-github-posture-"));
  const s = await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    checkGithubPosture: () => {
      checks += 1;
      // A non-empty return — including a PAID finding — must never gate anything below it.
      return [
        { capability: "dependabot_security_updates", kind: "free" },
        { capability: "code_quality", kind: "paid", cost: "Team/Enterprise Cloud, per-committer" },
      ];
    },
    checkStop: () => (merged.has("A") ? (requestStop(root, "task dispatched"), stopDetail(root)) : undefined),
    sleep: async () => {},
    log: (step, extra) => lines.push({ step, extra }),
  } satisfies DaemonDeps);

  assert.ok(checks >= 1, "the posture hook ran");
  assert.ok(merged.has("A"), "the task still dispatched and merged — the finding never blocked it");
  assert.notEqual(s.stopReason, "error", "a posture finding is not a daemon error");
  const findingLines = lines.filter((l) => l.step === "github_posture.finding");
  assert.equal(findingLines.length, 2, "each finding is ledgered as its own row — a line for the operator, nothing more");
});

test("W1-T1040: a THROWING checkGithubPosture does not kill the loop", async () => {
  const plan = onTaskPlan();
  const merged = new Set<string>();
  const root = mkdtempSync(join(tmpdir(), "daemon-github-posture-throw-"));
  const s = await runDaemon(plan, {
    refreshMerged: () => (id: string) => merged.has(id),
    runOne: async (id) => {
      merged.add(id);
      return okResult(id);
    },
    checkGithubPosture: () => {
      throw new Error("gh: HTTP 403");
    },
    checkStop: () => (merged.has("A") ? (requestStop(root, "task dispatched"), stopDetail(root)) : undefined),
    sleep: async () => {},
  } satisfies DaemonDeps);
  assert.ok(merged.has("A"), "dispatch proceeded through the failure");
  assert.notEqual(s.stopReason, "error", "a failing posture check is not a daemon error");
});

// ── the baseline store itself: atomic write + fail-open read, same discipline as last-seen.ts ─

test("W1-T1040: the baseline persists and reloads across a save/load round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "github-posture-baseline-"));
  const path = githubPosturePath(dir);
  assert.ok(!existsSync(path));
  assert.equal(loadGithubPostureBaseline(path), undefined, "no baseline yet — fails open to undefined");

  const baseline: GithubPostureBaseline = {
    checkedAt: "2026-08-19T00:00:00.000Z",
    snapshot: { dependabot_security_updates: "disabled", secret_scanning: "enabled" },
  };
  saveGithubPostureBaseline(path, baseline);
  assert.deepEqual(loadGithubPostureBaseline(path), baseline);

  mkdirSync(dir, { recursive: true }); // no-op — dir already exists; just proving idempotence
});
