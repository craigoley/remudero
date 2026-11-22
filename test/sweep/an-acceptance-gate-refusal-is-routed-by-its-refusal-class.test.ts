import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { Config } from "#src/lib/config.js";
import type { Plan } from "#src/lib/plan.js";
import {
  buildSweepEffects,
  DEFAULT_SWEEP_POLICY,
  prFileStatusesFromPullFiles,
  gateRefusalClass,
  gateScopeExceededPaths,
  metadataOnlyRed,
  runSweep,
  type BuildSweepEffectsDeps,
  type ClarificationQuestion,
  type OpenPrView,
  type PrFileStatus,
  type SweepDeps,
} from "#test/helpers/sweep-test.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

/**
 * W1-T13994: an acceptance-author-gate refusal is routed by the class its job log names. A
 * canonical-task-scope-exceeded refusal is cured by a commit or a scope amendment, never by a title
 * or body edit, so it leaves the metadata route the way credited-test-path already does.
 */

const tmp = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scope-refusal-`));
after(() => rmSync(tmp, { recursive: true, force: true }));

const NEW_PATH = "test/learning/a-withheld-arm-is-drawn-per-task.test.ts";
const SIBLING_SUITE = "test/learning/the-arm-ledger.test.ts";
const SRC_PATH = "src/lib/learning.ts";
const PLAN_PATH = "plan/tasks.d/W1-T14147-a-withheld-arm.yaml";

const scopeLog = (paths: readonly string[]) =>
  "2026-11-20T10:00:00.0000000Z acceptance-author-gate: REFUSED (canonical-task-scope-exceeded) — W1-T14147 changes " +
  `paths outside its merge-base scope: ${paths.map((p) => JSON.stringify(p)).join(", ")}. ` +
  "Merge a separate scope amendment before changing those paths.\n2026-11-20T10:00:00.1000000Z ##[error]Process completed with exit code 1.";

function gateRed(logTail: string, checks: string[] = ["acceptance-author-gate"], headSha = "head-a"): OpenPrView {
  return {
    prNumber: 14147,
    prUrl: "https://github.com/acme/remudero/pull/14147",
    taskId: "W1-T14147",
    reviewState: "success",
    checksState: "red",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    headSha,
    autoMergeArmed: false,
    body: "## Acceptance\n\n- a claim | unit test: a proof\n",
    ciFailures: checks.map((name) => ({ name, logTail: name === "acceptance-author-gate" ? logTail : "failed" })),
    redRequiredChecks: checks,
  };
}

const FILE_STATUSES: PrFileStatus[] = [
  { filename: NEW_PATH, status: "added" },
  { filename: SIBLING_SUITE, status: "modified" },
  { filename: SRC_PATH, status: "modified" },
  { filename: PLAN_PATH, status: "modified" },
];

function harness(author: string | "unreadable" | undefined) {
  const rows: Array<Record<string, unknown>> = [];
  const dispatched: Array<{ head: string; constraint?: string }> = [];
  const repairs: string[][] = [];
  const escalations: Array<{ reason: string; question?: ClarificationQuestion }> = [];
  const deps: SweepDeps = {
    arm: () => {},
    close: () => {},
    dispatchFix: (pr) => { dispatched.push({ head: pr.headSha, constraint: pr.pendingAnswer?.constraint }); },
    // The base behaviour for a body-shaped red: a title/body repair that finds no cure.
    repairMetadata: (_pr, checks) => { repairs.push([...checks]); return { repaired: false, noCure: true, reason: "no deterministic body cure" }; },
    escalate: (_pr, reason, question) => { escalations.push({ reason, question }); },
    readPlanRepairFacts: () => {
      if (author === "unreadable") throw new Error("pulls read failed");
      return { authorLogin: author };
    },
    readPrFileStatuses: () => FILE_STATUSES,
    ledgerPath: join(tmp, "ledger.ndjson"),
    runId: "SWEEP-W1-T13994",
    readLedger: () => rows,
    appendLine: (_path, row) => { rows.push(row); },
    log: () => {},
  };
  return { deps, rows, dispatched, repairs, escalations };
}

test("W1-T13994 criterion 1: a scope refusal on a fleet-authored head is not metadata-only and reaches a fix round", async () => {
  const pr = gateRed(scopeLog([NEW_PATH]));
  assert.equal(gateRefusalClass(pr), "canonical-task-scope-exceeded");
  assert.equal(metadataOnlyRed(pr), undefined, "no title or body edit cures a scope refusal");
  assert.equal(metadataOnlyRed(gateRed("acceptance-author-gate: REFUSED (credited-test-path) — absent suite")), undefined,
    "credited-test-path is still carved out");

  const fleet = harness("remudero-fleet[bot]");
  await runSweep([gateRed(scopeLog([NEW_PATH]))], fleet.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(fleet.repairs, [], "the refusal is never repaired as title and body");
  assert.deepEqual(fleet.escalations, [], "a fleet head's scope refusal is a fix round, not a question");
  assert.deepEqual(fleet.dispatched.map((d) => d.head), ["head-a"]);
  assert.ok(fleet.dispatched[0].constraint?.includes(NEW_PATH), "the fix round carries the named path");
  assert.ok(fleet.rows.some((row) => row.step === "sweep.disposed" && row.scope_refusal_outcome === "fix-round"));
});

test("W1-T13994 criterion 2: the fix prompt names each undeclared path by its kind", async () => {
  const fleet = harness("app/remudero-fleet");
  await runSweep([gateRed(scopeLog([NEW_PATH, SIBLING_SUITE, SRC_PATH, PLAN_PATH]))], fleet.deps, DEFAULT_SWEEP_POLICY);
  assert.equal(fleet.dispatched.length, 1);
  const constraint = fleet.dispatched[0].constraint ?? "";
  const line = (path: string) => constraint.split("\n").find((l) => l.startsWith(`- ${path} `)) ?? "";
  assert.match(line(NEW_PATH), /new on this head.*request a scope amendment/);
  assert.match(line(SRC_PATH), /exists at the merge base.*request a scope amendment/);
  assert.match(line(SIBLING_SUITE), /test file that exists at the merge base.*revert-or-justify/);
  assert.match(line(SIBLING_SUITE), /never adds an edit to an existing test file to scope/);
  assert.doesNotMatch(line(SIBLING_SUITE), /request a scope amendment/);
  assert.match(line(PLAN_PATH), /a plan path.*revert-or-justify/);
  assert.doesNotMatch(line(PLAN_PATH), /request a scope amendment/);
  const scopeRequest = constraint.split("\n").find((l) => l.includes("FIX_OUTCOME: NEEDS_SCOPE")) ?? "";
  assert.ok(scopeRequest.endsWith(`NEEDS_SCOPE ${NEW_PATH},${SRC_PATH}`), "only new-on-head and non-test paths go to the scope amendment");
  assert.ok(!scopeRequest.includes(SIBLING_SUITE), "an existing test file is never sent to the scope amendment");
  assert.ok(!scopeRequest.includes(PLAN_PATH), "a plan path is never sent to the scope amendment");
  const disposed = fleet.rows.find((row) => row.step === "sweep.disposed" && row.scope_refusal_outcome === "fix-round");
  assert.deepEqual(disposed?.scope_refusal_paths, { new_on_head: [NEW_PATH], existing_at_base: [SIBLING_SUITE, SRC_PATH, PLAN_PATH] });

  const unreadFiles = harness("remudero-fleet[bot]");
  unreadFiles.deps.readPrFileStatuses = () => { throw new Error("files read failed"); };
  await runSweep([gateRed(scopeLog([NEW_PATH]))], unreadFiles.deps, DEFAULT_SWEEP_POLICY);
  assert.match(unreadFiles.dispatched[0]?.constraint ?? "", /a test file that exists at the merge base.*revert-or-justify/,
    "an unreadable file list never sends a test path to the scope amendment");
  assert.deepEqual((unreadFiles.rows.find((row) => row.scope_refusal_outcome === "fix-round")?.scope_refusal_paths as
    { read_errors?: string[] } | undefined)?.read_errors, ["file statuses: files read failed"]);
});

test("W1-T13994 criterion 2: production reads each changed file's status from the PR's paginated file list", async () => {
  const calls: string[][] = [];
  const deps = {
    owner: "acme", repo: "remudero", config: { root: tmp, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(tmp, "ledger.ndjson"), runId: "SWEEP-W1-T13994",
    plan: { tasks: [], byId: new Map() } as unknown as Plan, log: () => {}, policy: DEFAULT_SWEEP_POLICY,
    ghJsonImpl: (args: string[]) => { calls.push(args); return [[{ filename: NEW_PATH, status: "added" }], [{ filename: SRC_PATH, status: "modified" }, {}]]; },
  } as unknown as BuildSweepEffectsDeps;
  const statuses = await buildSweepEffects(deps).readPrFileStatuses!(gateRed(scopeLog([NEW_PATH])));
  assert.deepEqual(statuses, [{ filename: NEW_PATH, status: "added" }, { filename: SRC_PATH, status: "modified" }]);
  assert.deepEqual(calls, [["api", "--paginate", "--slurp", "repos/acme/remudero/pulls/14147/files?per_page=100"]]);
  assert.throws(() => prFileStatusesFromPullFiles({ message: "Not Found" }), /did not return an array/);
});

test("W1-T13994 criterion 3: an operator-authored head escalates with the paths and the two cures", async () => {
  for (const author of ["craigoley", "unreadable", undefined] as const) {
    const operator = harness(author);
    await runSweep([gateRed(scopeLog([NEW_PATH, SIBLING_SUITE]))], operator.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(operator.dispatched, [], `${author}: an operator's head gets no fleet fix round`);
    assert.deepEqual(operator.repairs, [], `${author}: no title and body repair`);
    assert.equal(operator.escalations.length, 1, `${author}: escalates`);
    const errors = (operator.rows.find((row) => row.scope_refusal_outcome === "escalated")?.scope_refusal_paths as
      { read_errors?: string[] } | undefined)?.read_errors;
    assert.deepEqual(errors, author === "unreadable" ? ["author: pulls read failed"] : undefined);
    const { reason, question } = operator.escalations[0];
    assert.doesNotMatch(reason, /title\/body repair/);
    const text = question?.question ?? "";
    assert.ok(text.includes(`${NEW_PATH} (new on this head)`), text);
    assert.ok(text.includes(`${SIBLING_SUITE} (a test file that exists at the merge base)`), text);
    assert.match(text, /\(1\) amend the scope: .*\(2\) revert the edits: /);
    assert.deepEqual(question?.resolutions.map((r) => r.label), ["amend the scope", "revert the edits"]);
    await runSweep([gateRed(scopeLog([NEW_PATH, SIBLING_SUITE]))], operator.deps, DEFAULT_SWEEP_POLICY);
    assert.equal(operator.escalations.length, 1, `${author}: escalated once per head`);
  }
});

