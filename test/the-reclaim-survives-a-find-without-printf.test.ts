import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitRepo } from "./helpers/git-repo.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");
const DAYS = 24 * 60 * 60 * 1000;

/**
 * W1-T3837 — THIS FILE IS THE PORTABILITY FALSIFIER, AND IT IS A SEPARATE FILE ON PURPOSE.
 *
 * The sibling suite (agent-history-does-not-fill-the-root-disk.test.ts) already stubs a BSD-shaped
 * `find`, but it CANNOT witness this fix: `buildBaseProofDir` copies only the paths a diff ADDS
 * into the merge-base worktree (`addedTestFiles`, W1-T3190). That sibling is MODIFIED, so the base
 * side re-runs the BASE's copy of it — which has no stub — against GNU find on this runner, where
 * `-printf` works and the proof passes on both sides. The gate graded exactly that:
 *
 *   discrimination: executed_stale — this proof matches BOTH head and base
 *
 * An ADDED file is copied to the base, so the cases below run against the PRE-FIX script there and
 * fail, which is what makes them evidence. Keep them here; moving them into the sibling would
 * silently restore the stale grade without changing a single assertion.
 *
 * WHY A STUB AT ALL: every runner this suite executes on ships GNU find, so the macOS failure the
 * task describes cannot be reproduced with the real binary. `-printf` is the one primary that
 * differs for this script's purposes, so the stub rejects exactly that flag — printing nothing and
 * exiting non-zero, as BSD find does — and delegates everything else, including the portable
 * `-print0` the fix now uses, to the real binary. Under `set -euo pipefail` a pre-fix
 * `find -printf` dies here exactly as it does on a real macOS host.
 */
function writeStubs(dir: string): void {
  const resolved = spawnSync("bash", ["-c", "command -v find"], { encoding: "utf8" });
  const realFind = (resolved.stdout ?? "").trim();
  assert.ok(realFind, `could not resolve a real \`find\` to wrap: ${resolved.stderr ?? "no output"}`);

  const find = [
    "#!/usr/bin/env bash",
    'for a in "$@"; do',
    '  if [ "$a" = "-printf" ]; then',
    '    echo "find: -printf: unknown primary or operator" >&2',
    "    exit 1",
    "  fi",
    "done",
    `exec "${realFind}" "$@"`,
    "",
  ].join("\n");
  writeFileSync(join(dir, "find"), find, { mode: 0o755 });
  chmodSync(join(dir, "find"), 0o755);

  // Only what section 0/1/3/4 reach under `--reclaim-only`; no pull is ever reached in this mode.
  const docker = [
    "#!/usr/bin/env bash",
    'case "$1 $2" in',
    '  "info --format")  echo "$STUB_REC"; exit 0 ;;',
    '  "system df")      echo "TYPE TOTAL ACTIVE SIZE"; exit 0 ;;',
    "esac",
    'case "$1" in',
    "  ps)      exit 0 ;;",
    "  inspect) exit 0 ;;",
    "  image)",
    '    if [ "$2" = "inspect" ]; then exit 0; fi',
    '    echo "Total reclaimed space: 0B"; exit 0 ;;',
    '  container|builder) echo "Total reclaimed space: 0B"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 });
  chmodSync(join(dir, "docker"), 0o755);
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the REAL script under `--reclaim-only` with a BSD-shaped `find` ahead of it on PATH. */
function runWithBsdFind(extraEnv: NodeJS.ProcessEnv, extraArgs: readonly string[] = []): Run {
  const stubs = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bsd-find-stub-`));
  const rec = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bsd-find-rec-`));
  const state = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bsd-find-state-`));
  // A real git target, named through the env and built with the SHARED helper: the default pair's
  // first half must exist or every case here trips the "reached NONE of its named targets" refusal
  // and fails for a reason it is not about. Shelling `git init` again would trip
  // test/fixture-copy-census.test.ts, which exists to refuse exactly that extra copy.
  const gitTarget = gitRepo({ kind: "reclaim-target" });
  writeStubs(stubs);
  const r = spawnSync("bash", [SCRIPT, "--reclaim-only", ...extraArgs], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      STUB_REC: rec,
      STUB_MODE: "good",
      RMD_STATE_DIR: state,
      RMD_GIT_RECLAIM_DIRS: gitTarget.dir,
      ...extraEnv,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An empty claude tree, so a case that is only about the codex tree still satisfies the script. */
function emptyClaudeDir(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bsd-find-claude-empty-`));
}

