// W1-T12842: an author preflight appends one verdict row to the configured ledger, and the scout counts the refused
// and failed ones. The verdict text and the exit code never depend on that write.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as authorModule from "#scripts/preflight-author.mjs";
// @ts-ignore the executable .mjs module has no declaration file.
import { MacAuthorCapacityRefusal } from "#scripts/lib/mac-author-admission.mjs";
import { fixedClock, type Clock } from "#src/lib/clock.js";
import type { GardenerDeps } from "#src/lib/gardener.js";
import { ledgerPathFor } from "#src/lib/ledger-path.js";
import * as scout from "#src/lib/scout-gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = Record<string, unknown> & { run_id: string; task_id: string; step: string };
type Step = { name: string; ok: boolean; notMeasured?: string; testSummary?: Record<string, number> };
type Receipt = { verdict?: string; steps: Step[]; dryRun?: boolean; error?: string; affectedTestsNotRunReason?: string;
  startedAt?: string; durationMs?: number; headSha?: string; selection?: string; selectedArm?: string; suites?: string[];
  tiered?: { ran: string[] }; staticAdmission?: { waitedMs: number }; suiteQueue?: { waitedMs: number };
  testSlot?: { waitedMs: number }; pushEligible?: boolean; pushEligibleReason?: string };
type Written = { written: boolean; reason?: string; path?: string };
type Context = { exitCode?: number; headRef?: string | (() => string | null); refusalClass?: string; refusalStage?: string;
  capacityReasons?: string[]; announce?: boolean; ledger?: () => { root?: string; reason?: string };
  append?: (row: Row, root: string, options?: { boundMs?: number }) => Written; log?: (line: string) => void; boundMs?: number };
type Admission = { state: string; platform: string; reasons: string[]; capacityChecks: unknown[]; pressure: string; minimumFreeBytes: number };
type Child = { status: number | null; signal?: string | null; stdout: string; stderr: string };
const author = authorModule as unknown as {
  AUTHOR_VERDICT_STEPS: { passed: string; failed: string; refused: string };
  AUTHOR_REFUSAL_CLASSES: readonly string[];
  OVER_CAPACITY_EXIT: number;
  authorPushEligibility(receipt: Receipt): { pushEligible: boolean; pushEligibleReason: string };
  authorVerdictRow(receipt: Receipt, context?: Context): Row | undefined;
  recordAuthorVerdict(receipt: Receipt, context?: Context): Written;
  concludeAuthorRun(receipt: Receipt, context?: Context): number;
  appendAuthorVerdictRow(payload: { root: string; line: Row; tty?: boolean }, deps?: { clock?: Clock }): Written;
  appendAuthorVerdictRowBounded(line: Row, root: string, options?: { boundMs?: number; spawn?: () => Child }): Written;
  runAuthorVerdictRowChild(input: string): number;
  authorHeadRef(root: string, declared?: string, spawn?: () => Child): string | null;
  configuredAuthorLedger(options?: { testRunner?: boolean; configFile?: string }): { root?: string; reason?: string };
  runGuardedAuthor(argv: string[], deps: { root: string; runAuthor?: () => number; readAdmission?: () => Admission; verdictLedger?: Context }): number;
  main(argv: string[], deps: Record<string, unknown>): number;
};

const BRANCH = "run-W1-T12842-1794805390680";
const GiB = 1024 ** 3;
const summary = (pass: number, fail = 0) => ({ tests: pass + fail, suites: 0, pass, fail, cancelled: 0, skipped: 0, todo: 0 });
const census: Step = { name: "census-precheck", ok: true };
const staticGate: Step = { name: "static-preflight", ok: true };
const suiteNames = (count: number) => Array.from({ length: count }, (_, index) => `test/s${index}.test.ts`);
/** A receipt as `main` leaves it: the push answer derived from the verdict, a start time and a wall time. */
const receipt = (fields: Receipt): Receipt => {
  const whole = { startedAt: "2026-11-15T19:34:14.000Z", durationMs: 1_248_522, dryRun: false, ...fields };
  return { ...whole, ...author.authorPushEligibility(whole) };
};

