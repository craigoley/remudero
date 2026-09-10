import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { appendLedger } from "../src/lib/ledger.js";
import { runDaemon, type DaemonDeps } from "../src/lib/daemon.js";
import { loadPlan } from "../src/lib/plan.js";
import { loadPolicy, policyPath, type Policy } from "../src/lib/policy.js";
import { buildIntakeRungsDaemonHooks, ledgerPathFor } from "../src/run-task.js";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const NOW = new Date("2026-09-10T12:00:00.000Z");

function fixture(): { root: string; planPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rmd-intake-rungs-"));
  mkdirSync(join(root, "state"), { recursive: true });
  const planPath = join(root, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return { root, planPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function policyWithIssues(enabled: boolean): Policy {
  const shipped = loadPolicy(policyPath(REPO_ROOT));
  return {
    ...shipped,
    values: {
      ...shipped.values,
      intakeCadence: {
        ...shipped.values.intakeCadence,
        issues: { enabled, minIntervalMinutes: 60, maxPerDay: 4 },
      },
    },
  };
}

// checkStop admits exactly this many ticks before returning "bound", so a per-tick row count is a
// fixed number rather than a floor — a floor would still pass if the intake block ran once and stopped.
// The producer's own dep bag, so the fakes below are cast to the REAL verb signatures rather than
// to `never`: a fake whose shape drifts from the verb it stands in for still fails to compile.
type IntakeHookDeps = NonNullable<Parameters<typeof buildIntakeRungsDaemonHooks>[0]>;

const TICKS_PER_RUN = 2;

async function runTwoIntakeTicks(root: string, planPath: string, deps: Pick<DaemonDeps, "checkIntakeRungs" | "runIntakeRung">) {
  let stopChecks = 0;
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  await runDaemon(loadPlan(planPath), {
    refreshMerged: () => () => true,
    runOne: async () => {
      throw new Error("empty plan must never dispatch");
    },
    checkStop: () => {
      stopChecks++;
      return stopChecks > 2 ? "bound" : undefined;
    },
    sleep: async () => {},
    log: (step, extra = {}) => lines.push({ step, extra: extra ?? {} }),
    ...deps,
  });
  return lines;
}

test("one daemon tick polls issues when enabled, and the next tick inside the interval runs nothing", async () => {
  const disabled = fixture();
  try {
    let disabledPolls = 0;
    const disabledHooks = buildIntakeRungsDaemonHooks({
      config: { root: disabled.root, claudeBin: "/bin/true" },
      clock: fixedClock(NOW.getTime()),
      policy: policyWithIssues(false),
      loadManagedRepos: () => [{ owner: "acme", repo: "app" }],
      pollIssues: async () => {
        disabledPolls++;
        throw new Error("disabled issues rung must not poll");
      },
    });
    await runTwoIntakeTicks(disabled.root, disabled.planPath, disabledHooks);
    assert.equal(disabledPolls, 0, "disabled policy is the control: no issue poll runs");
    assert.equal(readLedgerRows(ledgerPathFor({ root: disabled.root, claudeBin: "/bin/true" })).length, 0);
  } finally {
    disabled.cleanup();
  }

  const enabled = fixture();
  try {
    let polls = 0;
    const hooks = buildIntakeRungsDaemonHooks({
      config: { root: enabled.root, claudeBin: "/bin/true" },
      clock: fixedClock(NOW.getTime()),
      policy: policyWithIssues(true),
      loadManagedRepos: () => [{ owner: "acme", repo: "app" }],
      pollIssues: async (managed, deps) => {
        polls++;
        const summary = {
          polledAt: NOW.toISOString(),
          repos: managed.map((r) => `${r.owner}/${r.repo}`),
          reviewedCount: 1,
          createdCount: 0,
        };
        appendLedger(deps.ledgerPath, {
          run_id: deps.runId,
          task_id: "ISSUES",
          step: "issues.polled",
          issues: summary,
        });
        return { summary, newIssues: [], created: [], skippedExisting: 0 };
      },
    });

    const lines = await runTwoIntakeTicks(enabled.root, enabled.planPath, hooks);
    const ledgerRows = readLedgerRows(ledgerPathFor({ root: enabled.root, claudeBin: "/bin/true" }));

    assert.equal(polls, 1, "the marker-first cadence blocks the immediate second tick");
    assert.equal(ledgerRows.filter((r) => r.step === "issues.polled").length, 1, "the issue poll ran from the daemon");
    assert.ok(lines.some((l) => l.step === "intake_cadence.fired" && l.extra.rung === "issues"));
    assert.ok(
      lines.some(
        (l) => l.step === "intake_cadence.skipped" && l.extra.rung === "issues" && String(l.extra.reason).includes("minInterval"),
      ),
      "the second tick names the interval refusal",
    );
  } finally {
    enabled.cleanup();
  }
});

function readLedgerRows(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ── W1-T2923: THE ARMS THE HAPPY PATH CANNOT REACH ────────────────────────────────────────────
// The suite above proves the cadence fires and then holds. Everything below drives the arms that a
// firing rung never touches: the two catch blocks in the daemon's intake block, the ratification
// refusal, and each rung's own dispatch. Every assertion names a row or a throw that DISAPPEARS
// when its arm is deleted — none of them re-assert the covered path from a second angle.

test("a check that throws costs one ledger-visible row per tick and dispatches nothing", async () => {
  const f = fixture();
  try {
    let ran = 0;
    const lines = await runTwoIntakeTicks(f.root, f.planPath, {
      checkIntakeRungs: () => {
        throw new Error("policy read exploded");
      },
      runIntakeRung: () => {
        ran++;
        return { rung: "issues", status: "ok" };
      },
    });
    const failed = lines.filter((l) => l.step === "intake_cadence.check_failed");
    assert.equal(failed.length, TICKS_PER_RUN, "every tick reports its own failed check");
    assert.match(String(failed[0].extra.error), /policy read exploded/, "the row carries the cause, not a bare marker");
    assert.equal(ran, 0, "a check that threw decides nothing, so no rung runs");
    assert.equal(lines.filter((l) => l.step === "intake_cadence.fired").length, 0);
  } finally {
    f.cleanup();
  }
});

test("a rung whose run throws is reported by rung and the tick keeps going", async () => {
  const f = fixture();
  try {
    const lines = await runTwoIntakeTicks(f.root, f.planPath, {
      checkIntakeRungs: () => [{ rung: "ops", fire: true, reason: "due" }],
      runIntakeRung: () => {
        throw new Error("gh alert list timed out");
      },
    });
    const failed = lines.filter((l) => l.step === "intake_cadence.run_failed");
    assert.equal(failed.length, TICKS_PER_RUN, "a throwing rung is best-effort: it is logged, not fatal");
    assert.equal(failed[0].extra.rung, "ops", "the row names WHICH rung threw");
    assert.match(String(failed[0].extra.error), /gh alert list timed out/);
    assert.equal(lines.filter((l) => l.step === "intake_cadence.ran").length, 0, "a throw writes no success row");
  } finally {
    f.cleanup();
  }
});

test("a rung whose ratified operation hash has drifted refuses, records the drift, and decides nothing else", () => {
  const f = fixture();
  const config = { root: f.root, claudeBin: "/bin/true" };
  try {
    const hooks = buildIntakeRungsDaemonHooks({
      config,
      clock: fixedClock(NOW.getTime()),
      policy: policyWithIssues(true),
      ratifications: new Map([
        [
          "intakeCadence.issues",
          {
            rung: "intakeCadence.issues",
            operationHash: "0000000000000000000000000000000000000000000000000000000000000000",
            ratifiedAt: "2026-01-01T00:00:00.000Z",
            ratifiedBy: "operator",
          },
        ],
      ]),
    });

    const issues = hooks.checkIntakeRungs().find((d) => d.rung === "issues");
    assert.equal(issues?.fire, false, "a pin that no longer matches the live policy refuses the rung");
    assert.match(String(issues?.reason), /ratified operation no longer matches/);

    const unratified = readLedgerRows(ledgerPathFor(config)).filter((r) => r.step === "rung.unratified");
    assert.equal(unratified.length, 1, "the refusal is on the ledger, not only in the return value");
    assert.equal(unratified[0].rung, "intakeCadence.issues");
    assert.match(String(unratified[0].diff), /re-run/, "the row tells the operator how to re-ratify");
  } finally {
    f.cleanup();
  }
});

test("runIntakeRung refuses a rung the policy never declared", async () => {
  const f = fixture();
  try {
    const hooks = buildIntakeRungsDaemonHooks({
      config: { root: f.root, claudeBin: "/bin/true" },
      clock: fixedClock(NOW.getTime()),
      policy: policyWithIssues(true),
    });
    await assert.rejects(
      async () => await hooks.runIntakeRung({ rung: "not-a-rung", fire: true, reason: "forced" }),
      /unknown intake rung: not-a-rung/,
      "an undeclared rung throws rather than falling through to the last branch",
    );
  } finally {
    f.cleanup();
  }
});

test("the codeqlQuality rung's SUCCESS arm partitions the alerts it was handed and ledgers the counts", async () => {
  // The sibling test drives this rung with `{ok:false}` (the 403), which exercises the refusal and
  // leaves the whole success arm unrun — the gap diff-coverage named. Same harness, real alerts.
  const f = fixture();
  const config = { root: f.root, claudeBin: "/bin/true" };
  try {
    const alert = (number: number, tags: string[]) => ({
      source: "code-scanning" as const, id: String(number), severity: "low" as const, state: "open",
      createdAt: "2026-09-10T00:00:00Z", summary: `rule ${number}`,
      url: `https://github.com/o/r/security/code-scanning/${number}`,
      toolName: "CodeQL", ruleTags: tags, ruleId: "js/unused-local-variable",
    });
    const hooks = buildIntakeRungsDaemonHooks({
      config,
      clock: fixedClock(NOW.getTime()),
      policy: policyWithIssues(true),
      // Two eligible, one excluded by tool — so the counts below cannot all be the same number,
      // which is what makes the partition assertions load-bearing rather than shape-only.
      readCodeScanningAlerts: () => ({
        ok: true,
        alerts: [
          alert(1, ["quality", "maintainability"]),
          alert(2, ["quality", "maintainability"]),
          { ...alert(3, ["security"]), toolName: "Scorecard" },
        ],
      }),
    });

    const result = await hooks.runIntakeRung({ rung: "codeqlQuality", fire: true, reason: "due" });
    assert.equal(result.rung, "codeqlQuality");
    assert.notEqual(result.status, "refused", "a readable alert list is not a refusal");

    const row = readLedgerRows(ledgerPathFor(config)).find((r) => r.step === "codeql_quality.partitioned");
    assert.ok(row, "the success arm ledgers its partition — the refusal row alone is not evidence it ran");
    assert.equal(row?.scanned_alerts, 3, "every alert handed in is counted as scanned");
    assert.equal(row?.eligible_alerts, 2, "only the CodeQL quality+maintainability alerts are eligible");
    assert.equal(row?.excluded_alerts, 1, "the Scorecard alert is excluded, not silently dropped");
    // THE PARTITION IS TOTAL: every eligible alert lands in exactly one disposition.
    assert.equal(
      Number(row?.rejected_alerts) + Number(row?.covered_alerts) + Number(row?.unassigned_alerts),
      Number(row?.eligible_alerts),
      "rejected + covered + unassigned must account for every eligible alert",
    );
  } finally {
    f.cleanup();
  }
});

test("each declared rung dispatches to its own verb and reports that verb's own numbers", async () => {
  const f = fixture();
  const config = { root: f.root, claudeBin: "/bin/true" };
  try {
    // Distinct magnitudes on purpose: a result field wired to the wrong source reads as a different
    // number here rather than as an equal one, which is what makes the deepEqual load-bearing.
    let reconciled: unknown[] | undefined = [{}];
    let alertFixExit = 0;
    let inboxExit = 0;
    const hooks = buildIntakeRungsDaemonHooks({
      config,
      clock: fixedClock(NOW.getTime()),
      policy: policyWithIssues(true),
      pollAlerts: (async () => ({
        summary: { totalOpen: 3 },
        feedbackCreated: [{}, {}],
        reconciled,
        escalated: [{}, {}, {}, {}, {}],
      })) as unknown as IntakeHookDeps["pollAlerts"],
      readCodeScanningAlerts: () => ({ ok: false, error: "HTTP 403: Resource not accessible by integration" }),
      alertFix: (async () => alertFixExit) as unknown as IntakeHookDeps["alertFix"],
      inbox: (async () => inboxExit) as unknown as IntakeHookDeps["inbox"],
      feedbackDocket: ((
        _config: unknown,
        _ledgerPath: string,
        _runId: string,
        log: (step: string, extra?: Record<string, unknown>) => void,
      ) => {
        log("feedback_docket.test_row", { fired: 7 });
        return { fired: 7 };
      }) as unknown as IntakeHookDeps["feedbackDocket"],
    });
    const run = (rung: string) => hooks.runIntakeRung({ rung, fire: true, reason: "due" });

    assert.deepEqual(await run("ops"), {
      rung: "ops",
      status: "ok",
      alerts: 3,
      feedback_created: 2,
      feedback_reconciled: 1,
      escalated: 5,
    });
    reconciled = undefined;
    assert.equal(
      (await run("ops")).feedback_reconciled,
      0,
      "a poll that reconciled nothing reports zero, never undefined",
    );

    assert.deepEqual(await run("alertFix"), { rung: "alertFix", status: "ok", exit_code: 0 });
    alertFixExit = 2;
    assert.deepEqual(await run("alertFix"), { rung: "alertFix", status: "refused", exit_code: 2 });

    assert.deepEqual(await run("codeqlQuality"), {
      rung: "codeqlQuality",
      status: "refused",
      reason: "code-scanning read failed",
    });
    const codeqlRefusal = readLedgerRows(ledgerPathFor(config)).find((row) => row.step === "codeql_quality.refused");
    assert.ok(codeqlRefusal, "a 403 is visible as a refusal, not reported as a successful zero-alert sweep");
    assert.match(String(codeqlRefusal?.error), /403/);

    assert.deepEqual(await run("inbox"), { rung: "inbox", status: "ok", exit_code: 0 });
    inboxExit = 1;
    assert.deepEqual(await run("inbox"), { rung: "inbox", status: "refused", exit_code: 1 });

    assert.deepEqual(await run("feedbackDocket"), { rung: "feedbackDocket", status: "ok", fired: 7 });
    const docket = readLedgerRows(ledgerPathFor(config)).find((r) => r.step === "feedback_docket.test_row");
    assert.ok(docket, "the docket rung's log closure writes through to the ledger");
    assert.equal(docket?.lane, "intake", "the closure stamps the lane the rung runs in");
    assert.equal(docket?.rung, "feedbackDocket", "and the rung, so a docket row is attributable");
  } finally {
    f.cleanup();
  }
});
