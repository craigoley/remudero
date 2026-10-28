import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitRepo } from "#test/helpers/git-repo.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const author = (await import(pathToFileURL(join(ROOT, "scripts/preflight-author.mjs")).href)) as {
  main: (argv: string[], deps: { root: string; select?: (changed: string[], range: string) => unknown; host?: () => unknown }) => number;
  authorSelection: (root: string, changed: string[], range: string) => {
    suites: string[]; fullRun: boolean; planOnly?: boolean; lintPlanFast?: boolean; reasons: string[];
  };
  hostBudget: (host: { cores: number; load1: number; headroomBytes?: number }, opts?: object) => {
    workers: number; budgetMs: number; inputs: Record<string, unknown>;
  };
  capacityVerdict: (suites: string[], manifest: object, budget: object) => {
    fits: boolean; costMs: number; budgetMs: number; workers: number;
  };
  OVER_CAPACITY_EXIT: number;
};
const diffClass = (await import(pathToFileURL(join(ROOT, "scripts/diff-class.mjs")).href)) as {
  planReadingSuiteFiles: (root: string, changed: string[]) => string[];
  planOnlySuiteFiles: (root: string, changed: string[]) => string[];
  isPlanIntegritySuite: (content: string) => boolean;
};
const affected = await import("#src/lib/affected-suites.js");

const SHARD = "plan/tasks.d/W1-T7809-preflight-author-sizes-its-selection-by-reach-and-host-capacity.yaml";

