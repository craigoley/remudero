import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// ── W1-T4399 — ABOUT 25 ONE-MINUTE GATES EACH START THEIR OWN RUNNER ────────────────────────
//
// commitlint, lint-plan, depcruise, claims, jscpd-gate, dashboard, comment-load-ratchet and ~10
// more each used to be their own ci.yml job: its own checkout, its own `npm ci`, its own
// rounded-up-to-a-minute runner (~228k job-min/month, MEASURED 2026-09-23). Design: (i) they run
// here as STEPS of one job (`commitlint`, expanded in place — see its own header comment for why
// it keeps that job key), each `continue-on-error: true`, and the job's own final step posts
// EVERY gate's result as its OWN check run via the checks API, under the exact name ci-gate.yml's
// REQUIRED list and branch protection already use — so no required context disappears. (ii) A
// gate with its own heavy setup (coverage-ratchet's matrix, mutation-ratchet's Stryker cache)
// stays its own job, untouched. (iii) `continue-on-error` means one step failing never skips the
// next — every step always runs and always reports.
//
// This suite reads the REAL ci.yml and ci-gate.yml on disk — never a copy-pasted fixture — so a
// later edit to either workflow is what these tests actually check.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CI_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const CI_GATE_YAML_PATH = join(REPO_ROOT, ".github", "workflows", "ci-gate.yml");

type CiStep = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
};
type CiDoc = { jobs: Record<string, { if?: string | boolean; steps?: CiStep[] }> };

function loadCiDoc(): CiDoc {
  return parseYaml(readFileSync(CI_YAML_PATH, "utf8")) as CiDoc;
}

function loadCiGateRequired(): string[] {
  const doc = parseYaml(readFileSync(CI_GATE_YAML_PATH, "utf8")) as {
    jobs: Record<string, { env?: Record<string, string> }>;
  };
  const raw = doc.jobs["ci-gate"]?.env?.REQUIRED;
  assert.equal(typeof raw, "string", "ci-gate.yml must carry a ci-gate.env.REQUIRED string");
  const parsed: unknown = JSON.parse(raw!);
  assert.ok(Array.isArray(parsed), "ci-gate.yml's REQUIRED must be a JSON array");
  return parsed as string[];
}

// Every REQUIRED name this task moved off its own job and onto a step of `commitlint`.
const MOVED_GATE_NAMES = [
  "commitlint",
  "leak-grep",
  "learnings-budget-ratchet",
  "jscpd-gate",
  "claims",
  "assertion-discrimination",
  "lint-plan",
  "depcruise",
  "containment-probe",
  "api-client-drift",
  "no-hand-rolled-fetch",
  "prompt-surface-gate",
  "task-id-existence",
  "source-size",
  "comment-load-ratchet",
  "baseline-monotonic",
];

test("W1-T4399: the light gates run as steps of one job", () => {
  const doc = loadCiDoc();
  const job = doc.jobs.commitlint;
  assert.ok(job, "ci.yml must declare a commitlint job — the shared runner for the moved gates");
  const steps = job!.steps ?? [];

  // Every moved gate (or one of its constituent steps, for a gate that used to be several steps
  // of its own job) must be present, as a STEP, with continue-on-error: true — so one gate
  // failing never skips the next (design (iii)).
  const stepIdsWithContinueOnError = new Set(
    steps.filter((s) => s["continue-on-error"] === true && typeof s.id === "string").map((s) => s.id!),
  );
  assert.ok(
    stepIdsWithContinueOnError.size >= 15,
    `expected at least 15 continue-on-error steps consolidated onto the commitlint job, found ${stepIdsWithContinueOnError.size}: ${[...stepIdsWithContinueOnError].join(", ")}`,
  );
  for (const name of MOVED_GATE_NAMES) {
    // A gate that split into several steps (depcruise -> depcruise + cycle-ratchet;
    // comment-load-ratchet -> four steps) is still represented by at least one continue-on-error
    // step whose id starts with its own name.
    const present = [...stepIdsWithContinueOnError].some((id) => id === name || id.startsWith(name));
    assert.ok(present, `expected a continue-on-error step for '${name}' inside the commitlint job, found ids: ${[...stepIdsWithContinueOnError].join(", ")}`);
  }

  // The job itself runs unconditionally on a pull_request event (never a class- or path-based
  // job-level if:, which would strand every gate it hosts absent — the #729/skipped-check-
  // deadlock class ci-gate.yml's own header names).
  assert.equal(job!.if, "github.event_name == 'pull_request'", "the commitlint job must stay a plain PR guard at the JOB level");

  // The moved gates' own former job keys stay registered (ci-parity.ts parity, see ci.yml's own
  // comment) but permanently skipped, never queuing a second runner for the same work.
  for (const name of ["leak-grep", "learnings-budget-ratchet", "jscpd-gate", "dashboard", "claims", "assertion-discrimination", "lint-plan", "depcruise", "containment-probe", "api-client-drift", "no-hand-rolled-fetch", "prompt-surface-gate", "task-id-existence", "source-size", "comment-load-ratchet", "baseline-monotonic"]) {
    const stub = doc.jobs[name];
    assert.ok(stub, `ci.yml must still declare the '${name}' job key (ci-parity.ts still expects it)`);
    assert.equal(stub!.if, false, `'${name}'s own job key must be permanently skipped (if: false) — it no longer starts its own runner`);
  }
});

test("W1-T4399: every required gate still reports under its own name", () => {
  const required = loadCiGateRequired();
  const doc = loadCiDoc();
  const job = doc.jobs.commitlint;
  assert.ok(job, "ci.yml must declare a commitlint job");
  const steps = job!.steps ?? [];

  // The reporting step is the job's own always-run finisher: it must exist, run unconditionally,
  // and post via the real checks API (never merely log a result nothing else observes).
  const reportStep = steps.at(-1);
  assert.equal(reportStep?.if, "always()", "the reporting step must run even when an earlier gate step failed or was skipped");
  const reportRun = reportStep?.run ?? "";
  assert.match(reportRun, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/check-runs"/, "the reporting step must post a real check run via the checks API");

  // FALSIFIER (this task's own): dropping the per-gate check-run report for a name still in
  // ci-gate.yml's REQUIRED list must be caught here — a required context no job (native OR
  // checks-API) produces is exactly the synthwatch #102 deadlock class this task must not
  // reintroduce.
  const namesRequiredButNoLongerNativelyProduced = MOVED_GATE_NAMES.filter((name) => required.includes(name));
  assert.ok(namesRequiredButNoLongerNativelyProduced.length > 0, "sanity: at least one moved gate must still be REQUIRED, or this test proves nothing");
  for (const name of namesRequiredButNoLongerNativelyProduced) {
    assert.match(
      reportRun,
      new RegExp(`report\\s+"${name}"`),
      `REQUIRED names "${name}", but its own ci.yml job is permanently skipped (if: false) and the ` +
        `reporting step carries no 'report "${name}"' call — this required context would never be ` +
        `produced by anything, the exact gap this task's falsifier names`,
    );
  }
});
