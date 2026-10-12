/**
 * W1-T5699 — A DIFF THAT TOUCHES NO src/ FILE SKIPS INSTRUMENTED COVERAGE AND STILL RUNS THE FULL
 * SUITE.
 *
 * `classifyCoverage` (scripts/diff-class.mjs) knew PLAN_ONLY, DOCS_ONLY and TEST_ONLY; anything else
 * was SOURCE, so a deploy/, hooks/, learnings/ or scripts/ diff, or a test-plus-plan diff, paid the
 * eight instrumented coverage shards although diff coverage of src/ is empty by construction. It now
 * returns NO_SRC when no changed path is under src/ and none is coverage or toolchain config
 * (package*.json, tsconfig*, .nvmrc, ci.yml, ci-gate.yml, scripts/coverage-*, scripts/diff-coverage*).
 *
 * W1-T3207 made the instrumented run the PR's test verdict, so a NO_SRC skip hands the verdict back
 * to the uninstrumented tiers: ci-shard runs the FULL fast tier (its classify step writes "full" to
 * test-only-run.txt, which already defeats the W1-T3207 skip) and test-slow-shard runs the slow tier
 * (its `--coverage-class` classify already treats any non-SOURCE, non-plan class that way). It is the
 * full suite, never a readers-only lane: the readers of ci.yml or deploy/ scripts are far wider than
 * `censusSuiteFiles` admits. coverage-ratchet's clamp and its required aggregator's event:class
 * allowlist admit NO_SRC, and the selector shadow (`explicitlySkippedRun`) counts an eight-shard
 * NO_SRC skip as a skipped run rather than missing evidence. The rationale lives here, not in ci.yml,
 * which sits at its comment-load ceiling.
 *
 * Each workflow case drives the REAL step bodies from .github/workflows/ci.yml through bash, with a
 * stub `git` answering the diff and the REAL classifier, then a stubbed `node` recording what the
 * test step would run (the W1-T5697 / W1-T5700 harness pattern).
 *
 * FALSIFIER: drop the NO_SRC branch from `classifyCoverage` — the deploy-plus-learnings diff
 * classifies SOURCE, coverage-shard runs its instrumented shard, and the first test fails.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { selectorShadowReport } from "../src/lib/selector-shadow-gardener.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
// @ts-expect-error -- plain .mjs script, no type declarations
import { COVERAGE_CLASSES, classifyCoverage } from "../scripts/diff-class.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string };
type Job = { steps: Step[] };
const jobs = (parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;

const DEPLOY_AND_LEARNINGS = ["deploy/rmd-host-cleanup.sh", "learnings/ci.yaml"];
const TEST_AND_PLAN = ["test/fast-lane-classifier.test.ts", "plan/tasks.d/W1-T5699-a.yaml"];
const NO_SRC_DIFFS = [
  DEPLOY_AND_LEARNINGS,
  TEST_AND_PLAN,
  ["hooks/deny-floor.sh"],
  ["deploy/Dockerfile", "plan/tasks.d/W1-T5699-a.yaml"],
  ["scripts/diff-class.mjs", "test/helpers/push-safety.ts"],
];
const SOURCE_DIFFS = [
  ["src/lib/leaf.ts"],
  ["deploy/rmd-host-cleanup.sh", "src/lib/leaf.ts"],
  ["package-lock.json"],
  ["learnings/ci.yaml", "package-lock.json"],
  ["package.json"],
  ["tsconfig.json"],
  [".nvmrc"],
  [".github/workflows/ci.yml"],
  [".github/workflows/ci-gate.yml"],
  ["scripts/coverage-ratchet.mjs"],
  ["scripts/coverage-baseline.json"],
  ["scripts/diff-coverage.mjs"],
];

function step(job: string, pick: (s: Step) => boolean): Step {
  const found = jobs[job]?.steps.find(pick);
  assert.ok(found?.run !== undefined || found?.uses !== undefined, `${job}: expected step is missing`);
  return found!;
}

/** Evaluates the only `if:` shape test-slow-shard's install steps use. Anything else throws. */
function evalIf(expr: string | undefined, outputs: Record<string, Record<string, string>>): boolean {
  if (expr === undefined) return true;
  const inner = /^\$\{\{\s*(.*?)\s*\}\}$/.exec(expr.trim());
  assert.ok(inner, `unexpected if: ${expr}`);
  return inner[1]!.split("||").some((any) =>
    any.split("&&").every((atom) => {
      const m = /^steps\.([\w-]+)\.outputs\.([\w-]+) (==|!=) '([^']*)'$/.exec(atom.trim());
      assert.ok(m, `unexpected if atom: ${atom}`);
      const value = outputs[m[1]!]?.[m[2]!] ?? "";
      return m[3] === "==" ? value === m[4] : value !== m[4];
    }),
  );
}

/** One runner workspace shared by every step of one job, as Actions shares its checkout. `scripts`,
 *  `src` and `node_modules` are the repo's own; `git`, `npm` and `npx` are stubs (`git diff`
 *  answers `files`). A step run with `stubNode` sees a `node` that only records its arguments. */
