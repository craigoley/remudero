import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import {
  alertDispositionReason,
  decideAlertDisposition,
  GOLDEN_CRITICAL_PATH,
  isCriticalPath,
  loadAlertPolicy,
  priorDispatchedAlertIds,
  REQUIRED_CRITICAL_PATH_CATEGORIES,
  runAlertLane,
  validateAlertPolicy,
  AlertPolicyError,
  type AlertLaneAlert,
  type AlertPolicy,
} from "../src/lib/alert-lane.js";
import { alertOriginId, alertTaskId } from "../src/lib/ops.js";

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ledgerPath(): string {
  return join(tmpRoot("rmd-alert-lane-"), "ledger.ndjson");
}

function readLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ── A minimal, valid policy fixture — mirrors plan/alert-policy.yaml's real shape ──

const POLICY: AlertPolicy = {
  actSeverities: ["medium", "low"],
  criticalPaths: {
    review: [GOLDEN_CRITICAL_PATH],
    gate: ["src/lib/gate*.ts"],
    containment: ["src/lib/containment*.ts"],
    ledger: ["src/lib/ledger.ts"],
    status: ["src/lib/status.ts"],
  },
};

// ── Seeded alert fixtures (fixture-only, per the acceptance's own proof shape) ──

const MEDIUM_SAFE_ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "10",
  severity: "medium",
  state: "open",
  createdAt: "2026-07-20T00:00:00Z",
  summary: "unused variable",
  url: "https://github.com/craigoley/remudero/security/code-scanning/10",
  path: "src/lib/some-non-critical-file.ts",
};

const CRITICAL_ALERT: AlertLaneAlert = {
  source: "dependabot",
  id: "20",
  severity: "critical",
  state: "open",
  createdAt: "2026-07-20T00:00:00Z",
  summary: "critical prototype pollution",
  url: "https://github.com/craigoley/remudero/security/dependabot/20",
};

const MEDIUM_ON_REVIEW_ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "30",
  severity: "medium",
  state: "open",
  createdAt: "2026-07-20T00:00:00Z",
  summary: "medium finding inside the review judge",
  url: "https://github.com/craigoley/remudero/security/code-scanning/30",
  path: GOLDEN_CRITICAL_PATH,
};

const HIGH_ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "40",
  severity: "high",
  state: "open",
  createdAt: "2026-07-20T00:00:00Z",
  summary: "high severity finding",
  url: "https://github.com/craigoley/remudero/security/code-scanning/40",
};

const UNKNOWN_SEVERITY_ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "50",
  severity: "unknown",
  state: "open",
  createdAt: "2026-07-20T00:00:00Z",
  summary: "unclassified finding",
  url: "https://github.com/craigoley/remudero/security/code-scanning/50",
};

const LOW_NO_PATH_ALERT: AlertLaneAlert = {
  source: "code-scanning",
  id: "60",
  severity: "low",
  state: "open",
  createdAt: "2026-07-20T00:00:00Z",
  summary: "low severity, no path reported",
  url: "https://github.com/craigoley/remudero/security/code-scanning/60",
};

// ── decideAlertDisposition: the pure verdict, one fixture per branch ────────

test("decideAlertDisposition: medium severity on a non-critical path -> act", () => {
  assert.equal(decideAlertDisposition(MEDIUM_SAFE_ALERT, POLICY), "act");
});

test("decideAlertDisposition: low severity with no known path -> act (missing path never itself forces escalate)", () => {
  assert.equal(decideAlertDisposition(LOW_NO_PATH_ALERT, POLICY), "act");
});

test("decideAlertDisposition: critical severity -> escalate regardless of path", () => {
  assert.equal(decideAlertDisposition(CRITICAL_ALERT, POLICY), "escalate");
});

test("decideAlertDisposition: high severity -> escalate", () => {
  assert.equal(decideAlertDisposition(HIGH_ALERT, POLICY), "escalate");
});

test("decideAlertDisposition: unknown severity -> escalate (fail-closed, mirrors dep-review's unknown-bump convention)", () => {
  assert.equal(decideAlertDisposition(UNKNOWN_SEVERITY_ALERT, POLICY), "escalate");
});

