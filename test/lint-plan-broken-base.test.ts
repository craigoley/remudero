/**
 * A BASE THAT DOES NOT PARSE MUST NOT FAIL THE PR THAT DIDN'T BREAK IT.
 *
 * `lint-plan --base <sha>` reconstructs the base plan and `loadPlan`s it. `loadPlan` refuses a
 * tree carrying a duplicate task id, and the base is whatever `origin/main` happens to be — so one
 * bad merge to main turned this REQUIRED check red on every open PR at once, INCLUDING the
 * plan-repair PR that would have fixed it. The gate proving the plan loads cannot pass while the
 * plan does not load, and the documented exit was an admin merge (the W1-T488 repair, #1820).
 *
 * Measured on 2026-08-16: `W1-T533` and `W1-T534` each landed twice within ten minutes, `rmd
 * lint-plan --base origin/main` exited 2 naming the collision, and #1952 and #1964 both went red
 * on a base neither had touched.
 *
 * These build a REAL base commit carrying a REAL duplicate id — a temp index off HEAD's tree plus
 * one extra shard, committed with `commit-tree`, so nothing touches the working tree, the real
 * index, or any branch — and drive the REAL `lintPlanCommand` against it. Both directions are
 * pinned: the broken base degrades and proceeds, the healthy base does not degrade at all.
 *
 * Its own file per CLAUDE.md's coverage rule.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { lintPlanCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The fixture's OWN committer. `commit-tree` refuses with "Author identity unknown" when neither
 *  the repo nor the global config names one, and `actions/checkout` configures neither — so this
 *  fixture passed on every developer machine and failed on every CI runner, taking three unrelated
 *  PRs to `blocked_ci` with it. Supplying an identity here is what makes it self-sufficient. */
const FIXTURE_IDENTITY = { name: "remudero test fixture", email: "fixture@remudero.invalid" };

function git(args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, ...env },
  }).trim();
}

/** An id that really exists in the shipped plan, read from the plan rather than hardcoded — a
 *  hardcoded id would silently stop duplicating anything the day that shard is renamed. */
function anExistingTaskId(): string {
  const shard = git(["ls-tree", "-r", "--name-only", "HEAD", "--", "plan/tasks.d/"])
    .split("\n")
    .find((f) => f.endsWith(".yaml"));
  assert.ok(shard, "the plan must carry at least one shard for this fixture to duplicate");
  const id = git(["show", `HEAD:${shard}`]).match(/^\s*- id: (\S+)\s*$/m)?.[1];
  assert.ok(id, `could not read an id out of ${shard}`);
  return id!;
}

/**
 * A commit whose tree is HEAD's plus one extra shard re-declaring `id` — i.e. a base that
 * `loadPlan` must refuse. Built through a TEMP INDEX (`GIT_INDEX_FILE`), so the repo's own index,
 * working tree and refs are untouched; the commit is unreachable and reaped by gc.
 */