test("W1-T13994 criterion 4: the gate, its refusal messages and every body repair are unchanged", async () => {
  // The gate prints one refusal line in the shape the sweep parses, and its scope message quotes each path.
  const gate = readFileSync(join(REPO_ROOT, "scripts/acceptance-author-gate.mjs"), "utf8");
  assert.ok(gate.includes("console.error(`acceptance-author-gate: REFUSED (${result.defect}) — ${result.message}`);"));
  assert.ok(gate.includes('defect: "canonical-task-scope-exceeded",'));
  assert.ok(gate.includes("changes paths outside its merge-base scope: ${undeclared.map(path => JSON.stringify(path)).join(\", \")}"));
  assert.deepEqual(gateScopeExceededPaths(gateRed(scopeLog([NEW_PATH, 'test/a "quoted" name.test.ts']))),
    [NEW_PATH, 'test/a "quoted" name.test.ts']);
  const unreadable = "acceptance-author-gate: REFUSED (canonical-task-scope-exceeded) — W1-T14147 changes paths outside its " +
    `merge-base scope: "bad\\q", ${JSON.stringify(SRC_PATH)}, "${NEW_PATH.slice(0, 10)}`;
  assert.deepEqual(gateScopeExceededPaths(gateRed(unreadable)), [SRC_PATH], "an unreadable or truncated quote names no path");

  for (const [checks, logTail] of [
    [["acceptance-author-gate"], "acceptance-author-gate: REFUSED (no-header) — the body has no ## Acceptance header"],
    [["acceptance-author-gate"], "acceptance-author-gate: REFUSED (empty-proofs) — the Acceptance block lists no proof"],
    [["acceptance-author-gate"], "acceptance-author-gate: REFUSED (grep-proof-target-missing) — a stale proof the plan cures"],
    [["acceptance-author-gate"], "acceptance-author-gate: REFUSED (proof-shape) — a grep: pattern is wrapped in quotes"],
    [["acceptance-author-gate"], "failed"],
    [["commitlint"], "failed"],
    [["proof-discrimination"], "failed"],
  ] as const) {
    const pr = gateRed(logTail, [...checks]);
    assert.deepEqual(metadataOnlyRed(pr), [...checks], `${logTail}: still metadata-only`);
    const h = harness("remudero-fleet[bot]");
    await runSweep([gateRed(logTail, [...checks])], h.deps, DEFAULT_SWEEP_POLICY);
    assert.deepEqual(h.repairs, [[...checks]], `${checks.join(",")} ${logTail}: still goes through the metadata repair`);
    assert.deepEqual(h.dispatched, []);
    assert.equal(h.escalations.length, 1, "a body red with no cure still escalates as a title/body repair");
    assert.match(h.escalations[0].reason, /need title\/body repair/);
  }
  const credited = harness("remudero-fleet[bot]");
  await runSweep([gateRed("acceptance-author-gate: REFUSED (credited-test-path) — W1-T14147 declares an absent suite")],
    credited.deps, DEFAULT_SWEEP_POLICY);
  assert.deepEqual(credited.dispatched.map((d) => d.head), ["head-a"]);
  assert.equal(credited.dispatched[0].constraint, undefined, "a missing suite's round carries no scope constraint");
});
