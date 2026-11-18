// W1-T13272: an author preflight whose every failing test is also red at the merge base on the same host is
// push-eligible, and its receipt and verdict row name those reds. A red the change caused still refuses as it did.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as authorModule from "#scripts/preflight-author.mjs";
import { makeTempDir } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Entry = { file: string | null; title: string; state: string; reason: string };
type Counts = { failingAtHead: number; alsoFailingAtBase: number; failingOnlyAtHead: number; unattributed: number };
type Attribution = { counts?: Counts; base?: { mergeBase?: string; boundMs?: number; files?: string[] }; cleanup?: { removed: boolean }; tests?: Entry[]; error?: string };
type Summary = { tests: number; suites: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number };
type Step = { name: string; ok: boolean; exitCode: number | null; signal: string | null; error: { message: string; code: string | null } | null;
  diagnostics: { mayBeIncomplete: boolean }; notMeasured?: string; testSummary?: Summary | null; judge?: { complete: boolean; given: number; reported: number } | undefined };
type Receipt = { verdict: string; selection: string; startedAt: string; headSha: string; baseSha: string; steps: Step[]; suites: string[];
  tiered?: { ran: string[] }; error?: string; failureAttribution?: Attribution | undefined; pushEligible?: boolean; pushEligibleReason?: string };
type Eligibility = { pushEligible: boolean; pushEligibleReason: string };
const author = authorModule as unknown as {
  authorPushEligibility(receipt: Receipt): Eligibility;
  authorVerdictRow(receipt: Receipt, context?: Record<string, unknown>): Record<string, unknown> | undefined;
  main(argv: string[], deps: { root: string; select?: () => unknown }): number;
};

// The suite's own real run holds one scratch slot directory, so a nested preflight never waits on the host's.
const slotDir = makeTempDir("author-base-reds-slots");
const originalSlotDir = process.env.RMD_TEST_SLOT_DIR;
process.env.RMD_TEST_SLOT_DIR = slotDir;
const cleanups: Array<() => void> = [];
after(() => {
  if (originalSlotDir === undefined) delete process.env.RMD_TEST_SLOT_DIR;
  else process.env.RMD_TEST_SLOT_DIR = originalSlotDir;
  rmSync(slotDir, { recursive: true, force: true });
  for (const cleanup of cleanups) cleanup();
});

const HEAD = "a".repeat(40), BASE = "b".repeat(40), MERGE_BASE = "c".repeat(40);
const BOOT = "test/namespace-boot.test.ts";
const summary = (pass: number, fail: number, cancelled = 0): Summary => ({ tests: pass + fail + cancelled, suites: 0, pass, fail, cancelled, skipped: 0, todo: 0 });
/** A step as the author run records it: measured, complete, exit 0. */
const green = (name: string): Step => ({ name, ok: true, exitCode: 0, signal: null, error: null, diagnostics: { mayBeIncomplete: false } });
/** A test stage that ended red only because tests failed: both suites reached their own summary, and the judge calls
 *  a run with a failing test incomplete, as scripts/pure-test-pool.mjs does. */
const redTests = (pass: number, fail: number, name = "affected-tests"): Step => ({ ...green(name), ok: false, exitCode: 1,
  testSummary: summary(pass, fail), judge: { complete: false, given: 2, reported: 2 } });
const entry = (file: string | null, title: string, state = "also-red"): Entry => ({ file, title, state,
  reason: state === "also-red" ? "reported failing in a completed base run of the same file" : "not failing in a completed base run of the same file" });
/** The attribution W1-T13215 stores on the receipt, its counts taken from the labels; `unnamed` are failures the head never named. */
const attribution = (tests: Entry[], unnamed = 0): Attribution => {
  const count = (state: string) => tests.filter((test) => test.state === state).length;
  return { counts: { failingAtHead: tests.length + unnamed, alsoFailingAtBase: count("also-red"), failingOnlyAtHead: count("only-head"),
    unattributed: count("unattributed") + unnamed }, base: { mergeBase: MERGE_BASE, boundMs: 5000, files: [BOOT] }, cleanup: { removed: true }, tests };
};
const bootReds = (): Entry[] => [entry(BOOT, "readNamespaceBootMs parses a boot time"), entry(BOOT, "readNamespaceBootMs refuses a short line")];
/** The run the ruling was made on (#18965): 2 of 4432 tests red, both red on a tree identical to main for that suite. */
const baseRedRun = (overrides: Partial<Receipt> = {}): Receipt => ({ verdict: "failed", selection: "affected-narrow", startedAt: "2026-11-16T23:20:00.000Z",
  headSha: HEAD, baseSha: BASE, steps: [green("census-precheck"), green("static-preflight"), redTests(4430, 2)], suites: [BOOT, "test/other.test.ts"],
  failureAttribution: attribution(bootReds()), ...overrides });