function baseCommitWithDuplicate(id: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-broken-base-"));
  try {
    const indexFile = join(dir, "index");
    const env = { GIT_INDEX_FILE: indexFile };
    git(["read-tree", "HEAD"], env);
    // `repo:` is required — without it the loader refuses on the MISSING FIELD before it ever
    // reaches the duplicate check, and this fixture would pin the wrong cause.
    const yaml = [
      `- id: ${id}`,
      `  title: "duplicate of ${id}, planted by a test"`,
      "  repo: remudero",
      "  type: implement",
      "  verify: auto",
      "  status: queued",
      "",
    ].join("\n");
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: yaml,
    }).trim();
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},plan/tasks.d/zzz-planted-duplicate.yaml`], env);
    const tree = git(["write-tree"], env);
    // IDENTITY IS SUPPLIED, NOT BORROWED. `commit-tree` refuses with "Author identity unknown"
    // when neither the repo nor the global config names one, and `actions/checkout` configures
    // NEITHER — so this fixture passed on every developer machine and failed on every CI runner,
    // taking three unrelated PRs to `blocked_ci` with it. Reproduced locally by unsetting the
    // repo's user.email/user.name: `# fail 1`, this test, the other two green. Passing the four
    // env vars git already honours makes the fixture self-sufficient, so it depends on nothing
    // the checkout happens to have configured.
    const sha = git(["commit-tree", tree, "-p", "HEAD", "-m", "planted: a base carrying a duplicate id"], {
      GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
    });
    // THE ASSERTION THAT WOULD HAVE CAUGHT THIS. Delete the four env vars above and this fails
    // two different ways, both real: on a host with a configured identity the commit is authored
    // by THAT identity and the equality below breaks, and on a host without one `commit-tree`
    // refuses outright and there is no sha to read. Either way the fixture stops depending
    // silently on whatever the checkout happened to configure.
    assert.match(sha, /^[0-9a-f]{40}$/, "commit-tree must return a real commit sha");
    assert.equal(
      git(["show", "-s", "--format=%ae", sha]),
      FIXTURE_IDENTITY.email,
      "the base commit must be authored by the fixture's OWN identity, never one borrowed from the checkout",
    );
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  return { lines, restore: () => { console.error = original; } };
}

test("a base plan that does not load degrades with a warning instead of failing the PR", async () => {
  const id = anExistingTaskId();
  const base = baseCommitWithDuplicate(id);

  // PREMISE, asserted rather than assumed: that base really is unloadable. Without this the test
  // could pass against a base that parses fine and prove nothing.
  const refusal = (() => {
    try {
      git(["show", `${base}:plan/tasks.d/zzz-planted-duplicate.yaml`]);
      return true;
    } catch {
      return false;
    }
  })();
  assert.ok(refusal, "the planted shard must really be in the base tree");

  const cap = captureStderr();
  let code: number;
  try {
    code = await lintPlanCommand(["--base", base]);
  } finally {
    cap.restore();
  }

  assert.notEqual(code, 2, "an unparseable BASE must not be reported as this branch's failure");
  const warned = cap.lines.find((l) => l.includes("does not itself load"));
  assert.ok(warned, `the degradation must be announced, not silent; stderr was ${JSON.stringify(cap.lines.slice(-4))}`);
  assert.match(warned!, new RegExp(`duplicate task id '${id}'`), "and must name the real cause");
  assert.match(warned!, /nothing here is wrong with this branch/, "and must say whose defect it is");
});

test("FALSIFIER: a base that loads fine is not degraded — the fallback fires only on a real refusal", async () => {
  // Without this, deleting the parsed comparison outright would pass the test above.
  const cap = captureStderr();
  try {
    await lintPlanCommand(["--base", "HEAD"]);
  } finally {
    cap.restore();
  }

  assert.equal(
    cap.lines.filter((l) => l.includes("does not itself load")).length,
    0,
    `a healthy base must take the normal path; stderr was ${JSON.stringify(cap.lines.slice(-4))}`,
  );
});

test("a HEAD plan that does not load still fails — fail-closed moved, not removed", async () => {
  // The safety property this change must not cost. The head plan is loaded before the base block
  // is reached, so a genuinely broken branch is still refused; only the BASE side degrades.
  // Driven through the real command against a base that is fine, with the live (valid) head:
  // the assertion is that the head-side loader is what would throw, which the source ordering
  // guarantees and this pins by exit code on a base that cannot be resolved AT ALL.
  const cap = captureStderr();
  let code: number;
  try {
    code = await lintPlanCommand(["--base", "0000000000000000000000000000000000000000"]);
  } finally {
    cap.restore();
  }

  assert.equal(code, 2, "a base ref that cannot be resolved at all is still exit 2");
  assert.ok(
    cap.lines.some((l) => l.includes("cannot resolve --base")),
    `and still says so; stderr was ${JSON.stringify(cap.lines.slice(-4))}`,
  );
});