// Each receipt below is a run this Mac made on 2026-11-15/16; the comment gives the line the preflight printed.
const RUNS = {
  // author push-eligible: true; passed: every stage this run selected ran green (census-precheck, static-preflight, lint-plan-fast, affected-tests)
  passed: receipt({ verdict: "passed", selection: "affected-narrow", steps: [census, staticGate, { name: "lint-plan-fast", ok: true },
    { name: "affected-tests", ok: true, testSummary: summary(212) }], staticAdmission: { waitedMs: 24 },
  testSlot: { waitedMs: 10 }, suiteQueue: { waitedMs: 116 } }),
  // author push-eligible: true; over-capacity with nothing red: ... (3301 test(s) passed, 0 failed, 338 of 441 suite(s))
  overCapacityGreen: receipt({ verdict: "over-capacity", selection: "over-capacity", selectedArm: "affected-narrow", suites: suiteNames(441),
    tiered: { ran: suiteNames(338) }, steps: [census, staticGate, { name: "affected-tests-subset", ok: true, testSummary: summary(3301) }] }),
  // author push-eligible: false; census-precheck failed   (census-suite: test/host-capability-fixtures.test.ts fails)
  censusFailed: receipt({ verdict: "failed", selection: "affected-narrow", steps: [{ name: "census-precheck", ok: false }] }),
  // author push-eligible: false; affected-tests-subset failed: 3 failing test(s)
  subsetFailed: receipt({ verdict: "failed", selection: "over-capacity", selectedArm: "affected-narrow",
    steps: [census, staticGate, { name: "affected-tests-subset", ok: false, testSummary: summary(4795, 3) }],
    staticAdmission: { waitedMs: 24 }, testSlot: { waitedMs: 10 }, suiteQueue: { waitedMs: 116 } }),
  staticFailed: receipt({ verdict: "failed", selection: "affected-narrow", steps: [census, { name: "static-preflight", ok: false }],
    affectedTestsNotRunReason: "static-preflight did not succeed; see its native outcome" }),
  lintPlanFailed: receipt({ verdict: "failed", selection: "plan-only", steps: [census, staticGate, { name: "lint-plan-fast", ok: false }],
    affectedTestsNotRunReason: "lint-plan-fast did not succeed; see its native outcome" }),
  // author push-eligible: false; census-precheck was not measured (time-bound); an over-capacity run needs it green
  censusTimeBound: receipt({ verdict: "over-capacity", selection: "over-capacity", selectedArm: "full-fallback", suites: suiteNames(817),
    tiered: { ran: suiteNames(501) }, durationMs: 1_398_439, staticAdmission: { waitedMs: 26 }, testSlot: { waitedMs: 5 }, suiteQueue: { waitedMs: 71 },
    steps: [{ ...census, notMeasured: "time-bound" }, staticGate, { name: "affected-tests-subset", ok: true, testSummary: summary(4513) }] }),
  // author push-eligible: false; affected-tests was not run: full-fallback: PARTIAL — ran 0 of 4715 suite(s) ...
  testsNotRun: receipt({ verdict: "over-capacity", selection: "over-capacity", selectedArm: "full-fallback", suites: suiteNames(4715),
    steps: [census, staticGate], affectedTestsNotRunReason: "full-fallback: PARTIAL — ran 0 of 4715 suite(s) chosen by reach and measured cost; CI's full run is the check for package.json and the other 4715" }),
  // author push-eligible: false; refused before census-precheck ran: installed dependency precheck unavailable: installed package version differs: node_modules/hono
  dependencyRefused: receipt({ verdict: "refused", steps: [],
    error: "installed dependency precheck unavailable: installed package version differs: node_modules/hono; expensive validation not started" }),
  // author preflight NOT_RUN: Mac author capacity NOT_RUN before static-preflight: {... "reserveBasis":"existing-20GiB" ... "shortfallBytes":13938688 ...}
  diskReserveNotRun: receipt({ verdict: "over-capacity", steps: [census],
    error: 'Mac author capacity NOT_RUN before static-preflight: {"state":"not-run","reserveBasis":"existing-20GiB","reasons":["workspaceFreeBytes:below-existing-20GiB-reserve"]}',
    affectedTestsNotRunReason: "Mac author capacity NOT_RUN before static-preflight" }),
  // author push-eligible: false; refused at the receipt, after its stages ran: the author tree changed during verification; receipt refused
  treeChanged: receipt({ verdict: "refused", steps: [census, staticGate, { name: "affected-tests", ok: true, testSummary: summary(12) }],
    error: "the author tree changed during verification; receipt refused" }),
  dryRun: receipt({ verdict: "not-run", dryRun: true, steps: [] }),
};
const DISK_REASONS = ["workspaceFreeBytes:below-existing-20GiB-reserve"];
/** What each run's row must say: [run, the context its refusal site gives, step, first step, class, exit code]. */
const EXPECTED: Array<[keyof typeof RUNS, Context, "passed" | "failed" | "refused", string | null, string | undefined, number]> = [
  ["passed", {}, "passed", null, undefined, 0],
  ["overCapacityGreen", {}, "passed", null, undefined, 3],
  ["censusFailed", {}, "failed", "census-precheck", "other", 1],
  ["subsetFailed", {}, "failed", "affected-tests-subset", undefined, 1],
  ["staticFailed", {}, "failed", "static-preflight", "other", 1],
  ["lintPlanFailed", {}, "failed", "lint-plan-fast", "lint-plan", 1],
  ["censusTimeBound", {}, "refused", "census-precheck", "census-time-bound", 3],
  ["testsNotRun", {}, "refused", "affected-tests", "affected-tests", 3],
  ["dependencyRefused", { refusalClass: "dependency-precheck" }, "refused", "census-precheck", "dependency-precheck", 1],
  ["diskReserveNotRun", { refusalClass: "other", refusalStage: "static-preflight", capacityReasons: DISK_REASONS }, "refused", "static-preflight", "other", 3],
  ["treeChanged", { refusalClass: "other" }, "refused", "receipt", "other", 1],
];