/** A baseline repo with two suites; the branch commit changes `changeset` (default: src and the leaf test). */
function fixture(opts: { manifest?: Record<string, number>; planOnly?: boolean } = {}) {
  const repo = gitRepo({ kind: "author-sizing", seedCommit: false });
  const root = repo.dir;
  for (const path of ["test/setup", "src", "scripts", "plan/tasks.d"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, "package-lock.json"), readFileSync(join(ROOT, "package-lock.json")));
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"), "console.log('fixture census precheck passed');\n");
  writeFileSync(join(root, "scripts/lint-plan-offline.mjs"), "console.log('fixture lint-plan passed');\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('fixture static preflight passed');\n");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 1;\n");
  const suite = "import { test } from 'node:test'; test('fixture', () => {});\n";
  writeFileSync(join(root, "test/leaf.test.ts"), suite);
  writeFileSync(join(root, "test/other.test.ts"), suite);
  // One suite reads the shard by id; one merely calls loadPlan on the whole plan and must not be selected.
  writeFileSync(join(root, "test/reads-shard.test.ts"), "import { test } from 'node:test'; test('reads W1-T1', () => {});\n");
  writeFileSync(join(root, "test/loads-plan.test.ts"),
    "import { test } from 'node:test'; const loadPlan = (_: string) => 0; test('loads', () => { loadPlan('plan/tasks.yaml'); });\n");
  writeFileSync(join(root, "plan/tasks.d/W1-T1-fixture.yaml"), "- id: W1-T1\n");
  if (opts.manifest) writeFileSync(join(root, "scripts/test-tier-manifest.json"), JSON.stringify({ thresholdMs: 5000, files: opts.manifest }));
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline");
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-author-sizing");
  if (opts.planOnly) writeFileSync(join(root, "plan/tasks.d/W1-T1-fixture.yaml"), "- id: W1-T1\n  title: edited\n");
  else {
    writeFileSync(join(root, "src/leaf.ts"), "export const value = 2;\n");
    writeFileSync(join(root, "test/leaf.test.ts"), "import { test } from 'node:test'; test('fixture changed', () => {});\n");
  }
  repo.git("add", ".");
  repo.git("commit", "-m", "fix: change");
  return { root, receipt: () => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")) };
}

/** Runs main with console output captured. */
function run(t: { mock: { method: (...a: never[]) => { mock: { calls: { arguments: unknown[] }[] } } } },
  root: string, deps: Omit<Parameters<typeof author.main>[1], "root">) {
  const logged = t.mock.method(console as never, "log" as never, (() => {}) as never);
  const status = author.main([], { ...deps, root });
  return { status, output: logged.mock.calls.map((c) => c.arguments.join(" ")).join("\n") };
}

test("W1-T7809: a plan-only diff selects plan lint and the suites that read its shard", (t) => {
  const changed = [SHARD];
  // The real tree: the author selection is the plan-only arm, far narrower than every loadPlan caller.
  const selection = author.authorSelection(ROOT, changed, "base...head");
  assert.equal(selection.planOnly, true);
  assert.equal(selection.lintPlanFast, true);
  assert.equal(selection.fullRun, false);
  assert.ok(selection.suites.includes("test/preflight-author-sizes-its-selection-by-reach-and-host-capacity.test.ts"),
    "a suite that names the changed shard's id reads it");
  assert.ok(selection.suites.includes("test/every-shard-on-main-is-lintable.test.ts"), "a plan-integrity suite stays");
  const broad = diffClass.planReadingSuiteFiles(ROOT, changed);
  assert.ok(selection.suites.length > 0 && selection.suites.length * 4 < broad.length,
    `plan-only selects ${selection.suites.length} suite(s); every loadPlan caller would be ${broad.length}`);
  assert.deepEqual(selection.suites, diffClass.planOnlySuiteFiles(ROOT, changed));
  // A mixed diff is not the plan-only arm.
  assert.equal(affected.isPlanOnlyDiff([SHARD, "src/lib/plan.ts"]), false);
  assert.equal(affected.isPlanOnlyDiff([SHARD]), true);
  // The integrity set is derived from a suite's own source: the linter as its subject, the real plan as its input.
  assert.equal(diffClass.isPlanIntegritySuite(
    "import { lintTask } from '../src/lib/task-linter.js'; const p = loadPlan('x'); read('plan/tasks.yaml'); loadPlan(1)"), true);
  assert.equal(diffClass.isPlanIntegritySuite("const p = loadPlan(1); read('plan/tasks.yaml');"), false);

  // End to end on a fixture: plan lint runs as a step, the shard's reader runs, the loadPlan decoy does not.
  const f = fixture({ planOnly: true });
  const { status } = run(t as never, f.root, {});
  assert.equal(status, 0);
  const receipt = f.receipt();
  assert.equal(receipt.selection, "plan-only");
  assert.deepEqual(receipt.suites, ["test/reads-shard.test.ts"]);
  assert.deepEqual(receipt.steps.map((s: { name: string }) => s.name),
    ["census-precheck", "static-preflight", "lint-plan-fast", "affected-tests"]);
  assert.equal(receipt.verdict, "passed");
});

test("W1-T7809: an over-capacity selection reports CI is the check with its priced cost and budget", (t) => {
  const huge = 10 * 60 * 60 * 1000;
  const f = fixture({ manifest: { "test/leaf.test.ts": huge, "test/other.test.ts": huge } });
  const select = () => ({ fullRun: false, suites: ["test/leaf.test.ts", "test/other.test.ts"], reasons: ["fixture"], recentOnly: { floor: [] } });
  const host = () => ({ cores: 8, load1: 0, headroomBytes: 8 * 1024 ** 3 });
  const { status, output } = run(t as never, f.root, { select, host });
  assert.equal(status, author.OVER_CAPACITY_EXIT);
  assert.notEqual(author.OVER_CAPACITY_EXIT, 0);
  assert.notEqual(author.OVER_CAPACITY_EXIT, 1);
  const receipt = f.receipt();
  assert.equal(receipt.selection, "over-capacity");
  assert.equal(receipt.selectedArm, "affected-floor");
  assert.equal(receipt.capacity.fits, false);
  assert.ok(receipt.capacity.costMs > receipt.capacity.budgetMs);
  assert.match(output, /affected-tests: NOT RUN — CI is the check/);
  assert.ok(output.includes(`priced ${receipt.capacity.costMs}ms`), "the priced cost is printed");
  assert.ok(output.includes(`budget ${receipt.capacity.budgetMs}ms`), "the budget is printed");
  assert.ok(output.includes('"cores":8'), "the inputs to the budget are printed");
  // The static preflight and the census precheck still ran.
  assert.deepEqual(receipt.steps.map((s: { name: string }) => s.name), ["census-precheck", "static-preflight"]);
});

test("W1-T7809: the same selection fits a larger host and not a smaller one", () => {
  const manifest = { files: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`test/s${i}.test.ts`, 200_000])) };
  const suites = Object.keys(manifest.files);
  const small = author.hostBudget({ cores: 3, load1: 0, headroomBytes: 64 * 1024 ** 3 });
  const large = author.hostBudget({ cores: 16, load1: 0, headroomBytes: 64 * 1024 ** 3 });
  assert.ok(large.workers > small.workers);
  const onSmall = author.capacityVerdict(suites, manifest, small);
  const onLarge = author.capacityVerdict(suites, manifest, large);
  assert.equal(onSmall.costMs, onLarge.costMs, "the same selection is priced the same on both hosts");
  assert.equal(onSmall.fits, false);
  assert.equal(onLarge.fits, true);
  // Memory headroom and current load shrink a host with the same cores.
  const squeezed = author.hostBudget({ cores: 16, load1: 0, headroomBytes: 600 * 1024 ** 2 });
  assert.equal(squeezed.workers, 1);
  assert.equal(author.capacityVerdict(suites, manifest, squeezed).fits, false);
  const busy = author.hostBudget({ cores: 16, load1: 11, headroomBytes: 64 * 1024 ** 3 });
  assert.ok(busy.workers < large.workers);
  assert.equal(busy.inputs.load1, 11);
  // The step runtime is an input too: a shorter step budgets less.
  const shortStep = author.hostBudget({ cores: 16, load1: 0, headroomBytes: 64 * 1024 ** 3 }, { stepRuntimeMs: 60_000 });
  assert.ok(shortStep.budgetMs < large.budgetMs);
  // An unmeasured file is never free: it prices at the manifest median, floor above zero.
  assert.ok(author.capacityVerdict(["test/unknown.test.ts"], { files: {} }, large).costMs > 0);
});

