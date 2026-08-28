/**
 * test/base-lint-attributes-pre-existing-violations.test.ts — W1-T2339.
 *
 * `lint-plan --base` restricts itself to the tasks a diff touched, then reports each touched
 * task's WHOLE violation set and fails the run if any is blocking — with no indication of
 * which violations the diff caused. A one-word prose edit to any of the 156 tasks already
 * failing on `main` fails the PR that made it, and the author has nothing in the report to
 * tell a pre-existing landmine from a defect they introduced (W1-T65 vs W1-T279, this task's
 * own shard).
 *
 * THE GATE DOES NOT MOVE: every violation still blocks exactly as before, and the exit code is
 * unchanged for every input (design (ii)). What changes is that a failing task's printed line,
 * in `--base` mode ONLY, is annotated with how many of ITS OWN violations already existed at
 * the base ref — A COUNT, never a violation-text comparison (design (iii): `LintViolation`
 * carries no stable identity across a reword, so a set diff would be untrustworthy; a count is
 * stable under rewording by construction).
 *
 * These build REAL, UNREACHABLE git commits (a temp index off HEAD's tree plus one planted
 * blob, committed with `commit-tree` — mirrors test/lint-plan-broken-base.test.ts's own
 * fixture) so `git show <base>:<path>` resolves for real, and drive the REAL `lintPlanCommand`
 * against a `--plan` pointed at a fixture file OUTSIDE `plan/` (a fresh tmpdir under the repo
 * root, so the repo-root-identity guard still passes) — never the shipped 856-task plan, so
 * this suite's assertions can't be moved by unrelated plan edits.
 *
 * Its own file per CLAUDE.md's coverage rule, and per this task's own `files:` (a forward
 * reference resolved by this very build).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { lintPlanCommand } from "../src/run-task.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The fixture's OWN committer — see test/lint-plan-broken-base.test.ts for why this is
 *  required rather than borrowed from the checkout (`commit-tree` refuses with "Author
 *  identity unknown" on a CI runner with neither repo nor global config set). */
const FIXTURE_IDENTITY = { name: "remudero test fixture", email: "fixture@remudero.invalid" };

function git(args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    env: { ...process.env, ...env },
  }).trim();
}

/**
 * An UNREACHABLE commit whose tree is HEAD's plus every planted blob in `blobs` (added, not
 * merged — `--cacheinfo` on a temp index built from `read-tree HEAD`). Nothing touches the
 * repo's own index, working tree or refs; the commit is reachable only by the sha this
 * returns, and is reaped by gc like any other unreferenced commit-tree object.
 */