function scratch(t: TestContext, kind: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}author-verdict-${kind}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A state root whose `state/` exists, as a configured ledger's does. */
function stateRoot(t: TestContext, kind: string): string {
  const root = scratch(t, kind);
  mkdirSync(join(root, "state"));
  return root;
}
const ledgerRows = (root: string): Row[] => !existsSync(ledgerPathFor({ root })) ? []
  : readFileSync(ledgerPathFor({ root }), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row);
/** Run `body` with the console held: what it printed to stdout and to stderr, and what it returned. */
function printed<T>(body: () => T): { out: string[]; err: string[]; value: T } {
  const log = console.log, error = console.error, out: string[] = [], err: string[] = [];
  console.log = (...args: unknown[]) => void out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void err.push(args.map(String).join(" "));
  try { return { out, err, value: body() }; }
  finally { console.log = log; console.error = error; }
}
/** A ledger that takes every row: the rows it was given, in order. */
function takingLedger(root = "/unused-state-root") {
  const rows: Row[] = [];
  const context: Context = { ledger: () => ({ root }), append: (row) => { rows.push(row); return { written: true, path: "captured" }; }, log: () => {} };
  return { rows, context };
}

test("W1-T12842 criterion 1: each outcome maps to one of the three steps and carries the head ref, the task id, the first step and both times", () => {
  assert.deepEqual(author.AUTHOR_VERDICT_STEPS, { passed: "author_preflight.passed", failed: "author_preflight.failed", refused: "author_preflight.refused" });
  for (const [name, context, outcome, firstStep, , exitCode] of EXPECTED) {
    const row = author.authorVerdictRow(RUNS[name], { ...context, exitCode, headRef: BRANCH });
    assert.ok(row, `${name}: a row`);
    assert.equal(row.step, author.AUTHOR_VERDICT_STEPS[outcome], name);
    assert.equal(row.head_ref, BRANCH, name);
    assert.equal(row.task_id, "W1-T12842", `${name}: the task the branch names`);
    assert.equal(row.first_step, firstStep, `${name}: the first failing or refusing step`);
    assert.equal(row.exit_code, exitCode, name);
    assert.equal(row.verdict, RUNS[name].verdict, name);
    assert.equal(row.push_eligible, RUNS[name].pushEligible, name);
    assert.equal(row.wall_ms, RUNS[name].durationMs, `${name}: the wall time`);
    assert.equal(typeof row.admission_wait_ms, "number", `${name}: the admission wait`);
  }
  // The admission wait is the static admission's wait plus the suite line's, each as the receipt measured it.
  assert.equal(author.authorVerdictRow(RUNS.subsetFailed, { headRef: BRANCH })!.admission_wait_ms, 24 + 116);
  assert.equal(author.authorVerdictRow(RUNS.censusTimeBound, { headRef: BRANCH })!.admission_wait_ms, 26 + 71);
  assert.equal(author.authorVerdictRow(RUNS.dependencyRefused, { headRef: BRANCH })!.admission_wait_ms, 0);
  assert.deepEqual(author.authorVerdictRow(RUNS.diskReserveNotRun, { refusalClass: "other", refusalStage: "static-preflight", capacityReasons: DISK_REASONS })!.capacity_reasons, DISK_REASONS);
  // A branch that names no task, an unfiled run and a detached head never invent a task id.
  for (const [headRef, taskId] of [["run-unfiled-1794805390680", "CLI"], ["main", "CLI"], ["run-CONSOLE-T127-1794805390680", "CONSOLE-T127"]] as const) {
    assert.equal(author.authorVerdictRow(RUNS.passed, { headRef })!.task_id, taskId, headRef);
  }
  const detached = author.authorVerdictRow(RUNS.passed, { headRef: () => null })!;
  assert.equal(detached.head_ref, null);
  assert.equal(detached.task_id, "CLI");
  assert.equal(author.authorVerdictRow(RUNS.dryRun, { headRef: BRANCH }), undefined, "a dry run is read-only: it has no row");
  // The head ref is the declared publication target, else the checked-out branch, else nothing.
  const git = (stdout: string, status = 0) => (): Child => ({ status, stdout, stderr: "" });
  assert.equal(author.authorHeadRef("/unused", `refs/heads/${BRANCH}`), BRANCH);
  assert.equal(author.authorHeadRef("/unused", undefined, git(`${BRANCH}\n`)), BRANCH);
  assert.equal(author.authorHeadRef("/unused", undefined, git("HEAD\n")), null, "a detached head names no branch");
  assert.equal(author.authorHeadRef("/unused", undefined, git("", 128)), null, "an unreadable checkout names no branch");
});

