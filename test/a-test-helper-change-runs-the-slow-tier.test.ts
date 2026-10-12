/**
 * W1-T5700 — A TEST-HELPER CHANGE RUNS THE SLOW TIER BEFORE IT MERGES.
 *
 * A diff touching only test/helpers/** or test/setup/** is TEST_ONLY to the coverage lane
 * (`classifyCoverage`), so coverage-ratchet skips it; `testOnlyRun` answers "full", so ci-shard runs
 * `--run fast` only. test-slow-shard classified it with the BASE `classify`, got SOURCE, and skipped
 * with its W1-T3207 "coverage-ratchet owns…" line — but coverage-ratchet had skipped too. So the
 * slow tier (the test-tier manifest's files at or over `thresholdMs`, about 254) first met a helper
 * change on main's push lane (W1-T4396), where a red is everyone's.
 *
 * test-slow-shard now classifies with `--coverage-class`: it skips only when the COVERAGE class is
 * SOURCE (coverage-ratchet then really owns the instrumented full-suite run). A TEST_ONLY diff whose
 * `testOnlyRun` is "full" installs and runs `test:slow`. A TEST_ONLY "files" diff (only `*.test.ts`
 * changed) keeps its narrower run: ci-shard's candidate lane runs exactly those suites, slow ones
 * included, so test-slow-shard still skips and installs nothing. Only an explicit "files" answer
 * skips: a `--test-only-run` that fails or answers anything else runs the slow tier (fails open).
 * The rationale lives here, not in ci.yml, which sits at its comment-load ceiling.
 *
 * Each case drives the REAL step bodies from .github/workflows/ci.yml through bash, with a stub
 * `git` answering the diff and the REAL classifier on plain node, then evaluates each install
 * step's real `if:` against the outputs the classify body wrote (the W1-T5697 harness pattern).
 *
 * FALSIFIER: keep test-slow-shard's skip keyed on the base classify (drop `--coverage-class`) — the
 * helper-only diff classifies SOURCE, installs nothing and skips, and the first test fails.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { steps: Step[] };
const job = (parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> })
  .jobs["test-slow-shard"]!;

/** Evaluates the only `if:` shape these steps use: `steps.<id>.outputs.<key> ==|!= '<literal>'`
 *  atoms joined by `&&`/`||`. Anything else throws, so a new shape cannot be misread as true. */
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

/** Runs one real step body as Actions does (`bash -eo pipefail`) in a scratch directory whose
 *  `scripts` is the repo's own. `git`, `npm` and `npx` are stubs (`git diff` answers `files`);
 *  `node` is a stub only when `stubNode` is given, so the real classifier runs otherwise. */
