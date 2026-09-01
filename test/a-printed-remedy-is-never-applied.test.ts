/**
 * test/a-printed-remedy-is-never-applied.test.ts — W1-T2551.
 *
 * THE DEFECT. Every `<name>:check` npm script paired with a bare `<name>` script is a GENERATOR
 * run in verify mode (plan-index/plan-index:check, docs-index/docs-index:check,
 * learnings-index/learnings-index:check, cli-reference/cli-reference:check,
 * capability-snapshot/capability-snapshot:check, learnings-assert/learnings-assert:check, as
 * declared in this repo's OWN package.json). Every one of those generators fails `--check` with
 * the IDENTICAL sentence, `Run 'npm run <name>' and commit the result.` (grepped verbatim out of
 * scripts/generate-plan-index.mjs et al., not assumed) — a printed, machine-fixable remedy. Before
 * this task, a ci-log fix-rung dispatch for exactly this class was handed to a full fix WORKER
 * anyway, spending a strike against `strikeCap` to reach the command the gate already named.
 *
 * THE FIX (src/run-task.ts). `declaredGeneratorScriptFor`/`remedyGeneratorNamedInLog`/
 * `generatorFixFor`/`allCiFailuresAreGeneratorFixable` derive the pairing straight off a
 * `scripts` map (package.json's own, at the real call sites) — never a hand-maintained table.
 * `runGeneratorFixForCiFailures` runs the declared generator(s), re-verifies each one's own
 * `:check` before ever committing, and commits+pushes only the generator's own output.
 * `runFixRung`'s new `W1-T2551 SITE` (before `strikes++`) calls it instead of spawning a worker
 * whenever a ci-log round's evidence is ENTIRELY generator-fixable.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  allCiFailuresAreGeneratorFixable,
  declaredGeneratorScriptFor,
  generatorFixFor,
  remedyGeneratorNamedInLog,
  runFixRung,
  runGeneratorFixForCiFailures,
} from "../src/run-task.js";
import type { CiFailure } from "../src/lib/sweep.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

// ── shared fixtures (mirrors test/fix-rung-empty-failures-stand-down.test.ts's own conventions) ─

function result(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function ciLogInitialReview(headSha = "deadbeef"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [],
    testTheater: false,
    summary: "sweep-reconstructed: required checks red (1 failing check(s)) — ci-log dispatch",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "sweep-reconstructed-ci-log",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts(task: { id: string; title: string }) {
  return {
    taskId: task.id,
    runId: `${task.id}-1730000000000`,
    task,
    prUrl: "https://github.com/acme/remudero/pull/2551",
    branch: `run-${task.id}-1730000000000`,
    worktreePath: "/tmp/rmd-generator-fix-wt",
    initialSessionId: "",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-generator-fix-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-generator-fix-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-generator-fix-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 900;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {
      // not exercised by these tests
    },
  };
}

// A REAL sample of package.json's own declared scripts (a subset, mirroring the shape measured on
// this repo 2026-08) — used for the pairing-derivation tests. Deliberately a LOCAL literal, never
// imported from package.json, so these tests prove the FUNCTIONS read whatever `scripts` map they
// are given, not a baked-in assumption about this repo's own file.
const REAL_SHAPED_SCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  "plan-index": "node scripts/generate-plan-index.mjs",
  "plan-index:check": "node scripts/generate-plan-index.mjs --check",
  "docs-index": "node scripts/generate-docs-index.mjs",
  "docs-index:check": "node scripts/generate-docs-index.mjs --check",
  "learnings-index": "node scripts/generate-learnings-index.mjs",
  "learnings-index:check": "node scripts/generate-learnings-index.mjs --check",
  "cli-reference": "tsx scripts/generate-cli-reference.mjs",
  "cli-reference:check": "tsx scripts/generate-cli-reference.mjs --check",
  "capability-snapshot": "tsx scripts/generate-capability-snapshot.mjs",
  "capability-snapshot:check": "tsx scripts/generate-capability-snapshot.mjs --check",
  // `api-client:check` has NO bare `api-client` counterpart declared — the real, measured
  // "no generator pairing" case (its fix is a different, non-generator command).
  "api-client:check": "node scripts/generate-api-client.mjs --check",
  test: "node --test test/**/*.test.ts",
});

