/**
 * W1-T5697 — A CI SHARD THAT WILL SKIP INSTALLS NOTHING FIRST.
 *
 * ci-shard and test-slow-shard used to run `npm ci` and the Playwright Chromium install BEFORE they
 * classified the diff, then skip on a SOURCE pull request (W1-T3207: coverage-ratchet owns that
 * verdict) — about 35 runner-hours in 2.8 days spent installing for jobs that ran no test. The
 * classification now runs first, on plain Node, and every install step is guarded on its answer.
 *
 * Each case below drives the REAL step bodies from .github/workflows/ci.yml through bash, with a
 * stub `git` answering the diff and, where the classifier's own verdict is not the subject, a stub
 * `node`; then it evaluates each install step's real `if:` against the outputs those bodies wrote.
 *
 * FALSIFIER: put either job's Install back above its classify step — the order test fails.
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
type Job = { if?: string; steps: Step[] };
const jobs = (parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> }).jobs;

const isNpmInstall = (s: Step) => /\bnpm ci\b/.test(s.run ?? "");
const isChromiumCache = (s: Step) => (s.uses ?? "").startsWith("actions/cache@") && String(s.with?.path ?? "").includes("ms-playwright");
const isChromiumInstall = (s: Step) => (s.run ?? "").includes("playwright install chromium");

function installSteps(job: Job): { npm: Step; cache: Step; chromium: Step } {
  const npm = job.steps.find(isNpmInstall);
  const cache = job.steps.find(isChromiumCache);
  const chromium = job.steps.find(isChromiumInstall);
  assert.ok(npm && cache && chromium, "each job must still carry npm ci, the Chromium cache and the Chromium install");
  return { npm, cache, chromium };
}

/** The classify step of each job: the one that answers whether this shard has work. */
const CLASSIFY: Record<string, { id: string; command: string }> = {
  ci: { id: "admission", command: "node scripts/ci-shard-admission.mjs" },
  "test-slow-shard": { id: "plan-reading", command: "node scripts/diff-class.mjs" },
};

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

type Run = { outputs: Record<string, string>; calls: string };

/** Runs one real step body the way Actions does (`bash -eo pipefail`) in a scratch directory whose
 *  `scripts` is the repo's own. `git`, `npm` and `npx` are always stubs (`git diff` answers `files`);
 *  `node` is a stub only when `stubNode` is given, so the real classifier runs otherwise. */
function runBody(
  body: string,
  opts: { event: string; files: string[]; subs?: Record<string, string>; stubNode?: string },
): Run {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t5697-`));
  mkdirSync(join(dir, "bin"));
  symlinkSync(join(REPO_ROOT, "scripts"), join(dir, "scripts"));
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "diff.txt"), opts.files.map((f) => `${f}\n`).join(""));
  const stub = (name: string, script: string) => {
    writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  stub("git", `case "$1" in fetch) exit 0 ;; diff) cat "${join(dir, "diff.txt")}" ;; *) exit 1 ;; esac`);
  stub("npm", `echo "npm $*" >> "${log}"`);
  stub("npx", `echo "npx $*" >> "${log}"`);
  if (opts.stubNode !== undefined) stub("node", `echo "node $*" >> "${log}"\n${opts.stubNode}`);
  let text = body;
  for (const [from, to] of Object.entries(opts.subs ?? {})) text = text.replaceAll(from, to);
  writeFileSync(join(dir, "step.sh"), text);
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: opts.event,
      GITHUB_BASE_REF: opts.event === "pull_request" ? "main" : "",
      GITHUB_OUTPUT: join(dir, "outputs.txt"),
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      RUNNER_TEMP: dir,
      RMD_AFFECTED_SUITE_LIVE: "0",
    },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const outputs: Record<string, string> = {};
  const raw = existsSync(join(dir, "outputs.txt")) ? readFileSync(join(dir, "outputs.txt"), "utf8") : "";
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { outputs, calls: existsSync(log) ? readFileSync(log, "utf8") : "" };
}

test("W1-T5697: in ci-shard and test-slow-shard the classify step runs on plain node before npm ci and Chromium", () => {
  for (const [jobId, { id, command }] of Object.entries(CLASSIFY)) {
    const job = jobs[jobId]!;
    assert.equal(job.if, undefined, `${jobId}: the required check must still register on every event`);
    const classify = job.steps.findIndex((s) => s.id === id);
    assert.ok(classify >= 0, `${jobId}: no '${id}' step`);
    const run = job.steps[classify]!.run ?? "";
    assert.ok(run.includes(command), `${jobId}: '${id}' must classify with \`${command}\``);
    assert.doesNotMatch(run, /--import tsx/, `${jobId}: '${id}' runs before npm ci, so it cannot load tsx`);
    const { npm, cache, chromium } = installSteps(job);
    for (const [what, step] of [["npm ci", npm], ["the Chromium cache", cache], ["the Chromium install", chromium]] as const) {
      assert.ok(classify < job.steps.indexOf(step), `${jobId}: '${id}' must precede ${what}`);
    }
  }
});

