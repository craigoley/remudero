/**
 * THE AUTHOR PREFLIGHT IS ADVISORY, AND ITS STATIC STEP RUNS ONLY CHECKS CI DOES NOT RUN — W1-T12511.
 *
 * MEASURED 2026-11-18 over 81 Mac author runs: the census suites (95 suites, run twice) cost about 8 minutes of a
 * code ship and rule-checks 85-91% of the static stage's ~5.2 minutes, and neither caught a defect of the change.
 * The one real catch (W1-T12842, fixture-copy ledgerHelperNames 53 > 51) came from the census COUNTS in 10.5 s.
 *
 * So each fast-gate step names the ci.yml job that runs the same check on every pull request (`ciJob`) and the
 * required check-run name it reports under (`ciCheck`). The author static step runs only the steps with no such
 * job, the author census step runs counts only, and the receipt lists what it left to CI and where. A `ciJob` this
 * file cannot confirm in ci.yml (no such job, a job-level `if:` that can skip a pull request, a check ci-gate does
 * not require) leaves the step ON the author path, and an unconfirmed census row keeps the full census pass.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse as parseYaml } from "yaml";

import * as parity from "#src/lib/ci-parity.js";
import { hostWorktreeGit } from "#src/lib/worktree-git.js";
// @ts-ignore the executable .mjs module has no declaration file.
import * as census from "#scripts/census-precheck.mjs";
// @ts-ignore the executable .mjs module has no declaration file.
import * as author from "#scripts/preflight-author.mjs";
// @ts-ignore the executable .mjs module has no declaration file.
import { countFixtureCopiesInTexts, listFixtureCopyFiles } from "#scripts/fixture-copy-census.mjs";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Row = { job: string; ciJob: string; ciCheck: string };
type Split = { staticSteps: parity.FastGateStep[]; leftToCi: Row[]; censusCountsOnly: boolean; kept: { job: string; reason: string }[] };
type Contract = { jobs: Record<string, unknown>; required: string[]; unreadable?: string };
type Tree = Record<string, string>;
type Call = { file: string; args: string[]; env: Record<string, string | undefined> };

const GiB = 1024 ** 3;
const HEAD = hostWorktreeGit(REPO_ROOT, ["rev-parse", "HEAD"]).trim();
const CI_YML = ".github/workflows/ci.yml";
const CI_GATE_YML = ".github/workflows/ci-gate.yml";

/** What ci.yml runs on every pull request, read for each step by hand on 2026-11-18 (never set on a guess):
 *  W1-T4399 moved these gates into the `commitlint` job (named light-gates) as steps whose `id:` is the
 *  check-run name ci-gate.yml requires; their old job keys are `if: false` stubs. The seven census entries are
 *  rule suites, which that job's `rule-checks` step runs. */
const LIGHT = (ciCheck: string): [string, string] => ["commitlint", ciCheck];
const EXPECTED_LEFT: Record<string, [string, string]> = {
  "rule-checks": LIGHT("rule-checks"),
  claims: LIGHT("claims"),
  "learnings-budget-ratchet": LIGHT("learnings-budget-ratchet"),
  jscpd: LIGHT("jscpd-gate"),
  "comment-load-ratchet": LIGHT("comment-load-ratchet"),
  depcruise: LIGHT("depcruise"),
  "api-client-drift": LIGHT("api-client-drift"),
  "no-hand-rolled-fetch": LIGHT("no-hand-rolled-fetch"),
  "source-size": LIGHT("source-size"),
  "lint-plan": LIGHT("lint-plan"),
  ...Object.fromEntries(parity.CENSUS_ADMITTED_MEMBERS.map((m) => [m.job, LIGHT("rule-checks")])),
};
/** No ci.yml job runs these: cli-reference and self-path-proof have no step of their own, worker-branch-shape
 *  and census-precheck have no job under .github/workflows/ at all. */
const EXPECTED_KEPT = ["cli-reference", "self-path-proof", "worker-branch-shape", "census-precheck"];

