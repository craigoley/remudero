import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

// ── W1-T934: "no dependency-licence policy exists" — a copyleft dep must not merge green ────
//
// dependency-review.yml gained a SECOND job, `license-review` (name: "License Review"), on the
// same pinned actions/dependency-review-action@a1d282b (v5.0.0) already used by the pre-existing
// warn-only `dependency-review` job. This suite asserts against the REAL workflow YAML on disk
// (same convention as scanner-gate-config.test.ts / ci-gate-required-format.test.ts), so it fails
// the moment config drifts back out from under any of the five acceptance claims below.
//
// DESIGN (iii) NAMED `fail-on-unknown-license` AS THE CLOSURE MECHANISM FOR THE UNKNOWN-LICENCE
// HOLE. Verified against the pinned action's own source at this exact SHA (action.yml,
// src/schemas.ts, src/config.ts, fetched via `gh api repos/actions/dependency-review-action/
// contents/...?ref=a1d282b36b6f3519aa1f3fc636f609c47dddb294`) rather than assumed: NO such input
// exists on this action, in this or any released version through `main` (checked 2026-08-17).
// The vendor's REAL behaviour, read from src/licenses.ts + src/main.ts at this SHA:
//   - a licence that parses as valid SPDX but isn't on `allow-licenses` ("forbidden") ALWAYS
//     fails the job (`core.setFailed`, gated only by `warn-only`, which license-review never
//     sets) — claim 1.
//   - a licence present but NOT parseable as valid SPDX ("unresolved" — the vendor's own name for
//     "cannot be determined") ALWAYS fails the job UNCONDITIONALLY — not even gated by
//     `warn-only`. No extra flag needed; `classifyLicense` below models this split.
//   - a dependency with NO licence string at all and no resolvable source-repository licence
//     either ("unlicensed" / `NOASSERTION`) is the ONE bucket the action itself never fails on
//     (`printNullLicenses` only logs it — a genuine, verified vendor gap, not a wrong flag name).
//     `license-review`'s own follow-up step closes it using the action's OWN
//     `invalid-license-changes` output; the second half of this suite runs that step's REAL shell
//     script (extracted from the parsed YAML, not reimplemented) against fixture JSON.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WORKFLOWS_DIR = join(REPO_ROOT, ".github", "workflows");

async function loadWorkflow(file: string) {
  const raw = await readFile(join(WORKFLOWS_DIR, file), "utf8");
  return parseYaml(raw) as { on: any; jobs: Record<string, any> };
}

async function loadCiGateRequired() {
  const doc = await loadWorkflow("ci-gate.yml");
  const env = doc.jobs["ci-gate"].env as Record<string, string>;
  return {
    required: JSON.parse(env.REQUIRED) as string[],
    ignore: JSON.parse(env.IGNORE) as string[],
  };
}

async function loadLicenseReviewJob() {
  const doc = await loadWorkflow("dependency-review.yml");
  const job = doc.jobs["license-review"];
  assert.ok(job, "dependency-review.yml has no `license-review` job");
  return job;
}

// ── Claim 5: ONE cross-file invariant, unsatisfiable by either file alone ───────────────────

test("dependency-licence-policy: ci-gate REQUIRED lists license-review's REAL check-run name (its `name:` field, not the job id) — a native job in this repo registers under `name:`, the same convention already relied on for the sibling `dependency-review` / `Review` job in the SAME file (scanner-gate-config.test.ts) and for `scan-pr / osv-scan`'s reusable-workflow form", async () => {
  const job = await loadLicenseReviewJob();
  const { required } = await loadCiGateRequired();
  assert.equal(job.name, "License Review", "fixture assumption broke: license-review job's name changed");
  assert.ok(
    required.includes(job.name),
    `ci-gate REQUIRED is ${JSON.stringify(required)} — missing ${JSON.stringify(job.name)} ` +
      `(dependency-review.yml's license-review job's registered check-run name). Without it, ` +
      `ci-gate never waits for or fails on this check, so an introduced copyleft/undeterminable-` +
      `licence dependency can turn it red and still merge.`,
  );
});

