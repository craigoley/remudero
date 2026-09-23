/**
 * test/local-diff-coverage-matches-ci.test.ts — W1-T4084 acceptance.
 *
 * scripts/diff-coverage-local.mjs exists so a local diff-coverage run cannot silently diverge from
 * ci.yml's "coverage-ratchet" job -- the divergence was MEASURED twice in one session on
 * 2026-09-22: a hand-rolled coverage run missing `--enable-source-maps` reported `diff-coverage: OK`
 * for a PR CI then BLOCKED (uncovered `src/lib/mounts.ts:510`), and later reported real, executed
 * `run-task.ts` lines as uncovered -- both because without source maps `DA:` positions land on
 * tsx-transpiled JS lines while `SF:` still names the `.ts` file. A third hand-rolled defect (a
 * two-dot `A..B` diff against a moved `origin/main`) added a false BLOCKED by including commits the
 * local branch never touched.
 *
 * These two tests are this task's own acceptance criteria, each pinned to a *mechanism* rather
 * than a spot-check of today's ci.yml text or today's git state, so a future edit to either the
 * workflow's flags or the diff semantics is caught rather than silently trusted:
 *  - flags: extractCoverageFlags reads ci.yml at call time, so mutating the workflow's own text
 *    changes what it returns -- proving this is READ, not a hand-copied literal, which is exactly
 *    what would let the two invocations drift apart again.
 *  - diff base: mergeBaseDiff is exercised against a real git fixture where origin/main moves
 *    AFTER the local branch diverged, and the diff is asserted to contain only the branch's own
 *    change -- the same shape as the measured false-BLOCKED defect, reproduced and proven fixed.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { extractCoverageFlags, mergeBaseDiff } from "../scripts/diff-coverage-local.mjs";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(import.meta.dirname, "..");

test('W1-T4084: the local command reads its flags from the CI workflow', () => {
  const ciYamlText = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");

  // Today's real ci.yml, parsed for real: the exact node coverage flags the "Test with coverage"
  // step passes, minus its own test-file placeholder (this script's caller supplies test files).
  const flags = extractCoverageFlags(ciYamlText);
  assert.deepEqual(flags, [
    "--enable-source-maps",
    "--experimental-test-coverage",
    "--test-coverage-exclude=test/**",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    "--test-reporter-destination=stderr",
    "--test-reporter=lcov",
    "--test-reporter-destination=coverage/lcov.info",
    "--test",
    "--import",
    "tsx",
    "--import",
    "./test/setup/tmp-hygiene.ts",
  ]);

  // READ, NOT COPIED: mutating the workflow's OWN text changes what extractCoverageFlags returns,
  // proving this parses ci.yml at call time rather than returning a value hand-copied into this
  // script -- the exact hazard that let the local and CI invocations drift apart in the first
  // place.
  const mutated = ciYamlText.replace(
    '--test-coverage-exclude="test/**"',
    '--test-coverage-exclude="test/**" --test-name-pattern="w1-t4084-mutated"',
  );
  assert.notEqual(mutated, ciYamlText, "the replacement must actually match today's ci.yml text");
  const mutatedFlags = extractCoverageFlags(mutated);
  assert.ok(
    mutatedFlags.includes("--test-name-pattern=w1-t4084-mutated"),
    `expected the mutated flag to be picked up; got ${JSON.stringify(mutatedFlags)}`,
  );
});

test('W1-T4084: the diff is taken from the merge base', () => {
  // A bare "origin" plus a "work" clone that pushes to it, reproducing the exact shape of a real
  // GitHub remote and a real local checkout -- not a single working tree diffed against itself.
  const origin = gitRepo({ bare: true, branch: "main", kind: "w1-t4084-origin" });
  const work = gitRepo({ branch: "main", kind: "w1-t4084-work" });
  work.addRemote("origin", origin.dir);
  work.git("push", "origin", "main");

  const local = gitRepo({ cloneFrom: origin.dir, kind: "w1-t4084-local" });
  local.git("checkout", "-b", "feature");

  writeFileSync(join(local.dir, "feature.txt"), "feature change\n");
  local.git("add", "feature.txt");
  local.git("commit", "-m", "feature change");

  // origin/main MOVES after the branch point -- the exact hazard the rationale measured: a
  // two-dot diff (`A..B`) against a moved base pulls in commits the feature branch never touched.
  writeFileSync(join(work.dir, "moved-base.txt"), "unrelated origin change\n");
  work.git("add", "moved-base.txt");
  work.git("commit", "-m", "unrelated origin change");
  work.git("push", "origin", "main");

  local.git("fetch", "origin");

  const diffText = mergeBaseDiff({ cwd: local.dir, base: "origin/main", head: "feature" });
  assert.match(diffText, /feature\.txt/, `expected the branch's own change in the diff; got:\n${diffText}`);
  assert.doesNotMatch(
    diffText,
    /moved-base\.txt/,
    `origin/main's own later, unrelated commit must not appear in a merge-base diff; got:\n${diffText}`,
  );
});