function hasSplit(): void {
  assert.equal(typeof (parity as Record<string, unknown>).authorCiSplit, "function", "ci-parity exports authorCiSplit (W1-T12511)");
  assert.equal(typeof (parity as Record<string, unknown>).readAuthorCiContract, "function", "ci-parity exports readAuthorCiContract (W1-T12511)");
}
const contractOf = (root: string): Contract =>
  ((parity as Record<string, unknown>).readAuthorCiContract as (root: string) => Contract)(root);
const splitOf = (contract: Contract, steps?: readonly parity.FastGateStep[], rows?: readonly Row[]): Split =>
  ((parity as Record<string, unknown>).authorCiSplit as (c: Contract, s?: readonly parity.FastGateStep[], r?: readonly Row[]) => Split)(contract, steps, rows);
const ciOf = (step: parity.FastGateStep) => step as parity.FastGateStep & { ciJob?: string; ciCheck?: string };

function withAnswer<T>(value: string | undefined, fn: () => T): T {
  const before = process.env[parity.AUTHOR_CENSUS_ANSWERED_ENV];
  if (value === undefined) delete process.env[parity.AUTHOR_CENSUS_ANSWERED_ENV];
  else process.env[parity.AUTHOR_CENSUS_ANSWERED_ENV] = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[parity.AUTHOR_CENSUS_ANSWERED_ENV];
    else process.env[parity.AUTHOR_CENSUS_ANSWERED_ENV] = before;
  }
}

/** Every spawn the fast gate asks for, each answered as a pass with no output. */
function recordingSpawn() {
  const calls: { file: string; args: string[] }[] = [];
  const spawn = (file: string, args: string[]) => {
    calls.push({ file, args: [...args] });
    return { status: 0, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

/** A git tree whose `work` branch writes `change` over `seed` committed on main. */
function changedTree(t: TestContext, seed: Tree, change: Tree, copied: string[] = []): string {
  const tree = gitRepo({ kind: "w1-t12511-census", scope: t });
  // Repository files the fixture needs byte for byte (census-precheck parses them); copied, never asserted on.
  for (const path of copied) {
    mkdirSync(dirname(join(tree.dir, path)), { recursive: true });
    copyFileSync(join(REPO_ROOT, path), join(tree.dir, path));
  }
  const write = (files: Tree) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(tree.dir, path)), { recursive: true });
      writeFileSync(join(tree.dir, path), text);
    }
  };
  write(seed);
  tree.git("add", "-A");
  tree.git("commit", "--quiet", "-m", "the base");
  tree.git("switch", "--quiet", "-c", "work");
  write(change);
  tree.git("add", "-A");
  tree.git("commit", "--quiet", "-m", "the change");
  return tree.dir;
}

/** census-precheck's main() with the author's own flags over `root`, every expensive seam counting its calls. */
function authorCensus(t: TestContext, root: string, flags?: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const log = t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
  const error = t.mock.method(console, "error", (...a: unknown[]) => void err.push(a.join(" ")));
  const seams = { admitted: 0, measured: 0, suites: 0 };
  let status: number;
  try {
    const args = flags ?? (author.authorCensusPrecheckArgs(root, "main") as string[]).slice(1);
    status = census.main([...args, "--root", root], {
      admitted: () => { seams.admitted++; return []; },
      measure: () => { seams.measured++; throw new Error("the instrument-surface child must not start"); },
      runSuites: () => { seams.suites++; return []; },
    }) as number;
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
  return { status, out, err, seams };
}

/** An author tree preflight-author's main() can run over with every child scripted (no git, no suite runs). */
function authorRoot(t: TestContext, { contract }: { contract: boolean }): string {
  const root = ownedFixtureDir(t, "w1-t12511-author").dir;
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, ".nvmrc"), `${process.versions.node}\n`);
  writeFileSync(join(root, "test/leaf.test.ts"), "import { test } from 'node:test'; test('leaf', () => {});\n");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  copyFileSync(join(REPO_ROOT, "package-lock.json"), join(root, "package-lock.json"));
  if (contract) {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    for (const file of [CI_YML, CI_GATE_YML]) copyFileSync(join(REPO_ROOT, file), join(root, file));
  }
  return root;
}