function remedyLog(name: string, extra = ""): string {
  return `generate-${name}: /repo/${name}.json is STALE -- it does not match a fresh regeneration.\nRun 'npm run ${name}' and commit the result.\n${extra}`;
}

// ── declaredGeneratorScriptFor / remedyGeneratorNamedInLog / generatorFixFor ─────────────────────

test("declaredGeneratorScriptFor: a `:check` script paired with a declared bare script resolves to the bare name", () => {
  assert.equal(declaredGeneratorScriptFor(REAL_SHAPED_SCRIPTS, "plan-index:check"), "plan-index");
  assert.equal(declaredGeneratorScriptFor(REAL_SHAPED_SCRIPTS, "learnings-index:check"), "learnings-index");
  // Bare name given directly resolves identically — the pairing is symmetric.
  assert.equal(declaredGeneratorScriptFor(REAL_SHAPED_SCRIPTS, "docs-index"), "docs-index");
});

test("declaredGeneratorScriptFor: a `:check` script with NO declared bare counterpart is undefined (the real api-client:check shape)", () => {
  assert.equal(declaredGeneratorScriptFor(REAL_SHAPED_SCRIPTS, "api-client:check"), undefined);
});

test("declaredGeneratorScriptFor: a name package.json does not declare at all is undefined", () => {
  assert.equal(declaredGeneratorScriptFor(REAL_SHAPED_SCRIPTS, "totally-unknown-script"), undefined);
  assert.equal(declaredGeneratorScriptFor(REAL_SHAPED_SCRIPTS, "totally-unknown-script:check"), undefined);
});

test("declaredGeneratorScriptFor: reads THE GIVEN scripts map, not a hand-maintained list — a repo-specific pairing absent from any built-in table still resolves", () => {
  // acceptance criterion 2: "the pairing is read from package.json's own declared scripts rather
  // than a hand-maintained list" — a synthetic, non-standard name proves the function is not
  // matching against any internal table of known generator names.
  const customScripts = { "widget-catalog": "node scripts/gen-widgets.mjs", "widget-catalog:check": "node scripts/gen-widgets.mjs --check" };
  assert.equal(declaredGeneratorScriptFor(customScripts, "widget-catalog:check"), "widget-catalog");
  // The SAME name in a DIFFERENT scripts map (missing the bare counterpart) is unpaired — proving
  // the decision is a live read of the map argument, not a cached/global fact about the name.
  assert.equal(declaredGeneratorScriptFor({ "widget-catalog:check": "node scripts/gen-widgets.mjs --check" }, "widget-catalog:check"), undefined);
});

test("remedyGeneratorNamedInLog: extracts the generator name from the EXACT sentence every generate-*.mjs script prints", () => {
  assert.equal(remedyGeneratorNamedInLog(remedyLog("plan-index")), "plan-index");
  assert.equal(remedyGeneratorNamedInLog(remedyLog("learnings-assert")), "learnings-assert");
});

test("remedyGeneratorNamedInLog: undefined for an ordinary CI failure that names no such remedy", () => {
  assert.equal(remedyGeneratorNamedInLog("Error: expected 200 but got 500\n  at Object.<anonymous> (test/api.test.ts:42:11)"), undefined);
  assert.equal(remedyGeneratorNamedInLog(""), undefined);
});

test("generatorFixFor: BOTH the log must name a remedy AND that name must be a declared pairing", () => {
  assert.equal(generatorFixFor({ logTail: remedyLog("plan-index") }, REAL_SHAPED_SCRIPTS), "plan-index");
  // The log names a real command, but this scripts map declares no pairing for it (the untrusted-
  // log threat model, W1-T210's own discipline extended here: a crafted log naming an arbitrary
  // command must never be enough on its own).
  assert.equal(generatorFixFor({ logTail: "Run 'npm run rm-rf-everything' and commit the result." }, REAL_SHAPED_SCRIPTS), undefined);
  // The log names nothing at all.
  assert.equal(generatorFixFor({ logTail: "lint error on line 4" }, REAL_SHAPED_SCRIPTS), undefined);
});