test("decideAlertDisposition: medium severity touching the GOLDEN critical path (src/lib/review.ts) -> escalate", () => {
  assert.equal(decideAlertDisposition(MEDIUM_ON_REVIEW_ALERT, POLICY), "escalate");
});

test("alertDispositionReason: names the deciding factor for both branches", () => {
  assert.match(alertDispositionReason(CRITICAL_ALERT, POLICY), /severity 'critical'/);
  assert.match(alertDispositionReason(MEDIUM_ON_REVIEW_ALERT, POLICY), /critical path/);
  assert.match(alertDispositionReason(MEDIUM_SAFE_ALERT, POLICY), /safe to dispatch/);
});

// ── isCriticalPath: glob matching ───────────────────────────────────────────

test("isCriticalPath: exact path match, wildcard prefix match, and non-match", () => {
  assert.equal(isCriticalPath("src/lib/review.ts", POLICY), true);
  assert.equal(isCriticalPath("src/lib/gate-foo.ts", POLICY), true, "src/lib/gate*.ts must match a wildcard suffix");
  assert.equal(isCriticalPath("src/lib/unrelated.ts", POLICY), false);
});

test("isCriticalPath: an undefined path is always outside the critical set", () => {
  assert.equal(isCriticalPath(undefined, POLICY), false);
});

// ── Acceptance #3b: policy is DATA — editing ONLY the policy fixture flips a ──
// fixture alert's disposition, with ZERO changes to alert-lane.ts's logic. ───

test("acceptance #3b: moving a path OUT of critical_paths flips escalate -> act, with zero code changes", () => {
  const policyWithoutReviewCritical: AlertPolicy = {
    actSeverities: ["medium", "low"],
    criticalPaths: {
      // review.ts is no longer named critical — same alert, same decideAlertDisposition code,
      // different DATA.
      review: ["src/lib/some-other-file.ts"],
      gate: ["src/lib/gate*.ts"],
      containment: ["src/lib/containment*.ts"],
      ledger: ["src/lib/ledger.ts"],
      status: ["src/lib/status.ts"],
    },
  };
  assert.equal(decideAlertDisposition(MEDIUM_ON_REVIEW_ALERT, POLICY), "escalate");
  assert.equal(decideAlertDisposition(MEDIUM_ON_REVIEW_ALERT, policyWithoutReviewCritical), "act");
});

test("acceptance #3b: raising the act-severity threshold flips escalate -> act for a HIGH alert, with zero code changes", () => {
  const policyWithHighAsAct: AlertPolicy = {
    actSeverities: ["high", "medium", "low"],
    criticalPaths: POLICY.criticalPaths,
  };
  assert.equal(decideAlertDisposition(HIGH_ALERT, POLICY), "escalate");
  assert.equal(decideAlertDisposition(HIGH_ALERT, policyWithHighAsAct), "act");
});

// ── Acceptance #3a: the lane never writes tasks.yaml (grep-provable) ────────

test("acceptance #3a: alert-lane.ts writes NOTHING to tasks.yaml — grep-provable, structurally true", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/alert-lane.ts", import.meta.url)), "utf8");
  // grep -n "tasks.yaml" src/lib/alert-lane.ts finds only DOC-COMMENT prose (explaining the
  // rule-15 resolution — mirrors dep-review.ts's own doc, which names tasks.yaml for the same
  // reason). The structural proof is that the module never even imports a file-WRITE primitive
  // other than lib/ledger.ts's appendLedger (its own dedup/decision trail) — so there is no
  // codepath through which a tasks.yaml write (or any other file write) could occur at all.
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|\bwriteFile\b/, "no direct file-write primitive is imported/used");
  // Every literal "tasks.yaml" occurrence that DOES exist must be inside a comment line (// or
  // JSDoc /** ... */ prose — never inside an executable statement that could write it).
  const codeLines = src.split("\n").filter((line) => /tasks\.yaml/.test(line));
  for (const line of codeLines) {
    assert.match(line.trim(), /^(\*|\/\/|\/\*)/, `a tasks.yaml reference must live in a comment, found: ${line}`);
  }
});

// ── AlertPolicy loading + validation ─────────────────────────────────────────

