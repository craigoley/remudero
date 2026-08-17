import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_ALLOW_LICENSES,
  classifyLicense,
  collectLockPackages,
  diffAdded,
  evaluate,
} from "../scripts/check-dependency-licences.mjs";

// ── W1-T934: "no dependency-licence policy exists" — a copyleft dep must not merge green ────
//
// ROUND 1 wired `license-review` (name: "License Review", dependency-review.yml) to
// actions/dependency-review-action, keyed on GitHub's own dependency-graph `compare` API. That
// API 403s on this repository (confirmed via `gh api .../dependency-graph/{compare,sbom}` —
// see the job's own comment in dependency-review.yml for the full trail), and the vendor action
// has no fallback that avoids it, so the check could never pass here no matter its config. This
// round replaces the MECHANISM (not the acceptance shape) with scripts/check-dependency-
// licences.mjs, a self-contained `package-lock.json`-diffing gate that needs no GitHub API call.
// This suite tests: (A) the script's pure functions directly (the real classification/diff logic,
// not a paraphrase), and (B) the workflow YAML wiring that makes `license-review` a required,
// unconditional, non-continue-on-error check invoking that script.

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

// ── Workflow wiring: the five properties that make this a real, unconditional, required gate ──

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

test("dependency-licence-policy: license-review does NOT depend on actions/dependency-review-action (its GitHub-hosted dependency-graph compare API 403s on this repository — see the job's own comment) — it runs scripts/check-dependency-licences.mjs with fetch-depth: 0", async () => {
  const job = await loadLicenseReviewJob();
  const steps: any[] = Array.isArray(job.steps) ? job.steps : [];
  assert.ok(
    !steps.some((s) => typeof s?.uses === "string" && s.uses.includes("dependency-review-action")),
    "license-review must not use actions/dependency-review-action — its dependency-graph compare API is unavailable on this repository",
  );
  const checkoutStep = steps.find((s) => typeof s?.uses === "string" && s.uses.startsWith("actions/checkout"));
  assert.ok(checkoutStep, "license-review must check out the repo");
  assert.equal(checkoutStep.with?.["fetch-depth"], 0, "checkout needs full history (fetch-depth: 0) to diff base..head lockfiles");
  const scriptStep = steps.find((s) => typeof s?.run === "string" && s.run.includes("check-dependency-licences.mjs"));
  assert.ok(scriptStep, "license-review must invoke scripts/check-dependency-licences.mjs");
  assert.match(scriptStep.run, /--base "\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}"/, "must diff against the PR's real base sha");
  assert.match(scriptStep.run, /--head "\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}"/, "must diff against the PR's real head sha");
});