test("allCiFailuresAreGeneratorFixable: true only when EVERY failure resolves — a mixed batch is false (acceptance criterion 3)", () => {
  const allFixable: CiFailure[] = [{ name: "plan-index-check", logTail: remedyLog("plan-index") }, { name: "docs-index-check", logTail: remedyLog("docs-index") }];
  assert.equal(allCiFailuresAreGeneratorFixable(allFixable, REAL_SHAPED_SCRIPTS), true);

  const mixed: CiFailure[] = [{ name: "plan-index-check", logTail: remedyLog("plan-index") }, { name: "unit-tests", logTail: "AssertionError: expected true to equal false" }];
  assert.equal(allCiFailuresAreGeneratorFixable(mixed, REAL_SHAPED_SCRIPTS), false);

  assert.equal(allCiFailuresAreGeneratorFixable([], REAL_SHAPED_SCRIPTS), false, "empty is never fixable — nothing to fix");
});

// ── runGeneratorFixForCiFailures (the orchestration, unit-tested with injected deps only) ────────

test("runGeneratorFixForCiFailures (criterion 1): runs the declared generator, re-checks, and commits — no worker-shaped interaction anywhere in this function's own surface", async () => {
  const ranScripts: string[] = [];
  const commits: Array<{ cwd: string; message: string }> = [];
  const pushes: Array<{ cwd: string; branch: string }> = [];

  const outcome = await runGeneratorFixForCiFailures({
    failures: [{ name: "plan-index-check", logTail: remedyLog("plan-index") }],
    scripts: REAL_SHAPED_SCRIPTS,
    worktreePath: "/tmp/wt-2551",
    taskId: "W1-T9001",
    branch: "run-W1-T9001-1",
    deps: {
      runScript: async (script, cwd) => {
        ranScripts.push(script);
        assert.equal(cwd, "/tmp/wt-2551");
        return { status: 0, stdout: "", stderr: "" };
      },
      commit: (o) => {
        commits.push(o);
        return { sha: "cafef00d", changed: true };
      },
      push: async (o) => {
        pushes.push(o);
      },
    },
  });

  assert.deepEqual(ranScripts, ["plan-index", "plan-index:check"], "the generator runs, then its OWN check re-verifies — in that order");
  assert.equal(outcome.applied, true);
  assert.deepEqual(outcome.generators, ["plan-index"]);
  assert.equal(outcome.commitSha, "cafef00d");
  assert.equal(commits.length, 1, "exactly one commit — the generator's own output");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].branch, "run-W1-T9001-1");
});

test("runGeneratorFixForCiFailures (criterion 2): the pairing comes from the `scripts` ARGUMENT, never a built-in table — an unconventional name still resolves", async () => {
  const customScripts = { "widget-catalog": "node scripts/gen-widgets.mjs", "widget-catalog:check": "node scripts/gen-widgets.mjs --check" };
  const ranScripts: string[] = [];

  const outcome = await runGeneratorFixForCiFailures({
    failures: [{ name: "widget-catalog-check", logTail: remedyLog("widget-catalog") }],
    scripts: customScripts,
    worktreePath: "/tmp/wt-2551",
    taskId: "W1-T9002",
    branch: "run-W1-T9002-1",
    deps: {
      runScript: async (script) => {
        ranScripts.push(script);
        return { status: 0, stdout: "", stderr: "" };
      },
      commit: () => ({ sha: "abc1234", changed: true }),
      push: async () => {},
    },
  });

  assert.equal(outcome.applied, true);
  assert.deepEqual(ranScripts, ["widget-catalog", "widget-catalog:check"]);
});