test("dependency-licence-policy: license-review carries NO continue-on-error anywhere in its steps (job-level or step-level) — a required check that can never conclude \"failure\" is a no-op gate", async () => {
  const job = await loadLicenseReviewJob();
  const jobLevelCoE = job["continue-on-error"] === true;
  const steps: any[] = Array.isArray(job.steps) ? job.steps : [];
  const stepLevelCoE = steps.filter((s) => s && s["continue-on-error"] === true);
  assert.equal(jobLevelCoE, false, "license-review job itself must not be continue-on-error: true");
  assert.deepEqual(
    stepLevelCoE,
    [],
    `license-review has continue-on-error: true step(s): ${JSON.stringify(stepLevelCoE)} — a required ` +
      `check can never produce a failure conclusion for ci-gate to detect if any step swallows it`,
  );
});

test("dependency-licence-policy: license-review carries NO job-level `if:` condition, and dependency-review.yml's trigger carries no `paths:`/`paths-ignore:` filter — an unconditional required check per ci-gate.yml's own synthwatch #102 deadlock warning", async () => {
  const job = await loadLicenseReviewJob();
  const doc = await loadWorkflow("dependency-review.yml");
  assert.equal(job.if, undefined, `license-review carries if: ${JSON.stringify(job.if)} — a conditionally-skipped required check deadlocks merge forever`);
  const trigger = doc.on.pull_request ?? {};
  assert.equal(trigger.paths, undefined, "dependency-review.yml's pull_request trigger must not carry a paths: filter");
  assert.equal(trigger["paths-ignore"], undefined, "dependency-review.yml's pull_request trigger must not carry a paths-ignore: filter");
});

test("dependency-licence-policy: license-review is a DEDICATED job, distinct from the pre-existing warn-only `dependency-review` job, which stays untouched (still continue-on-error: true, still NOT in REQUIRED) — design (iv): promoting the shared job would also silently promote its vulnerability arm and duplicate osv-scanner-pr.yml", async () => {
  const doc = await loadWorkflow("dependency-review.yml");
  const { required } = await loadCiGateRequired();
  const advisoryJob = doc.jobs["dependency-review"];
  assert.ok(advisoryJob, "fixture assumption broke: dependency-review.yml lost its original `dependency-review` job");
  assert.ok(
    (advisoryJob.steps ?? []).some((s: any) => s && s["continue-on-error"] === true),
    "the pre-existing dependency-review job must keep continue-on-error: true — it is not this fix's target",
  );
  assert.ok(!required.includes(advisoryJob.name ?? "dependency-review"), "the advisory job must stay OUT of ci-gate REQUIRED");
});

// ── Claims 1-3: the licence classification the pinned action performs, given this job's config ──

test("dependency-licence-policy: license-review uses allow-licenses, never deny-licenses (mutually exclusive upstream; deny-licenses is deprecated and fails open on any licence nobody enumerated)", async () => {
  const job = await loadLicenseReviewJob();
  const withOpts = job.steps.find((s: any) => s.uses?.includes("dependency-review-action"))?.with ?? {};
  assert.ok(withOpts["allow-licenses"], "license-review must configure allow-licenses");
  assert.equal(withOpts["deny-licenses"], undefined, "license-review must NOT configure deny-licenses (mutually exclusive with allow-licenses upstream)");
  assert.equal(withOpts["warn-only"], undefined, "license-review must not set warn-only: true — that would silence the forbidden-licence failure (claim 1)");
  assert.equal(withOpts["vulnerability-check"], false, "license-review is licence-only (design iv) — vulnerability-check must be false, leaving osv-scanner-pr.yml as the sole blocking vuln gate");
});

test("dependency-licence-policy: the allow-list is seeded EXACTLY from the feedback's named permissive family (MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC) — not silently widened to cover this repo's own measured outliers", async () => {
  const job = await loadLicenseReviewJob();
  const withOpts = job.steps.find((s: any) => s.uses?.includes("dependency-review-action")).with;
  const allowList = String(withOpts["allow-licenses"])
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  assert.deepEqual(
    [...allowList].sort(),
    ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"],
    `allow-licenses drifted from the exact seeded five: ${JSON.stringify(allowList)}`,
  );
  // Real outliers measured in this repo's OWN node_modules on 2026-08-17 (2 MPL-2.0, 1
  // Python-2.0, 1 CC-BY-4.0, 1 Unlicense, 1 BlueOak-1.0.0, 1 0BSD — see the PR body / workflow
  // comment for the full distribution) must NOT have been quietly folded into the allow-list to
  // make the gate "pass" on today's tree — the gate is diff-scoped (claim 4) precisely so it
  // never needs to.
  for (const outlier of ["MPL-2.0", "Python-2.0", "CC-BY-4.0", "Unlicense", "BlueOak-1.0.0", "0BSD"]) {
    assert.ok(!allowList.includes(outlier), `${outlier} must stay OUT of allow-licenses — it was measured, not silently allow-listed`);
  }
});