test("W1-T12842 criterion 1: one run appends exactly one row to a real ledger file through the repo's ledger writer", (t) => {
  const root = stateRoot(t, "real");
  const lines: string[] = [];
  const result = author.recordAuthorVerdict(RUNS.dependencyRefused, { exitCode: 1, headRef: BRANCH, refusalClass: "dependency-precheck",
    ledger: () => ({ root }), log: (line) => lines.push(line) });
  assert.deepEqual(result, { written: true, path: ledgerPathFor({ root }) }, lines.join("\n"));
  const rows = ledgerRows(root);
  assert.equal(rows.length, 1, "exactly one row");
  const [row] = rows;
  assert.equal(row!.step, "author_preflight.refused");
  assert.equal(row!.task_id, "W1-T12842");
  assert.equal(row!.head_ref, BRANCH);
  assert.equal(row!.first_step, "census-precheck");
  assert.equal(row!.refusal_class, "dependency-precheck");
  assert.equal(row!.exit_code, 1);
  // appendLedger's own stamps prove the row went through the shared writer, not a second one.
  assert.equal(typeof row!.ts, "string");
  assert.equal(typeof row!.host, "string");
  assert.equal(row!.actor, "test");
  assert.match(lines.join("\n"), /verdict row author_preflight\.refused written to /);
  // A second run is a second row; a dry run and a run with no configured ledger add none.
  author.recordAuthorVerdict(RUNS.passed, { exitCode: 0, headRef: "main", ledger: () => ({ root }), log: () => {} });
  author.recordAuthorVerdict(RUNS.dryRun, { exitCode: 0, headRef: BRANCH, ledger: () => ({ root }), log: () => {} });
  author.recordAuthorVerdict(RUNS.passed, { exitCode: 0, headRef: BRANCH, ledger: () => ({ reason: "no instance config" }), log: () => {} });
  assert.deepEqual(ledgerRows(root).map((r) => [r.step, r.task_id]), [["author_preflight.refused", "W1-T12842"], ["author_preflight.passed", "CLI"]]);
});

test("W1-T12842 criterion 1: the preflight's own exit appends one row for a run it refuses, and a run stopped at entry appends one too", (t) => {
  const root = scratch(t, "node-pin");
  writeFileSync(join(root, ".nvmrc"), "0.0.1\n");
  const taken = takingLedger();
  const run = printed(() => author.main(["--head-ref", BRANCH], { root, verdictLedger: taken.context }));
  assert.equal(run.value, 1);
  assert.equal(taken.rows.length, 1, "exactly one row for the run");
  assert.equal(taken.rows[0]!.step, "author_preflight.refused");
  assert.equal(taken.rows[0]!.refusal_class, "node-version");
  assert.equal(taken.rows[0]!.task_id, "W1-T12842");
  assert.equal(taken.rows[0]!.head_ref, BRANCH);
  assert.equal(taken.rows[0]!.first_step, "census-precheck");
  assert.equal(taken.rows[0]!.exit_code, 1);
  assert.equal(typeof taken.rows[0]!.wall_ms, "number");

  // A memory-pressure refusal at entry never reaches main: {"reasons":["pressure:warning"],"stage":"entry"} on this Mac.
  const entry = takingLedger();
  let reached = 0;
  const pressure: Admission = { state: "not-run", platform: "darwin", minimumFreeBytes: 10 * GiB, reasons: ["pressure:warning"], capacityChecks: [], pressure: "warning" };
  const refused = printed(() => author.runGuardedAuthor([`--head-ref=${BRANCH}`], { root, readAdmission: () => pressure,
    runAuthor: () => { reached += 1; return 0; }, verdictLedger: entry.context }));
  assert.equal(refused.value, author.OVER_CAPACITY_EXIT);
  assert.equal(reached, 0, "positive control: the entry admission refused before the author ran");
  assert.match(refused.err.join("\n"), /author preflight NOT_RUN: /);
  assert.equal(entry.rows.length, 1);
  assert.deepEqual([entry.rows[0]!.step, entry.rows[0]!.first_step, entry.rows[0]!.refusal_class, entry.rows[0]!.exit_code, entry.rows[0]!.task_id],
    ["author_preflight.refused", "entry", "other", 3, "W1-T12842"]);
  assert.deepEqual(entry.rows[0]!.capacity_reasons, ["pressure:warning"]);
  // With no declared target the row reads the checkout itself; this scratch directory is no checkout, so it names none.
  const bare = takingLedger();
  printed(() => author.runGuardedAuthor([], { root, readAdmission: () => pressure, runAuthor: () => 0, verdictLedger: bare.context }));
  assert.deepEqual([bare.rows.length, bare.rows[0]!.head_ref, bare.rows[0]!.task_id], [1, null, "CLI"]);
  // An admitted entry hands the run to main, which appends its own row: the entry adds none.
  const admitted = takingLedger();
  const ok: Admission = { ...pressure, state: "admitted", reasons: [], pressure: "normal" };
  assert.equal(printed(() => author.runGuardedAuthor([], { root, readAdmission: () => ok, runAuthor: () => 0, verdictLedger: admitted.context })).value, 0);
  assert.deepEqual(admitted.rows, []);
});