const AUTHOR_HEAD = "a".repeat(40);
const AUTHOR_BASE = "b".repeat(40);
/** Git's answers for a clean tree one commit ahead of its base; the census child answers `censusResult`; every other child passes. */
function scriptedAuthor(calls: Call[], censusResult: { status: number; stdout?: string; stderr?: string }) {
  return (file: string, args: string[], opts: { env?: Record<string, string | undefined> } = {}) => {
    calls.push({ file, args: [...args], env: { ...(opts.env ?? {}) } });
    const ok = (stdout = "") => ({ status: 0, signal: null, stdout, stderr: "" });
    if (file !== "git") {
      if (args.some((a) => a.endsWith("census-precheck.mjs"))) {
        return { status: censusResult.status, signal: null, stdout: censusResult.stdout ?? "", stderr: censusResult.stderr ?? "" };
      }
      return ok();
    }
    const call = args.join(" ");
    if (call === "rev-parse --is-inside-work-tree") return ok("true\n");
    if (call.startsWith("config --local")) return { status: 1, signal: null, stdout: "", stderr: "" };
    if (call === "rev-parse HEAD") return ok(`${AUTHOR_HEAD}\n`);
    if (call === "rev-parse origin/main") return ok(`${AUTHOR_BASE}\n`);
    if (call === "rev-parse --is-shallow-repository") return ok("false\n");
    if (call.startsWith("diff --name-only")) return ok("src/leaf.ts\0");
    return ok();
  };
}

