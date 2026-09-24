/**
 * W1-T4396 — the slow tier runs on main.
 *
 * `test-slow` was pull_request-only, and W1-T3207 skips it on every SOURCE pull request because
 * coverage-ratchet owns the one full-suite run. So the 107 slowest test files ran on main nowhere:
 * a merge that broke one was invisible until a later PR's coverage run tripped on it. Now the job
 * registers on a push too, and its push lane always runs the slow tier through the failed-file retry.
 * Each test drives the REAL step bodies through Actions' own shell with stub `node` and `npm`
 * binaries that record what they were asked to run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
type Step = { name?: string; id?: string; run?: string };
type CiDoc = { on: Record<string, unknown>; jobs: Record<string, { if?: string; steps?: Step[] }> };
const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as CiDoc;
const job = doc.jobs["test-slow"]!;
const steps = job.steps!;
const TIER_CHECK = steps.find((s) => s.run?.includes("test:tier:check"))!.run!;
const PLAN_READING = steps.find((s) => s.id === "plan-reading")!.run!;
const RUN_SLOW = steps.find((s) => s.name?.startsWith("Run the slow tier"))!.run!;

/** Runs the tier check, the plan-reading step and the slow-tier step in order, the way Actions
 *  would: plan-reading's real `$GITHUB_OUTPUT` is substituted into the next step's expressions.
 *  `diffClass` is what the stubbed diff-class.mjs answers for a pull request's changed files. */
function runJob(event: "push" | "pull_request", diffClass = "SOURCE"): { calls: string; out: string; outputs: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4396-`));
  mkdirSync(join(dir, "bin"));
  const log = join(dir, "calls.log");
  for (const bin of ["node", "npm"]) {
    writeFileSync(
      join(dir, "bin", bin),
      `#!/usr/bin/env bash\necho "${bin} $*" >> "${log}"\ncase "$*" in *diff-class.mjs*) echo "${diffClass}" ;; *) echo "# tests 1" ;; esac\n`,
    );
    chmodSync(join(dir, "bin", bin), 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    GITHUB_EVENT_NAME: event,
    GITHUB_BASE_REF: event === "pull_request" ? "main" : "",
    GITHUB_OUTPUT: join(dir, "outputs.txt"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
    RUNNER_TEMP: dir,
  };
  let out = "";
  const bash = (body: string) => {
    writeFileSync(join(dir, "step.sh"), body);
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], { cwd: dir, encoding: "utf8", env });
    out += r.stdout + r.stderr;
    assert.equal(r.status, 0, out);
  };
  bash(TIER_CHECK);
  bash(PLAN_READING);
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(env.GITHUB_OUTPUT, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  bash(
    RUN_SLOW.replaceAll("${{ steps.plan-reading.outputs.established }}", outputs.established ?? "")
      .replaceAll("${{ steps.plan-reading.outputs.class }}", outputs.class ?? ""),
  );
  return { calls: existsSync(log) ? readFileSync(log, "utf8") : "", out, outputs };
}

test("W1-T4396: the push lane runs the slow tier", () => {
  assert.ok("push" in doc.on, "ci.yml must still trigger on a push to main");
  assert.equal(job.if, undefined, "test-slow must not carry the PR-only job guard, or no push ever runs it");
  const push = runJob("push");
  assert.deepEqual(push.outputs, { class: "PUSH", established: "false" });
  assert.equal(
    push.calls.trim(),
    "node scripts/test-with-retry.mjs node scripts/test-tier-manifest.mjs --run slow --base HEAD",
    "a push runs exactly the slow tier, once, behind the failed-file retry — and no PR-only tier check",
  );
  assert.match(push.out, /W1-T4396: push to main — running the slow tier/);
});

test("W1-T4396: a source pull request still leaves the slow tier to coverage-ratchet", () => {
  // The control: the same harness on a SOURCE pull request takes the W1-T3207 skip, so the push
  // assertion above can tell the two lanes apart.
  const pr = runJob("pull_request", "SOURCE");
  assert.deepEqual(pr.outputs, { class: "SOURCE", established: "false" });
  assert.equal(
    pr.calls.replace(/^node --import tsx scripts\/diff-class\.mjs .*\n/m, "").trim(),
    "npm run --silent test:tier:check -- --base origin/main",
  );
  assert.match(pr.out, /W1-T3207: coverage-ratchet owns/);
  // A test-only pull request (not SOURCE, not established) still runs the PR form of the tier.
  const testOnly = runJob("pull_request", "TEST_ONLY");
  assert.equal(testOnly.outputs.class, "TEST_ONLY");
  assert.match(testOnly.calls, /^npm run --silent test:slow -- --base origin\/main$/m);
  assert.doesNotMatch(testOnly.calls, /test-with-retry/);
});