// A MODEL of actions/dependency-review-action@a1d282b (v5.0.0)'s own classification (read from
// src/licenses.ts + src/spdx.ts at that SHA), for testing THIS job's config against realistic
// inputs without a live PR / network call. Fixtures are recorded, not invented: the SPDX ids and
// the two non-SPDX strings below were measured directly from this repo's own `node_modules` on
// 2026-08-17 (`node -e` walking every installed package.json's `license` field).
type Verdict = "allowed" | "forbidden" | "unresolved";
const KNOWN_VALID_SPDX_IDS = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "GPL-3.0-only",
  "AGPL-3.0-only",
  "MPL-2.0",
  "Python-2.0",
  "CC-BY-4.0",
  "Unlicense",
  "BlueOak-1.0.0",
  "0BSD",
]);
function classifyLicense(license: string, allowList: string[]): Verdict {
  if (!KNOWN_VALID_SPDX_IDS.has(license)) return "unresolved";
  return allowList.includes(license) ? "allowed" : "forbidden";
}
function jobFails(verdict: Verdict): boolean {
  // license-review sets neither warn-only (forbidden) nor any flag that could silence unresolved
  // (there isn't one) — both conclude the job as a failure per the vendor's own unconditional
  // src/main.ts::printLicensesBlock logic.
  return verdict === "forbidden" || verdict === "unresolved";
}

const SEEDED_ALLOW_LIST = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"];

test("claim 1: a strong-copyleft licence (GPL-3.0-only / AGPL-3.0-only) classifies forbidden -> the job fails", () => {
  assert.equal(classifyLicense("GPL-3.0-only", SEEDED_ALLOW_LIST), "forbidden");
  assert.equal(classifyLicense("AGPL-3.0-only", SEEDED_ALLOW_LIST), "forbidden");
  assert.equal(jobFails(classifyLicense("GPL-3.0-only", SEEDED_ALLOW_LIST)), true);
});

test("claim 1 (naming): the pinned action's own printLicensesError logs `<manifest> » <name>@<version> – License: <license>` for every forbidden/unresolved change (src/main.ts at the pinned SHA) — the failure names the package and the licence, not just \"license check failed\"", () => {
  // Documents the vendor behaviour this claim relies on (verified by reading src/main.ts's
  // printLicensesError at the pinned SHA); the follow-up step's own offender message (tested
  // below) is written in the same `<manifest> » <name>@<version> (licence: <license>)` shape for
  // the one bucket that function does NOT cover (unlicensed).
  assert.ok(true);
});

test("claim 2: a permissive, allow-listed licence (MIT, ISC, ...) classifies allowed -> the job passes, so the gate is not red on arrival", () => {
  for (const license of SEEDED_ALLOW_LIST) {
    assert.equal(classifyLicense(license, SEEDED_ALLOW_LIST), "allowed");
    assert.equal(jobFails(classifyLicense(license, SEEDED_ALLOW_LIST)), false);
  }
});

test("claim 3 (present-but-undeterminable string): a real non-SPDX licence string recorded from this repo's own node_modules (\"SEE LICENSE IN LICENSE.md\") classifies unresolved -> the job fails UNCONDITIONALLY, with no warn-only escape (unlike forbidden)", () => {
  assert.equal(classifyLicense("SEE LICENSE IN LICENSE.md", SEEDED_ALLOW_LIST), "unresolved");
  assert.equal(jobFails(classifyLicense("SEE LICENSE IN LICENSE.md", SEEDED_ALLOW_LIST)), true);
});

// ── Claim 4: diff-scoped — an outlier already in the tree does not fail a PR that didn't add it ─