test("W1-T12842 criterion 2: invariant:the-verdict-never-depends-on-the-ledger — a missing, unwritable or slow ledger leaves the verdict text and exit code unchanged and says so on stderr", (t) => {
  const missingState = scratch(t, "missing");
  const unwritable = stateRoot(t, "unwritable");
  // A directory where the ledger file belongs: the append fails for any user, with no permission bits involved.
  mkdirSync(ledgerPathFor({ root: unwritable }));
  const writable = stateRoot(t, "writable");
  const config = join(scratch(t, "config"), "config.json");
  const arms: Array<[string, Context, RegExp | undefined]> = [
    ["a writable ledger", { ledger: () => ({ root: writable }) }, undefined],
    ["no configured ledger", { ledger: () => author.configuredAuthorLedger({ testRunner: false, configFile: config }) }, /verdict row NOT written.*no instance config/],
    ["a test process with no ledger given", {}, /verdict row NOT written.*test/],
    ["a state directory that is not there", { ledger: () => ({ root: missingState }) }, /verdict row NOT written.*no state directory/],
    ["an unwritable ledger", { ledger: () => ({ root: unwritable }) }, /verdict row NOT written/],
    ["a ledger slower than the bound", { ledger: () => ({ root: writable }), boundMs: 1 }, /verdict row NOT written.*within 1 ms/],
    ["a ledger resolver that throws", { ledger: () => { throw new Error("config exploded"); } }, /verdict row NOT written.*config exploded/],
    ["a writer that throws", { ledger: () => ({ root: writable }), append: () => { throw new Error("EIO: i/o error"); } }, /verdict row NOT written.*EIO/],
  ];
  const runs: Array<[keyof typeof RUNS, number, string]> = [
    ["passed", 0, "author push-eligible: true; passed: every stage this run selected ran green (census-precheck, static-preflight, lint-plan-fast, affected-tests)"],
    ["subsetFailed", 1, "author push-eligible: false; affected-tests-subset failed: 3 failing test(s)"],
    ["censusTimeBound", 3, "author push-eligible: false; census-precheck was not measured (time-bound); an over-capacity run needs it green"],
    ["dependencyRefused", 1, "author push-eligible: false; refused before census-precheck ran: installed dependency precheck unavailable: installed package version differs: node_modules/hono; expensive validation not started"],
  ];
  for (const [name, exitCode, eligibleLine] of runs) {
    // The text and exit code the script gave before this task: two stdout lines, then 0, 1 or the over-capacity 3.
    const text = [`author verdict: ${RUNS[name].verdict}; hosted full-suite/coverage remains REQUIRED, not proven by this run`, eligibleLine];
    // The four arms that start a real child run once, on the refused run; the cheap arms run for every verdict.
    const real = name === "dependencyRefused";
    for (const [arm, context, notWritten] of arms) {
      if (!real && /unwritable|slower|writable|not there/.test(arm)) continue;
      const run = printed(() => author.concludeAuthorRun(RUNS[name], { headRef: BRANCH, ...context }));
      assert.deepEqual(run.out, text, `${name} with ${arm}: the verdict text`);
      assert.equal(run.value, exitCode, `${name} with ${arm}: the exit code`);
      if (notWritten) assert.match(run.err.join("\n"), notWritten, `${name} with ${arm}: stderr says the row was not written`);
      else assert.doesNotMatch(run.err.join("\n"), /NOT written/, `${name} with ${arm}`);
    }
  }
  assert.equal(author.OVER_CAPACITY_EXIT, 3);
  // The writer's child, when it dies or is handed anything but an author verdict row: a reason, never a throw.
  const row = author.authorVerdictRow(RUNS.passed, { headRef: BRANCH })!;
  assert.match(author.appendAuthorVerdictRowBounded(row, writable, { spawn: () => ({ status: 1, signal: null, stdout: "", stderr: "boom: cannot load" }) }).reason ?? "", /ended 1: boom: cannot load/);
  assert.match(author.appendAuthorVerdictRowBounded(row, writable, { spawn: () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }) }).reason ?? "", /ended SIGKILL/);
  const garbled = printed(() => author.runAuthorVerdictRowChild("{ not json"));
  assert.deepEqual([garbled.value, (JSON.parse(garbled.out[0]!) as Written).written], [0, false]);
  const foreign = printed(() => author.runAuthorVerdictRowChild(JSON.stringify({ root: writable, line: { run_id: "x", task_id: "CLI", step: "cli.invoked" } })));
  assert.match((JSON.parse(foreign.out[0]!) as Written).reason ?? "", /not an author verdict row/);
  // Positive control: the writable arm really wrote, once; the slow and unwritable arms added nothing beside it.
  assert.deepEqual(ledgerRows(writable).map((row) => row.step), ["author_preflight.refused"]);
  assert.deepEqual(ledgerRows(missingState), [], "a missing state directory is never created");
  assert.equal(existsSync(join(missingState, "state")), false);

  // The same holds through the preflight's own exit: a writer that throws changes neither the code nor the lines.
  const root = scratch(t, "node-pin");
  writeFileSync(join(root, ".nvmrc"), "0.0.1\n");
  const quiet = printed(() => author.main(["--head-ref", BRANCH], { root, verdictLedger: takingLedger().context }));
  const broken = printed(() => author.main(["--head-ref", BRANCH], { root,
    verdictLedger: { ledger: () => ({ root: writable }), append: () => { throw new Error("EIO: i/o error"); } } }));
  assert.equal(broken.value, quiet.value);
  assert.equal(broken.value, 1);
  assert.deepEqual(broken.out, quiet.out);
  assert.match(broken.out.at(-1) ?? "", /^author push-eligible: false; refused before census-precheck ran: Node 0\.0\.1 required; got /);
  assert.match(broken.err.join("\n"), /verdict row NOT written.*EIO/);

  // A receipt that cannot be written still exits 1 with no verdict line, as before, and still gets its one row.
  const sealed = scratch(t, "no-receipt");
  writeFileSync(join(sealed, ".nvmrc"), "0.0.1\n");
  mkdirSync(join(sealed, "coverage/preflight-author.json"), { recursive: true });
  const unwritten = takingLedger();
  const noReceipt = printed(() => author.main(["--head-ref", BRANCH], { root: sealed, verdictLedger: unwritten.context }));
  assert.equal(noReceipt.value, 1);
  assert.match(noReceipt.err.join("\n"), /author receipt could not be written: /, "positive control: the receipt write failed");
  assert.deepEqual(noReceipt.out.filter((line) => line.startsWith("author verdict") || line.startsWith("author push-eligible")), []);
  assert.deepEqual(unwritten.rows.map((r) => [r.step, r.refusal_class, r.exit_code]), [["author_preflight.refused", "node-version", 1]]);
});

