import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

// ── W1-T1250: every workflow's node-test-runner invocation must carry the fixture harness ──
//
// `containment-probe` (.github/workflows/ci.yml) ran
// `node --test --import tsx test/containment.test.ts` — no `--import ./test/setup/tmp-hygiene.ts`
// — while `src/lib/ci-parity.ts`'s `containment-probe:test` step mirrors that same file WITH the
// harness import (its own `TMP_HYGIENE_IMPORT` constant, W1-T131/W1-T1217). `containment-probe`
// is in `.github/workflows/ci-gate.yml`'s REQUIRED list, so a harness-dependent assertion could
// pass under `rmd preflight --ci-parity` and still fail on the required check — preflight was
// richer than CI, backwards from every other site of this class (#2523/W1-T1217 fixed the
// identical drift at `coverage-ratchet`).
//
// This suite reads every `.github/workflows/*.yml` file on disk — never a copy-pasted fixture —
// so a later edit to any workflow, or a brand-new workflow, is what this suite actually checks.
// `src/lib/ci-parity.ts` is deliberately NOT read or edited here: it already carries the correct
// invocation, and ci.yml's own coverage-ratchet comment warns against "completing" parity by
// editing that file instead of the workflow (that edit re-creates a Rule 25
// instrument/product pairing). Bringing the workflow into line with ci-parity is what makes the
// two agree, so this suite proves the workflow SIDE without ever depending on the file whose
// correctness caused the drift to matter.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");
const HARNESS_IMPORT = "--import ./test/setup/tmp-hygiene.ts";

// The node test runner is invoked with a literal `--test` FLAG (whitespace on both sides in the
// shell string) — never matched against `--test-coverage-exclude`/`--test-reporter=...`, which
// contain the substring "--test" but are not the runner-selection flag itself. This is what lets
// `coverage-ratchet`'s multi-line, coverage-flag-laden invocation be recognized as a real
// node-test-runner call without also tripping on its own coverage flags.
const TEST_RUNNER_FLAG_RE = /(^|\s)--test(\s|$)/;

type CiStep = { name?: string; run?: string };
type CiJob = { name?: string; steps?: CiStep[] };
type CiWorkflow = { jobs?: Record<string, CiJob> };

type RealInvocation = {
  file: string;
  jobId: string;
  stepName: string;
  run: string;
};

async function loadWorkflowFiles(): Promise<string[]> {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();
}

/** Every step, across every `.github/workflows/*.yml` file, whose `run` script actually invokes
 * the node test runner (a literal `--test` flag) — matched by content, never by a hardcoded
 * job-name list, so this suite would catch a brand-new site growing the same drift. Steps that
 * merely pass `--import tsx` to run a plain script (e.g. `main-plan-guard.yml`'s
 * `node --import tsx -e '...'`, `acceptance-author-gate.yml`'s
 * `node --import tsx scripts/acceptance-author-gate.mjs`) are NOT test-runner invocations and are
 * correctly excluded — they have no test-only fixtures to load. */
async function findRealInvocations(): Promise<RealInvocation[]> {
  const files = await loadWorkflowFiles();
  const found: RealInvocation[] = [];
  for (const file of files) {
    const raw = await readFile(join(WORKFLOWS_DIR, file), "utf8");
    const doc = parseYaml(raw) as CiWorkflow;
    for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        const run = step.run;
        if (typeof run !== "string") continue;
        if (!TEST_RUNNER_FLAG_RE.test(run)) continue;
        found.push({ file, jobId, stepName: step.name ?? "(unnamed step)", run });
      }
    }
  }
  return found;
}

// ── acceptance 3 (checked first): the scan proves it SAW the real invocations ──────────────
//
// `--import tsx` is present on every real node-test-runner invocation in this repo (it is how
// each one loads TypeScript sources) and is the control this scan is verified against, per the
// task's own design note (iii): a scan that matched zero steps would report "clean" over an
// empty set, which is indistinguishable from a scan that genuinely found nothing wrong.