/** preflight-author's main() over `root`; the suite slot is never granted, so a run that gets past static ends there. */
function runAuthor(t: TestContext, root: string, censusResult: { status: number; stdout?: string; stderr?: string }) {
  const calls: Call[] = [];
  const out: string[] = [];
  const log = t.mock.method(console, "log", (...a: unknown[]) => void out.push(a.join(" ")));
  const error = t.mock.method(console, "error", (...a: unknown[]) => void out.push(a.join(" ")));
  let exit: number;
  try {
    exit = author.main([], {
      root, spawn: scriptedAuthor(calls, censusResult),
      select: () => ({ fullRun: false, suites: ["test/leaf.test.ts"], reasons: ["fixture"] }),
      host: () => ({ cores: 8, load1: 0, headroomBytes: 8 * GiB }),
      testSlot: { dir: ownedFixtureDir(t, "w1-t12511-slots").dir, memoryHeadroom: () => 64 * GiB, log: () => {} },
      enqueueTestSlot: () => ({ ticketed: true, position: 1, note: "fixture ticket", setPrice() {}, cancel() {},
        admit: () => ({ refresh() {}, release() {}, outcome: "wait_bound_exceeded", concurrency: 1, executionAllowed: false,
          waitedMs: 0, note: "NOT_RUN: the fixture grants no suite slot" }) }),
      verdictLedger: { ledger: () => ({ reason: "the fixture keeps no ledger" }) },
    }) as number;
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
  const receipt = JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8"));
  const censusCall = calls.find((c) => c.args.some((a) => a.endsWith("census-precheck.mjs")));
  const staticCall = calls.find((c) => c.args.some((a) => a.endsWith("src/run-task.ts")) && c.args.includes("preflight"));
  return { exit, out, receipt, censusCall, staticCall };
}

test("W1-T12511 criterion 1: each fast-gate step names the ci.yml job that runs it on every PR, the author static step runs only the steps with none, and the receipt lists the rest as left to CI", (t) => {
  for (const step of parity.FAST_GATE_STEPS) {
    const expected = EXPECTED_LEFT[step.job];
    assert.deepEqual([ciOf(step).ciJob, ciOf(step).ciCheck], expected ?? [undefined, undefined],
      `${step.job}: ${expected ? `runs in ci.yml job ${expected[0]} as ${expected[1]}` : "no ci.yml job runs it, so it names none"}`);
  }
  assert.deepEqual(parity.FAST_GATE_STEPS.filter((s) => !EXPECTED_LEFT[s.job]).map((s) => s.job), EXPECTED_KEPT);

  hasSplit();
  const split = splitOf(contractOf(REPO_ROOT));
  assert.deepEqual(split.kept, [], "every ciJob is confirmed in this tree's ci.yml");
  assert.deepEqual(split.staticSteps.map((s) => s.job), EXPECTED_KEPT, "the author static step keeps exactly the steps no CI job runs");
  const staticLeft = split.leftToCi.filter((row) => !row.job.startsWith("census-precheck:"));
  assert.deepEqual(staticLeft, parity.FAST_GATE_STEPS.filter((s) => EXPECTED_LEFT[s.job])
    .map((s) => ({ job: s.job, ciJob: EXPECTED_LEFT[s.job]![0], ciCheck: EXPECTED_LEFT[s.job]![1] })));

  // The static stage is marked by the author's census answer for this head (W1-T11101): under it the fast gate
  // runs only the kept steps; without it (run-task, the pre-open gate) every step runs as before.
  const marked = recordingSpawn();
  const authorRun = withAnswer(`${HEAD}:ok`, () => parity.runPreflightFast(REPO_ROOT, { spawn: marked.spawn as never }));
  assert.deepEqual(authorRun.steps.map((s) => s.name), EXPECTED_KEPT);
  assert.ok(!marked.calls.some((c) => c.args.some((a) => a.endsWith("list-rule-suites.mjs"))), "rule-checks did not start");
  assert.ok(!marked.calls.some((c) => c.args.includes("jscpd") || c.args.some((a) => a.startsWith("census:bound"))), "no left-to-CI script started");
  const unmarked = recordingSpawn();
  const fullRun = withAnswer(undefined, () => parity.runPreflightFast(REPO_ROOT, { spawn: unmarked.spawn as never }));
  assert.deepEqual(fullRun.steps.map((s) => s.name), parity.FAST_GATE_STEPS.map((s) => s.job), "control: the unmarked gate runs every step");
  const otherHead = withAnswer(`${"f".repeat(40)}:ok`, () => parity.runPreflightFast(REPO_ROOT, { spawn: recordingSpawn().spawn as never }));
  assert.equal(otherHead.steps.length, parity.FAST_GATE_STEPS.length, "an answer for another head marks nothing");

  // The author run records the list on its receipt, and its static child carries the mark.
  const run = runAuthor(t, authorRoot(t, { contract: true }), { status: 0, stdout: "census-precheck: counts OK" });
  assert.deepEqual(run.receipt.leftToCi.filter((row: Row) => !row.job.startsWith("census-precheck:")), staticLeft, run.out.join("\n"));
  assert.ok(run.staticCall, `the static step started: ${run.out.join("\n")}`);
  assert.equal(run.staticCall!.env[parity.AUTHOR_CENSUS_ANSWERED_ENV], `${AUTHOR_HEAD}:ok`);
  assert.ok(run.out.some((l) => l.startsWith("left to CI: ") && l.includes("jscpd (commitlint as jscpd-gate)")), run.out.join("\n"));
});

test("W1-T12511 criterion 2: the author keeps worker-branch-shape and the census counts, and leaves the census suites and the instrument-surface child to the required ci.yml jobs it names", (t) => {
  hasSplit();
  const split = splitOf(contractOf(REPO_ROOT));
  for (const job of ["worker-branch-shape", "census-precheck"]) assert.ok(split.staticSteps.some((s) => s.job === job), `${job} stays`);
  assert.equal(split.censusCountsOnly, true);
  assert.deepEqual(split.leftToCi.filter((row) => row.job.startsWith("census-precheck:")), [
    { job: "census-precheck:census-suites", ciJob: "commitlint", ciCheck: "rule-checks" },
    { job: "census-precheck:census-suites", ciJob: "ci", ciCheck: "ci" },
    { job: "census-precheck:census-suites", ciJob: "coverage-ratchet", ciCheck: "coverage-ratchet" },
    { job: "census-precheck:instrument-surface", ciJob: "ci", ciCheck: "ci" },
    { job: "census-precheck:instrument-surface", ciJob: "coverage-ratchet", ciCheck: "coverage-ratchet" },
  ]);
  // The filer's flag: instrument-surface is not a rule suite, so only the ci and coverage shards run it.
  const instrument = "test/instrument-surface-completeness.test.ts";
  assert.ok(!parity.listRuleSuites(REPO_ROOT).includes(instrument), "not in the rule-checks population");
  assert.ok(hostWorktreeGit(REPO_ROOT, ["ls-files", "--", instrument]).trim() === instrument, "a tracked suite the shards' test/**/*.test.ts selection covers");

  // Under the author mark the fast gate spawns worker-branch-shape and takes census-precheck's answer.
  const rec = recordingSpawn();
  const fast = withAnswer(`${HEAD}:ok`, () => parity.runPreflightFast(REPO_ROOT, { spawn: rec.spawn as never }));
  assert.ok(rec.calls.some((c) => c.args.includes("worker-branch-shape:check")), "worker-branch-shape ran");
  assert.match(fast.steps.find((s) => s.name === "census-precheck")!.detail, /answered by the author preflight's census-precheck step/);

  // counts-only still asks both parity rows: a new ci.yml script gate and a new CI census nothing asks.
  const rules = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`test/rules/r${i + 1}.test.ts`, "export {};\n"]));
  const minimalCi = "on: pull_request\njobs:\n  light:\n    runs-on: ubuntu-26.04\n    steps:\n      - run: echo light\n";
  const root = changedTree(t, {
    ...rules,
    "scripts/census-precheck-parity-baseline.json": JSON.stringify({ ciOnly: Object.keys(rules), ciOnlyScripts: {} }),
    // W1-T14250: the script census follows each npm script to its file, so the tree carries package.json.
    "package.json": JSON.stringify({ scripts: { "widget-ratchet": "node scripts/widget-ratchet.mjs" } }),
    [CI_YML]: minimalCi,
  }, {
    "test/rules/r21.test.ts": "export {};\n",
    [CI_YML]: `${minimalCi}      - id: widget-ratchet\n        run: npm run --silent widget-ratchet\n`,
  }, ["src/lib/rule-suites.ts", "scripts/census-precheck.mjs"]);
  const counted = authorCensus(t, root);
  assert.equal(counted.status, 1, counted.err.join("\n"));
  assert.ok(counted.err.some((l) => l.includes("script-ratchet: script:widget-ratchet runs in .github/workflows/ci.yml")), counted.err.join("\n"));
  assert.ok(counted.err.some((l) => l.includes("census-parity: test/rules/r21.test.ts is a CI census nothing asks")), counted.err.join("\n"));
  assert.deepEqual(counted.seams, { admitted: 0, measured: 0, suites: 0 });

  // A census row no confirmed job carries keeps the full census pass on the author path, and so does an unread contract.
  const contract = contractOf(REPO_ROOT);
  const jobs = { ...contract.jobs, ci: { ...(contract.jobs.ci as object), if: "github.event_name == 'push'" } };
  const unconfirmed = splitOf({ ...contract, jobs });
  assert.equal(unconfirmed.censusCountsOnly, false);
  assert.ok(unconfirmed.kept.some((k) => k.job === "census-precheck:census-suites" && /job-level if: that can skip it/.test(k.reason)), JSON.stringify(unconfirmed.kept));
  assert.ok(!unconfirmed.leftToCi.some((row) => row.job.startsWith("census-precheck:")), "nothing of the census is left to CI");
  assert.deepEqual(author.authorCensusPrecheckArgs("/r", "abc", false).slice(1), ["--base", "abc", "--skip-when-unread"]);
  const bare = runAuthor(t, authorRoot(t, { contract: false }), { status: 0 });
  assert.ok(bare.censusCall?.args.includes("--skip-when-unread"), `no readable ci.yml: the full census stays (${bare.out.join("\n")})`);
  assert.deepEqual(bare.receipt.leftToCi, [], "no readable ci.yml: nothing is left to CI");
  assert.ok(bare.receipt.authorPathKept.length >= Object.keys(EXPECTED_LEFT).length, "each unconfirmed step is named with its reason");
});