test("a find without -printf still reclaims old agent history and reports the bytes freed", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bsd-find-codex-`));
  const old = join(dir, "thread_history_1.sqlite");
  const fresh = join(dir, "state_5.sqlite");
  writeFileSync(old, "x".repeat(4096));
  writeFileSync(fresh, "y".repeat(2048));
  const now = new Date();
  utimesSync(old, new Date(now.getTime() - 60 * DAYS), new Date(now.getTime() - 60 * DAYS));
  utimesSync(fresh, now, now);

  const run = runWithBsdFind({ RMD_CODEX_DIR: dir, RMD_CLAUDE_DIR: emptyClaudeDir() });

  // On the PRE-FIX script the `find -printf` producer dies under `set -euo pipefail` here, so this
  // status assertion is the one that separates the two sides.
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!existsSync(old), "a 60-day-old file must be reclaimed without GNU find's -printf");
  assert.ok(existsSync(fresh), "a file written today must survive — this is age-tiered, not a size cap");
  // The bytes must be COUNTED through the portable producer, not merely tolerated: a script that
  // enumerated nothing would still print a per-tree line, reporting 0B reclaimed.
  assert.match(run.stdout, new RegExp(`agent history reclaim — ${esc(dir)}: freed 4\\.0KB across 1 file`));
});

test("a find without -printf still removes oldest first", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bsd-find-order-`));
  const now = new Date();
  // Named so that readdir order disagrees with mtime order unless the script sorts explicitly.
  const third = join(dir, "z-third.log");
  const first = join(dir, "a-first.log");
  const second = join(dir, "m-second.log");
  for (const [p, age] of [
    [third, 20],
    [first, 60],
    [second, 40],
  ] as const) {
    writeFileSync(p, "z".repeat(1024));
    utimesSync(p, new Date(now.getTime() - age * DAYS), new Date(now.getTime() - age * DAYS));
  }

  const run = runWithBsdFind({ RMD_CODEX_DIR: dir, RMD_CLAUDE_DIR: emptyClaudeDir() });

  assert.equal(run.status, 0, run.stderr);
  const order = run.stdout
    .split("\n")
    .filter((l) => l.startsWith("  removed "))
    .map((l) => l.slice("  removed ".length).trim());
  assert.deepEqual(
    order,
    [first, second, third],
    "the portable producer must still hand the removals over sorted by ascending mtime",
  );
});

test("a find without -printf still reports a dry run without removing anything", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}bsd-find-dry-`));
  const old = join(dir, "thread_history_1.sqlite");
  writeFileSync(old, "x".repeat(4096));
  const now = new Date();
  utimesSync(old, new Date(now.getTime() - 60 * DAYS), new Date(now.getTime() - 60 * DAYS));

  const run = runWithBsdFind({ RMD_CODEX_DIR: dir, RMD_CLAUDE_DIR: emptyClaudeDir() }, ["--dry-run"]);

  // The pre-fix dry-run branch assigned from `$(find … -printf …)`; with the BSD stub that
  // substitution fails and the script exits non-zero, so status alone separates the two sides.
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /agent history reclaim \(DRY RUN\)/);
  // COUNTED, not merely tolerated: a producer that enumerated nothing would still print the label
  // while reporting 0B, so the fixture's real size is the assertion that has teeth.
  assert.match(run.stdout, /would free 4\.0KB/, "the old file's size must be computed by the portable producer");
  assert.ok(existsSync(old), "a dry run must remove nothing");
});