test("validateAlertPolicy: accepts a well-formed policy and round-trips act_severities/critical_paths", () => {
  const p = validateAlertPolicy({
    act_severities: ["medium", "low"],
    critical_paths: {
      review: ["src/lib/review.ts"],
      gate: ["src/lib/gate*.ts"],
      containment: ["src/lib/containment*.ts"],
      ledger: ["src/lib/ledger.ts"],
      status: ["src/lib/status.ts"],
    },
  });
  assert.deepEqual(p.actSeverities, ["medium", "low"]);
  assert.deepEqual(p.criticalPaths.review, ["src/lib/review.ts"]);
});

test("validateAlertPolicy: rejects a missing required critical-path category", () => {
  assert.throws(
    () =>
      validateAlertPolicy({
        act_severities: ["medium"],
        critical_paths: { review: ["src/lib/review.ts"], gate: ["x"], containment: ["x"], ledger: ["x"] }, // status missing
      }),
    AlertPolicyError,
  );
});

test("validateAlertPolicy: rejects a review category missing the GOLDEN fixture path", () => {
  assert.throws(
    () =>
      validateAlertPolicy({
        act_severities: ["medium"],
        critical_paths: {
          review: ["src/lib/other.ts"], // missing src/lib/review.ts
          gate: ["x"],
          containment: ["x"],
          ledger: ["x"],
          status: ["x"],
        },
      }),
    AlertPolicyError,
  );
});

test("validateAlertPolicy: rejects an unknown severity in act_severities", () => {
  assert.throws(
    () =>
      validateAlertPolicy({
        act_severities: ["catastrophic"],
        critical_paths: {
          review: [GOLDEN_CRITICAL_PATH],
          gate: ["x"],
          containment: ["x"],
          ledger: ["x"],
          status: ["x"],
        },
      }),
    AlertPolicyError,
  );
});

test("validateAlertPolicy: rejects an empty act_severities array", () => {
  assert.throws(
    () =>
      validateAlertPolicy({
        act_severities: [],
        critical_paths: {
          review: [GOLDEN_CRITICAL_PATH],
          gate: ["x"],
          containment: ["x"],
          ledger: ["x"],
          status: ["x"],
        },
      }),
    /'act_severities' must be a non-empty array/,
  );
});

test("validateAlertPolicy: rejects a critical_paths that is not a mapping", () => {
  assert.throws(
    () =>
      validateAlertPolicy({
        act_severities: ["medium"],
        critical_paths: ["not", "a", "mapping"],
      }),
    /'critical_paths' must be a mapping of category -> glob\[\]/,
  );
});

test("validateAlertPolicy: rejects a critical_paths category whose globs are not all strings", () => {
  assert.throws(
    () =>
      validateAlertPolicy({
        act_severities: ["medium"],
        critical_paths: {
          review: [GOLDEN_CRITICAL_PATH, 42],
          gate: ["x"],
          containment: ["x"],
          ledger: ["x"],
          status: ["x"],
        },
      }),
    /'critical_paths\.review' must be an array of glob strings/,
  );
});

