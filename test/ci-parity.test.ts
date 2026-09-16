/**
 * test/ci-parity.test.ts — W1-T3702 (a fast local check for the commonest PR shape).
 *
 * THE GAP THIS CLOSES: `lint-plan` was absent from `FAST_GATE_STEPS`, and the ONLY gate that
 * judges a `plan/tasks.d/*.yaml` filing — the commonest PR shape in this repository — was
 * ci.yml's required `lint-plan` job (`npm run --silent lint-plan -- --base HEAD^1`), reachable
 * only after a full CI round.
 *
 * THIS TASK'S FIX, per its own design note (i)/(iv): `FAST_GATE_STEPS` gains a `lint-plan` entry
 * (src/lib/ci-parity.ts) that shells the NEW `lint-plan:fast` npm script (package.json), which
 * pins `--base origin/main` — the SAME diff scope `HEAD^1` resolves to on a PR branch — onto the
 * already-shipped offline entrypoint (scripts/lint-plan-offline.mjs, `deps.offline: true`), so the
 * step reads only the plan and the merge-base diff and never the network. A checkout with no
 * `plan/` directory (the site/console repos this same table also runs in) SKIPS the step rather
 * than failing it, via the new `skipWhenAbsent` field on `FastGateStep` (runPreflightFast).
 *
 * design note (ii) — defaulting the BARE `rmd lint-plan` verb itself to `origin/main` — is
 * REFUSED below (see the REFUSED block in this task's own REPORT): that default lives in
 * `lintPlanCommand` (src/run-task.ts), outside this task's declared `files:` scope, and flipping
 * it would invert test/lint-plan-open-only.test.ts's own pinned "DEFAULT (no --base, no --all):
 * checks OPEN tasks only" contract for the identical bare invocation. What IS proven here is that
 * every mode `lintPlanCommand` already supports — default (open-only), `--base`, and `--all` —
 * already NAMES which scope it used (design note iii), so the new `--base origin/main` fast-gate
 * invocation and the pre-existing whole-plan default read as legibly different questions rather
 * than a silent disagreement, and that `--all` still reaches the full corpus explicitly (design
 * note iv's "whole-plan auditing stays available" half, independent of the fast-gate wiring).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { PreflightSpawn } from "../src/lib/commit-message.js";
import { FAST_GATE_STEPS, runPreflightFast } from "../src/lib/ci-parity.js";
import { lintPlanCommand, type LintPlanStatusDeps } from "../src/run-task.js";

const REPO_ROOT = process.cwd();
const LINT_PLAN_STEP = FAST_GATE_STEPS.find((s) => s.job === "lint-plan");

/** Captures console.log during a `lintPlanCommand` call — the same idiom
 *  test/lint-plan-open-only.test.ts's `runLintPlanCapturing` uses, extended with a `deps`
 *  parameter (defaulted to `{ offline: true }`) so these tests never depend on network/`gh`
 *  availability in a sandboxed runner. */
