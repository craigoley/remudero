// @source-text-subject: the subject is the workflow files themselves: which check names ci.yml's reporter posts, which names every workflow's runnable jobs register, and ci-gate.yml's shipped aggregation step.
/**
 * W1-T5695 — A POSTED GATE NEVER SHARES A NAME WITH A WORKFLOW JOB.
 *
 * Three producers named a check `commitlint` on every head: ci.yml's own bundling job, the check
 * that job POSTED through the checks API (the AND of the title lint and rule-checks), and
 * pr-title-lint.yml's job. ci-gate.yml kept the newest run per NAME, so on #8905 (head 30f6aabe) a
 * posted FAILURE at 16:37 was hidden by the title job's SUCCESS at 16:39 and the gate read green.
 *
 * One producer per name: the bundling job (key `commitlint`) is named `light-gates` and posts
 * `rule-checks` under its own name; pr-title-lint.yml's job is the only `commitlint`; every post
 * carries a run-scoped external_id; ci-gate groups by name AND producer class.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { loadCiGateLists } from "../src/lib/ci-control-plane.js";
import { checkJobId } from "../src/lib/sweep.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { ghShim } from "./helpers/gh-shim.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOWS = join(ROOT, ".github", "workflows");

type Step = { id?: string; name?: string; env?: Record<string, string>; run?: string };
type Job = { name?: string; if?: unknown; steps?: Step[] };
type Workflow = { on?: unknown; jobs: Record<string, Job> };

function workflow(file: string): Workflow {
  return parseYaml(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
}

function bundlingJob(): Job {
  const job = workflow("ci.yml").jobs.commitlint;
  assert.ok(job, "ci.yml's bundling job keeps its `commitlint` KEY (CI_PARITY_TABLE, gate-posture and needs: read it)");
  return job;
}

function reporterStep(): Step & { env: Record<string, string>; run: string } {
  const step = bundlingJob().steps?.find((s) => s.run?.includes("report()"));
  assert.ok(step?.run && step.env, "ci.yml's bundling job must still carry the checks-API reporter step");
  return step as Step & { env: Record<string, string>; run: string };
}

/** Every check name the reporter POSTS — the first argument of each `report "<name>"` line. */
function postedNames(): string[] {
  return [...reporterStep().run.matchAll(/^\s*report "([^"]+)"/gm)].map((m) => m[1]!);
}

/** The `name:` (or key) of every job that can RUN, in every workflow. An `if: false` stub never
 *  runs, so it produces no conclusion that could supersede a post. */
function runnableJobNames(): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    for (const [key, job] of Object.entries(workflow(file).jobs ?? {})) {
      if (job.if === false) continue;
      const name = job.name ?? key;
      owners.set(name, [...(owners.get(name) ?? []), `${file}#${key}`]);
    }
  }
  return owners;
}

/** Run ci.yml's real reporter step with `gh` stubbed, returning each posted check's argv. */
function runReporter(outcomes: Record<string, string>): string[] {
  const step = reporterStep();
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}posted-gate-names-`));
  try {
    const log = join(dir, "calls");
    const stub = `gh() { printf '%s\\n' "$*" >> "${log}"; }\n`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...Object.fromEntries(Object.keys(step.env).filter((k) => k.startsWith("OUTCOME_")).map((k) => [k, "success"])),
      ...outcomes,
      GITHUB_REPOSITORY: "owner/repo",
      HEAD_SHA: "30f6aabe",
      POSTING_JOB_ID: "12345",
      POSTING_RUN_ID: "777",
      POSTING_RUN_ATTEMPT: "2",
      GATE_REPORT_DIR: dir,
    };
    const result = spawnSync("bash", ["-c", stub + step.run], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(log, "utf8").trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Run = { id: number; name: string; status: string; conclusion: string | null; started_at: string; external_id?: string };

/** Run ci-gate.yml's shipped aggregation step over a fixed set of check runs. */
function runShippedGate(runs: Run[], required: string[]): { status: number | null; output: string } {
  const script = workflow("ci-gate.yml").jobs["ci-gate"]?.steps?.find((s) => s.run?.includes("runs_json"))?.run;
  assert.ok(script, "ci-gate.yml must expose its real aggregation step");
  const shim = ghShim([{ when: "api", stdout: JSON.stringify([{ check_runs: runs }]) }], { kind: "posted-gate-names" });
  try {
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${shim.dir}:${process.env.PATH}`,
        GH_TOKEN: "fixture",
        REPO: "craigoley/remudero",
        SHA: "30f6aabe",
        REQUIRED: JSON.stringify(required),
        IGNORE: "[]",
        GRACE_WINDOW_SECONDS: "0",
        GRACE_POLL_INTERVAL_SECONDS: "1",
        WAIT_CAP_SECONDS: "0",
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(shim.dir, { recursive: true, force: true });
  }
}

/** #8905 head 30f6aabe: ci.yml's posted `commitlint` FAILED at 16:37; pr-title-lint.yml's job
 *  (an Actions run, whose external_id is GitHub's own uuid) SUCCEEDED under the same name at 16:39. */
