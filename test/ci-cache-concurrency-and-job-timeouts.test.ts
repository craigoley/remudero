import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── R-50: cache npm, cancel superseded PR runs, bound every job with a timeout ─────────────
//
// docs/audits/recon-2026-09-05.md's R-50 measured (at f7ceb86): 17 workflow files, 34 jobs; a
// typical PR runs 32 jobs with 23 cold `npm ci` runs; all 16 `actions/setup-node` uses in
// ci.yml (24 across the whole fleet) carried no `cache:`; ci.yml had no `concurrency:` group,
// so a force-push mid-run cancelled nothing; 10 PR-firing jobs carried no `timeout-minutes`.
//
// This suite reads the real workflow files on disk — never a copy-pasted fixture — so a later
// edit to any of them is what these assertions actually read. Scoped to the fleet-wide
// invariants this task adds; test/workflow-job-timeouts.test.ts already owns ci.yml's own
// heavy/light timeout BAND (a narrower, pre-existing concern) and is unchanged by this file.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");
const CI_YAML_PATH = join(WORKFLOWS_DIR, "ci.yml");
const CI_GATE_YAML_PATH = join(WORKFLOWS_DIR, "ci-gate.yml");

type WorkflowStep = { uses?: string; with?: Record<string, unknown> };
type WorkflowJob = {
  "timeout-minutes"?: number;
  uses?: string; // a job whose body IS a reusable-workflow call — no timeout-minutes is valid there
  steps?: WorkflowStep[];
};
type WorkflowDoc = {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs: Record<string, WorkflowJob>;
};

async function loadWorkflowFiles(): Promise<Array<{ file: string; doc: WorkflowDoc }>> {
  const names = (await readdir(WORKFLOWS_DIR)).filter((f) => f.endsWith(".yml"));
  assert.ok(names.length >= 15, `expected at least the 15+ workflow files on record, got ${names.length}`);
  const out: Array<{ file: string; doc: WorkflowDoc }> = [];
  for (const name of names) {
    const raw = await readFile(join(WORKFLOWS_DIR, name), "utf8");
    out.push({ file: name, doc: parseYaml(raw) as WorkflowDoc });
  }
  return out;
}

// ── acceptance 1: every actions/setup-node use, across every workflow file, caches npm ─────

test("R-50: every actions/setup-node use across the whole workflow fleet declares cache: npm", async () => {
  const files = await loadWorkflowFiles();
  let setupNodeUses = 0;
  for (const { file, doc } of files) {
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/setup-node@")) continue;
        setupNodeUses += 1;
        assert.equal(
          step.with?.cache,
          "npm",
          `${file}: job '${jobId}'s actions/setup-node step has no cache: npm — every PR pays for a cold ` +
            "npm ci with no lockfile-keyed cache to warm it from",
        );
      }
    }
  }
  assert.ok(setupNodeUses >= 20, `expected at least the 24 actions/setup-node uses on record, got ${setupNodeUses}`);
});

// ── acceptance 2: ci.yml declares a concurrency group that cancels only PR runs ─────────────