async function runLintPlanCapturing(args: string[], deps: LintPlanStatusDeps = { offline: true }): Promise<{ exitCode: number; stdout: string }> {
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const logs: string[] = [];
  console.log = (m: string) => logs.push(m);
  console.error = () => {};
  console.warn = () => {};
  try {
    const exitCode = await lintPlanCommand(args, deps);
    return { exitCode, stdout: logs.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

function fixtureTask(id: string, status: string): string {
  return [
    `- id: ${id}`,
    `  title: "fixture task ${id}"`,
    "  repo: remudero",
    "  origin: architect",
    "  depends_on: []",
    "  type: implement",
    "  verify: auto",
    `  status: ${status}`,
    "  attempts: 0",
    "  files: [test/ci-parity.test.ts]",
    "  acceptance:",
    '    - claim: "the thing holds"',
    '      proof: "unit test: test/ci-parity.test.ts"',
    "",
  ].join("\n");
}

/** One OPEN task and one DONE (retired) task, under a `plan/` directory of its own — the same
 *  "build a fixture plan under the repo root" shape test/lint-plan-open-only.test.ts's
 *  `buildCountingFixture` uses, sized down to just what this file's scope/naming claims need. */
function buildFixture(): { tasksPath: string; dir: string } {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t3702-lint-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  const tasksPath = join(dir, "plan", "tasks.yaml");
  writeFileSync(tasksPath, fixtureTask("FIX-OPEN", "queued") + fixtureTask("FIX-DONE", "done"), "utf8");
  return { tasksPath, dir };
}

// ── acceptance 1: "the fast gate runs lint-plan, so the commonest pull request shape has a ─────
// ── local check that costs seconds" ─────────────────────────────────────────────────────────────

test("FAST_GATE_STEPS carries a lint-plan entry, and its own npm script pins the SAME diff scope CI's required lint-plan job checks via --base HEAD^1", () => {
  assert.ok(LINT_PLAN_STEP, "FAST_GATE_STEPS must declare a job named 'lint-plan'");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const scriptText = pkg.scripts[LINT_PLAN_STEP!.script];
  assert.ok(scriptText, `package.json must define the "${LINT_PLAN_STEP!.script}" script this step runs`);
  assert.match(scriptText, /--base origin\/main/, "the fast-gate lint-plan step must be diff-scoped against origin/main — the same comparison CI makes");
  assert.match(
    scriptText,
    /lint-plan-offline\.mjs/,
    "must route through the already-shipped offline entrypoint (deps.offline: true) — never the network-capable bare verb",
  );
});

test("runPreflightFast: invokes lint-plan's own npm script exactly like every other FAST_GATE_STEPS entry — `npm run --silent <script>`, nothing extra", () => {
  const calls: { file: string; args: string[] }[] = [];
  const spawn: PreflightSpawn = (file, args) => {
    calls.push({ file, args });
    return { status: 0, stdout: "", stderr: "" };
  };
  const pkgText = JSON.stringify({ scripts: Object.fromEntries(FAST_GATE_STEPS.map((s) => [s.script, "echo stub"])) });
  runPreflightFast(REPO_ROOT, { spawn, packageJsonText: pkgText });
  const call = calls.find((c) => c.file === "npm" && c.args.join(" ") === `run --silent ${LINT_PLAN_STEP!.script}`);
  assert.ok(call, `expected an \`npm run --silent ${LINT_PLAN_STEP!.script}\` call`);
});

test("lint-plan:fast (the fast-gate's own script): runs for real, unmocked, on this checkout — reads only the plan and the merge-base diff, never the network", () => {
  // Real spawn, real package.json — the same "run for real" discipline
  // test/fast-gate-admits-the-census-class.test.ts's census-entry test uses. This checkout's plan
  // touches nothing in THIS PR's diff (only src/lib/ci-parity.ts, package.json and test/ files
  // change), so the scope is 0 new/changed regardless of how far HEAD has moved past origin/main.
  const res = spawnSync("npm", ["run", "--silent", "lint-plan:fast"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(res.status, 0, `lint-plan:fast must pass on this checkout; got:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /new\/changed vs origin\/main/, "acceptance 3 — the run must NAME its own scope: origin/main, the same comparison CI makes");
  assert.match(res.stdout, /offline subset: GitHub reads disabled/, "must run through the offline dependency boundary — never the network");
});

// ── acceptance 3: "every run names the scope it used, so two runs that disagree are legibly ────
// ── asking different questions" ─────────────────────────────────────────────────────────────────

test("lint-plan DEFAULT (no --base, no --all) names its own scope as 'open tasks only'", async () => {
  const { tasksPath, dir } = buildFixture();
  try {
    const { stdout } = await runLintPlanCapturing(["--plan", tasksPath]);
    assert.match(stdout, /open tasks only/, "the default mode must name itself, distinctly from --base and --all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint-plan --base <ref> names its own scope as 'N new/changed vs <ref>'", async () => {
  // Against the real repo's own history (--base HEAD), the same shape
  // test/lint-plan-open-only.test.ts's --base test uses — a fixture plan built under a temp dir
  // has no git history of its own for `git show <base>:<path>` to read.
  const { stdout } = await runLintPlanCapturing(["--base", "HEAD"]);
  assert.match(stdout, /new\/changed vs HEAD/, "the --base mode must name the ref it diffed against");
  assert.doesNotMatch(stdout, /open tasks? only/, "--base mode must never read as the whole-plan default");
});

// ── acceptance 4: "whole-plan auditing stays available explicitly, so widening the default ──────
// ── removes no capability" ──────────────────────────────────────────────────────────────────────

test("lint-plan --all still reaches the full corpus (open + retired) explicitly, naming itself distinctly from the default", async () => {
  const { tasksPath, dir } = buildFixture();
  try {
    const { stdout } = await runLintPlanCapturing(["--plan", tasksPath, "--all"]);
    assert.match(stdout, /--all: full corpus/, "the --all mode must name itself as the full corpus");
    assert.match(stdout, /2 task\(s\) checked/, "both the open and the retired (done) fixture task must be checked under --all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── acceptance 5: "a repository with no plan directory skips the step rather than failing it" ───

test("runPreflightFast: a checkout with no plan/ directory SKIPS the lint-plan step (ok: true) rather than failing it, and never even spawns its script", () => {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t3702-noplan-"));
  try {
    // Deliberately no `mkdirSync(join(dir, "plan"))` — this checkout shape has none, the site/
    // console repos' own shape this table also runs in (design note iv).
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { [LINT_PLAN_STEP!.script]: "echo stub" } }), "utf8");
    let spawned = false;
    const spawn: PreflightSpawn = () => {
      spawned = true;
      // Configured to FAIL if it were ever invoked, so a bug that skips the skip-check reads as a
      // loud red here, never a silent pass-through.
      return { status: 1, stdout: "", stderr: "should never have run" };
    };
    const result = runPreflightFast(dir, { spawn, steps: [LINT_PLAN_STEP!] });
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].ok, true, `expected the lint-plan step to be SKIPPED (ok: true), got: ${result.steps[0].detail}`);
    assert.match(result.steps[0].detail, /SKIPPED/, "must be reported as SKIPPED, distinct from a PASS the script never earned");
    assert.equal(spawned, false, "a checkout with no plan/ directory must never even attempt the npm script");
    assert.equal(result.ok, true, "a skipped-only run must read as an overall pass, never a refusal over a missing input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflightFast: a checkout WITH a plan/ directory never skips the lint-plan step", () => {
  // REPO_ROOT (this checkout) has a plan/ directory, so the skip-check must fall through to the
  // ordinary script check every other FAST_GATE_STEPS member gets.
  const calls: { file: string; args: string[] }[] = [];
  const spawn: PreflightSpawn = (file, args) => {
    calls.push({ file, args });
    return { status: 0, stdout: "", stderr: "" };
  };
  const pkgText = JSON.stringify({ scripts: { [LINT_PLAN_STEP!.script]: "echo stub" } });
  const result = runPreflightFast(REPO_ROOT, { spawn, packageJsonText: pkgText, steps: [LINT_PLAN_STEP!] });
  assert.equal(result.steps[0].ok, true);
  assert.doesNotMatch(result.steps[0].detail, /SKIPPED/, "a checkout that HAS plan/ must run the step, never skip it");
  assert.equal(calls.length, 1, "the script must actually have been spawned");
});