test("runGeneratorFixForCiFailures (criterion 3, restated at this layer): a failure with NO declared pairing calls nothing and applies nothing", async () => {
  let scriptCalls = 0;
  let commitCalls = 0;

  const outcome = await runGeneratorFixForCiFailures({
    failures: [{ name: "unit-tests", logTail: "AssertionError: expected true to equal false" }],
    scripts: REAL_SHAPED_SCRIPTS,
    worktreePath: "/tmp/wt-2551",
    taskId: "W1-T9003",
    branch: "run-W1-T9003-1",
    deps: {
      runScript: async () => {
        scriptCalls++;
        return { status: 0, stdout: "", stderr: "" };
      },
      commit: () => {
        commitCalls++;
        return { sha: "x", changed: true };
      },
      push: async () => {},
    },
  });

  assert.equal(outcome.applied, false);
  assert.deepEqual(outcome.generators, []);
  assert.equal(scriptCalls, 0, "nothing generator-fixable — the generator is never run");
  assert.equal(commitCalls, 0);
});

test("runGeneratorFixForCiFailures (criterion 4): a generator that runs clean but whose OWN --check still fails escalates — no commit, no push", async () => {
  const commits: unknown[] = [];
  const pushes: unknown[] = [];

  const outcome = await runGeneratorFixForCiFailures({
    failures: [{ name: "docs-index-check", logTail: remedyLog("docs-index") }],
    scripts: REAL_SHAPED_SCRIPTS,
    worktreePath: "/tmp/wt-2551",
    taskId: "W1-T9004",
    branch: "run-W1-T9004-1",
    deps: {
      runScript: async (script) => {
        if (script === "docs-index:check") {
          // The regeneration ran clean, but the check STILL fails — e.g. an unresolved mermaid
          // path citation, a defect the generator itself cannot self-correct.
          return { status: 1, stdout: "", stderr: "generate-docs-index: 1 unresolved mermaid path citation(s)" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      commit: () => {
        commits.push(1);
        return { sha: "should-not-happen", changed: true };
      },
      push: async () => {
        pushes.push(1);
      },
    },
  });

  assert.equal(outcome.applied, false, "never a false success");
  assert.ok(outcome.escalate, "names an escalate reason");
  assert.equal(outcome.escalate?.generator, "docs-index");
  assert.match(outcome.escalate?.detail ?? "", /unresolved mermaid/);
  assert.equal(commits.length, 0, "a non-fix is NEVER committed");
  assert.equal(pushes.length, 0, "and never pushed");
});

test("runGeneratorFixForCiFailures (criterion 4, the generator itself failing): a non-zero generator run also escalates before ever reaching its own --check", async () => {
  const scriptsRun: string[] = [];

  const outcome = await runGeneratorFixForCiFailures({
    failures: [{ name: "cli-reference-check", logTail: remedyLog("cli-reference") }],
    scripts: REAL_SHAPED_SCRIPTS,
    worktreePath: "/tmp/wt-2551",
    taskId: "W1-T9005",
    branch: "run-W1-T9005-1",
    deps: {
      runScript: async (script) => {
        scriptsRun.push(script);
        return { status: 1, stdout: "", stderr: "Cannot find module ../src/run-task.js" };
      },
      commit: () => ({ sha: "x", changed: true }),
      push: async () => {},
    },
  });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.escalate?.generator, "cli-reference");
  assert.match(outcome.escalate?.detail ?? "", /Cannot find module/);
  assert.deepEqual(scriptsRun, ["cli-reference"], "the check is never even attempted once the generator itself fails");
});

test("runGeneratorFixForCiFailures (criterion 5): commits ONLY when the generator run actually staged something — never fabricates a commit", async () => {
  let commitCalls = 0;
  let pushCalls = 0;

  const outcome = await runGeneratorFixForCiFailures({
    failures: [{ name: "learnings-index-check", logTail: remedyLog("learnings-index") }],
    scripts: REAL_SHAPED_SCRIPTS,
    worktreePath: "/tmp/wt-2551",
    taskId: "W1-T9006",
    branch: "run-W1-T9006-1",
    deps: {
      runScript: async () => ({ status: 0, stdout: "", stderr: "" }),
      commit: () => {
        commitCalls++;
        // Nothing was actually staged — e.g. the failing read was already stale (a race).
        return { sha: "", changed: false };
      },
      push: async () => {
        pushCalls++;
      },
    },
  });

  assert.equal(outcome.applied, true, "still a success — the check passes now, whatever caused that");
  assert.equal(outcome.commitSha, undefined, "no sha — nothing was committed");
  assert.equal(commitCalls, 1, "the commit step IS attempted (that's how 'nothing changed' is observed)");
  assert.equal(pushCalls, 0, "but never pushed when there was nothing to push");
});

test("runGeneratorFixForCiFailures (criterion 5, dedup): TWO failures naming the SAME generator run it exactly once, and the commit message never fabricates content — it names the generator, not an authored diff", async () => {
  const scriptsRun: string[] = [];
  let commitMessage = "";

  const outcome = await runGeneratorFixForCiFailures({
    failures: [
      { name: "capability-snapshot-check-a", logTail: remedyLog("capability-snapshot") },
      { name: "capability-snapshot-check-b", logTail: remedyLog("capability-snapshot") },
    ],
    scripts: REAL_SHAPED_SCRIPTS,
    worktreePath: "/tmp/wt-2551",
    taskId: "W1-T9007",
    branch: "run-W1-T9007-1",
    deps: {
      runScript: async (script) => {
        scriptsRun.push(script);
        return { status: 0, stdout: "", stderr: "" };
      },
      commit: (o) => {
        commitMessage = o.message;
        return { sha: "d00dfeed", changed: true };
      },
      push: async () => {},
    },
  });

  assert.deepEqual(scriptsRun, ["capability-snapshot", "capability-snapshot:check"], "the SAME generator is de-duplicated, run once");
  assert.equal(outcome.applied, true);
  assert.match(commitMessage, /capability-snapshot/);
  assert.match(commitMessage, /W1-T9007/);
  assert.match(commitMessage, /never a hand edit/i);
});

// ── runFixRung integration: the generator-fix short-circuit wired into the real dispatch loop ────

test("runFixRung (criterion 1, integration): a ci-log round entirely generator-fixable never spawns a worker and spends no strike", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const runScriptCalls: string[] = [];
  const pushCalls: Array<{ cwd: string; branch: string }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2551A", title: "regenerate the stale plan index" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "plan-index-check", logTail: remedyLog("plan-index") }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      // First wait (inside the generator-fix site, after its own commit) reports green — no more
      // ci-log evidence to refresh, so the very next round's `rung.empty_ci_failures` guard
      // (W1-T1282) stands the rung down cleanly.
      waitForCiGreen: async () => "green",
      fetchCiFailures: async () => [],
      runReview: async () => {
        throw new Error("must never be reached — no worker means no review to run");
      },
      // `runGeneratorFixForCiFailures` reuses this SAME `push` dep for its own commit (no
      // separate push seam) — it IS expected to be called once, for the generator's commit.
      push: (wt, branch) => {
        pushCalls.push({ cwd: wt, branch });
      },
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      packageScripts: REAL_SHAPED_SCRIPTS,
      runGeneratorScript: async (script, cwd) => {
        runScriptCalls.push(script);
        assert.equal(cwd, "/tmp/rmd-generator-fix-wt");
        return { status: 0, stdout: "", stderr: "" };
      },
      commitGeneratorOutput: () => ({ sha: "f1xed00", changed: true }),
    },
  });

  assert.equal(spawnCalls.length, 0, "no fix worker is ever spawned for a fully generator-fixable round");
  assert.deepEqual(runScriptCalls, ["plan-index", "plan-index:check"]);
  assert.equal(outcome.strikes, 0, "the generator-fix short-circuit never spends a strike");
  assert.equal(outcome.outcome, "stood_down", "CI cleared and the empty-evidence guard cleanly stands the rung down");

  const generatorFixLogs = logs.filter((l) => l.step === "fix.generator_fix");
  assert.equal(generatorFixLogs.length, 1);
  assert.equal(generatorFixLogs[0].extra?.commit_sha, "f1xed00");
  assert.equal(logs.filter((l) => l.step === "fix.dispatch").length, 0, "fix.dispatch — the strike-counted step — is never logged");
  assert.equal(pushCalls.length, 1, "the generator's own commit is pushed exactly once");
  assert.equal(pushCalls[0].branch, `run-W1-T2551A-1730000000000`);
});