test("W1-T12511 criterion 3: a ciJob naming no job, or a job whose job-level if: can skip a pull request, is refused and its step stays on the author path", () => {
  const runsOnPr = (parity as Record<string, unknown>).jobIfRunsOnPullRequest as (c: unknown) => boolean;
  assert.equal(typeof runsOnPr, "function");
  for (const condition of [undefined, true, "${{ always() && !cancelled() }}", "${{ always() }}",
    "github.event_name == 'pull_request' || github.event_name == 'merge_group'", "!(github.event_name != 'pull_request')", "success()"]) {
    assert.equal(runsOnPr(condition), true, `runs on every PR: ${String(condition)}`);
  }
  for (const condition of [false, "false", "${{ false }}", "github.event_name == 'push'", "github.event_name != 'pull_request'",
    "always() && github.repository == 'x'", "cancelled()", "failure() || false", "always() &&", "(always()", "'pull_request'", 7]) {
    assert.equal(runsOnPr(condition), false, `can skip a PR (or is unreadable): ${String(condition)}`);
  }
  hasSplit();

  const contract = contractOf(REPO_ROOT);
  const ciDoc = parseYaml(readFileSync(join(REPO_ROOT, CI_YML), "utf8")) as { jobs: Record<string, { if?: unknown }> };
  // Every job any ciJob names exists and no job-level if: can skip it on a pull request; the old per-gate keys are if: false.
  for (const step of parity.FAST_GATE_STEPS.filter((s) => ciOf(s).ciJob !== undefined)) {
    const job = ciDoc.jobs[ciOf(step).ciJob!];
    assert.ok(job, `${step.job}: ci.yml has no job ${ciOf(step).ciJob}`);
    assert.equal(runsOnPr(job!.if), true, `${step.job}: ${ciOf(step).ciJob}'s job-level if: ${String(job!.if)} can skip a pull request`);
  }
  for (const row of splitOf(contract).leftToCi) {
    assert.ok(ciDoc.jobs[row.ciJob], `${row.job}: ci.yml has job ${row.ciJob}`);
    assert.equal(runsOnPr(ciDoc.jobs[row.ciJob]!.if), true, `${row.job}: ${row.ciJob}'s job-level if: ${String(ciDoc.jobs[row.ciJob]!.if)}`);
    assert.ok(contract.required.includes(row.ciCheck), `${row.ciCheck} is required by ci-gate.yml`);
  }
  assert.equal(ciDoc.jobs["jscpd-gate"]?.if, false, "the record's jscpd-gate is an if: false stub since W1-T4399");

  const jscpd = parity.FAST_GATE_STEPS.find((s) => s.job === "jscpd")!;
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["a stub job", { ...jscpd, ciJob: "jscpd-gate", ciCheck: "jscpd-gate" }, /job-level if: that can skip it on a pull request/],
    ["no such job", { ...jscpd, ciJob: "no-such-job", ciCheck: "jscpd-gate" }, /ci\.yml has no job no-such-job/],
    ["an unrequired check", { ...jscpd, ciJob: "commitlint", ciCheck: "leak-grep-not" }, /not a required check/],
    ["a check the job does not post", { ...jscpd, ciJob: "commitlint", ciCheck: "test-slow" }, /reports no check named test-slow/],
    ["no check named", { ...jscpd, ciJob: "commitlint", ciCheck: undefined }, /names no ciCheck/],
  ];
  for (const [name, step, reason] of cases) {
    const split = splitOf(contract, [step as unknown as parity.FastGateStep], []);
    assert.deepEqual(split.staticSteps.map((s) => s.job), ["jscpd"], `${name}: the step stays on the author path`);
    assert.deepEqual(split.leftToCi, [], name);
    assert.match(split.kept[0]?.reason ?? "", reason, name);
  }
  const unread = contractOf(join(REPO_ROOT, "no-such-directory"));
  assert.ok(unread.unreadable, "a missing ci.yml is named unreadable");
  assert.deepEqual(splitOf(unread).staticSteps.map((s) => s.job), parity.FAST_GATE_STEPS.map((s) => s.job), "an unread contract keeps every step");
});

