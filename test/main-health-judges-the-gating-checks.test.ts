/**
 * W1-T4056 — MAIN-HEALTH JUDGES THE CHECKS THAT GATE A MERGE, NOT EVERY CHECK ON MAIN'S HEAD.
 *
 * `buildMainHealthRung` called `mainHealthFromRollup(sha, rollup, undefined)`, so every check run
 * attached to main's head counted, and a SCHEDULED workflow attaches its run there. Measured
 * 2026-09-22: 65 of 83 `[MANUAL] MAIN-HEALTH` issues since 09-12 named `heartbeat-watch`, a
 * host-liveness monitor, and one named CodeQL's `Analyze (actions)`; neither is in ci-gate's
 * REQUIRED list, the repository's own definition of what gates a merge. A real red main must stay
 * loud, so these fixtures pin BOTH directions and the fail-open arm between them.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCiGateRequiredChecks } from "../src/lib/ci-gate-required.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import { buildMainHealthRung, type MainHealthRungDeps } from "../src/lib/main-health-rung.js";
import type { GhApiFetcher } from "../src/lib/open-prs-rest.js";
import type { RollupCheckEntry } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const OWNER = "o";
const REPO = "r";
const SHA = "4056".padEnd(40, "0");
const MONITOR = "heartbeat-watch (reads every host's beat branch off-machine; fails when one goes silent)";
const CODEQL = "Analyze (actions)";
/** A slice of ci-gate's REQUIRED list — enough to hold the required side of every fixture. */
const REQUIRED = ["ci", "coverage-ratchet", "lint-plan"];

type CheckRun = { name: string; status: "completed"; conclusion: "success" | "failure" };
const run = (name: string, conclusion: CheckRun["conclusion"]): CheckRun => ({ name, status: "completed", conclusion });

function observe(checkRuns: CheckRun[], overrides: Partial<MainHealthRungDeps> = {}) {
  const fetch = ((args: string[]) => {
    const path = args[1] ?? "";
    if (path === `repos/${OWNER}/${REPO}`) return { default_branch: "main" };
    if (path === `repos/${OWNER}/${REPO}/commits/main`) return { sha: SHA };
    if (path === `repos/${OWNER}/${REPO}/commits/${SHA}/check-runs?per_page=100`) return { check_runs: checkRuns };
    if (path === `repos/${OWNER}/${REPO}/commits/${SHA}/status`) return { statuses: [] };
    if (path.startsWith(`repos/${OWNER}/${REPO}/actions/runs?`)) return { workflow_runs: [] };
    throw new Error(`unrouted gh api path: ${path}`);
  }) as GhApiFetcher;
  const created: Array<{ title: string; body: string }> = [];
  const issues: IssueGateway = {
    create: (title, body) => {
      created.push({ title, body });
      return `https://github.com/${OWNER}/${REPO}/issues/${created.length}`;
    },
    listOpen: () => [],
    comment: () => {},
    closeWithComment: () => {},
  };
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4056-`));
  const rung = buildMainHealthRung(OWNER, REPO, {
    fetch,
    issues,
    ledgerPath: join(root, "ledger.ndjson"),
    runId: "DAEMON-T4056",
    log: (step, extra = {}) => logs.push({ step, extra }),
    readRequiredChecks: () => REQUIRED,
    ...overrides,
  });
  return {
    run: async () => {
      try {
        await rung();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
      return { created, logs, observed: logs.find((l) => l.step === "main.health.observed")?.extra };
    },
  };
}

test("W1-T4056: a red monitor alone does not make main red", async () => {
  for (const advisory of [MONITOR, CODEQL]) {
    const { created, observed, logs } = await observe([run("ci", "success"), run("coverage-ratchet", "success"), run(advisory, "failure")]).run();
    assert.equal(observed?.state, "green", `${advisory} failing alone must not read main as red`);
    assert.deepEqual(observed?.failing_checks, []);
    assert.equal(created.length, 0, "no MAIN-HEALTH issue is filed for a non-gating check");
    assert.equal(logs.some((l) => l.step === "main.health.escalated"), false);
  }
});

test("W1-T4056: a red required check still makes main red", async () => {
  // The monitor fails TOO: dropping it must not drop the required failure beside it.
  const { created, observed } = await observe([run("ci", "failure"), run("coverage-ratchet", "success"), run(MONITOR, "failure")]).run();
  assert.equal(observed?.state, "red");
  assert.deepEqual(observed?.failing_checks, ["ci"], "only the gating failure is judged");
  assert.equal(created.length, 1, "a real red main still files");
  assert.match(created[0]!.body, /concluded failing on main: ci\b/);
  assert.doesNotMatch(created[0]!.body, /concluded failing on main:[^\n]*heartbeat-watch/, "the monitor is not named as main's failure");
});

test("W1-T4056: an unreadable contract judges every check", async () => {
  // The REAL reader over a root with no ci-gate.yml: it fails inert to [], and [] must mean "judge
  // everything", never "nothing is required, so green".
  const empty = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t4056-no-contract-`));
  try {
    assert.deepEqual(readCiGateRequiredChecks(empty), []);
    const { created, observed } = await observe([run("ci", "success"), run(MONITOR, "failure")], {
      readRequiredChecks: () => readCiGateRequiredChecks(empty),
    }).run();
    assert.equal(observed?.state, "red", "today's behaviour: every check counts");
    assert.deepEqual(observed?.failing_checks, [MONITOR]);
    assert.equal(observed?.judged_against, "all-checks");
    assert.equal(created.length, 1);
    // And a rung built with no reader at all behaves exactly the same way.
    const unwired = await observe([run("ci", "success"), run(MONITOR, "failure")], { readRequiredChecks: undefined }).run();
    assert.equal(unwired.observed?.state, "red");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("W1-T4056: a red non-required check is ledgered as advisory", async () => {
  const { observed } = await observe([run("ci", "success"), run(MONITOR, "failure"), run(CODEQL, "failure")]).run();
  assert.equal(observed?.judged_against, "ci-gate-required");
  assert.deepEqual(observed?.advisory_failing_checks, [MONITOR, CODEQL].sort(), "a red monitor stays visible without escalating");
  // CONTROL: with nothing advisory failing, the field is absent rather than an empty list on every tick.
  const quiet = await observe([run("ci", "success"), run(MONITOR, "success")]).run();
  assert.equal("advisory_failing_checks" in (quiet.observed ?? {}), false);
});

test("W1-T4056: the retry evidence reads only the judged checks", async () => {
  // readCiFailures fetches a log per failing entry it is handed; handing it the monitor would both
  // spend a read and break the exact-evidence match the infrastructure requeue depends on.
  const seen: string[][] = [];
  await observe([run("ci", "failure"), run(MONITOR, "failure")], {
    readCiFailures: (rollup: readonly RollupCheckEntry[] | undefined) => {
      seen.push((rollup ?? []).map((c) => c.name ?? c.context ?? ""));
      return [];
    },
  }).run();
  assert.deepEqual(seen, [["ci"]]);
});