function workspace(files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5699-`));
  for (const d of ["bin", "node-bin"]) mkdirSync(join(dir, d));
  for (const link of ["scripts", "src", "node_modules"]) symlinkSync(join(REPO_ROOT, link), join(dir, link));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "diff.txt"), files.map((f) => `${f}\n`).join(""));
  const stub = (path: string, script: string) => {
    writeFileSync(path, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(path, 0o755);
  };
  stub(join(dir, "bin", "git"), `case "$1" in fetch) exit 0 ;; diff) cat "${join(dir, "diff.txt")}" ;; *) exit 1 ;; esac`);
  stub(join(dir, "bin", "npm"), `echo "npm $*" >> "${log}"`);
  stub(join(dir, "bin", "npx"), `echo "npx $*" >> "${log}"`);
  stub(join(dir, "node-bin", "node"), `echo "node $*" >> "${log}"`);
  const run = (body: string, subs: Record<string, string> = {}, opts: { stubNode?: boolean; env?: Record<string, string> } = {}) => {
    let text = body;
    for (const [from, to] of Object.entries(subs)) text = text.replaceAll(from, to);
    writeFileSync(join(dir, "step.sh"), text);
    writeFileSync(join(dir, "outputs.txt"), "");
    writeFileSync(log, "");
    const path = [opts.stubNode ? join(dir, "node-bin") : "", join(dir, "bin"), dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(":");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: path,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_BASE_REF: "main",
        GITHUB_WORKSPACE: dir,
        GITHUB_OUTPUT: join(dir, "outputs.txt"),
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        RUNNER_TEMP: dir,
        RMD_AFFECTED_SUITE_LIVE: "0",
        ...opts.env,
      },
    });
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(join(dir, "outputs.txt"), "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return { status: r.status, outputs, stdout: r.stdout, all: `${r.stdout}${r.stderr}`, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };
  return { dir, run };
}

/** coverage-shard N/8 on a pull request: the real classify step, then the real "Test with coverage". */
function coverageShard(files: string[], shard: number) {
  const ws = workspace(files);
  const classify = ws.run(step("coverage-ratchet", (s) => s.id === "classify").run!);
  assert.equal(classify.status, 0, classify.all);
  const tested = ws.run(
    step("coverage-ratchet", (s) => (s.name ?? "").startsWith("Test with coverage")).run!,
    { "${{ steps.classify.outputs.class }}": classify.outputs.class ?? "", "${{ matrix.shard }}": String(shard) },
    { stubNode: true },
  );
  return { cls: classify.outputs.class, tested };
}

/** ci-shard N/8 on a pull request: admission, classify, then the Test step with `node` stubbed. */
function ciShard(files: string[], shard: number) {
  const ws = workspace(files);
  const admission = ws.run(step("ci", (s) => s.id === "admission").run!, { "${{ matrix.shard }}": String(shard) });
  assert.equal(admission.status, 0, admission.all);
  const classify = ws.run(step("ci", (s) => s.id === "classify").run!, {
    "${{ steps.admission.outputs.setup }}": admission.outputs.setup ?? "",
  });
  assert.equal(classify.status, 0, classify.all);
  const tested = ws.run(
    step("ci", (s) => s.name === "Test").run!,
    { "${{ steps.classify.outputs.class }}": classify.outputs.class ?? "", "${{ matrix.shard }}": String(shard) },
    { stubNode: true, env: { RENAME_ONLY: classify.outputs.rename_only ?? "false" } },
  );
  assert.equal(tested.status, 0, tested.all);
  return { setup: admission.outputs.setup, fullFast: tested.calls.includes(`scripts/test-tier-manifest.mjs --run fast --shard ${shard}/8`), tested };
}

/** test-slow-shard on a pull request: classify, its install guards, then what "Run the slow tier" does. */
function slowShard(files: string[]) {
  const ws = workspace(files);
  const plan = ws.run(step("test-slow-shard", (s) => s.id === "plan-reading").run!);
  assert.equal(plan.status, 0, plan.all);
  const outputs = { "plan-reading": plan.outputs };
  const guards = jobs["test-slow-shard"]!.steps.filter((s) => /\bnpm ci\b|playwright install chromium/.test(s.run ?? "") || (s.uses ?? "").startsWith("actions/cache@"));
  assert.equal(guards.length, 3, "test-slow-shard must still carry npm ci, the Chromium cache and its install");
  const installs = guards.map((s) => evalIf(s.if, outputs));
  const ran = ws.run(
    step("test-slow-shard", (s) => (s.name ?? "").startsWith("Run the slow tier")).run!,
    {
      "${{ matrix.shard }}": "1",
      "${{ steps.plan-reading.outputs.established }}": plan.outputs.established ?? "",
      "${{ steps.plan-reading.outputs.class }}": plan.outputs.class ?? "",
    },
    { stubNode: true },
  );
  assert.equal(ran.status, 0, ran.all);
  return { cls: plan.outputs.class, installs, slowRun: /npm run --silent test:slow -- --shard 1\/2 --base origin\/main/.test(ran.calls) };
}

test("W1-T5699: a deploy plus learnings diff and a test plus plan diff classify NO_SRC and skip the instrumented coverage shard", () => {
  assert.equal(COVERAGE_CLASSES.NO_SRC, "NO_SRC");
  for (const files of NO_SRC_DIFFS) {
    assert.equal(classifyCoverage(files).class, "NO_SRC", `${files}: ${classifyCoverage(files).reason}`);
  }
  for (const files of [DEPLOY_AND_LEARNINGS, TEST_AND_PLAN]) {
    const { cls, tested } = coverageShard(files, 3);
    assert.equal(cls, "NO_SRC", `${files}: coverage-ratchet's clamp must keep the NO_SRC token`);
    assert.equal(tested.status, 0, tested.all);
    assert.match(tested.stdout, /W1-T2428 fast-lane: class=NO_SRC — skipping Test with coverage/);
    assert.doesNotMatch(tested.calls, /test-tier-manifest|experimental-test-coverage/, `${files}: no instrumented shard may run`);
  }
});

