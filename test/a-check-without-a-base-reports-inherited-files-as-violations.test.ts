/**
 * W1-T3203 — A `--check` WITH NO `--base` REPORTED INHERITED FILES AS VIOLATIONS.
 *
 * Both readings were true of what they measured. Only one is CI's, and nothing said which.
 * MEASURED 2026-09-08: an operator read the bare form as "main is failing its own gate and blocking
 * every open PR", opened a 21-row seeding PR on that diagnosis, and merged it. The rows were
 * harmless placeholders; the diagnosis was false, and the gate's own printed remedy is what led
 * there.
 *
 * WHAT MUST NOT SOFTEN, and the MUTANT test below is what holds it: a file this branch genuinely
 * ADDS still refuses. This task changes what the gate SAYS when it cannot tell, never when it
 * refuses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-tier-manifest.mjs");

/** A throwaway git repo with a manifest and two test files: one the base already had (INHERITED)
 *  and one this working tree adds (BLOCKING). The distinction is the whole subject of this task. */
function fixture(): { root: string; cleanup: () => void } {
  // The SHARED helper, never an inline `git init`: fixture-copy-census counts that shape across
  // test/ precisely so a fixture's identity env and cleanup stay one implementation.
  const repo = gitRepo({ kind: "t3203", branch: "base", seedCommit: false });
  const root = repo.dir;
  mkdirSync(join(root, "test"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "test-tier-manifest.json"), JSON.stringify({ thresholdMs: 1000, files: {} }));
  writeFileSync(join(root, "test", "inherited.test.ts"), "// already on the base, untiered there\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base: an untiered test file the branch did not add");
  // Only NOW does this working tree add its own untiered file.
  writeFileSync(join(root, "test", "added.test.ts"), "// this branch adds it\n");
  return { root, cleanup: () => repo.cleanup() };
}

const run = (root: string, args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, "--check", "--manifest", "scripts/test-tier-manifest.json", ...args], {
    cwd: root,
    encoding: "utf8",
  });

test("W1-T3203: with NO --base, the check says its reading is not CI's and names the flag", () => {
  const f = fixture();
  try {
    const r = run(f.root, []);
    const err = r.stderr;
    assert.equal(r.status, 1, "it still REFUSES — this task changes what it says, never whether it blocks");
    assert.match(err, /not CI's verdict/, "the reading announces what it is, exactly as task-id-existence-check does");
    assert.match(err, /--base origin\/main/, "and names the flag that produces CI's reading");
    assert.match(err, /cannot be told from one this branch added/, "and says WHY the two are listed together");
  } finally {
    f.cleanup();
  }
});

test("W1-T3203: the --seed remedy is NOT printed for a reading that cannot tell inherited from added", () => {
  const f = fixture();
  try {
    const err = run(f.root, []).stderr;
    assert.doesNotMatch(
      err,
      /Record it with: node scripts\/test-tier-manifest\.mjs --seed/,
      "this exact line is what produced a 21-row seeding PR against a false diagnosis — it must not appear when inheritance is unknowable",
    );
  } finally {
    f.cleanup();
  }
});

test("W1-T3203: WITH a --base, inherited is separated from added and the seed remedy returns", () => {
  const f = fixture();
  try {
    const r = run(f.root, ["--base", "base"]);
    assert.equal(r.status, 1, "the ADDED file still refuses");
    assert.match(r.stderr, /untiered file\(s\) came from base/, "the inherited one is named as inherited, not charged to this branch");
    assert.match(r.stderr, /added\.test\.ts/, "and the added one is what blocks");
    assert.doesNotMatch(r.stderr, /not CI's verdict/, "with a base, the reading IS CI's — no degrade notice");
    assert.match(r.stderr, /Record it with: node scripts\/test-tier-manifest\.mjs --seed/, "and the remedy is knowable again, so it is offered");
  } finally {
    f.cleanup();
  }
});

test("W1-T3203 MUTANT: the gate is not softened — a file this tree ADDS refuses in BOTH modes", () => {
  // The failure this guards against is a "fix" that makes the bare form pass by treating every
  // unknown file as inherited. That would silence the gate entirely for the local invocation an
  // author actually types, which is the one W1-T3205's pre-push hook runs.
  const f = fixture();
  try {
    assert.equal(run(f.root, []).status, 1, "no base: still refuses");
    assert.equal(run(f.root, ["--base", "base"]).status, 1, "with a base: still refuses");
    assert.match(run(f.root, ["--base", "base"]).stderr, /added\.test\.ts/);
  } finally {
    f.cleanup();
  }
});

test("W1-T3203: a fully tiered tree is OK in both modes — the notice fires only on a refusal", () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.root, "scripts", "test-tier-manifest.json"),
      JSON.stringify({ thresholdMs: 1000, files: { "test/inherited.test.ts": 0, "test/added.test.ts": 0 } }),
    );
    const bare = run(f.root, []);
    assert.equal(bare.status, 0);
    assert.doesNotMatch(bare.stderr, /not CI's verdict/, "a clean tree gets no degrade notice — the notice is about a REFUSAL it could not attribute");
    assert.equal(run(f.root, ["--base", "base"]).status, 0);
  } finally {
    f.cleanup();
  }
});