test("W1-T7809: a plan-only selection that names no suite runs no tests and says plan lint is its check", (t) => {
  const f = fixture({ planOnly: true });
  const select = () => ({ fullRun: false, planOnly: true, lintPlanFast: true, suites: [], reasons: ["fixture"], recentOnly: { floor: [] } });
  const { status, output } = run(t as never, f.root, { select });
  assert.equal(status, 0);
  const receipt = f.receipt();
  assert.equal(receipt.selection, "plan-only");
  assert.match(receipt.affectedTestsNotRunReason, /plan-only selection named no suite/);
  assert.match(output, /affected-tests: NOT RUN — the plan-only selection named no suite; lint-plan-fast is the check/);
  assert.deepEqual(receipt.steps.map((s: { name: string }) => s.name), ["census-precheck", "static-preflight", "lint-plan-fast"]);
});

test("W1-T7809: an unreadable plan-only listing is a named full run, never a narrower guess", () => {
  const selection = affected.planOnlySelectionOrFull([SHARD], () => { throw new Error("listing exploded"); });
  assert.equal(selection.fullRun, true);
  assert.deepEqual(selection.suites, []);
  assert.equal(selection.planOnly, undefined);
  assert.equal(selection.reasons.length, 1);
  assert.match(selection.reasons[0], /full run: the plan-only listing could not be read — listing exploded/);
  assert.deepEqual(selection.recentOnly.floor, []);
});

test("W1-T7809: diff-class --list-plan-only-suites prints nothing and exits 1 when the listing cannot be read", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-plan-only-fail-"));
  try {
    const list = join(dir, "changed.txt");
    writeFileSync(list, SHARD + "\n");
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/diff-class.mjs"), "--list-plan-only-suites",
      "--changed-files", list, "--plan-reading-root", join(dir, "does-not-exist")], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /diff-class: FAILED to enumerate the plan-only suite set/);
    assert.match(r.stderr, /printing NOTHING — a caller reading zero lines here must fail closed\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T7809: an over-capacity receipt never records the affected tests as passed", (t) => {
  const huge = 10 * 60 * 60 * 1000;
  // leaf is a changed test and cheap; other is reached by the floor and far over the budget.
  const f = fixture({ manifest: { "test/leaf.test.ts": 1_000, "test/other.test.ts": huge } });
  const select = () => ({ fullRun: false, suites: ["test/leaf.test.ts", "test/other.test.ts"], reasons: ["fixture"], recentOnly: { floor: [] } });
  const host = () => ({ cores: 8, load1: 0, headroomBytes: 8 * 1024 ** 3 });
  const { status } = run(t as never, f.root, { select, host });
  assert.equal(status, author.OVER_CAPACITY_EXIT);
  const receipt = f.receipt();
  assert.equal(receipt.selection, "over-capacity");
  assert.equal(receipt.verdict, "over-capacity");
  assert.notEqual(receipt.verdict, "passed");
  // Only the subset that fits ran, under its own name, and what was skipped is named.
  assert.deepEqual(receipt.tiered.ran, ["test/leaf.test.ts"]);
  assert.deepEqual(receipt.tiered.skipped, ["test/other.test.ts"]);
  const names = receipt.steps.map((s: { name: string }) => s.name);
  assert.ok(!names.includes("affected-tests"), "no step claims the selected affected tests passed");
  assert.ok(names.includes("affected-tests-subset"));

  // Nothing fits at all: no test step at all, and no green verdict.
  const none = fixture({ manifest: { "test/leaf.test.ts": huge, "test/other.test.ts": huge } });
  run(t as never, none.root, { select, host });
  const skipped = none.receipt();
  assert.equal(skipped.verdict, "over-capacity");
  assert.ok(skipped.affectedTestsNotRunReason);
  assert.ok(!skipped.steps.some((s: { name: string; ok: boolean }) => s.name.startsWith("affected-tests")));
  assert.ok(existsSync(join(none.root, "coverage/preflight-author.json")));
});