const ELIGIBLE_REASON = `every failing test is also red at the merge base ${MERGE_BASE} on this host: ` +
  `${BOOT} :: readNamespaceBootMs parses a boot time; ${BOOT} :: readNamespaceBootMs refuses a short line`;
/** What the same run answers with no attribution at all: the refusal a failing run had before this rule. */
const asToday = (receipt: Receipt): Eligibility => author.authorPushEligibility({ ...receipt, failureAttribution: undefined });

/** A committed author tree whose one red test is red at its base too; the head only adds a passing suite. */
function fixture() {
  const repo = gitRepo({ kind: "author-base-reds", seedCommit: false });
  const root = repo.dir;
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ["test/setup", "src", "scripts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('fixture static preflight passed');\n");
  writeFileSync(join(root, "test/leaf.test.ts"), `import { test } from "node:test"; import assert from "node:assert/strict";\n` +
    `test("red at both", () => assert.equal(1, 2));\ntest("green at both", () => assert.equal(1, 1));\n`);
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  const mergeBase = repo.git("rev-parse", "HEAD").trim();
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-author-base-reds");
  // The base run is bounded by the time the head stage took (the fixture has no duration reporter, so the whole stage's).
  // This passing suite holds that stage open, so the base run of leaf.test.ts alone has real headroom on a loaded host.
  writeFileSync(join(root, "test/fresh.test.ts"),
    `import { test } from "node:test";\ntest("born green", async () => { await new Promise((done) => setTimeout(done, 8000)); });\n`);
  repo.git("add", ".");
  repo.git("commit", "-m", "test: add a passing suite");
  return { root, mergeBase, git: repo.git };
}
type RealRun = { exit: number; printed: string[]; receipt: Receipt; mergeBase: string; worktrees: number };
let ran: RealRun | undefined;
/** One real author run of that tree, shared by the criteria that read it. */
function realRun(): RealRun {
  if (ran) return ran;
  const f = fixture();
  const printed: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  let exit: number;
  try { exit = author.main([], { root: f.root, select: () => ({ fullRun: false, suites: ["test/leaf.test.ts", "test/fresh.test.ts"], reasons: [] }) }); }
  finally { console.log = log; }
  ran = { exit, printed, mergeBase: f.mergeBase, worktrees: f.git("worktree", "list").trim().split("\n").length,
    receipt: JSON.parse(readFileSync(join(f.root, "coverage/preflight-author.json"), "utf8")) as Receipt };
  return ran;
}

test("W1-T13272 criterion 1: a run whose every failing test is also red at the merge base is push-eligible, and the reason names each red and the base sha", () => {
  const run = baseRedRun();
  assert.deepEqual(author.authorPushEligibility(run), { pushEligible: true, pushEligibleReason: ELIGIBLE_REASON });
  // Positive control: the attribution is what makes it eligible. The same run without one is refused as it always was.
  assert.deepEqual(asToday(run), { pushEligible: false, pushEligibleReason: "affected-tests failed: 2 failing test(s)" });
  // An over-capacity subset is judged the same way: its census, static gate and subset ran, and its only reds are the base's.
  const subset = baseRedRun({ selection: "over-capacity", steps: [green("census-precheck"), green("static-preflight"), redTests(4430, 2, "affected-tests-subset")],
    suites: [BOOT, "test/other.test.ts", "test/left-to-ci.test.ts"], tiered: { ran: [BOOT, "test/other.test.ts"] } });
  assert.deepEqual(author.authorPushEligibility(subset), { pushEligible: true, pushEligibleReason: ELIGIBLE_REASON });
  // Every red is named, however many there are: the reason is not cut to the length other reasons are held to.
  const many = Array.from({ length: 40 }, (_, index) => entry(`test/suite-${index}.test.ts`, `a pre-existing red with a long descriptive title number ${index}`));
  const long = author.authorPushEligibility(baseRedRun({ steps: [green("census-precheck"), green("static-preflight"), redTests(100, 40)], failureAttribution: attribution(many) }));
  assert.equal(long.pushEligible, true, long.pushEligibleReason);
  assert.ok(long.pushEligibleReason.length > 400, "positive control: this list is longer than the usual bound");
  for (const red of many) assert.ok(long.pushEligibleReason.includes(`${red.file} :: ${red.title}`), `${red.title} is named`);
  assert.doesNotMatch(long.pushEligibleReason, /[\r\n]/, "the reason is one line");
});