test("runFixRung (criterion 3, integration): a ci-log round with NO declared generator counterpart dispatches a worker exactly as before this task", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const runScriptCalls: string[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2551B", title: "fix a real test failure" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "unit-tests", logTail: "AssertionError: expected true to equal false\n  at test/foo.test.ts:12:3" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({
        ...ciLogInitialReview("sha-fixed"),
        state: "success",
        criteria: [{ claim: "unit tests pass", met: true, proof: "npm test", reason: "", proof_exec: "executed_pass" }],
      }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      packageScripts: REAL_SHAPED_SCRIPTS,
      runGeneratorScript: async (script) => {
        runScriptCalls.push(script);
        return { status: 0, stdout: "", stderr: "" };
      },
      commitGeneratorOutput: () => ({ sha: "should-not-be-called", changed: true }),
    },
  });

  assert.equal(runScriptCalls.length, 0, "no declared generator counterpart — the short-circuit never fires");
  assert.equal(spawnCalls.length, 1, "the ordinary fix worker is dispatched, unchanged");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
});

test("runFixRung (criterion 3, integration, dep-absent): with the generator-fix deps unwired, a generator-fixable round STILL dispatches a worker exactly as pre-W1-T2551 behavior", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2551C", title: "regenerate the stale plan index" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "plan-index-check", logTail: remedyLog("plan-index") }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({
        ...ciLogInitialReview("sha-fixed"),
        state: "success",
        criteria: [{ claim: "plan index is fresh", met: true, proof: "npm run plan-index:check", reason: "", proof_exec: "executed_pass" }],
      }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      // No `runGeneratorScript`/`commitGeneratorOutput`/`packageScripts` wired at all.
    },
  });

  assert.equal(spawnCalls.length, 1, "fail OPEN: an unwired feature never blocks the pre-existing dispatch path");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 1);
});