test("R-50: ci.yml declares a concurrency group, PR-only cancel-in-progress", async () => {
  const raw = await readFile(CI_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as WorkflowDoc;
  assert.ok(doc.concurrency, "ci.yml must declare a top-level concurrency block");
  assert.equal(
    doc.concurrency!.group,
    "ci-${{ github.event.pull_request.number || github.ref }}",
    "ci.yml's concurrency group must key on the PR number (falling back to the ref for a push), " +
      "so a PR's own runs share one group and a push-to-main run shares a different one",
  );
  assert.equal(
    doc.concurrency!["cancel-in-progress"],
    "${{ github.event_name == 'pull_request' }}",
    "cancel-in-progress must be conditioned on the event being a pull_request — a PR's superseded " +
      "run should cancel, but a push-to-main run (the only lane that runs the full suite against " +
      "main and the only coverage-ratchet run that reaches the fleet) must never cancel a sibling",
  );
  // The literal string must also appear in the raw text — guards against a parser normalising
  // an equivalent-looking but differently-spelled expression into the same JS value.
  assert.ok(raw.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"));
});

// ── acceptance 3: every job in every PR-firing workflow declares timeout-minutes ───────────

/** A workflow "fires on a PR" when its `on:` block declares a `pull_request` trigger at all —
 *  path-filtered or not, since a path-filtered PR trigger still runs a job that can hang. */
function firesOnPullRequest(doc: WorkflowDoc): boolean {
  return Object.prototype.hasOwnProperty.call(doc.on ?? {}, "pull_request");
}

test("R-50: every job in every PR-firing workflow declares a positive timeout-minutes", async () => {
  const files = await loadWorkflowFiles();
  const prFiring = files.filter(({ doc }) => firesOnPullRequest(doc));
  assert.ok(prFiring.length >= 10, `expected at least 10 PR-firing workflow files, got ${prFiring.length}`);

  let checked = 0;
  for (const { file, doc } of prFiring) {
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      if (typeof job.uses === "string") {
        // A job whose body is a reusable-workflow call accepts no timeout-minutes key at all
        // (GitHub Actions schema: name/uses/with/secrets/needs/if/permissions/strategy only) —
        // adding one here would be invalid YAML for this job shape, not a stricter bound.
        continue;
      }
      checked += 1;
      const value = job["timeout-minutes"];
      assert.ok(
        typeof value === "number" && Number.isFinite(value) && value > 0,
        `${file}: job '${jobId}' (a PR-firing workflow) has no positive timeout-minutes (got ` +
          `${JSON.stringify(value)}) — it would inherit GitHub's 360-minute default`,
      );
    }
  }
  assert.ok(checked >= 25, `expected at least 25 non-reusable-workflow jobs checked, got ${checked}`);
});

// ── acceptance 4: ci-gate's own timeout exceeds its WAIT_CAP_SECONDS + grace, in minutes ───

test("R-50: ci-gate.yml's job timeout exceeds WAIT_CAP_SECONDS + GRACE_WINDOW_SECONDS", async () => {
  const raw = await readFile(CI_GATE_YAML_PATH, "utf8");
  const doc = parseYaml(raw) as {
    jobs: Record<string, { "timeout-minutes"?: number; env?: Record<string, string> }>;
  };
  const gate = doc.jobs["ci-gate"];
  assert.ok(gate, "ci-gate.yml must declare a `ci-gate` job");

  const waitCapSeconds = Number(gate!.env?.WAIT_CAP_SECONDS);
  const graceWindowSeconds = Number(gate!.env?.GRACE_WINDOW_SECONDS);
  assert.ok(
    Number.isFinite(waitCapSeconds) && waitCapSeconds > 0,
    `ci-gate.yml must declare a positive env.WAIT_CAP_SECONDS, got ${gate!.env?.WAIT_CAP_SECONDS}`,
  );
  assert.ok(
    Number.isFinite(graceWindowSeconds) && graceWindowSeconds > 0,
    `ci-gate.yml must declare a positive env.GRACE_WINDOW_SECONDS, got ${gate!.env?.GRACE_WINDOW_SECONDS}`,
  );

  const timeoutMinutes = gate!["timeout-minutes"];
  assert.ok(
    typeof timeoutMinutes === "number" && Number.isFinite(timeoutMinutes) && timeoutMinutes > 0,
    `ci-gate.yml's ci-gate job has no positive timeout-minutes (got ${JSON.stringify(timeoutMinutes)})`,
  );

  const derivedFloorMinutes = (waitCapSeconds + graceWindowSeconds) / 60;
  assert.ok(
    timeoutMinutes! > derivedFloorMinutes,
    `ci-gate's timeout-minutes (${timeoutMinutes}m) must exceed WAIT_CAP_SECONDS + GRACE_WINDOW_SECONDS ` +
      `expressed in minutes (${derivedFloorMinutes}m = ${waitCapSeconds}s + ${graceWindowSeconds}s) — ` +
      "below that, the job's own external timeout can fire before its internal wait+grace logic ever " +
      "concludes, misattributing a slow-but-honest run as a hung job",
  );
});