test("dependency-licence-policy: the allow-list is seeded EXACTLY from the feedback's named permissive family (MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC) — not silently widened to cover this repo's own measured outliers", async () => {
  const job = await loadLicenseReviewJob();
  const scriptStep = job.steps.find((s: any) => typeof s.env?.ALLOW_LICENSES === "string");
  assert.ok(scriptStep, "license-review's script step must set ALLOW_LICENSES");
  const allowList = String(scriptStep.env.ALLOW_LICENSES)
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  assert.deepEqual(
    [...allowList].sort(),
    ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"],
    `ALLOW_LICENSES drifted from the exact seeded five: ${JSON.stringify(allowList)}`,
  );
  assert.deepEqual([...DEFAULT_ALLOW_LICENSES].sort(), ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"]);
  // Real outliers measured in this repo's OWN node_modules on 2026-08-17 (2 MPL-2.0, 1
  // Python-2.0, 1 CC-BY-4.0, 1 Unlicense, 1 BlueOak-1.0.0, 1 0BSD — see the PR body / workflow
  // comment for the full distribution) must NOT have been quietly folded into the allow-list to
  // make the gate "pass" on today's tree — the gate is diff-scoped (claim 4) precisely so it
  // never needs to.
  for (const outlier of ["MPL-2.0", "Python-2.0", "CC-BY-4.0", "Unlicense", "BlueOak-1.0.0", "0BSD"]) {
    assert.ok(!allowList.includes(outlier), `${outlier} must stay OUT of ALLOW_LICENSES — it was measured, not silently allow-listed`);
  }
});

// ── The script's own classification (claims 1-3) — the REAL function, not a model of it ───────

const SEEDED_ALLOW_LIST = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC"];

test("claim 1: a strong-copyleft licence (GPL-3.0-only / AGPL-3.0-only) classifies forbidden -> the gate fails, and is NEVER exemptable", () => {
  assert.equal(classifyLicense("GPL-3.0-only", SEEDED_ALLOW_LIST), "forbidden");
  assert.equal(classifyLicense("AGPL-3.0-only", SEEDED_ALLOW_LIST), "forbidden");
  const added = [{ name: "copyleft-pkg", version: "1.0.0", license: "GPL-3.0-only" }];
  const { offenders, undetermined } = evaluate(added, {
    allowList: SEEDED_ALLOW_LIST,
    exemptions: [{ name: "copyleft-pkg", reason: "attempted exemption — must not work" }],
  });
  assert.equal(offenders.length, 1, "a forbidden licence must fail even when the package is named in exemptions");
  assert.equal(undetermined.length, 0);
});

test("claim 2: a permissive, allow-listed licence (MIT, ISC, ...), including an `A OR B` / `A AND B` SPDX expression built only from allow-listed clauses, classifies allowed -> the gate passes", () => {
  for (const license of SEEDED_ALLOW_LIST) {
    assert.equal(classifyLicense(license, SEEDED_ALLOW_LIST), "allowed");
  }
  assert.equal(classifyLicense("Apache-2.0 AND MIT", SEEDED_ALLOW_LIST), "allowed");
  assert.equal(classifyLicense("(MIT OR GPL-3.0-only)", SEEDED_ALLOW_LIST), "allowed", "an OR expression is allowed if ANY clause is allow-listed");
  const added = SEEDED_ALLOW_LIST.map((license, i) => ({ name: `pkg-${i}`, version: "1.0.0", license }));
  const { offenders, undetermined, allowed } = evaluate(added, { allowList: SEEDED_ALLOW_LIST, exemptions: [] });
  assert.equal(offenders.length, 0);
  assert.equal(undetermined.length, 0);
  assert.equal(allowed.length, SEEDED_ALLOW_LIST.length);
});

test("claim 3 (present-but-undeterminable string): a real non-SPDX licence string recorded from this repo's own node_modules (\"SEE LICENSE IN LICENSE.md\") classifies unresolved -> the gate fails UNLESS the package is named in LICENSE_EXEMPTIONS with a reason", () => {
  assert.equal(classifyLicense("SEE LICENSE IN LICENSE.md", SEEDED_ALLOW_LIST), "unresolved");
  const added = [{ name: "mystery-pkg", version: "2.0.0", license: "SEE LICENSE IN LICENSE.md" }];
  const unexempted = evaluate(added, { allowList: SEEDED_ALLOW_LIST, exemptions: [] });
  assert.equal(unexempted.offenders.length, 0, "unresolved is never a 'forbidden' offender — it's undeterminable");
  assert.equal(unexempted.undetermined.length, 1);
  const exempted = evaluate(added, { allowList: SEEDED_ALLOW_LIST, exemptions: [{ name: "mystery-pkg", reason: "manually reviewed" }] });
  assert.equal(exempted.undetermined.length, 0, "an exempted package passes");
  assert.equal(exempted.allowed.length, 1);
});

test("claim 3b (no licence field at all): a `null` licence classifies no-license -> the gate fails UNLESS the package is named in LICENSE_EXEMPTIONS with a reason — the ONE bucket the old vendor-action approach never failed on (design iii)", () => {
  assert.equal(classifyLicense(null, SEEDED_ALLOW_LIST), "no-license");
  assert.equal(classifyLicense(undefined, SEEDED_ALLOW_LIST), "no-license");
  const added = [{ name: "left-pad-mystery", version: "9.9.9", license: null }];
  const unexempted = evaluate(added, { allowList: SEEDED_ALLOW_LIST, exemptions: [] });
  assert.equal(unexempted.undetermined.length, 1);
  assert.equal(unexempted.undetermined[0].name, "left-pad-mystery");
  const exempted = evaluate(added, { allowList: SEEDED_ALLOW_LIST, exemptions: [{ name: "left-pad-mystery", reason: "test fixture" }] });
  assert.equal(exempted.undetermined.length, 0);
});

// ── Claim 4: diff-scoped — an outlier already in the tree does not fail a PR that didn't add it ─

test("claim 4: diffAdded returns ONLY name@version pairs present at head but absent at base — an outlier licence already installed at BOTH base and head never appears, so a PR that doesn't touch it can't be failed by it", () => {
  const base = collectLockPackages({
    packages: {
      "": {},
      "node_modules/already-installed-outlier": { version: "1.0.0", license: "MPL-2.0" },
      "node_modules/mit-pkg": { version: "1.0.0", license: "MIT" },
    },
  });
  const head = collectLockPackages({
    packages: {
      "": {},
      "node_modules/already-installed-outlier": { version: "1.0.0", license: "MPL-2.0" },
      "node_modules/mit-pkg": { version: "1.0.0", license: "MIT" },
      "node_modules/newly-added": { version: "2.0.0", license: "GPL-3.0-only" },
    },
  });
  const added = diffAdded(base, head);
  assert.deepEqual(
    added.map((d) => d.name),
    ["newly-added"],
    "only the genuinely NEW dependency should appear in the diff",
  );
  assert.equal(added[0].license, "GPL-3.0-only");
});

test("claim 4b: a version bump of an ALREADY-allowed package (base has v1 MIT, head has v2 MIT) is treated as newly introduced (matches the vendor compare API's own added/removed-by-version semantics), and still passes because v2 is also allow-listed", () => {
  const base = collectLockPackages({ packages: { "": {}, "node_modules/bumped": { version: "1.0.0", license: "MIT" } } });
  const head = collectLockPackages({ packages: { "": {}, "node_modules/bumped": { version: "2.0.0", license: "MIT" } } });
  const added = diffAdded(base, head);
  assert.deepEqual(added, [{ name: "bumped", version: "2.0.0", license: "MIT" }]);
  const { offenders, undetermined } = evaluate(added, { allowList: SEEDED_ALLOW_LIST, exemptions: [] });
  assert.equal(offenders.length, 0);
  assert.equal(undetermined.length, 0);
});

test("collectLockPackages: workspace-member entries (no `version`, e.g. this repo's own apps/*) and the root `\"\"` entry are excluded — they are not third-party dependencies", () => {
  const lock = collectLockPackages({
    packages: {
      "": { name: "remudero" },
      "apps/dashboard": { name: "@remudero/dashboard" },
      "node_modules/real-dep": { version: "1.0.0", license: "MIT" },
    },
  });
  assert.deepEqual([...lock.keys()], ["real-dep@1.0.0"]);
});

test("collectLockPackages: a scoped package name is derived from the LAST `node_modules/` segment of its map key, even nested arbitrarily deep — matches how npm lockfileVersion-3 keys deduped/nested packages", () => {
  const lock = collectLockPackages({
    packages: {
      "": {},
      "node_modules/foo/node_modules/@scope/bar": { version: "3.0.0", license: "ISC" },
    },
  });
  assert.deepEqual([...lock.keys()], ["@scope/bar@3.0.0"]);
});

// ── End-to-end: the REAL script, invoked as a subprocess against a throwaway git fixture repo ──
//
// Builds a tiny real git repo with two commits (base, head) each carrying its own
// package-lock.json, then runs `node scripts/check-dependency-licences.mjs --base <sha> --head
// <sha>` exactly as the workflow step does — the actual CLI entry point, not just its exported
// functions.

async function makeFixtureRepo() {
  const dir = await mkdtemp(join(tmpdir(), "license-gate-fixture-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  return { dir, git };
}

async function writeLockAndCommit(dir: string, git: (...a: string[]) => string, packages: Record<string, unknown>, message: string) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }, null, 2));
  git("add", "package-lock.json");
  git("commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD").trim();
}

