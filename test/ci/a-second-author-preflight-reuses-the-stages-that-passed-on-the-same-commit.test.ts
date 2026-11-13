import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// @ts-ignore the executable .mjs module has no declaration file.
import * as authorModule from "#scripts/preflight-author.mjs";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT as ROOT } from "#test/helpers/repo-root.js";

type Step = { name: string; ok: boolean; exitCode?: number | null; startedAt?: string | null; durationMs?: number | null;
  notMeasured?: string; reused?: { runStartedAt: string; measuredAt: string; durationMs: number | null };
  testSummary?: Record<string, number> | null; judge?: { complete: boolean }; diagnostics?: { mayBeIncomplete: boolean } };
type Receipt = Record<string, unknown> & { verdict: string; startedAt: string; steps: Step[]; suites: string[];
  pushEligible: boolean; pushEligibleReason: string; stageReuse?: { state: string; reason: string; reused: string[] } };
const author = authorModule as unknown as {
  main: (argv: string[], deps: { root: string; select?: () => unknown; host?: () => unknown }) => number;
  reusableAuthorStages: (previous: unknown, current: unknown) => { state: string; reason: string; stages: Step[] };
  authorPushEligibility: (receipt: unknown) => { pushEligible: boolean; pushEligibleReason: string };
};

// The suite slot lives in owned scratch, so a busy host's real queue never decides these outcomes.
const scratch = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stage-reuse-`));
const saved = { slots: process.env.RMD_TEST_SLOT_DIR, log: process.env.T12166_LOG, red: process.env.T12166_RED };
process.env.RMD_TEST_SLOT_DIR = join(scratch, "slots");
const cleanups: (() => void)[] = [];
after(() => {
  for (const [key, value] of [["RMD_TEST_SLOT_DIR", saved.slots], ["T12166_LOG", saved.log], ["T12166_RED", saved.red]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const cleanup of cleanups) cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

/** Each stage writes its name to the log, and fails while a marker file names it: a red that is not in the commit. */
const stageScript = (stage: string) => [
  "import { appendFileSync, existsSync } from 'node:fs';",
  `appendFileSync(process.env.T12166_LOG, '${stage}\\n');`,
  `if (existsSync(process.env.T12166_RED + '/${stage}')) process.exitCode = 1;`, ""].join("\n");

/** A committed author tree whose census, static gate and changed suite pass unless a marker names them. */
function fixture(opts: { otherCostMs?: number; docsInput?: boolean } = {}) {
  const repo = gitRepo({ kind: "stage-reuse", seedCommit: false });
  cleanups.push(() => repo.cleanup());
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), stageScript("census"));
  if (opts.docsInput) {
    writeFileSync(join(root, "scripts/docs-stage.mjs"), [
      "import { appendFileSync, existsSync } from 'node:fs';",
      "const stage = `docs-index:${process.argv[2]}`;",
      "appendFileSync(process.env.T12166_LOG, `${stage}\\n`);",
      "if (existsSync(`${process.env.T12166_RED}/${stage}`)) process.exitCode = 1;", "",
    ].join("\n"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: {
      "docs-index:check": "node scripts/docs-stage.mjs check",
      "docs-index:check-paths": "node scripts/docs-stage.mjs check-paths",
    }, description: "baseline" }) + "\n");
  }
  writeFileSync(join(root, "src/run-task.ts"), stageScript("static"));
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 1;\n");
  const suite = "import { test } from 'node:test'; test('fixture', () => {});\n";
  writeFileSync(join(root, "test/leaf.test.ts"), suite);
  writeFileSync(join(root, "test/other.test.ts"), suite);
  writeFileSync(join(root, "scripts/test-tier-manifest.json"), JSON.stringify({ thresholdMs: 5000,
    files: { "test/leaf.test.ts": 1_000, "test/other.test.ts": opts.otherCostMs ?? 1_000 } }));
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-stage-reuse");
  if (opts.docsInput) {
    const packagePath = join(root, "package.json");
    const packageData = JSON.parse(readFileSync(packagePath, "utf8"));
    packageData.description = "changed docs input";
    writeFileSync(packagePath, JSON.stringify(packageData) + "\n");
    repo.git("add", "package.json");
    repo.git("commit", "-m", "docs: change index input");
  }
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 2;\n");
  writeFileSync(join(root, "test/leaf.test.ts"), [
    "import { appendFileSync, existsSync } from 'node:fs';", "import { test } from 'node:test';",
    "test('fixture changed', () => {", "  appendFileSync(process.env.T12166_LOG, 'tests\\n');",
    "  if (existsSync(process.env.T12166_RED + '/tests')) throw new Error('red on a busy host');", "});", ""].join("\n"));
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: change");
  const log = join(scratch, `${repo.dir.split("/").at(-1)}.log`), red = join(scratch, `${repo.dir.split("/").at(-1)}.red`);
  mkdirSync(red);
  return { root, repo, log, red };
}

type Fixture = ReturnType<typeof fixture>;
const select = () => ({ fullRun: false, suites: ["test/leaf.test.ts", "test/other.test.ts"], reasons: ["fixture"], recentOnly: { floor: [] } });
const host = () => ({ cores: 8, load1: 0, headroomBytes: 8 * 1024 ** 3 });
const HUGE = 10 * 60 * 60 * 1000;

/** One real author run: which stages ran (from their own log lines), what main returned and the receipt it wrote. */
function run(f: Fixture, red: string[] = []) {
  rmSync(f.red, { recursive: true, force: true });
  mkdirSync(f.red);
  for (const stage of red) writeFileSync(join(f.red, stage), "");
  writeFileSync(f.log, "");
  process.env.T12166_LOG = f.log;
  process.env.T12166_RED = f.red;
  const log = console.log, error = console.error;
  console.log = () => {}; console.error = () => {};
  let status: number;
  try { status = author.main([], { root: f.root, select, host }); }
  finally { console.log = log; console.error = error; }
  const receipt = JSON.parse(readFileSync(join(f.root, "coverage/preflight-author.json"), "utf8")) as Receipt;
  return { status, receipt, ran: readFileSync(f.log, "utf8").split("\n").filter(Boolean) };
}
const step = (receipt: Receipt, name: string) => receipt.steps.find((s) => s.name === name || s.name === `${name}-subset`);
const names = (receipt: Receipt) => receipt.steps.map((s) => [s.name, s.ok, Boolean(s.reused)]);

/** The flake the task measured: census and static green, a suite red only on a busy host, then green alone. */
let flake: { f: Fixture; first: ReturnType<typeof run>; second: ReturnType<typeof run> } | undefined;
function flakeThenGreen() {
  if (flake) return flake;
  const f = fixture();
  const first = run(f, ["tests"]);
  const second = run(f);
  flake = { f, first, second };
  return flake;
}

test("W1-T12166 criterion 1: a second run on the same head, base, node, dependency record and selection does not run again the stages that passed", () => {
  const { first, second } = flakeThenGreen();
  assert.equal(first.receipt.verdict, "failed");
  assert.deepEqual(first.ran, ["census", "static", "tests"]);
  assert.equal(second.receipt.stageReuse?.state, "reused", second.receipt.stageReuse?.reason);
  assert.deepEqual(second.ran, ["tests"], "census and static did not run again; the failed test stage did");
  assert.deepEqual(names(second.receipt), [["census-precheck", true, true], ["static-preflight", true, true], ["affected-tests", true, false]]);
  assert.equal(second.receipt.verdict, "passed");
  assert.equal(second.status, 0);
  assert.deepEqual(second.receipt.stageReuse?.reused, ["census-precheck", "static-preflight"]);
});

test("W1-T12166 criterion 2: the new receipt marks each reused stage as reused and names the time of the run that measured it", () => {
  const { first, second } = flakeThenGreen();
  for (const name of ["census-precheck", "static-preflight"]) {
    const measured = step(first.receipt, name)!, reused = step(second.receipt, name)!;
    assert.ok(reused.reused, `${name} carries the reuse mark`);
    assert.equal(reused.reused.runStartedAt, first.receipt.startedAt);
    assert.equal(reused.reused.measuredAt, measured.startedAt);
    assert.equal(reused.reused.durationMs, measured.durationMs);
    assert.equal(reused.durationMs, null, "a reused stage spent no time in this run");
  }
  assert.equal(step(second.receipt, "affected-tests")!.reused, undefined, "a stage this run measured has no reuse mark");
  // A third run on the same inputs keeps the time of the run that really measured the stage.
  const third = run(flakeThenGreen().f);
  assert.deepEqual(third.ran, [], "every stage passed measured on these inputs");
  assert.equal(step(third.receipt, "static-preflight")!.reused?.runStartedAt, first.receipt.startedAt);
  assert.equal(step(third.receipt, "affected-tests")!.reused?.runStartedAt, flakeThenGreen().second.receipt.startedAt);
});

test("W1-T12166 criterion 3: a stage that failed, did not run or was not measured is never reused, and a test subset is never reused", () => {
  // A failed static gate runs again, and so does every stage after it.
  const f = fixture();
  const first = run(f, ["static"]);
  assert.equal(first.receipt.verdict, "failed");
  assert.deepEqual(first.ran, ["census", "static"], "the tests did not run after a red static gate");
  const second = run(f);
  assert.deepEqual(second.ran, ["static", "tests"]);
  assert.deepEqual(names(second.receipt), [["census-precheck", true, true], ["static-preflight", true, false], ["affected-tests", true, false]]);

  // An over-capacity run ran only the suites that fit: its subset runs again even when it was green.
  const over = fixture({ otherCostMs: HUGE });
  const o1 = run(over);
  assert.equal(o1.receipt.verdict, "over-capacity");
  const o2 = run(over);
  assert.deepEqual(o2.ran, ["tests"]);
  assert.equal(step(o2.receipt, "affected-tests")!.reused, undefined);
  assert.equal(o2.receipt.verdict, "over-capacity");

  // The rule itself: start from a receipt whose every stage could be reused, then break one stage at a time.
  const summary = { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const good = (name: string): Step => ({ name, ok: true, exitCode: 0, startedAt: "2026-11-13T00:00:00.000Z", durationMs: 5,
    diagnostics: { mayBeIncomplete: false }, ...(name === "affected-tests" ? { testSummary: summary, judge: { complete: true } } : {}) });
  const base = (steps: Step[]) => ({ verdict: "failed", dryRun: false, startedAt: "2026-11-13T00:00:00.000Z", headSha: "a".repeat(40),
    baseSha: "b".repeat(40), node: "v24", selection: "affected-narrow", suites: ["test/leaf.test.ts"],
    dependencyProvenance: { before: { state: "present", key: "k" }, after: { state: "present", key: "k" } }, steps });
  const current = { ...base([]), steps: [] };
  const reused = (steps: Step[], extra: Record<string, unknown> = {}) =>
    author.reusableAuthorStages({ ...base(steps), ...extra }, current).stages.map((s) => s.name);
  assert.deepEqual(reused([good("census-precheck"), good("static-preflight"), good("affected-tests")]),
    ["census-precheck", "static-preflight", "affected-tests"]);
  assert.deepEqual(reused([{ ...good("census-precheck"), ok: false }, good("static-preflight")]), [], "a failed stage ends reuse");
  assert.deepEqual(reused([{ ...good("census-precheck"), notMeasured: "time-bound" }, good("static-preflight")]), [],
    "a stage that was not measured ends reuse");
  assert.deepEqual(reused([good("census-precheck"), { ...good("static-preflight"), exitCode: 1 }]), ["census-precheck"]);
  assert.deepEqual(reused([good("census-precheck"), { ...good("static-preflight"), diagnostics: { mayBeIncomplete: true } }]), ["census-precheck"]);
  assert.deepEqual(reused([good("census-precheck")]), ["census-precheck"], "a stage that did not run is not in the list");
  assert.deepEqual(reused([good("census-precheck"), { ...good("affected-tests"), judge: { complete: false } }]), ["census-precheck"],
    "a test stage reused only when every selected suite reported");
  assert.deepEqual(reused([good("census-precheck"), { ...good("affected-tests"), testSummary: { ...summary, fail: 1 } }]), ["census-precheck"]);
  assert.deepEqual(reused([good("census-precheck"), { ...good("affected-tests"), name: "affected-tests-subset" }]), ["census-precheck"]);
  assert.deepEqual(reused([good("census-precheck"), good("affected-tests")], { tiered: { ran: [] } }), ["census-precheck"]);
});

test("W1-T12166: a refused docs precheck reuses the passing census and reruns from the refused stage", () => {
  const f = fixture({ docsInput: true });
  const first = run(f, ["docs-index:check"]);
  assert.equal(first.receipt.verdict, "refused");
  assert.deepEqual(first.ran, ["census", "docs-index:check"]);
  const provenance = first.receipt.dependencyProvenance as { before: unknown; after: unknown };
  assert.deepEqual(provenance.after, provenance.before,
    "the refusal records whether its dependencies stayed stable");

  const second = run(f);
  assert.equal(second.receipt.stageReuse?.state, "reused", second.receipt.stageReuse?.reason);
  assert.deepEqual(second.receipt.stageReuse?.reused, ["census-precheck"]);
  assert.deepEqual(second.ran, ["docs-index:check", "docs-index:check-paths", "static", "tests"]);
  assert.equal(step(second.receipt, "census-precheck")?.reused?.runStartedAt, first.receipt.startedAt);
  assert.equal(step(second.receipt, "docs-index-precheck:docs-index:check")?.reused, undefined,
    "the refused docs stage is rerun");
  assert.equal(second.receipt.verdict, "passed");
});

test("W1-T12166 criterion 4: when one key field differs, or the last receipt is absent or does not parse, every stage runs", () => {
  const all = ["census", "static", "tests"];
  const f = fixture();
  const fresh = run(f, ["tests"]);
  assert.match(fresh.receipt.stageReuse?.reason ?? "", /no readable last receipt \(ENOENT\)/);
  assert.deepEqual(fresh.ran, all, "an absent receipt reuses nothing");

  writeFileSync(join(f.root, "coverage/preflight-author.json"), "{ not json");
  const garbled = run(f, ["tests"]);
  assert.equal(garbled.receipt.stageReuse?.state, "none");
  assert.deepEqual(garbled.ran, all, "a receipt that does not parse reuses nothing");

  // The base moved: the same head now sits on another main, and its rules may differ.
  f.repo.git("checkout", "-q", "main");
  writeFileSync(join(f.root, "src/other.ts"), "export const other = 1;\n");
  f.repo.git("add", ".");
  f.repo.git("commit", "-q", "-m", "chore: move main");
  f.repo.git("checkout", "-q", "run-unfiled-stage-reuse");
  const moved = run(f, ["tests"]);
  assert.equal(moved.receipt.stageReuse?.reason, "baseSha differs from the last run");
  assert.deepEqual(moved.ran, all, "a moved base reuses nothing");

  // A new commit: the tree differs.
  writeFileSync(join(f.root, "src/leaf.ts"), "export const value = 3;\n");
  f.repo.git("commit", "-q", "-am", "fix: change again");
  const changed = run(f);
  assert.equal(changed.receipt.stageReuse?.reason, "headSha differs from the last run");
  assert.deepEqual(changed.ran, all, "a changed commit reuses nothing");

  // Each other key field, one at a time, through the rule the run uses.
  const previous = changed.receipt;
  assert.equal(author.reusableAuthorStages(previous, previous).state, "reused");
  for (const [field, value] of [["node", "v0.0.0"], ["selection", "full-fallback"], ["suites", ["test/leaf.test.ts"]],
    ["dependencyProvenance", { before: { state: "present", key: "other" } }]] as const) {
    const answer = author.reusableAuthorStages(previous, { ...previous, [field]: value });
    assert.equal(answer.state, "none", field);
    assert.equal(answer.stages.length, 0, field);
  }
  // A refused last run, or one whose dependency record changed while it ran, is not a source of reuse.
  assert.equal(author.reusableAuthorStages({ ...previous, verdict: "refused", error: "tree changed" }, previous).state, "none");
  assert.equal(author.reusableAuthorStages({ ...previous, dependencyProvenance: { ...(previous.dependencyProvenance as object), after: { state: "absent" } } },
    previous).state, "none");
  assert.equal(author.reusableAuthorStages({ ...previous, startedAt: undefined }, previous).state, "none");
});

test("W1-T12166 criterion 5: the answer to whether the run may push is the same as for a run that measured every stage itself", () => {
  const { f, second } = flakeThenGreen();
  rmSync(join(f.root, "coverage/preflight-author.json"));
  const measured = run(f);
  assert.deepEqual(measured.ran, ["census", "static", "tests"], "this run measured every stage");
  assert.equal(second.receipt.pushEligible, true, second.receipt.pushEligibleReason);
  assert.deepEqual([second.status, second.receipt.verdict, second.receipt.pushEligible],
    [measured.status, measured.receipt.verdict, measured.receipt.pushEligible]);
  assert.deepEqual({ pushEligible: second.receipt.pushEligible, pushEligibleReason: second.receipt.pushEligibleReason },
    author.authorPushEligibility(second.receipt));
  // A red that persists stays red: reuse never turns a failed stage into a push.
  const stubborn = fixture();
  const redOnce = run(stubborn, ["tests"]);
  const redAgain = run(stubborn, ["tests"]);
  assert.deepEqual(redAgain.ran, ["tests"]);
  assert.deepEqual([redAgain.status, redAgain.receipt.verdict, redAgain.receipt.pushEligible], [redOnce.status, "failed", false]);
  assert.equal(redAgain.status, 1);
  assert.ok(existsSync(join(stubborn.root, "coverage/preflight-author.json")));
});
