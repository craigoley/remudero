/**
 * test/repo-root-identity.test.ts — W1-T120: a gate PROVES it read the file under test.
 *
 * Locks the #271 false-green fixture: `src/run-task.ts` used to derive `repoRoot` from
 * WHERE THE SCRIPT LIVES (`dirname(dirname(fileURLToPath(import.meta.url)))`), never from
 * where the operator is standing. Invoking ONE checkout's `bin/rmd` with cwd inside a
 * DIFFERENT work tree therefore silently gated the INSTALL tree's plan and never opened
 * the file under test — both runs exited 0, nothing distinguished the wrong read from the
 * right one. Three things now close that hole:
 *   1. `resolveRepoRoot` ascends from CWD (`git rev-parse --show-toplevel`), not the
 *      script's install path — proven end-to-end by actually spawning `bin/rmd` with cwd
 *      pointed at a SEPARATE git work tree carrying its own plan.
 *   2. an explicit `--plan` resolving outside the resolved root is REFUSED by name.
 *   3. `rmd lint-plan`'s summary line carries the absolute path + content hash of the plan
 *      file it actually opened (the read-identity assertion).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lintPlanCommand, resolveRepoRoot, stripRepoRootFlag } from "../src/run-task.js";
import { formatReadIdentity, isPathOutsideRoot } from "../src/lib/task-linter.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function sha256_12(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
}

// ── resolveRepoRoot: the pure resolution function, unit-tested directly ──────────────────

test("resolveRepoRoot: an explicit --repo-root wins over cwd-ascent entirely (git is never even consulted)", () => {
  let called = false;
  const root = resolveRepoRoot(["--repo-root", "/some/explicit/root", "lint-plan"], "/irrelevant/cwd", () => {
    called = true;
    return "/would-be-cwd-ascent-result";
  });
  assert.equal(root, "/some/explicit/root");
  assert.equal(called, false, "cwd-ascent must not run at all when --repo-root is given");
});

test("resolveRepoRoot: CWD-ASCENT — with no --repo-root flag, the tree returned is whatever `git rev-parse --show-toplevel` from CWD names, not any install-path notion", () => {
  const root = resolveRepoRoot(["lint-plan"], "/some/cwd", (dir) => {
    assert.equal(dir, "/some/cwd", "showToplevel must be invoked with the given cwd");
    return "/the/cwd-ascent/toplevel";
  });
  assert.equal(root, "/the/cwd-ascent/toplevel");
});

test("resolveRepoRoot: falls back to the INSTALL path (and says so on stderr) ONLY when cwd is not inside a git work tree", () => {
  const origError = console.error;
  const messages: string[] = [];
  console.error = (m: string) => messages.push(m);
  let root: string;
  try {
    root = resolveRepoRoot(["lint-plan"], "/not/a/git/tree", () => {
      throw new Error("fatal: not a git repository");
    });
  } finally {
    console.error = origError;
  }
  // The install-path fallback is fixed to THIS checkout (src/run-task.ts's own location) —
  // the same value every OTHER test file in this suite derives via `fileURLToPath(new
  // URL("..", import.meta.url))` from its own path one directory shallower than src/.
  assert.equal(root, repoRoot.replace(/\/$/, ""));
  assert.ok(
    messages.some((m) => m.includes("not inside a git work tree") && m.includes("falling back")),
    `expected a named, non-silent fallback message on stderr; got: ${JSON.stringify(messages)}`,
  );
});

// ── stripRepoRootFlag: so --repo-root never trips an unrelated command's own flag allow-list ──

test("stripRepoRootFlag: removes the --repo-root/value pair; leaves argv untouched when absent", () => {
  assert.deepEqual(stripRepoRootFlag(["lint-plan", "--repo-root", "/x", "--base", "HEAD"]), ["lint-plan", "--base", "HEAD"]);
  assert.deepEqual(stripRepoRootFlag(["lint-plan", "--base", "HEAD"]), ["lint-plan", "--base", "HEAD"]);
});

// ── isPathOutsideRoot / formatReadIdentity: the pure task-linter.ts helpers ──────────────

test("isPathOutsideRoot: a path under root is IN; a sibling/ancestor path is OUTSIDE; root itself is IN", () => {
  assert.equal(isPathOutsideRoot("/a/b", "/a/b/plan/tasks.yaml"), false);
  assert.equal(isPathOutsideRoot("/a/b", "/a/b"), false);
  assert.equal(isPathOutsideRoot("/a/b", "/a/other/plan/tasks.yaml"), true);
  assert.equal(isPathOutsideRoot("/a/b", "/a/b-sibling/plan/tasks.yaml"), true, "a name that merely PREFIXES root must not be misread as contained");
});

test("formatReadIdentity: absolute path + first-12-hex sha256 of the content, deterministic over the same bytes", () => {
  const raw = "- id: T1\n  title: x\n  repo: remudero\n  type: implement\n";
  const line = formatReadIdentity("/abs/plan/tasks.yaml", raw);
  assert.equal(line, `/abs/plan/tasks.yaml (sha256:${sha256_12(raw)})`);
});

// ── ACCEPTANCE 1 (CANONICAL REGRESSION, live #271 fixture): invoking bin/rmd with cwd ──────
// inside a DIFFERENT work tree gates the CWD tree's plan, never the install tree's.

test("rmd lint-plan: cwd wins over install location — a SEPARATE work tree's own plan/tasks.yaml is what gets gated, not this checkout's (the #271 false-green, now a regression test)", () => {
  // realpathSync: on macOS $TMPDIR lives under a symlink (/tmp -> /private/tmp), and
  // `git rev-parse --show-toplevel` (which the fix under test calls) returns the RESOLVED
  // path — so every path built below must agree with what the CHILD PROCESS will report,
  // not the un-resolved mkdtempSync string.
  const other = realpathSync(mkdtempSync(join(tmpdir(), "rmd-repo-root-identity-")));
  try {
    execFileSync("git", ["-C", other, "init", "--quiet", "-b", "main"]);
    mkdirSync(join(other, "plan"), { recursive: true });
    const fixtureTask = (id: string, title: string): string =>
      `- id: ${id}\n  title: ${title}\n  repo: remudero\n  type: implement\n  origin: architect\n  risk: medium\n`;
    const otherPlan = fixtureTask("OTHER-T1", "fixture one") + fixtureTask("OTHER-T2", "fixture two") + fixtureTask("OTHER-T3", "fixture three");
    writeFileSync(join(other, "plan", "tasks.yaml"), otherPlan, "utf8");

    // The REAL bin/rmd from THIS checkout, invoked with cwd inside the OTHER tree — exactly
    // the #271 shape (one checkout's bin/rmd, cwd = a different work tree). Pre-fix this
    // silently read THIS checkout's own (much larger) plan/tasks.yaml and still exited 0.
    // `stdio: pipe` on all three streams (execFileSync's default) is fine on a clean-lint
    // exit-0; the fixture is provenance-clean by construction so we still get stdout back
    // via the normal (non-throwing) return path.
    const stdout = execFileSync(join(repoRoot, "bin", "rmd"), ["lint-plan"], {
      cwd: other,
      encoding: "utf8",
      env: { ...process.env },
    });

    assert.match(
      stdout,
      /rmd lint-plan: 3 task\(s\) checked/,
      `expected the OTHER tree's 3-task plan to be gated; got:\n${stdout}`,
    );
    // Sanity: THIS checkout's real plan is nowhere near 3 tasks, so a "3 task(s) checked"
    // reading is only explicable by the cwd tree's plan having actually been opened.
    const realTaskCount = (readFileSync(join(repoRoot, "plan", "tasks.yaml"), "utf8").match(/^- id:/gm) ?? []).length;
    assert.ok(realTaskCount > 3, "sanity: this checkout's real plan must be larger than the fixture, or the count assertion above is not discriminating");

    // ACCEPTANCE 3: the read-identity assertion — the OTHER tree's absolute plan path and its
    // content hash, both present in the gate's own output.
    const expectedIdentity = formatReadIdentity(join(other, "plan", "tasks.yaml"), otherPlan);
    assert.ok(
      stdout.includes(expectedIdentity),
      `expected the read-identity line "${expectedIdentity}" in stdout:\n${stdout}`,
    );
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 2: a --plan resolving OUTSIDE the resolved root is REFUSED by name ─────────

test("rmd lint-plan --plan <outside root>: REFUSED by name (both paths named), never the old base-resolution-failure mis-report", async () => {
  const outside = mkdtempSync(join(tmpdir(), "rmd-repo-root-identity-outside-"));
  const outsidePlan = join(outside, "tasks.yaml");
  writeFileSync(outsidePlan, "- id: T1\n  title: x\n  repo: remudero\n  type: implement\n", "utf8");
  try {
    const origError = console.error;
    const errors: string[] = [];
    console.error = (m: string) => errors.push(m);
    let exitCode: number;
    try {
      exitCode = await lintPlanCommand(["--plan", outsidePlan]);
    } finally {
      console.error = origError;
    }
    assert.equal(exitCode, 2, "an out-of-root --plan must be refused, never proceed to lint");
    const joined = errors.join("\n");
    assert.match(joined, /resolves OUTSIDE the repo root/, `expected an explicit out-of-root refusal; got:\n${joined}`);
    assert.ok(joined.includes(outsidePlan), "the refusal must name the offending --plan path");
    assert.ok(!/cannot resolve --base/.test(joined), "must NOT mis-report as a --base resolution failure");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rmd lint-plan --plan <outside root> --base HEAD: still refused BY NAME — --base never gets a chance to mis-report this as its own failure", async () => {
  const outside = mkdtempSync(join(tmpdir(), "rmd-repo-root-identity-outside-base-"));
  const outsidePlan = join(outside, "tasks.yaml");
  writeFileSync(outsidePlan, "- id: T1\n  title: x\n  repo: remudero\n  type: implement\n", "utf8");
  try {
    const origError = console.error;
    const errors: string[] = [];
    console.error = (m: string) => errors.push(m);
    let exitCode: number;
    try {
      exitCode = await lintPlanCommand(["--plan", outsidePlan, "--base", "HEAD"]);
    } finally {
      console.error = origError;
    }
    assert.equal(exitCode, 2);
    const joined = errors.join("\n");
    assert.match(joined, /resolves OUTSIDE the repo root/);
    assert.ok(!/cannot resolve --base HEAD/.test(joined), "the OLD failure mode named --base as the culprit; the new refusal must name the plan path instead");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── ACCEPTANCE 3 (direct, in-process): the read-identity assertion on an IN-root --plan ───

test("rmd lint-plan --plan <inside root>: the summary line carries the absolute path + content hash of the plan file actually opened", async () => {
  const fixtureDir = mkdtempSync(join(repoRoot, "test", ".tmp-w1-t120-"));
  const fixturePlan = join(fixtureDir, "tasks.yaml");
  const raw = "- id: FIXTURE-T1\n  title: identity fixture\n  repo: remudero\n  type: implement\n  origin: architect\n  risk: medium\n";
  writeFileSync(fixturePlan, raw, "utf8");
  try {
    assert.equal(isPathOutsideRoot(repoRoot, fixturePlan), false, "sanity: the fixture must be IN-root for this test to exercise the identity line rather than the refusal");
    const origLog = console.log;
    const logs: string[] = [];
    console.log = (m: string) => logs.push(m);
    let exitCode: number;
    try {
      exitCode = await lintPlanCommand(["--plan", fixturePlan]);
    } finally {
      console.log = origLog;
    }
    assert.equal(exitCode, 0);
    const joined = logs.join("\n");
    assert.equal(exitCode, 0, "a single valid task with no plan-level defects must lint clean");
    const expectedIdentity = formatReadIdentity(fixturePlan, raw);
    assert.ok(
      joined.includes(expectedIdentity),
      `expected the read-identity line "${expectedIdentity}" in the summary:\n${joined}`,
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
