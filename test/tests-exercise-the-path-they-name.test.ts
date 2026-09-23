/**
 * test/tests-exercise-the-path-they-name.test.ts — proof for W1-T4226.
 *
 * W1-T4119's shared `gh` refusal stub (test/setup/tmp-hygiene.ts) turned an accidental shell-out
 * into a fast, self-naming failure at the SHELL level — but the calling TEST still passed,
 * because whatever production code caught the refused call's thrown error swallowed it and
 * reported success on the fallback/empty path. MEASURED 2026-09-23 on a full-suite run with the
 * refusing stub in place: about 80 test files still shell out this way, each one exercising
 * "GitHub unreachable" instead of the behaviour its own title names (#6714's rationale;
 * test/policy.test.ts alone made 864 such calls before #6744 fixed it).
 *
 * This file proves the two halves of the fix that live entirely in test/setup/tmp-hygiene.ts:
 *
 *  1. The offline deps seam (already generalized by #6744's `offlineLintDeps` pattern in
 *     test/policy.test.ts) really does keep a whole-plan `lintPlanCommand` call from building a
 *     real GitHub gateway — demonstrated here with a fresh, minimal fixture, independent of any
 *     of the ~80 already-affected files.
 *  2. The shared stub's refusal count is now VISIBLE and ENFORCED: a test file that triggers it
 *     without opting in fails at exit (claim 2), and a file that opts in by name is exempt
 *     (claim 3) — proved by actually spawning a `node --test` child process on a throwaway
 *     fixture file, exactly the shape every real affected file has, rather than reaching into
 *     tmp-hygiene.ts's own internals.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { lintPlanCommand, type LintPlanStatusDeps } from "../src/run-task.js";
import { fakeGitHub } from "./helpers/fake-github.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HYGIENE_HREF = pathToFileURL(join(REPO_ROOT, "test", "setup", "tmp-hygiene.ts")).href;

// ── claim 1: a whole-plan lint-plan test builds no real GitHub gateway ─────────────────────────

const MINIMAL_VALID_TASKS_YAML =
  "- id: FIXTURE-T1\n  title: W1-T4226 offline-seam fixture\n  repo: remudero\n  type: implement\n  origin: architect\n  risk: medium\n  files: [src/lib/example.ts]\n";

function wholePlanFixture(): { tasksPath: string; dir: string } {
  const dir = mkdtempSync(join(REPO_ROOT, "test", ".tmp-w1-t4226-lint-"));
  mkdirSync(join(dir, "plan"), { recursive: true });
  const tasksPath = join(dir, "plan", "tasks.yaml");
  writeFileSync(tasksPath, MINIMAL_VALID_TASKS_YAML, "utf8");
  // A minimal, structurally valid policy.yaml — this fixture is about the credit-scoping
  // gateway seam, not policy bounds, so every field is simply within its own declared range.
  writeFileSync(
    join(dir, "plan", "policy.yaml"),
    stringifyYaml({
      proofTimeoutMs: { value: 60_000, origin: "net-new", min: 60_000, max: 300_000 },
    }),
    "utf8",
  );
  return { tasksPath, dir };
}

test("a whole-plan lint-plan test builds no real GitHub gateway", async () => {
  const { tasksPath, dir } = wholePlanFixture();
  const gatewaysBuilt: string[] = [];
  const deps: LintPlanStatusDeps = {
    offline: true,
    ghGateway: (owner, repo) => {
      gatewaysBuilt.push(`${owner}/${repo}`);
      return fakeGitHub();
    },
  };
  const origError = console.error;
  const origLog = console.log;
  const origWarn = console.warn;
  console.error = () => {};
  console.log = () => {};
  console.warn = () => {};
  try {
    // No `--base` — this is the WHOLE-PLAN path (credit scoping's `creditedMergedIdsForWholePlan`),
    // not the diff-scoped one; that is exactly the call shape the ~80 affected files share.
    await lintPlanCommand(["--plan", tasksPath], deps);
  } finally {
    console.error = origError;
    console.log = origLog;
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(gatewaysBuilt, [], "a whole-plan lint-plan run given the offline seam must build no GitHub gateway");
});

// ── claims 2 & 3: the shared stub's refusal count, visible and enforced ────────────────────────

/**
 * Spawn a real `node --test` on a throwaway fixture file, `--import`ed with the SAME tmp-hygiene
 * module this repo's own `test`/`test:ci` scripts load — so the fixture experiences exactly the
 * shared refusal stub and exit-time check a real affected file does, not a stand-in for them.
 * `cwd` stays the repo root (not the fixture's own dir) so `--import tsx`'s bare-specifier
 * resolution still finds this repo's `node_modules` — the fixture file itself is passed by its
 * own absolute path, which `node --test` runs directly regardless of cwd.
 */
function runFixture(source: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-test-w1-t4226-fixture-"));
  try {
    const file = join(dir, "fixture.test.mjs");
    writeFileSync(file, source, "utf8");
    const result = spawnSync(process.execPath, ["--test", "--import", "tsx", "--import", HYGIENE_HREF, file], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // This proof file is itself running under `node --test` — without clearing this, the
      // spawned child inherits it, node:test detects the "recursive" nesting, and SKIPS
      // running the fixture file entirely instead of actually executing it (silently
      // reporting a 0 exit and no output, which the first assertion below would misread as
      // "the fixture passed" rather than "the fixture never ran").
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    });
    // node:test's own reporter re-emits `console.error` (the exit handler's channel) as `#`
    // comment lines on the CHILD process's stdout — not its stderr — so both streams are
    // combined here rather than assuming which one carries the message.
    return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHELL_OUT_TO_GH = [
  "import { test } from 'node:test';",
  "import { execFileSync } from 'node:child_process';",
  "test('a production call site that swallows the failure', () => {",
  "  try {",
  "    execFileSync('gh', ['api', 'repos/craigoley/remudero/pulls/1/files'], { stdio: 'pipe' });",
  "  } catch {",
  // Exactly the swallowing shape this task exists to expose: the individual assertion never
  // sees the refusal, so it passes — the WHOLE FILE is the only thing left to fail it.
  "  }",
  "});",
  "",
].join("\n");

test("a test file that calls the refusing stub without opting in fails at exit", () => {
  const { status, output } = runFixture(SHELL_OUT_TO_GH);
  assert.notEqual(status, 0, `expected the fixture file to fail at exit — output:\n${output}`);
  assert.match(
    output,
    /triggered the shared gh refusal stub 1 time\(s\) and did not opt in/,
    "must name that this is the unexplained-refusal check, not an unrelated failure",
  );
});

test("a test file that opts in by name may still call its own stub", () => {
  const optedIn = [`import { allowGhRefusals } from ${JSON.stringify(HYGIENE_HREF)};`, 'allowGhRefusals("W1-T4226 proof fixture — deliberately exercises the shared refusal");', SHELL_OUT_TO_GH].join(
    "\n",
  );
  const { status, output } = runFixture(optedIn);
  assert.equal(status, 0, `expected the opted-in fixture file to pass — output:\n${output}`);
  assert.doesNotMatch(output, /did not opt in/, "the opt-in must suppress the exit-time failure");
});