test("W1-T13272 criterion 1: a real run that fails only a test its base fails too ends push-eligible, and keeps its verdict and exit code", () => {
  const { exit, printed, receipt, mergeBase, worktrees } = realRun();
  const attributed = receipt.failureAttribution!;
  assert.deepEqual(attributed.tests!.map((test) => `${test.file} :: ${test.title}: ${test.state}`), ["test/leaf.test.ts :: red at both: also-red"],
    "positive control: the run had one failing test and the base run labelled it");
  const reason = `every failing test is also red at the merge base ${mergeBase} on this host: test/leaf.test.ts :: red at both`;
  assert.deepEqual({ pushEligible: receipt.pushEligible, pushEligibleReason: receipt.pushEligibleReason }, { pushEligible: true, pushEligibleReason: reason });
  assert.ok(printed.includes(`author push-eligible: true; ${reason}`), printed.filter((line) => line.startsWith("author ")).join("\n"));
  // The rule reads the verdict and never sets it: the run still failed, and still exits as a failed run does.
  assert.equal(receipt.verdict, "failed");
  assert.equal(exit, 1);
  assert.equal(receipt.steps.find((step) => step.name === "affected-tests")!.ok, false);
  assert.equal(worktrees, 1, "the scratch worktree of the base run was removed");
});

test("W1-T13272 criterion 2: the verdict row lists the pre-existing reds beside the counts", () => {
  const run = baseRedRun();
  Object.assign(run, author.authorPushEligibility(run));
  const row = author.authorVerdictRow(run, { exitCode: 1, headRef: "run-W1-T13272-1794919777975" })!;
  const reds = [{ file: BOOT, test: "readNamespaceBootMs parses a boot time" }, { file: BOOT, test: "readNamespaceBootMs refuses a short line" }];
  assert.deepEqual(row.preexisting_reds, reds);
  assert.deepEqual([row.failing_at_head, row.failing_also_at_base, row.failing_only_at_head, row.failing_unattributed], [2, 2, 0, 0]);
  const keys = Object.keys(row);
  assert.equal(keys.indexOf("preexisting_reds"), keys.indexOf("failing_unattributed") + 1, "the list sits beside the counts");
  assert.deepEqual([row.step, row.verdict, row.push_eligible, row.task_id], ["author_preflight.failed", "failed", true, "W1-T13272"]);
  assert.deepEqual((JSON.parse(JSON.stringify(row)) as { preexisting_reds: unknown }).preexisting_reds, reds, "the list survives the ledger's one JSON line");
  // A mixed run lists only the reds the base has, and is not pushable; a run that compared nothing has no list.
  const mixed = baseRedRun({ failureAttribution: attribution([bootReds()[0]!, entry(BOOT, "readNamespaceBootMs refuses a short line", "only-head")]) });
  Object.assign(mixed, author.authorPushEligibility(mixed));
  const mixedRow = author.authorVerdictRow(mixed, { exitCode: 1 })!;
  assert.deepEqual(mixedRow.preexisting_reds, reds.slice(0, 1));
  assert.equal(mixedRow.push_eligible, false);
  assert.deepEqual(author.authorVerdictRow(baseRedRun({ failureAttribution: attribution([entry(BOOT, "new red", "only-head")]) }))!.preexisting_reds, []);
  assert.equal("preexisting_reds" in author.authorVerdictRow(baseRedRun({ failureAttribution: undefined }))!, false);
  assert.equal("preexisting_reds" in author.authorVerdictRow(baseRedRun({ failureAttribution: { error: "the attribution could not be made: boom" } }))!, false);
  // The row of a real run carries the list too.
  const real = realRun();
  const realRow = author.authorVerdictRow(real.receipt, { exitCode: real.exit, headRef: "run-unfiled-author-base-reds" })!;
  assert.deepEqual(realRow.preexisting_reds, [{ file: "test/leaf.test.ts", test: "red at both" }]);
  assert.deepEqual([realRow.failing_at_head, realRow.failing_also_at_base, realRow.push_eligible], [1, 1, true]);
});