test("end-to-end: the REAL CLI exits non-zero and names the package when a copyleft dependency is introduced between base and head", async () => {
  const { dir, git } = await makeFixtureRepo();
  try {
    const baseSha = await writeLockAndCommit(dir, git, { "node_modules/mit-pkg": { version: "1.0.0", license: "MIT" } }, "base");
    const headSha = await writeLockAndCommit(
      dir,
      git,
      {
        "node_modules/mit-pkg": { version: "1.0.0", license: "MIT" },
        "node_modules/copyleft-pkg": { version: "1.0.0", license: "GPL-3.0-only" },
      },
      "head",
    );
    const result = execFileSync(
      "node",
      [join(REPO_ROOT, "scripts", "check-dependency-licences.mjs"), "--base", baseSha, "--head", headSha],
      { cwd: dir, encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    assert.fail(`expected the CLI to exit non-zero; stdout: ${result}`);
  } catch (err: any) {
    assert.equal(err.status, 1, `expected exit 1; got ${err.status}, stderr: ${err.stderr}`);
    assert.match(String(err.stderr), /copyleft-pkg/, "the failure must name the offending package");
    assert.match(String(err.stderr), /FORBIDDEN/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end-to-end: the REAL CLI exits zero when every introduced dependency's licence is on the allow-list", async () => {
  const { dir, git } = await makeFixtureRepo();
  try {
    const baseSha = await writeLockAndCommit(dir, git, {}, "base");
    const headSha = await writeLockAndCommit(dir, git, { "node_modules/mit-pkg": { version: "1.0.0", license: "MIT" } }, "head");
    const stdout = execFileSync(
      "node",
      [join(REPO_ROOT, "scripts", "check-dependency-licences.mjs"), "--base", baseSha, "--head", headSha],
      { cwd: dir, encoding: "utf8" },
    );
    assert.match(stdout, /clean/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
