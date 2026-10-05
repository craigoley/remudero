/**
 * @source-text-subject: this suite's subject is the text of .github/workflows/coverage-nightly.yml.
 *
 * W1-T5704 — the instrumented suite runs nightly on main.
 *
 * coverage-ratchet shell-skips on push (W1-T1033), so before this workflow no instrumented run ever
 * measured main itself: the absolute coverage floor was read only through PR heads. The live
 * selector (W1-T5705) narrows PR coverage to a selection, so the floor needs a full instrumented run
 * on main to fall back on. coverage-nightly.yml is that run: the eight coverage shards with
 * `--select-all`, the cross-shard merge, and the absolute-floor ratchet, on `schedule` and
 * `workflow_dispatch`.
 *
 * THE LOAD-BEARING ASSERTION is schedule reachability: no `if:` and no shell guard anywhere in the
 * workflow may read the event name. That is the W1-T1033 shape — a guard on `pull_request` that
 * quietly turns a scheduled run into a green no-op. FALSIFIER: guard the coverage step on
 * `github.event_name == 'pull_request'` and the reachability test below fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "coverage-nightly.yml");

type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = {
  name?: string;
  if?: string;
  needs?: string | string[];
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: unknown[] } };
  steps?: Step[];
};
type WorkflowDoc = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean | string };
  jobs?: Record<string, Job>;
};

function loadWorkflow(): WorkflowDoc {
  return parseYaml(readFileSync(WORKFLOW_PATH, "utf8")) as WorkflowDoc;
}

function jobsOf(doc: WorkflowDoc): Array<[string, Job]> {
  const jobs = Object.entries(doc.jobs ?? {});
  assert.ok(jobs.length > 0, "coverage-nightly.yml must define at least one job");
  return jobs;
}

/** The job whose matrix is the eight coverage shards. */
function shardJob(doc: WorkflowDoc): [string, Job] {
  const found = jobsOf(doc).find(([, job]) => Array.isArray(job.strategy?.matrix?.shard));
  assert.ok(found, "coverage-nightly.yml must carry a `shard` matrix job");
  return found;
}

/** The step whose `run:` contains `needle`, anywhere in `job`. */
function stepRunning(job: Job, needle: string): Step {
  const found = (job.steps ?? []).find((s) => s.run?.includes(needle));
  assert.ok(found, `expected a step whose run: contains ${JSON.stringify(needle)}`);
  return found;
}

const EVENT_NAME_RE = /github\.event_name|GITHUB_EVENT_NAME|github\.event\.pull_request/;

/**
 * Every place a workflow could skip the `schedule` event: an `if:` (job or step) or a `run:` shell
 * guard that reads the event name. Both shapes count — W1-T1033's guard is a shell line, not a YAML
 * conditional. Returns one `<job>[/<step>]: <text>` entry per site.
 */
export function eventGuards(doc: WorkflowDoc): string[] {
  const sites: string[] = [];
  for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
    if (job.if !== undefined && EVENT_NAME_RE.test(String(job.if))) sites.push(`${jobId}: if: ${job.if}`);
    for (const [i, s] of (job.steps ?? []).entries()) {
      const label = `${jobId}/${s.name ?? s.id ?? `step ${i + 1}`}`;
      if (s.if !== undefined && EVENT_NAME_RE.test(String(s.if))) sites.push(`${label}: if: ${s.if}`);
      if (s.run !== undefined && EVENT_NAME_RE.test(s.run)) sites.push(`${label}: run reads the event name`);
    }
  }
  return sites;
}

test("the nightly workflow has a schedule trigger and workflow_dispatch, and no per-PR trigger", () => {
  const on = loadWorkflow().on ?? {};
  const schedule = on.schedule as Array<{ cron?: string }> | undefined;
  assert.ok(Array.isArray(schedule) && schedule.length > 0, "`on.schedule` must hold at least one cron entry");
  for (const entry of schedule) {
    assert.equal(String(entry.cron ?? "").trim().split(/\s+/).length, 5, `cron ${JSON.stringify(entry.cron)} must have five fields`);
  }
  assert.ok("workflow_dispatch" in on, "`on.workflow_dispatch` must be declared so an operator can run it by hand");
  // A pull_request or push trigger would spend eight instrumented shards per event and register PR
  // checks that the required-or-advisory census would then demand a ci-gate.yml entry for.
  assert.deepEqual(Object.keys(on).sort(), ["schedule", "workflow_dispatch"]);
});