test("W1-T13272 criterion 3: invariant a-red-the-change-caused-still-refuses, and a run with no attribution is never pushable on this rule", () => {
  // Positive control: every case below is this eligible run with one thing changed.
  assert.equal(author.authorPushEligibility(baseRedRun()).pushEligible, true);
  const [first, second] = bootReds() as [Entry, Entry];
  const tests = (step: Partial<Step>, name = "affected-tests"): Step[] => [green("census-precheck"), green("static-preflight"), { ...redTests(4430, 2, name), ...step }];
  const today = /^affected-tests failed: 2 failing test\(s\)$/;
  const cases: Array<[string, Receipt, RegExp]> = [
    ["one red only at the head", baseRedRun({ failureAttribution: attribution([first, { ...second, state: "only-head" }]) }), today],
    ["one unattributed red", baseRedRun({ failureAttribution: attribution([first, { ...second, state: "unattributed", reason: "the base run was cut short (SIGTERM) at its bound of 5000ms" }]) }), today],
    ["a failure the head's output never named", baseRedRun({ steps: tests({ testSummary: summary(4429, 3) }), failureAttribution: attribution(bootReds(), 1) }), /^affected-tests failed: 3 failing test\(s\)$/],
    ["no attribution", baseRedRun({ failureAttribution: undefined }), today],
    ["an attribution that could not be made", baseRedRun({ failureAttribution: { error: "the attribution could not be made: boom" } }), today],
    ["counts with no list of tests", baseRedRun({ failureAttribution: { counts: attribution(bootReds()).counts!, base: { mergeBase: MERGE_BASE } } }), today],
    ["a list with no counts", baseRedRun({ failureAttribution: { tests: bootReds(), base: { mergeBase: MERGE_BASE } } }), today],
    ["an empty list", baseRedRun({ failureAttribution: attribution([]) }), today],
    ["counts that disagree with the labels", baseRedRun({ failureAttribution: { ...attribution(bootReds()), counts: { failingAtHead: 2, alsoFailingAtBase: 1, failingOnlyAtHead: 1, unattributed: 0 } } }), today],
    ["unattributed counted beside two labelled reds", baseRedRun({ failureAttribution: { ...attribution(bootReds()), counts: { failingAtHead: 2, alsoFailingAtBase: 2, failingOnlyAtHead: 0, unattributed: 1 } } }), today],
    ["fewer labelled tests than the stage failed", baseRedRun({ steps: tests({ testSummary: summary(4429, 3) }) }), /^affected-tests failed: 3 failing test\(s\)$/],
    ["more labelled tests than the stage failed", baseRedRun({ steps: tests({ testSummary: summary(4431, 1) }) }), /^affected-tests failed: 1 failing test\(s\)$/],
    ["no merge base recorded", baseRedRun({ failureAttribution: { ...attribution(bootReds()), base: {} } }), today],
    ["a labelled red that names no file", baseRedRun({ failureAttribution: attribution([first, { ...second, file: null }]) }), today],
    ["a stage killed by a signal", baseRedRun({ steps: tests({ signal: "SIGTERM", exitCode: null }) }), today],
    ["a stage that could not be spawned", baseRedRun({ steps: tests({ error: { message: "spawn ETIMEDOUT", code: "ETIMEDOUT" } }) }), today],
    ["a stage whose output may be incomplete", baseRedRun({ steps: tests({ diagnostics: { mayBeIncomplete: true } }) }), today],
    ["a suite that never reached its summary", baseRedRun({ steps: tests({ judge: { complete: false, given: 2, reported: 1 } }) }), today],
    ["a stage that was given no suite", baseRedRun({ steps: tests({ judge: { complete: false, given: 0, reported: 0 } }) }), today],
    ["a stage with no judged record", baseRedRun({ steps: tests({ judge: undefined }) }), today],
    ["a cancelled test beside the reds", baseRedRun({ steps: tests({ testSummary: summary(4429, 2, 1) }) }), today],
    ["no passing test", baseRedRun({ steps: tests({ testSummary: summary(0, 2) }) }), today],
    ["no test summary", baseRedRun({ steps: tests({ testSummary: null }) }), /^affected-tests failed$/],
    ["a static gate that failed too", baseRedRun({ steps: [green("census-precheck"), { ...green("static-preflight"), ok: false, exitCode: 1 }, redTests(4430, 2)] }), /^static-preflight failed$/],
    ["a later stage that failed too", baseRedRun({ steps: [...tests({}), { ...green("workflow-contract-precheck"), ok: false, exitCode: 1 }] }), today],
    ["a receipt that was refused", baseRedRun({ verdict: "refused", error: "author receipt could not be written: EACCES" }), /^affected-tests failed: 2 failing test\(s\); refused: author receipt could not be written: EACCES$/],
    ["an over-capacity subset whose census was not measured", baseRedRun({ selection: "over-capacity", tiered: { ran: [BOOT] },
      steps: [{ ...green("census-precheck"), notMeasured: "time-bound" }, green("static-preflight"), redTests(4430, 2, "affected-tests-subset")] }), /^affected-tests-subset failed: 2 failing test\(s\)$/],
  ];
  for (const [name, receipt, reason] of cases) {
    const answer = author.authorPushEligibility(receipt);
    assert.equal(answer.pushEligible, false, `${name}: ${answer.pushEligibleReason}`);
    assert.match(answer.pushEligibleReason, reason, name);
    assert.deepEqual(answer, asToday(receipt), `${name}: the refusal is word for word the one this run had before the rule`);
    Object.assign(receipt, answer);
    assert.equal(author.authorVerdictRow(receipt, { exitCode: 1 })!.push_eligible, false, `${name}: the row says so too`);
  }
});