test("runFixRung (criterion 4, integration): a generator that cannot fix its own check falls through to the ordinary worker, not a silent commit", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  const commitCalls: Array<{ cwd: string; message: string }> = [];
  const pushCalls: Array<{ worktreePath: string; branch: string }> = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2551D", title: "regenerate the stale docs index" }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "docs-index-check", logTail: remedyLog("docs-index") }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return result({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "green",
      runReview: async () => ({
        ...ciLogInitialReview("sha-fixed"),
        state: "success",
        criteria: [{ claim: "docs index is fresh", met: true, proof: "npm run docs-index:check", reason: "", proof_exec: "executed_pass" }],
      }),
      push: (wt, branch) => {
        pushCalls.push({ worktreePath: wt, branch });
      },
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: (step, extra) => logs.push({ step, extra }),
      say: () => {},
      account: (r) => r,
      packageScripts: REAL_SHAPED_SCRIPTS,
      runGeneratorScript: async (script) => {
        if (script === "docs-index:check") return { status: 1, stdout: "", stderr: "still stale after regeneration" };
        return { status: 0, stdout: "", stderr: "" };
      },
      commitGeneratorOutput: (o) => {
        commitCalls.push(o);
        return { sha: "should-never-land", changed: true };
      },
    },
  });

  assert.equal(commitCalls.length, 0, "the failed self-check is never committed");
  assert.equal(spawnCalls.length, 1, "falls through to the ordinary fix worker for a REAL failure");
  assert.equal(outcome.outcome, "fixed");
  const escalateLogs = logs.filter((l) => l.step === "fix.generator_fix_escalate");
  assert.equal(escalateLogs.length, 1);
  assert.equal(escalateLogs[0].extra?.generator, "docs-index");
});