test("the nightly workflow runs the eight coverage shards with --select-all, instrumented", () => {
  const [, job] = shardJob(loadWorkflow());
  assert.deepEqual(job.strategy?.matrix?.shard, [1, 2, 3, 4, 5, 6, 7, 8], "exactly the eight coverage shards");
  assert.equal(job.strategy?.["fail-fast"], false, "one red shard must not cancel the other seven measurements");
  const select = stepRunning(job, "--select-all").run!;
  assert.match(select, /scripts\/test-tier-manifest\.mjs --select-all --shard \$\{\{ matrix\.shard \}\}\/8/);
  // The same instrumentation flags as ci.yml's coverage lane, or the two floors measure different things.
  for (const flag of ["--enable-source-maps", "--experimental-test-coverage", '--test-coverage-exclude="test/**"', "--test-reporter=lcov"]) {
    assert.ok(select.includes(flag), `the shard run must pass ${flag}`);
  }
  assert.ok(select.includes("--import ./test/setup/tmp-hygiene.ts"), "the shard run must load the same test harness setup as ci.yml");
  stepRunning(job, "--compact-output");
  const upload = (job.steps ?? []).find((s) => s.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(upload, "each shard must upload its compact coverage for the merge job");
});

test("the nightly workflow measures main and refuses any other ref", () => {
  const [, job] = shardJob(loadWorkflow());
  const guard = stepRunning(job, "refs/heads/main").run!;
  assert.match(guard, /GITHUB_REF/, "the guard must read the ref the run was started on");
  assert.match(guard, /exit 1/, "a run on another ref must fail loudly, never skip to green");
});

test("the nightly workflow merges the shards and runs the absolute-floor ratchet, uploading the merged lcov and a summary", () => {
  const doc = loadWorkflow();
  const [shardId] = shardJob(doc);
  const merge = jobsOf(doc).find(([, job]) => [job.needs ?? []].flat().includes(shardId));
  assert.ok(merge, `a job must declare needs: ${shardId}`);
  const [, mergeJob] = merge;
  const merged = stepRunning(mergeJob, "scripts/coverage-merge-ratchet.mjs").run!;
  assert.match(merged, /--output coverage\/lcov\.info/);
  assert.match(merged, /--shard-count 8/);
  for (let n = 1; n <= 8; n += 1) assert.ok(merged.includes(`coverage-shard-${n}/raw`), `the merge must read shard ${n}`);
  const ratchetStep = stepRunning(mergeJob, "node scripts/coverage-ratchet.mjs --lcov");
  assert.match(ratchetStep.run!, /--lcov coverage\/lcov\.info --baseline scripts\/coverage-baseline\.json/);
  const steps = mergeJob.steps ?? [];
  assert.ok(steps.indexOf(stepRunning(mergeJob, "coverage-merge-ratchet")) < steps.indexOf(ratchetStep),
    "the merge must run before the ratchet reads its lcov");
  const summary = stepRunning(mergeJob, "coverage-nightly-summary.json").run!;
  assert.match(summary, /parseLcovTotals/, "the summary must come from the ratchet's own lcov parser, not a second one");
  const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
  const paths = uploads.map((s) => String(s.with?.path ?? "")).join("\n");
  assert.match(paths, /lcov\.info/, "the merged lcov must be uploaded");
  assert.match(paths, /coverage-nightly-summary\.json/, "the ledgerable summary must be uploaded");
});

test("no step's if: or shell guard skips the schedule event", () => {
  assert.deepEqual(eventGuards(loadWorkflow()), [], "a guard on the event name is the W1-T1033 shape that skips `schedule`");
});

test("eventGuards finds both the YAML-conditional and the shell-guard shape (falsifier for the test above)", () => {
  const yamlGuard = parseYaml(`
jobs:
  shards:
    steps:
      - name: Test with coverage
        if: github.event_name == 'pull_request'
        run: node --test
`) as WorkflowDoc;
  assert.deepEqual(eventGuards(yamlGuard), ["shards/Test with coverage: if: github.event_name == 'pull_request'"]);
  const shellGuard = parseYaml(`
jobs:
  shards:
    if: always()
    steps:
      - run: |
          [ "\${GITHUB_EVENT_NAME}" = "pull_request" ] || exit 0
          node --test
`) as WorkflowDoc;
  assert.deepEqual(eventGuards(shellGuard), ["shards/step 1: run reads the event name"]);
  const jobGuard = parseYaml(`
jobs:
  merge:
    if: \${{ github.event_name != 'schedule' }}
`) as WorkflowDoc;
  assert.equal(eventGuards(jobGuard).length, 1);
  assert.deepEqual(eventGuards(parseYaml("jobs:\n  ok:\n    if: always()\n") as WorkflowDoc), []);
});

test("the nightly workflow is bounded, read-only and pinned", () => {
  const doc = loadWorkflow();
  assert.deepEqual(doc.permissions, { contents: "read" }, "least privilege: contents: read and nothing else");
  assert.equal(doc.concurrency?.["cancel-in-progress"], false, "a newer run must queue, never cancel a measurement in flight");
  assert.ok(doc.concurrency?.group, "runs must share one concurrency group");
  for (const [jobId, job] of jobsOf(doc)) {
    const minutes = job["timeout-minutes"];
    assert.ok(typeof minutes === "number" && minutes > 0 && minutes <= 60, `${jobId} must bound its runtime (got ${minutes})`);
    // W1-T5811: the one job that delivers a needs-human issue holds `issues: write`, and only it.
    const delivers = (job.steps ?? []).some((s) => s.run?.includes("needs-human-issue.mjs"));
    if (delivers) assert.deepEqual(job.permissions, { contents: "read", issues: "write" }, `${jobId} needs exactly issues: write`);
    else assert.equal(job.permissions, undefined, `${jobId} must not widen the read-only top-level permissions`);
    for (const s of job.steps ?? []) {
      if (s.uses === undefined) continue;
      assert.match(s.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${jobId}: ${s.uses} must be pinned to a full commit sha`);
    }
  }
});