function runBody(body: string, files: string[], subs: Record<string, string> = {}, stubNode?: string) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5700-`));
  mkdirSync(join(dir, "bin"));
  symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "diff.txt"), files.map((f) => `${f}\n`).join(""));
  const stub = (name: string, script: string) => {
    writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  stub("git", `case "$1" in fetch) exit 0 ;; diff) cat "${join(dir, "diff.txt")}" ;; *) exit 1 ;; esac`);
  stub("npm", `echo "npm $*" >> "${log}"`);
  stub("npx", `echo "npx $*" >> "${log}"`);
  if (stubNode !== undefined) stub("node", `echo "node $*" >> "${log}"\n${stubNode}`);
  let text = body;
  for (const [from, to] of Object.entries(subs)) text = text.replaceAll(from, to);
  writeFileSync(join(dir, "step.sh"), text);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_BASE_REF: "main",
      GITHUB_OUTPUT: join(dir, "outputs.txt"),
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      RUNNER_TEMP: dir,
    },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const outputs: Record<string, string> = {};
  const raw = existsSync(join(dir, "outputs.txt")) ? readFileSync(join(dir, "outputs.txt"), "utf8") : "";
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { outputs, calls: existsSync(log) ? readFileSync(log, "utf8") : "", stdout: r.stdout };
}

/** test-slow-shard on a pull request: classify, every install guard, then what Run does. */
function slowShard(files: string[], stubNode?: string) {
  const plan = runBody(job.steps.find((s) => s.id === "plan-reading")!.run!, files, {}, stubNode);
  const outputs = { "plan-reading": plan.outputs };
  const npm = job.steps.find((s) => /\bnpm ci\b/.test(s.run ?? ""));
  const cache = job.steps.find((s) => (s.uses ?? "").startsWith("actions/cache@"));
  const chromium = job.steps.find((s) => (s.run ?? "").includes("playwright install chromium"));
  assert.ok(npm && cache && chromium, "test-slow-shard must still carry npm ci, the Chromium cache and its install");
  const install = [npm, cache, chromium].map((s) => evalIf(s.if, outputs));
  assert.ok(install.every((v) => v === install[0]), `the three install guards must agree: ${install}`);
  const runStep = job.steps.find((s) => s.name?.startsWith("Run the slow tier"));
  assert.ok(runStep?.run, "test-slow-shard must still carry its 'Run the slow tier' step");
  const ran = runBody(
    runStep.run,
    files,
    {
      "${{ matrix.shard }}": "1",
      "${{ steps.plan-reading.outputs.established }}": plan.outputs.established ?? "",
      "${{ steps.plan-reading.outputs.class }}": plan.outputs.class ?? "",
    },
    "exit 0",
  );
  return { outputs: plan.outputs, installs: install[0]!, slowRun: /npm run --silent test:slow/.test(ran.calls), ran };
}

test("W1-T5700: a test/helpers-only or test/setup-only pull request installs and reaches test-slow-shard's slow-tier run", () => {
  for (const files of [["test/helpers/push-safety.ts"], ["test/setup/env.ts"], ["test/helpers/a.ts", "test/leaf.test.ts"]]) {
    const r = slowShard(files);
    assert.equal(r.outputs.class, "TEST_ONLY", `${files}: the coverage class, which coverage-ratchet skips on`);
    assert.equal(r.outputs.established, "false", `${files}`);
    assert.deepEqual([r.installs, r.slowRun], [true, true], `${files}: ${JSON.stringify(r.outputs)} ${r.ran.calls}`);
    assert.match(r.ran.calls, /npm run --silent test:slow -- --shard 1\/2 --base origin\/main/);
  }
});

test("W1-T5700: a SOURCE pull request still skips test-slow-shard, coverage-ratchet owning its full-suite run", () => {
  for (const files of [["src/lib/leaf.ts"], ["src/lib/leaf.ts", "test/helpers/push-safety.ts"]]) {
    const r = slowShard(files);
    assert.deepEqual(r.outputs, { class: "SOURCE", established: "false" }, `${files}`);
    assert.deepEqual([r.installs, r.slowRun], [false, false], `${files}`);
    assert.match(r.ran.stdout, /W1-T3207: coverage-ratchet owns/);
  }
});

test("W1-T5700: a pull request changing only *.test.ts files keeps its narrower run and skips test-slow-shard", () => {
  const r = slowShard(["test/leaf.test.ts", "test/other-leaf.test.ts"]);
  assert.equal(r.outputs.established, "false");
  assert.deepEqual([r.installs, r.slowRun], [false, false], `${JSON.stringify(r.outputs)} ${r.ran.calls}`);
});

test("W1-T5700: a TEST_ONLY pull request whose --test-only-run answer is unreadable fails open to the slow-tier run", () => {
  const stub = `case "$*" in *--test-only-run*) exit 1 ;; *--coverage-class*) echo TEST_ONLY ;; *) exit 0 ;; esac`;
  const r = slowShard(["test/helpers/push-safety.ts"], stub);
  assert.deepEqual(r.outputs, { class: "TEST_ONLY", established: "false" });
  assert.deepEqual([r.installs, r.slowRun], [true, true], r.ran.calls);
});