function baseCommitWithBlobs(blobs: ReadonlyArray<{ relPath: string; content: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t2339-base-"));
  try {
    const indexFile = join(dir, "index");
    const env = { GIT_INDEX_FILE: indexFile };
    git(["read-tree", "HEAD"], env);
    for (const { relPath, content } of blobs) {
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        input: content,
      }).trim();
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},${relPath}`], env);
    }
    const tree = git(["write-tree"], env);
    const identityEnv = {
      GIT_AUTHOR_NAME: FIXTURE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: FIXTURE_IDENTITY.email,
      GIT_COMMITTER_NAME: FIXTURE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: FIXTURE_IDENTITY.email,
    };
    const sha = git(
      ["commit-tree", tree, "-p", "HEAD", "-m", "planted: W1-T2339 base fixture"],
      identityEnv,
    );
    assert.match(sha, /^[0-9a-f]{40}$/, "commit-tree must return a real commit sha");
    return sha;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Single-blob convenience wrapper over {@link baseCommitWithBlobs}. */
function baseCommitWithBlob(relPath: string, content: string): string {
  return baseCommitWithBlobs([{ relPath, content }]);
}

/** A fresh, git-invisible fixture plan file INSIDE the repo root (so the `--plan` outside-root
 *  guard passes) — never `plan/tasks.yaml` itself, so this suite never depends on, or perturbs,
 *  the shipped plan. Returns the plan path and its path RELATIVE to the repo root, the same
 *  relative path `baseCommitWithBlob` must plant its blob at for `--base` to find it. */
function fixturePlanPaths(): { dir: string; planPath: string; relPath: string } {
  const dir = mkdtempSync(join(REPO_ROOT, ".rmd-w1-t2339-fixture-"));
  const planPath = join(dir, "tasks.yaml");
  const relPath = relative(REPO_ROOT, planPath);
  return { dir, planPath, relPath };
}

function captureConsole(): { errLines: string[]; logLines: string[]; restore: () => void } {
  const errLines: string[] = [];
  const logLines: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  const origLog = console.log;
  console.error = (...a: unknown[]) => void errLines.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void errLines.push(a.map(String).join(" "));
  console.log = (...a: unknown[]) => void logLines.push(a.map(String).join(" "));
  return {
    errLines,
    logLines,
    restore: () => {
      console.error = origError;
      console.warn = origWarn;
      console.log = origLog;
    },
  };
}

// A vibe proof — VIBE_PROOFS (task-linter.ts) — trips BOTH `proof-shape` (a non-observable
// proof) AND `proof-dialect` (free prose that cannot execute), each BLOCK by default and
// unconditionally (no LintOpts can demote either). Two checks, same free-prose cause, so this
// deterministically manufactures exactly TWO blocking violations with no dependence on any
// injected opt — measured directly via `lintTask`, not assumed.
const LANDMINE_TASK = (title: string, proof: string) =>
  [
    `- id: ZZ-Landmine`,
    `  title: "${title}"`,
    `  repo: remudero`,
    `  depends_on: []`,
    `  type: implement`,
    `  verify: human`,
    `  risk: high`,
    `  status: queued`,
    `  origin: "W1-T2339 test fixture"`,
    `  acceptance:`,
    `    - claim: "something is proven"`,
    `      proof: "${proof}"`,
    ``,
  ].join("\n");

// A clean task — its proof carries the "unit test:" dialect prefix with a resolvable
// test/*.test.ts shape (PROOF_PAYLOAD_SHAPES), so proof-dialect and proof-resolvability are
// both silent; proof-shape is silent because the proof is not a vibe phrase.
const CLEAN_TASK = (title: string, proof: string) =>
  [
    `- id: ZZ-Clean`,
    `  title: "${title}"`,
    `  repo: remudero`,
    `  depends_on: []`,
    `  type: implement`,
    `  verify: human`,
    `  risk: high`,
    `  status: queued`,
    `  origin: "W1-T2339 test fixture"`,
    `  acceptance:`,
    `    - claim: "something is proven"`,
    `      proof: "${proof}"`,
    ``,
  ].join("\n");

test("a base-failing task a diff merely touches still fails, and the line names how many of its violations pre-date the diff", async () => {
  const { dir, planPath, relPath } = fixturePlanPaths();
  try {
    const baseYaml = LANDMINE_TASK("landmine task, before the touch", "works");
    const base = baseCommitWithBlob(relPath, baseYaml);
    // The diff: a one-word prose edit, unrelated to the violation (the same shape this task's
    // own shard measured against W1-T65 — "have" to "carry").
    writeFileSync(planPath, LANDMINE_TASK("landmine task, after the touch", "works"), "utf8");

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath, "--base", base]);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1, "a task still carrying a blocking violation must still fail the run");
    const line = cap.errLines.find((l) => l.startsWith("✗ ZZ-Landmine:"));
    assert.ok(line, `must still report the failing task; stderr was ${JSON.stringify(cap.errLines)}`);
    assert.match(
      line!,
      new RegExp(`2 violation\\(s\\) \\(2 pre-existing on base ${base}\\)`),
      "must name how many of this task's OWN violations the base ref already carried",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task with none of its own violations on the base is reported with a base count of zero once the diff introduces one", async () => {
  const { dir, planPath, relPath } = fixturePlanPaths();
  try {
    const baseYaml = CLEAN_TASK("clean task, before the touch", "unit test: test/w1-t2339-fixture.test.ts");
    const base = baseCommitWithBlob(relPath, baseYaml);
    // The diff introduces a REAL, new violation (a vibe proof) — the task still exists at the
    // base, but the base version of it had zero blocking violations.
    writeFileSync(planPath, CLEAN_TASK("clean task, after the touch", "works"), "utf8");

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath, "--base", base]);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1, "the newly-introduced violation must still fail the run");
    const line = cap.errLines.find((l) => l.startsWith("✗ ZZ-Clean:"));
    assert.ok(line, `must report the now-failing task; stderr was ${JSON.stringify(cap.errLines)}`);
    assert.match(
      line!,
      new RegExp(`2 violation\\(s\\) \\(0 pre-existing on base ${base}\\)`),
      "the base carried none of this task's violations, so the count must read zero",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FALSIFIER: the attribution is a COUNT, not a violation-text comparison — a reworded pre-existing violation still counts as pre-existing", async () => {
  const { dir, planPath, relPath } = fixturePlanPaths();
  try {
    // Both "works" and "looks good" are VIBE_PROOFS — both trip the SAME two checks
    // (proof-shape, proof-dialect), both BLOCK, but every one of those violation MESSAGEs
    // embeds the literal proof text verbatim, so no message at head is byte-identical to any
    // message at base. A set-diff over violation text would see this as "0 pre-existing, 2
    // new" (none of the base's exact messages ever appear at head). A count over
    // severity="block" must instead see it as "2 pre-existing" — the same two checks fired at
    // both ends, reworded but never removed.
    const base = baseCommitWithBlob(relPath, LANDMINE_TASK("reworded landmine, before", "works"));
    writeFileSync(planPath, LANDMINE_TASK("reworded landmine, after", "looks good"), "utf8");

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath, "--base", base]);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1);
    const line = cap.errLines.find((l) => l.startsWith("✗ ZZ-Landmine:"));
    assert.ok(line, `stderr was ${JSON.stringify(cap.errLines)}`);
    assert.match(
      line!,
      new RegExp(`2 violation\\(s\\) \\(2 pre-existing on base ${base}\\)`),
      "a reworded violation of the SAME check must still count as pre-existing, by count, never by text",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exit code is unchanged: 0 on a clean diff, 1 on a diff that introduces a violation, 1 on a diff that merely touches a base-failing task", async () => {
  // Clean diff: task unchanged in substance, one-word title edit, no violations at either end.
  {
    const { dir, planPath, relPath } = fixturePlanPaths();
    try {
      const base = baseCommitWithBlob(
        relPath,
        CLEAN_TASK("untouched clean task, before", "unit test: test/w1-t2339-fixture.test.ts"),
      );
      writeFileSync(
        planPath,
        CLEAN_TASK("untouched clean task, after", "unit test: test/w1-t2339-fixture.test.ts"),
        "utf8",
      );
      const cap = captureConsole();
      let code: number;
      try {
        code = await lintPlanCommand(["--plan", planPath, "--base", base]);
      } finally {
        cap.restore();
      }
      assert.equal(code, 0, "a clean diff over a clean task must still exit 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Diff introduces a violation.
  {
    const { dir, planPath, relPath } = fixturePlanPaths();
    try {
      const base = baseCommitWithBlob(
        relPath,
        CLEAN_TASK("introduces one, before", "unit test: test/w1-t2339-fixture.test.ts"),
      );
      writeFileSync(planPath, CLEAN_TASK("introduces one, after", "works"), "utf8");
      const cap = captureConsole();
      let code: number;
      try {
        code = await lintPlanCommand(["--plan", planPath, "--base", base]);
      } finally {
        cap.restore();
      }
      assert.equal(code, 1, "a diff that introduces a real violation must still exit 1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Diff merely touches a base-failing task.
  {
    const { dir, planPath, relPath } = fixturePlanPaths();
    try {
      const base = baseCommitWithBlob(relPath, LANDMINE_TASK("touches a landmine, before", "works"));
      writeFileSync(planPath, LANDMINE_TASK("touches a landmine, after", "works"), "utf8");
      const cap = captureConsole();
      let code: number;
      try {
        code = await lintPlanCommand(["--plan", planPath, "--base", base]);
      } finally {
        cap.restore();
      }
      assert.equal(code, 1, "a diff merely touching a base-failing task must still exit 1 — the gate does not move");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a base ref that cannot itself be linted degrades the annotation, not the run", async () => {
  const { dir, planPath, relPath } = fixturePlanPaths();
  try {
    // A base whose MONOLITH-position blob (at `relPath`) parses fine on its own, but whose
    // reconstructed FULL plan does not — a shard beside it (`<relDir>/tasks.d/*.yaml`)
    // re-declares the SAME id, exactly test/lint-plan-broken-base.test.ts's own shape. That
    // distinction matters here: `lintPlanCommand` parses the monolith blob TWICE — once via
    // `loadPlan(tmpFile)` over monolith+shards (guarded, degrades on failure) and once via a
    // bare `parseTasksFromYaml(oldRaw, ...)` over the monolith blob ALONE, for the
    // monolith-filing check (unguarded — a duplicate WITHIN that blob alone would throw
    // past the degrade path entirely). Keeping the monolith blob itself duplicate-free is
    // what isolates this test to the annotation this task adds, rather than tripping that
    // separate, pre-existing, unguarded call.
    const relDir = dirname(relPath);
    const shardRelPath = relDir === "." ? "tasks.d/zzz-w1-t2339-dup.yaml" : `${relDir}/tasks.d/zzz-w1-t2339-dup.yaml`;
    const base = baseCommitWithBlobs([
      { relPath, content: LANDMINE_TASK("duplicate one, monolith position", "works") },
      // A second record under the SAME id ("ZZ-Landmine"), planted in the SHARD position —
      // `loadPlan` refuses two records sharing one id once shards are materialized alongside it.
      { relPath: shardRelPath, content: LANDMINE_TASK("duplicate two, shard position", "works") },
    ]);
    writeFileSync(planPath, LANDMINE_TASK("head version", "works"), "utf8");

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath, "--base", base]);
    } finally {
      cap.restore();
    }

    assert.notEqual(code, 2, "an unparseable BASE must not be reported as this branch's failure");
    assert.equal(code, 1, "the head task still genuinely fails, on its own, so the run still exits 1");
    const degraded = cap.errLines.find((l) => l.includes("does not itself load"));
    assert.ok(degraded, `must announce the degradation; stderr was ${JSON.stringify(cap.errLines)}`);
    const line = cap.errLines.find((l) => l.startsWith("✗ ZZ-Landmine:"));
    assert.ok(line, `must still report the failing task; stderr was ${JSON.stringify(cap.errLines)}`);
    assert.equal(
      line,
      "✗ ZZ-Landmine: 2 violation(s)",
      "with no pre-existing annotation — today's exact output, since the base could not be attributed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no run without --base performs a second lint pass: the annotation never appears in whole-plan mode", async () => {
  const { dir, planPath } = fixturePlanPaths();
  try {
    // Whole-plan mode reads `--plan` directly with no base resolution at all.
    writeFileSync(planPath, LANDMINE_TASK("whole-plan mode", "works"), "utf8");

    const cap = captureConsole();
    let code: number;
    try {
      code = await lintPlanCommand(["--plan", planPath]);
    } finally {
      cap.restore();
    }

    assert.equal(code, 1, "the task still genuinely fails");
    const line = cap.errLines.find((l) => l.startsWith("✗ ZZ-Landmine:"));
    assert.ok(line, `stderr was ${JSON.stringify(cap.errLines)}`);
    assert.equal(
      line,
      "✗ ZZ-Landmine: 2 violation(s)",
      "no --base ⇒ no base ref to lint against ⇒ no annotation, ever",
    );
    assert.ok(
      cap.errLines.every((l) => !l.includes("pre-existing")),
      "the word 'pre-existing' must never appear anywhere in whole-plan output",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