test("W1-T12511 criterion 4: the doctrine and the operator guide say the author preflight is advisory and name the gate", () => {
  for (const path of ["doctrine/before-you-push/preflight-before-first-push.md", "docs/operator-guide.md"]) {
    const text = readFileSync(join(REPO_ROOT, path), "utf8").replace(/\s+/g, " ");
    assert.match(text, /the author preflight is advisory/i, path);
    for (const check of ["remudero-review", "ci-gate", "security-merge-policy", "merge-time ratchet verdict"]) assert.ok(text.includes(check), `${path} names ${check}`);
  }
});

test("W1-T12511 criterion 5: a static check leaves the author path only when a ci.yml job that runs on every pull request runs it", () => {
  hasSplit();
  const split = splitOf(contractOf(REPO_ROOT));
  const left = new Set(split.leftToCi.map((row) => row.job));
  const ruleSuites = new Set(parity.listRuleSuites(REPO_ROOT));
  const ciDoc = parseYaml(readFileSync(join(REPO_ROOT, CI_YML), "utf8")) as { jobs: Record<string, { steps?: { id?: string }[] }> };
  for (const step of parity.FAST_GATE_STEPS) {
    const leaves = !split.staticSteps.includes(step);
    assert.equal(leaves, left.has(step.job), `${step.job}: leaving the static step and being listed left to CI are one fact`);
    if (!leaves) continue;
    const { ciJob, ciCheck } = ciOf(step);
    assert.ok(ciJob && ciCheck, `${step.job} left with a named job`);
    // The job really runs it: a step posting that required name, and for a census entry, a rule suite rule-checks runs.
    assert.ok(ciDoc.jobs[ciJob]!.steps?.some((s) => s.id === ciCheck), `${step.job}: ${ciJob} has the step ${ciCheck}`);
    const member = parity.CENSUS_ADMITTED_MEMBERS.find((m) => m.job === step.job);
    if (member) assert.ok(ruleSuites.has(member.testFile), `${member.testFile} is in the rule-checks population`);
  }
  // Every suite the full census pass could run is run by a job the census rows name: the rule-checks step, or the shards.
  const tracked = new Set(hostWorktreeGit(REPO_ROOT, ["ls-files", "--", "test"]).split("\n").filter(Boolean));
  const fullPass = new Set([...Object.keys(census.PRECHECK_PARITY), ...census.PRECHECK_TRIGGERED_SUITES.map((m: { testFile: string }) => m.testFile),
    ...census.PRECHECK_PATH_TRIGGERED_SUITES.map((m: { testFile: string }) => m.testFile)]);
  assert.ok(fullPass.size >= 60, `the full pass names ${fullPass.size} suites`);
  for (const suite of fullPass) {
    assert.ok(ruleSuites.has(suite) || (tracked.has(suite) && /^test\/.+\.test\.ts$/.test(suite)), `${suite}: run by rule-checks or the ci/coverage shards`);
  }
  assert.match(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts["test:ci"], /"test\/\*\*\/\*\.test\.ts"/);
});