test("W1-T12842 criterion 2: the configured ledger is the instance config's root, and a test process or a session with no config has none", (t) => {
  const dir = scratch(t, "config");
  const configFile = join(dir, "config.json");
  assert.match(author.configuredAuthorLedger().reason ?? "", /test/, "this test process has no configured ledger");
  assert.match(author.configuredAuthorLedger({ testRunner: false, configFile }).reason ?? "", /no instance config/);
  writeFileSync(configFile, JSON.stringify({ claudeBin: "/usr/bin/true", root: join(dir, "root") }));
  assert.deepEqual(author.configuredAuthorLedger({ testRunner: false, configFile }), { root: join(dir, "root") });
  writeFileSync(configFile, JSON.stringify({ root: "relative/root" }));
  assert.match(author.configuredAuthorLedger({ testRunner: false, configFile }).reason ?? "", /not an absolute path/);
  writeFileSync(configFile, "{ not json");
  assert.match(author.configuredAuthorLedger({ testRunner: false, configFile }).reason ?? "", /unreadable/);
  // The writer itself refuses a state directory that is not there, and an unwritable file, without creating anything.
  const missing = author.appendAuthorVerdictRow({ root: dir, line: author.authorVerdictRow(RUNS.passed, { headRef: BRANCH })! });
  assert.equal(missing.written, false);
  assert.match(missing.reason ?? "", /no state directory/);
  assert.equal(existsSync(join(dir, "state")), false);
});