test("W1-T5699: ci.yml runs the full fast tier on every ci-shard and the slow tier on test-slow-shard for a NO_SRC diff", () => {
  for (const files of [DEPLOY_AND_LEARNINGS, TEST_AND_PLAN]) {
    for (const shard of [1, 2]) {
      const r = ciShard(files, shard);
      assert.equal(r.setup, "true", `${files} shard ${shard}: an idle-shard admission would skip the verdict`);
      assert.ok(r.fullFast, `${files} shard ${shard}: the full fast tier must run, got ${r.tested.calls}${r.tested.stdout}`);
      assert.doesNotMatch(r.tested.stdout, /W1-T3207: coverage-ratchet owns/);
    }
    const slow = slowShard(files);
    assert.equal(slow.cls, "NO_SRC", `${files}`);
    assert.deepEqual([...slow.installs, slow.slowRun], [true, true, true, true], `${files}: install and run the slow tier`);
  }
});

test("W1-T5699: a diff with any src/ path or package-lock.json stays SOURCE, and coverage keeps the test verdict", () => {
  for (const files of SOURCE_DIFFS) {
    assert.equal(classifyCoverage(files).class, "SOURCE", `${files}: ${classifyCoverage(files).reason}`);
  }
  assert.equal(classifyCoverage([]).class, "SOURCE", "an empty list still fails closed");
  assert.equal(classifyCoverage(["test/leaf.test.ts"]).class, "TEST_ONLY", "an all-test diff keeps its narrower class");
  assert.equal(classifyCoverage(["plan/tasks.d/W1-T5699-a.yaml"]).class, "PLAN_ONLY");
  for (const files of [["deploy/rmd-host-cleanup.sh", "src/lib/leaf.ts"], ["learnings/ci.yaml", "package-lock.json"]]) {
    assert.equal(coverageShard(files, 1).cls, "SOURCE", `${files}`);
    const r = ciShard(files, 1);
    assert.equal(r.fullFast, false, `${files}: coverage-ratchet owns the one full-suite run`);
    assert.match(r.tested.stdout, /W1-T3207: coverage-ratchet owns/);
    const slow = slowShard(files);
    assert.deepEqual([slow.cls, slow.slowRun], ["SOURCE", false], `${files}`);
  }
});

test("W1-T5699: a NO_SRC skip log counts as a skipped shadow run and the required coverage aggregator accepts it", () => {
  const lines = [];
  for (let shard = 1; shard <= 8; shard += 1) {
    const { tested } = coverageShard(DEPLOY_AND_LEARNINGS, shard);
    const skip = tested.stdout.split("\n").find((l) => l.includes("skipping Test with coverage"));
    assert.ok(skip, tested.all);
    lines.push(`coverage-shard (${shard}/8)\t${skip}`);
  }
  const report = selectorShadowReport([{ id: 5699, headSha: "no-src", log: lines.join("\n") }], 100);
  assert.deepEqual([report.runsSkipped, report.runsIncomplete], [1, 0], "an eight-shard NO_SRC skip is not missing source evidence");
  const partial = selectorShadowReport([{ id: 5700, headSha: "partial", log: lines.slice(0, 7).join("\n") }], 100);
  assert.deepEqual([partial.runsSkipped, partial.runsIncomplete], [0, 1], "seven skips cannot hide a missing coverage shard");

  for (const event of ["pull_request", "merge_group"]) {
    const ws = workspace(DEPLOY_AND_LEARNINGS);
    for (let shard = 1; shard <= 8; shard += 1) {
      mkdirSync(join(ws.dir, "coverage-shards", `coverage-shard-${shard}`), { recursive: true });
      writeFileSync(join(ws.dir, "coverage-shards", `coverage-shard-${shard}`, "class"), `${event}:NO_SRC\n`);
    }
    const r = ws.run(step("coverage-ratchet-required", (s) => s.id === "coverage-artifact").run!);
    assert.equal(r.status, 0, `${event}: ${r.all}`);
    assert.deepEqual(r.outputs, { event, class: "NO_SRC" });
  }
});