test("W1-T12511 criterion 6: authorCensusPrecheckArgs passes --counts-only, so the census step prints the counts verdict and starts no suite child, and rule-checks leaves the static step", (t) => {
  assert.deepEqual(author.authorCensusPrecheckArgs("/r", "abc").slice(1), ["--base", "abc", "--counts-only"]);
  // A diff the full pass would measure (scripts/ is in the instrument-surface scope): counts only, nothing started.
  const root = changedTree(t, { "scripts/x.mjs": "export const x = 1;\n" }, { "scripts/x.mjs": "export const x = 2;\n" });
  const counted = authorCensus(t, root);
  assert.equal(counted.status, 0, counted.err.join("\n"));
  assert.ok(counted.out.some((l) => /^census-precheck: counts OK — 1 changed file\(s\) checked against main; census suites not run \(--counts-only\)$/.test(l)), counted.out.join("\n"));
  assert.deepEqual(counted.seams, { admitted: 0, measured: 0, suites: 0 }, "no census suite, member listing or instrument child started");
  const gated = authorCensus(t, root, ["--base", "main", "--skip-when-unread"]);
  assert.ok(gated.seams.measured > 0 || gated.seams.suites > 0, "control: the old author flag measures this diff");

  const rules = parity.FAST_GATE_STEPS.find((s) => s.runner === "rule-checks")!;
  assert.deepEqual([ciOf(rules).ciJob, ciOf(rules).ciCheck], ["commitlint", "rule-checks"]);
  hasSplit();
  assert.ok(!splitOf(contractOf(REPO_ROOT)).staticSteps.includes(rules), "the author static step no longer runs rule-checks");
  const run = runAuthor(t, authorRoot(t, { contract: true }), { status: 0, stdout: "census-precheck: counts OK" });
  assert.ok(run.censusCall?.args.includes("--counts-only") && !run.censusCall.args.includes("--skip-when-unread"), run.out.join("\n"));
});