const POSTED_FAILURE: Run = {
  id: 52_001, name: "commitlint", status: "completed", conclusion: "failure",
  started_at: "2026-10-03T16:37:10Z", external_id: "job:51998877",
};
const LATER_JOB_SUCCESS: Run = {
  id: 52_050, name: "commitlint", status: "completed", conclusion: "success",
  started_at: "2026-10-03T16:39:02Z", external_id: "6c3f1a2e-0b5d-5e0c-9f0a-2d4b8e1c7a90",
};

test("W1-T5695: no check name ci.yml's reporter posts is the name of a runnable job in any workflow", () => {
  const posted = postedNames();
  assert.ok(posted.length >= 15, `sanity: the reporter posts its ~17 gates, found ${posted.length}`);
  const jobs = runnableJobNames();
  assert.ok(jobs.size > 20, "sanity: the census is reading real jobs, not running vacuously");
  const collisions = posted.filter((name) => jobs.has(name)).map((name) => `${name} (${jobs.get(name)!.join(", ")})`);
  assert.deepEqual(collisions, [], `posted gate name(s) shared with a runnable job: ${collisions.join("; ")}`);
});

test("W1-T5695: commitlint is produced only by pr-title-lint.yml's job, which fires on edited and stays REQUIRED", () => {
  assert.deepEqual(runnableJobNames().get("commitlint"), ["pr-title-lint.yml#commitlint"]);
  assert.ok(!postedNames().includes("commitlint"), "ci.yml's reporter no longer posts commitlint");
  const titleLint = workflow("pr-title-lint.yml") as Workflow & { on: { pull_request: { types: string[] } } };
  assert.ok(titleLint.on.pull_request.types.includes("edited"), "a title edit re-runs the sole commitlint producer");
  const bundled = JSON.stringify(bundlingJob().steps);
  assert.doesNotMatch(bundled, /npx commitlint/, "ci.yml's bundling job carries no copy of the PR-title lint");
  assert.ok(!Object.keys(reporterStep().env).includes("OUTCOME_COMMITLINT"));
  assert.ok(loadCiGateLists(ROOT).required.has("commitlint"));
});

test("W1-T5695: rule-checks is posted under its own name with a run-scoped external_id and listed in ci-gate's REQUIRED", () => {
  assert.equal(postedNames().filter((n) => n === "rule-checks").length, 1);
  assert.equal(workflow("ci.yml").jobs["rule-checks"], undefined, "no stub job: W1-T5802 derives the posted name");
  assert.ok(loadCiGateLists(ROOT).required.has("rule-checks"), "ci-gate.yml's REQUIRED names rule-checks");

  const calls = runReporter({ OUTCOME_RULE_CHECKS: "failure" });
  const call = (name: string) => calls.find((line) => line.includes(`name=${name} `));
  assert.match(call("rule-checks") ?? "", /conclusion=failure/);
  assert.equal(call("commitlint"), undefined);
  const ids = calls.map((line) => line.match(/external_id=(\S+)/)?.[1]);
  assert.ok(ids.every((id) => id === "run:777:2:job:12345"), calls.join("\n"));
  assert.equal(checkJobId({ externalId: ids[0] }), "12345", "W1-T5802's checkJobId reads the posted identity");
});

test("W1-T5695: ci.yml's bundling job is named light-gates and is ADVISORY", () => {
  assert.equal(bundlingJob().name, "light-gates");
  const { required, advisory } = loadCiGateLists(ROOT);
  assert.ok(advisory.has("light-gates"));
  assert.ok(!required.has("light-gates"), "green by construction: it can never be the verdict");
});

test("W1-T5695: ci-gate's grouping reads the #8905 pair as failing while a rerun of the posting job supersedes its own post", () => {
  for (const posted of [POSTED_FAILURE, { ...POSTED_FAILURE, external_id: "run:777:1:job:51998877" }]) {
    const masked = runShippedGate([posted, LATER_JOB_SUCCESS], ["commitlint"]);
    assert.notEqual(masked.status, 0, masked.output);
    assert.match(masked.output, /required check\(s\) FAILED/);
  }
  // W1-T123 survives: a rerun of the POSTING job (new attempt, new job id) supersedes its own
  // earlier failed post, because the group is the producer CLASS, never the full external_id.
  const rerun: Run = { ...POSTED_FAILURE, id: 52_100, conclusion: "success", started_at: "2026-10-03T16:45:00Z", external_id: "run:777:2:job:51999000" };
  const recovered = runShippedGate([POSTED_FAILURE, LATER_JOB_SUCCESS, rerun], ["commitlint"]);
  assert.equal(recovered.status, 0, recovered.output);
  // A never-run stub's skipped row beside a posted success never fails.
  const stub: Run = { id: 51_000, name: "lint-plan", status: "completed", conclusion: "skipped", started_at: "2026-10-03T16:30:00Z" };
  const post: Run = { ...rerun, id: 52_200, name: "lint-plan" };
  const skippedBeside = runShippedGate([stub, post], ["lint-plan"]);
  assert.equal(skippedBeside.status, 0, skippedBeside.output);
  // A name is not ready while any of its producer groups is still running.
  const running: Run = { ...LATER_JOB_SUCCESS, id: 52_300, status: "in_progress", conclusion: null };
  const waiting = runShippedGate([rerun, running], ["commitlint"]);
  assert.notEqual(waiting.status, 0, waiting.output);
  assert.match(waiting.output, /TIMED OUT waiting/);
});