/** A committed tree `main` can walk with an injected Git: a pinned Node, one changed source file and one suite. */
function authorTree(t: TestContext, kind: string, { dependencies }: { dependencies: boolean }): string {
  const root = scratch(t, kind);
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`);
  writeFileSync(join(root, "test/leaf.test.ts"), "import { test } from 'node:test'; test('leaf', () => {});\n");
  if (dependencies) {
    symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
    copyFileSync(join(REPO_ROOT, "package-lock.json"), join(root, "package-lock.json"));
  }
  return root;
}
const HEAD = "a".repeat(40), BASE = "b".repeat(40);
/** Git's answers for a clean, complete tree one commit ahead of its base; every other child passes with no output. */
function scriptedSpawn(file: string, args: string[]) {
  const ok = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "" });
  if (file !== "git") return ok();
  const call = args.join(" ");
  if (call === "rev-parse --is-inside-work-tree") return ok("true\n");
  if (call.startsWith("config --local")) return { status: 1, signal: null, stdout: "", stderr: "" };
  if (call === "rev-parse HEAD") return ok(`${HEAD}\n`);
  if (call === "rev-parse origin/main") return ok(`${BASE}\n`);
  if (call === "rev-parse --is-shallow-repository") return ok("false\n");
  if (call.startsWith("log -1")) return ok("fix: change the leaf\n\nRemudero-Task: W1-T12842\n");
  if (call.startsWith("diff --name-only")) return ok("src/leaf.ts\0");
  return ok();
}
const select = () => ({ fullRun: false, suites: ["test/leaf.test.ts"], reasons: ["fixture"] });
const host = () => ({ cores: 8, load1: 0, headroomBytes: 8 * GiB });
/** A suite line whose admission gives `lease`. */
const suiteLine = (lease: Record<string, unknown>) => () => ({ ticketed: true, position: 1, note: "fixture ticket", setPrice() {},
  admit: () => ({ refresh() {}, release() {}, ...lease }), cancel() {} });

test("W1-T12842 criterion 3: a refused or NOT_RUN run carries a refusal class from the closed list, named at the site that refused", (t) => {
  assert.deepEqual(author.AUTHOR_REFUSAL_CLASSES, ["node-version", "dependency-precheck", "static-wait-bound", "test-slot-wait-bound",
    "census-time-bound", "lint-plan", "affected-tests", "other"]);
  // Every run in the table: a refused row always carries a class, a passed row never, and each class is in the list.
  for (const [name, context, outcome, , refusalClass, exitCode] of EXPECTED) {
    const row = author.authorVerdictRow(RUNS[name], { ...context, exitCode, headRef: BRANCH })!;
    assert.equal(row.refusal_class, refusalClass, name);
    if (outcome === "refused") assert.ok(author.AUTHOR_REFUSAL_CLASSES.includes(String(row.refusal_class)), `${name}: ${String(row.refusal_class)}`);
    if (outcome === "passed") assert.equal("refusal_class" in row, false, name);
  }
  // Free text can never reach the row: a class outside the list is recorded as `other`.
  for (const text of ["Node 24.22.2 required; got 24.21.0", "disk", "", "NODE-VERSION"]) {
    assert.equal(author.authorVerdictRow(RUNS.dependencyRefused, { refusalClass: text, headRef: BRANCH })!.refusal_class, "other", text);
  }

  // The refusal sites themselves, each reached through main with Git and the suite line scripted.
  const site = (root: string, deps: Record<string, unknown>, exitCode = 1) => {
    const taken = takingLedger();
    const run = printed(() => author.main(["--head-ref", BRANCH], { root, spawn: scriptedSpawn, select, host, verdictLedger: taken.context, ...deps }));
    assert.equal(taken.rows.length, 1, run.err.join("\n"));
    assert.equal(taken.rows[0]!.step, "author_preflight.refused", run.err.join("\n"));
    assert.equal(run.value, exitCode);
    assert.equal(taken.rows[0]!.exit_code, exitCode);
    assert.equal(taken.rows[0]!.head_sha, HEAD);
    return { row: taken.rows[0]!, err: run.err.join("\n") };
  };
  const bare = site(authorTree(t, "no-deps", { dependencies: false }), {});
  assert.match(bare.err, /installed dependency precheck unavailable/, "positive control: the dependency precheck refused");
  assert.deepEqual([bare.row.refusal_class, bare.row.first_step], ["dependency-precheck", "census-precheck"]);

  const staticRefused = site(authorTree(t, "static", { dependencies: true }), {
    testSlot: { privateParentPolicy: "require-entry-protection", log: () => {} }, enqueueTestSlot: suiteLine({ outcome: "acquired", concurrency: 1, waitedMs: 0, note: "unused" }) });
  assert.match(staticRefused.err, /author static stage NOT_RUN/, "positive control: the static stage was not admitted");
  assert.deepEqual([staticRefused.row.refusal_class, staticRefused.row.first_step], ["static-wait-bound", "static-preflight"]);

  const slots = scratch(t, "slots");
  const slotRefused = site(authorTree(t, "slot", { dependencies: true }), {
    testSlot: { dir: slots, memoryHeadroom: () => 64 * GiB, log: () => {} },
    enqueueTestSlot: suiteLine({ outcome: "wait_bound_exceeded", concurrency: 1, executionAllowed: false, waitedMs: 2_700_000,
      note: "NOT_RUN: private coordination requires an admitted lease (wait_bound_exceeded); waited 2700s" }) });
  assert.match(slotRefused.err, /author preflight NOT_RUN \(NOT_RUN: private coordination/, "positive control: the suite slot was not admitted");
  assert.deepEqual([slotRefused.row.refusal_class, slotRefused.row.first_step], ["test-slot-wait-bound", "affected-tests"]);
  assert.equal(slotRefused.row.admission_wait_ms as number >= 2_700_000, true, "the 45 minutes the run waited for its slot are on the row");

  // A Mac disk-reserve refusal before the static stage: NOT_RUN, exit 3, and no class in the list fits it.
  const short = { state: "not-run", platform: "darwin", minimumFreeBytes: 20 * GiB, reserveBasis: "existing-20GiB", reasons: DISK_REASONS, pressure: "normal",
    capacityChecks: [{ filesystem: "workspaceFreeBytes", requiredFreeBytes: 20 * GiB, observedFreeBytes: 20 * GiB - 13_938_688, shortfallBytes: 13_938_688 }] };
  const diskRefused = site(authorTree(t, "disk", { dependencies: true }), { enqueueTestSlot: suiteLine({ outcome: "acquired", concurrency: 1, waitedMs: 0, note: "unused" }),
    admitHost: (stage: string) => { throw new MacAuthorCapacityRefusal(stage, short); } }, author.OVER_CAPACITY_EXIT);
  assert.match(diskRefused.err, /author preflight NOT_RUN: Mac author capacity NOT_RUN before static-preflight: /, "positive control: the capacity admission refused");
  assert.deepEqual([diskRefused.row.refusal_class, diskRefused.row.first_step, diskRefused.row.capacity_reasons], ["other", "static-preflight", DISK_REASONS]);
});

test("W1-T12842 criterion 4: the scout's catalogue names the refused and failed rows, and counts the ones the writer really appended", (t) => {
  assert.deepEqual([...scout.AUTHOR_PREFLIGHT_SYMPTOM_STEPS], [author.AUTHOR_VERDICT_STEPS.refused, author.AUTHOR_VERDICT_STEPS.failed],
    "the catalogue and the writer name the same two steps");
  for (const step of scout.AUTHOR_PREFLIGHT_SYMPTOM_STEPS) assert.equal(scout.isFailureShapedStep(step), true, step);
  assert.equal(scout.isFailureShapedStep(author.AUTHOR_VERDICT_STEPS.passed), false, "a passed run is not a symptom");

  // Rows appended by the real writer, read back by the scout's real ledger reader.
  const root = stateRoot(t, "scout");
  const now = Date.now(), day = 24 * 3_600_000;
  const append = (run: keyof typeof RUNS, context: Context, daysAgo: number) => {
    const written = author.appendAuthorVerdictRow({ root, line: author.authorVerdictRow(RUNS[run], { headRef: BRANCH, ...context })! },
      { clock: fixedClock(now - daysAgo * day) });
    assert.equal(written.written, true, written.reason);
  };
  append("dependencyRefused", { refusalClass: "dependency-precheck" }, 6);
  append("censusTimeBound", {}, 2);
  append("diskReserveNotRun", { refusalClass: "other", refusalStage: "static-preflight" }, 1);
  append("censusFailed", {}, 5);
  append("subsetFailed", {}, 1);
  append("passed", {}, 5);
  append("passed", {}, 1);
  assert.equal(ledgerRows(root).length, 7, "positive control: seven rows are on disk");
  const deps: GardenerDeps = { repoRoot: REPO_ROOT, stateDir: join(root, "state"), clock: fixedClock(now), log: () => {},
    openWorkspace: () => { throw new Error("unexpected workspace"); } };
  const spec = scout.scoutGardenSpec(deps, { clock: fixedClock(now), plan: () => ({ open: [], all: [], shards: new Map() }),
    mergedTasks: () => new Map(), mergedLastDay: () => 5, pricedSteps: () => new Set<string>(), mintTaskId: () => "W1-T99001" });
  const symptoms = spec.inventory().symptoms.map((s) => [s.step, s.older, s.newer]);
  assert.deepEqual(symptoms, [["author_preflight.refused", 1, 2], ["author_preflight.failed", 1, 1]]);
  assert.equal(scout.SCOUT_WINDOW_MS, 7 * day, "the window the days above are placed in");
});