test("W1-T12511 criterion 7: replaying the W1-T12842 fixture-copy growth (ledgerHelperNames 53 > 51) refuses at the counts step, before any census suite or the static step", (t) => {
  // The real population: every test file that declares a ledger helper, and the real baseline (51).
  const texts: [string, string][] = (listFixtureCopyFiles(REPO_ROOT) as string[]).map((name) => [name, readFileSync(join(REPO_ROOT, "test", name), "utf8")]);
  const bearing = texts.filter((entry) => countFixtureCopiesInTexts([entry]).ledgerHelperNames > 0);
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/fixture-copy-baseline.json"), "utf8"));
  const base = countFixtureCopiesInTexts(bearing).ledgerHelperNames;
  assert.equal(baseline.ledgerHelperNames, 51);
  assert.equal(base, 51, "main sits at the ceiling, as it did when W1-T12842 crossed it");
  // W1-T12842's shape: a new test carrying two hand-built ledger helpers. The names are joined here so this file declares none.
  const L = "Ledger";
  const growth = [`import { test } from "node:test";`, `function seedOwn${L}Rows(dir: string) { return dir; }`,
    `const writeOwn${L} = (dir: string) => dir;`, `test("two hand-built helpers", () => { seedOwn${L}Rows("a"); writeOwn${L}("b"); });`, ""].join("\n");
  assert.equal(countFixtureCopiesInTexts([...bearing, ["w1-t12842-replay.test.ts", growth]]).ledgerHelperNames, 53);
  const root = changedTree(t, {
    "scripts/fixture-copy-baseline.json": JSON.stringify(baseline),
    ...Object.fromEntries(bearing.map(([name, text]) => [`test/${name}`, text])),
  }, { "test/w1-t12842-replay.test.ts": growth });

  const counted = authorCensus(t, root);
  const row = /^ {2}fixture-copy: ledgerHelperNames 53 > baseline 51 — build the fixture with test\/helpers\//;
  assert.equal(counted.status, 1, counted.err.join("\n"));
  assert.ok(counted.err.some((l) => row.test(l)), counted.err.join("\n"));
  assert.deepEqual(counted.seams, { admitted: 0, measured: 0, suites: 0 }, "refused at the counts step: no census suite started");
  // The full precheck refuses the same growth with the same row: counts-only drops no count.
  const full = authorCensus(t, root, ["--base", "main"]);
  assert.equal(full.status, 1);
  assert.deepEqual(full.err.filter((l) => l.startsWith("  ")), counted.err.filter((l) => l.startsWith("  ")));

  // The author run: that refusal stops it before the static step starts.
  const refused = runAuthor(t, authorRoot(t, { contract: true }), { status: 1, stderr: counted.err.join("\n") });
  assert.equal(refused.exit, 1);
  assert.ok(refused.censusCall?.args.includes("--counts-only"), refused.out.join("\n"));
  assert.equal(refused.staticCall, undefined, "the static step never started");
  assert.equal(refused.receipt.steps.find((s: { name: string }) => s.name === "census-precheck")?.ok, false);
  assert.ok(!refused.receipt.steps.some((s: { name: string }) => s.name === "static-preflight"), "no static step on the receipt");
});