test("W1-T1250: the scan sees the real node-test-runner invocations, not an empty set", async () => {
  const invocations = await findRealInvocations();
  assert.ok(
    invocations.length >= 5,
    `expected at least the 5 node-test-runner invocations known at filing time ` +
      `(clock-sweep.yml x2, ci.yml coverage-ratchet + containment-probe, recovery-drill.yml), ` +
      `got ${invocations.length}: ${JSON.stringify(invocations.map((i) => `${i.file}:${i.jobId}`))}`,
  );

  // Every real invocation this scan finds must carry the `--import tsx` control -- if one didn't,
  // the regex above would be matching something that isn't actually a node-test-runner call.
  for (const inv of invocations) {
    assert.ok(
      inv.run.includes("--import tsx"),
      `${inv.file}:${inv.jobId} ('${inv.stepName}') matched the --test flag but not the --import ` +
        `tsx control -- the TEST_RUNNER_FLAG_RE regex may be over-matching`,
    );
  }

  // The specific job this task fixes must be among what the scan found -- guards against the
  // regex accidentally excluding containment-probe itself.
  assert.ok(
    invocations.some((i) => i.file === "ci.yml" && i.jobId === "containment-probe"),
    "expected the scan to see ci.yml's containment-probe step",
  );
});

// ── acceptance 1 & 2: every real invocation carries the harness import, including the ─────────
//    containment probe's required-check invocation matching ci-parity's local mirror ──────────

test("W1-T1250: every workflow's node-test-runner invocation carries the fixture harness import", async () => {
  const invocations = await findRealInvocations();
  assert.ok(invocations.length > 0, "no node-test-runner invocations found -- scan is broken");

  for (const inv of invocations) {
    assert.ok(
      inv.run.includes(HARNESS_IMPORT),
      `${inv.file}:${inv.jobId} ('${inv.stepName}') invokes the node test runner without ` +
        `'${HARNESS_IMPORT}' -- a harness-dependent assertion (e.g. the tmp-dir reaper or the ` +
        `GIT_CONFIG_* pair, both from test/setup/tmp-hygiene.ts) can pass under a richer local ` +
        `run and fail here. Run: ${JSON.stringify(inv.run)}`,
    );
  }
});

test("W1-T1250: containment-probe's required-check invocation matches what ci-parity mirrors locally", async () => {
  const invocations = await findRealInvocations();
  const containmentProbe = invocations.find(
    (i) => i.file === "ci.yml" && i.jobId === "containment-probe",
  );
  assert.ok(containmentProbe, "expected ci.yml to still define a containment-probe job with a node-test-runner step");

  // src/lib/ci-parity.ts's TMP_HYGIENE_IMPORT constant is "./test/setup/tmp-hygiene.ts" and its
  // containment-probe:test step invokes exactly
  // `node --test --import tsx --import ./test/setup/tmp-hygiene.ts test/containment.test.ts`
  // (read directly at review time -- not re-read here, since that file is deliberately out of
  // scope for this task and this assertion must not depend on it staying byte-identical to pass).
  // What's asserted is the property that made the two disagree: the REQUIRED check's own script
  // must run the same file with the same flags ci-parity already predicts it runs with.
  assert.ok(
    containmentProbe!.run.includes("--test"),
    "containment-probe must invoke the node test runner",
  );
  assert.ok(
    containmentProbe!.run.includes("--import tsx"),
    "containment-probe must load TypeScript sources via --import tsx, same as ci-parity's mirror",
  );
  assert.ok(
    containmentProbe!.run.includes(HARNESS_IMPORT),
    "containment-probe must load the fixture harness via --import ./test/setup/tmp-hygiene.ts, " +
      "same as ci-parity's mirror -- this is the exact line that drifted",
  );
  assert.ok(
    containmentProbe!.run.includes("test/containment.test.ts"),
    "containment-probe must still target test/containment.test.ts, same file ci-parity mirrors",
  );
});