/** ci-shard: the admission body, then each install step's real guard against what it wrote. */
function ciShard(event: string, files: string[], shard: number) {
  const job = jobs.ci!;
  const admission = runBody(job.steps.find((s) => s.id === "admission")!.run!, {
    event,
    files,
    subs: { "${{ matrix.shard }}": String(shard) },
  });
  const outputs = { admission: admission.outputs };
  const { npm, cache, chromium } = installSteps(job);
  const npmRun = runBody(npm.run!, {
    event,
    files,
    subs: { "${{ steps.admission.outputs.setup }}": admission.outputs.setup ?? "" },
  });
  return {
    outputs: admission.outputs,
    npm: evalIf(npm.if, outputs) && /npm ci/.test(npmRun.calls),
    chromium: evalIf(cache.if, outputs) && evalIf(chromium.if, outputs),
  };
}

test("W1-T5697: a SOURCE pull request installs no Chromium on any ci shard, and only shard 1 installs for Typecheck", () => {
  for (let shard = 1; shard <= 8; shard += 1) {
    const r = ciShard("pull_request", ["src/lib/leaf.ts"], shard);
    assert.equal(r.npm, shard === 1, `shard ${shard}/8: npm ci only where Typecheck runs (${JSON.stringify(r.outputs)})`);
    assert.equal(r.chromium, false, `shard ${shard}/8: a SOURCE pull request runs no browser suite (${JSON.stringify(r.outputs)})`);
  }
  // A ci.yml diff keeps shard 1's browser: its guard-mutation step runs every ci.yml-reading suite.
  const workflow = ciShard("pull_request", ["src/lib/leaf.ts", ".github/workflows/ci.yml"], 1);
  assert.deepEqual([workflow.npm, workflow.chromium], [true, true]);
  // A test-only diff runs its tests on every shard, so every shard installs both.
  for (const shard of [1, 2, 8]) {
    const r = ciShard("pull_request", ["test/leaf.test.ts"], shard);
    assert.deepEqual([r.npm, r.chromium], [true, true], `shard ${shard}/8: a test-only diff is work`);
  }
});

test("W1-T5697: push and merge_group install on every ci shard, unconditionally", () => {
  for (const event of ["push", "merge_group"]) {
    for (let shard = 1; shard <= 8; shard += 1) {
      const r = ciShard(event, ["src/lib/leaf.ts"], shard);
      assert.deepEqual(r.outputs, { setup: "true", browser: "true" }, `${event} shard ${shard}/8`);
      assert.deepEqual([r.npm, r.chromium], [true, true], `${event} shard ${shard}/8 must install`);
    }
  }
});

/** test-slow-shard: plan-reading, then each install step's guard, then whether Run skips. */
function slowShard(event: string, files: string[], stubNode?: string) {
  const job = jobs["test-slow-shard"]!;
  const plan = runBody(job.steps.find((s) => s.id === "plan-reading")!.run!, { event, files, stubNode });
  const outputs = { "plan-reading": plan.outputs };
  const { npm, cache, chromium } = installSteps(job);
  const install = [npm, cache, chromium].map((s) => evalIf(s.if, outputs));
  assert.ok(install.every((v) => v === install[0]), `the three install guards must agree: ${install}`);
  const runStep = job.steps.find((s) => s.name?.startsWith("Run the slow tier"))!;
  const ran = runBody(runStep.run!, {
    event,
    files,
    stubNode: "exit 0",
    subs: {
      "${{ matrix.shard }}": "1",
      "${{ steps.plan-reading.outputs.established }}": plan.outputs.established ?? "",
      "${{ steps.plan-reading.outputs.class }}": plan.outputs.class ?? "",
    },
  });
  return { outputs: plan.outputs, installs: install[0]!, runsTests: ran.calls !== "" };
}

test("W1-T5697: test-slow-shard installs nothing exactly when it will skip, and always installs on push and merge_group", () => {
  // The REAL classifier, on plain node, before any install: a source diff is SOURCE and skips.
  const source = slowShard("pull_request", ["src/lib/leaf.ts"]);
  assert.deepEqual(source.outputs, { class: "SOURCE", established: "false" });
  assert.deepEqual([source.installs, source.runsTests], [false, false]);
  for (const event of ["push", "merge_group"]) {
    const push = slowShard(event, ["src/lib/leaf.ts"]);
    assert.deepEqual(push.outputs, { class: "PUSH", established: "false" }, event);
    assert.deepEqual([push.installs, push.runsTests], [true, true], `${event} must install and run the slow tier`);
  }
  // A plan diff whose exact plan-reading matrix is established skips too, so it installs nothing.
  const answer = (selectExit: number) =>
    `case "$*" in *--list-plan-reading-suites*) echo test/leaf.test.ts ;; *--select-candidates*) exit ${selectExit} ;; *diff-class.mjs*) echo PLAN_ONLY ;; esac`;
  const established = slowShard("pull_request", ["plan/tasks.d/x.yaml"], answer(0));
  assert.deepEqual(established.outputs, { class: "PLAN_ONLY", established: "true" });
  assert.deepEqual([established.installs, established.runsTests], [false, false]);
  // The control: the same plan diff with no established matrix runs the slow tier, so it installs.
  const fallback = slowShard("pull_request", ["plan/tasks.d/x.yaml"], answer(1));
  assert.deepEqual(fallback.outputs, { class: "PLAN_ONLY", established: "false" });
  assert.deepEqual([fallback.installs, fallback.runsTests], [true, true]);
});