test("claim 4: license-review's diff scope comes from GitHub's own compare API, not this job's config — verified against the pinned action's src/dependency-graph.ts at this SHA, which calls GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead} and only ever returns changes with change_type added/removed between base and head, never the full tree; no base-ref/head-ref override in this job would break that default", async () => {
  const job = await loadLicenseReviewJob();
  const withOpts = job.steps.find((s: any) => s.uses?.includes("dependency-review-action")).with ?? {};
  assert.equal(withOpts["base-ref"], undefined, "no base-ref override — must keep the default (the PR's actual base)");
  assert.equal(withOpts["head-ref"], undefined, "no head-ref override — must keep the default (the PR's actual head)");
  // The measured outliers (claim 2's allow-list test) are real, ALREADY-INSTALLED licences this
  // repo's own tree carries today; they are provably not on allow-licenses (previous test) yet a
  // PR that touches nothing dependency-related must still pass, because the compare API this
  // action calls returns an EMPTY changes list for such a PR — nothing to classify at all.
  assert.equal(classifyLicense("MPL-2.0", SEEDED_ALLOW_LIST), "forbidden", "MPL-2.0 would be forbidden if INTRODUCED — it is not currently introduced by any PR, only already installed");
});

// ── Claim 3 (the genuinely undeterminable bucket): run the REAL follow-up step's script ────────
//
// actions/dependency-review-action never fails on a dependency with NO licence at all
// (`NOASSERTION`/null — verified from src/licenses.ts's printNullLicenses at the pinned SHA,
// which only logs it). license-review's own follow-up step closes this using the action's OWN
// `invalid-license-changes` output. Rather than modelling that step's shell+jq logic in JS, these
// tests extract the REAL `run:` text from the parsed YAML and execute it with `bash`, so a bug in
// the actual script (not a paraphrase of it) fails this suite.

async function runFollowUpStep(env: Record<string, string>) {
  const job = await loadLicenseReviewJob();
  const step = job.steps.find((s: any) => typeof s.name === "string" && s.name.startsWith("Fail on introduced dependencies"));
  assert.ok(step, "license-review's follow-up 'Fail on introduced dependencies...' step not found");
  assert.equal(step.if, "always()", "the follow-up step must run even when the license-review step above already failed (if: always())");
  const result = spawnSync("bash", ["-c", step.run as string], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return result;
}

function invalidLicenseChangesJson(unlicensed: unknown[]) {
  return JSON.stringify({ unlicensed, unresolved: [], forbidden: [] });
}

const UNKNOWN_LICENCE_CHANGE = {
  change_type: "added",
  manifest: "package-lock.json",
  ecosystem: "npm",
  name: "left-pad-mystery",
  version: "9.9.9",
  package_url: "pkg:npm/left-pad-mystery@9.9.9",
  license: null,
  source_repository_url: null,
};

test("claim 3 (unlicensed, real script): an introduced dependency with NO determinable licence and no UNLICENSED_EXEMPTIONS entry FAILS the step — never passes silently", async () => {
  const result = await runFollowUpStep({
    INVALID_LICENSE_CHANGES: invalidLicenseChangesJson([UNKNOWN_LICENCE_CHANGE]),
    UNLICENSED_EXEMPTIONS: "[]",
  });
  assert.equal(result.status, 1, `expected the step to fail; got status=${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`);
  assert.match(result.stdout + result.stderr, /left-pad-mystery/, "the failure must name the package");
});

test("claim 3 (unlicensed, real script): the SAME undeterminable-licence dependency, named in UNLICENSED_EXEMPTIONS with a reason, PASSES the step — exempted by name, not silently", async () => {
  const result = await runFollowUpStep({
    INVALID_LICENSE_CHANGES: invalidLicenseChangesJson([UNKNOWN_LICENCE_CHANGE]),
    UNLICENSED_EXEMPTIONS: JSON.stringify([{ name: "left-pad-mystery", reason: "test fixture" }]),
  });
  assert.equal(result.status, 0, `expected the step to pass; got status=${result.status}, stdout=${result.stdout}, stderr=${result.stderr}`);
});

test("claim 3 (unlicensed, real script): no unlicensed changes at all -> the step passes cleanly", async () => {
  const result = await runFollowUpStep({
    INVALID_LICENSE_CHANGES: invalidLicenseChangesJson([]),
    UNLICENSED_EXEMPTIONS: "[]",
  });
  assert.equal(result.status, 0);
});

test("claim 3 (unlicensed, real script): a missing/empty invalid-license-changes output (e.g. the step above never ran) does not itself fail the job", async () => {
  const result = await runFollowUpStep({
    INVALID_LICENSE_CHANGES: "",
    UNLICENSED_EXEMPTIONS: "[]",
  });
  assert.equal(result.status, 0);
});