test("loadAlertPolicy: not-valid YAML throws a named AlertPolicyError naming the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "alert-policy-badyaml-"));
  const path = join(dir, "alert-policy.yaml");
  writeFileSync(path, "act_severities: [medium\n  bad: : indent\n");
  try {
    assert.throws(() => loadAlertPolicy(path), (e: unknown) => {
      assert.ok(e instanceof AlertPolicyError);
      assert.match((e as Error).message, /alert-policy\.yaml is not valid YAML/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("REQUIRED_CRITICAL_PATH_CATEGORIES names exactly the five P20 categories", () => {
  assert.deepEqual([...REQUIRED_CRITICAL_PATH_CATEGORIES].sort(), ["containment", "gate", "ledger", "review", "status"]);
});

test("loadAlertPolicy: the real plan/alert-policy.yaml loads and validates cleanly", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const policy = loadAlertPolicy(join(repoRoot, "plan", "alert-policy.yaml"));
  assert.ok(policy.actSeverities.includes("medium"));
  assert.ok(policy.actSeverities.includes("low"));
  for (const category of REQUIRED_CRITICAL_PATH_CATEGORIES) {
    assert.ok(policy.criticalPaths[category]?.length, `missing/empty category: ${category}`);
  }
  assert.ok(policy.criticalPaths.review.includes(GOLDEN_CRITICAL_PATH));
  // decideAlertDisposition over the REAL policy, proving the shipped file actually gates:
  assert.equal(decideAlertDisposition(MEDIUM_ON_REVIEW_ALERT, policy), "escalate");
  assert.equal(decideAlertDisposition(MEDIUM_SAFE_ALERT, policy), "act");
});

// ── priorDispatchedAlertIds ───────────────────────────────────────────────────

test("priorDispatchedAlertIds reads every alert-lane.dispatched task_id, ignoring other steps", () => {
  const ids = priorDispatchedAlertIds([
    { step: "alert-lane.dispatched", task_id: "alert-code-scanning-10" },
    { step: "alert-lane.decided", task_id: "alert-code-scanning-99" }, // wrong step — ignored
    { step: "escalation.issue_opened", task_id: "alert-dependabot-20" }, // wrong step — ignored
  ]);
  assert.deepEqual([...ids], ["alert-code-scanning-10"]);
});

// ── runAlertLane: acceptance #1 — dispatch exactly once, re-poll dispatches nothing ──

test("acceptance #1: a medium alert on a non-critical path dispatches exactly ONE lane run; re-poll dispatches no duplicate", async () => {
  const path = ledgerPath();
  const dispatchCalls: AlertLaneAlert[] = [];
  const escalateCalls: AlertLaneAlert[] = [];
  const deps = {
    ledgerPath: path,
    runId: "ALERT-FIX-1",
    dispatch: (alert: AlertLaneAlert) => {
      dispatchCalls.push(alert);
    },
    escalate: (alert: AlertLaneAlert) => {
      escalateCalls.push(alert);
      return "https://github.com/craigoley/remudero/issues/999";
    },
  };

  const first = await runAlertLane([MEDIUM_SAFE_ALERT], POLICY, deps);
  assert.equal(dispatchCalls.length, 1, "exactly one spawn on the first pass");
  assert.equal(first.dispatched.length, 1);
  assert.equal(escalateCalls.length, 0);

  // The dispatch ledger line carries the alert's provenance (taskId + alert# origin).
  const lines = readLines(path);
  const dispatchedLine = lines.find((l) => l.step === "alert-lane.dispatched");
  assert.ok(dispatchedLine, "an alert-lane.dispatched ledger line must exist");
  assert.equal(dispatchedLine!.task_id, alertTaskId(MEDIUM_SAFE_ALERT));
  assert.equal(dispatchedLine!.origin, `alert#${alertOriginId(MEDIUM_SAFE_ALERT)}`);

  // Re-poll: the SAME (unchanged) alert list, against the SAME ledger (now carrying the dispatch
  // line) -> zero additional spawn calls.
  const second = await runAlertLane([MEDIUM_SAFE_ALERT], POLICY, { ...deps, runId: "ALERT-FIX-2" });
  assert.equal(dispatchCalls.length, 1, "re-poll must NOT call dispatch again");
  assert.equal(second.dispatched.length, 0);
  assert.equal(second.skippedDuplicateDispatch.length, 1);
});

// ── runAlertLane: acceptance #2 — critical and medium-on-critical-path both escalate, dispatch nothing ──

test("acceptance #2a: a critical-severity alert escalates and dispatches NOTHING", async () => {
  const path = ledgerPath();
  const dispatchCalls: AlertLaneAlert[] = [];
  const escalateCalls: AlertLaneAlert[] = [];
  const result = await runAlertLane([CRITICAL_ALERT], POLICY, {
    ledgerPath: path,
    runId: "ALERT-FIX-1",
    dispatch: (a) => {
      dispatchCalls.push(a);
    },
    escalate: (a) => {
      escalateCalls.push(a);
      return "https://github.com/craigoley/remudero/issues/1000";
    },
  });
  assert.equal(escalateCalls.length, 1);
  assert.equal(dispatchCalls.length, 0);
  assert.equal(result.escalated.length, 1);
  assert.equal(result.dispatched.length, 0);
});

test("acceptance #2b: a medium-severity alert touching a policy-named critical path (src/lib/review.ts) escalates and dispatches NOTHING", async () => {
  const path = ledgerPath();
  const dispatchCalls: AlertLaneAlert[] = [];
  const escalateCalls: AlertLaneAlert[] = [];
  const result = await runAlertLane([MEDIUM_ON_REVIEW_ALERT], POLICY, {
    ledgerPath: path,
    runId: "ALERT-FIX-1",
    dispatch: (a) => {
      dispatchCalls.push(a);
    },
    escalate: (a) => {
      escalateCalls.push(a);
      return "https://github.com/craigoley/remudero/issues/1001";
    },
  });
  assert.equal(escalateCalls.length, 1);
  assert.equal(dispatchCalls.length, 0);
  assert.equal(result.escalated.length, 1);
  assert.equal(result.dispatched.length, 0);
});

// ── runAlertLane: cross-lane escalation dedup (shares ops.ts's escalation.issue_opened namespace) ──

test("runAlertLane: an alert already escalated (e.g. by rmd ops's own poll) is never escalated again here", async () => {
  const path = ledgerPath();
  // Seed the ledger as if `rmd ops`'s poll already escalated this exact alert.
  const { appendLedger } = await import("../src/lib/ledger.js");
  appendLedger(path, {
    run_id: "OPS-1",
    task_id: alertTaskId(CRITICAL_ALERT),
    step: "escalation.issue_opened",
    class: "MANUAL",
    issue_url: "https://github.com/craigoley/remudero/issues/1",
  });

  const escalateCalls: AlertLaneAlert[] = [];
  const result = await runAlertLane([CRITICAL_ALERT], POLICY, {
    ledgerPath: path,
    runId: "ALERT-FIX-1",
    dispatch: () => {},
    escalate: (a) => {
      escalateCalls.push(a);
      return "should-not-be-called";
    },
  });
  assert.equal(escalateCalls.length, 0, "the escalate-ledger namespace is SHARED with rmd ops — no duplicate escalation");
  assert.equal(result.skippedDuplicateEscalate.length, 1);
});

// ── runAlertLane: non-open alerts are skipped entirely ──────────────────────

test("runAlertLane: a non-open (e.g. fixed/dismissed) alert is skipped — no decision, no dispatch, no escalate", async () => {
  const path = ledgerPath();
  const closedAlert: AlertLaneAlert = { ...MEDIUM_SAFE_ALERT, state: "fixed" };
  const dispatchCalls: AlertLaneAlert[] = [];
  const escalateCalls: AlertLaneAlert[] = [];
  const result = await runAlertLane([closedAlert], POLICY, {
    ledgerPath: path,
    runId: "ALERT-FIX-1",
    dispatch: (a) => {
      dispatchCalls.push(a);
    },
    escalate: (a) => {
      escalateCalls.push(a);
      return "unused";
    },
  });
  assert.equal(dispatchCalls.length, 0);
  assert.equal(escalateCalls.length, 0);
  assert.equal(result.dispatched.length, 0);
  assert.equal(result.escalated.length, 0);
  assert.deepEqual(readLines(path), [], "a skipped non-open alert leaves no ledger trace");
});

// ── runAlertLane: every decision is a ledger line (P20's own design note) ───

test("runAlertLane: every act/escalate decision writes an alert-lane.decided ledger line, naming the disposition", async () => {
  const path = ledgerPath();
  await runAlertLane([MEDIUM_SAFE_ALERT, CRITICAL_ALERT], POLICY, {
    ledgerPath: path,
    runId: "ALERT-FIX-1",
    dispatch: () => {},
    escalate: () => "url",
  });
  const decided = readLines(path).filter((l) => l.step === "alert-lane.decided");
  assert.equal(decided.length, 2);
  const bySource = Object.fromEntries(decided.map((l) => [l.task_id, l.disposition]));
  assert.equal(bySource[alertTaskId(MEDIUM_SAFE_ALERT)], "act");
  assert.equal(bySource[alertTaskId(CRITICAL_ALERT)], "escalate");
});
