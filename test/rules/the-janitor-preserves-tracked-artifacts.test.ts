import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitRepo } from "#test/helpers/git-repo.js";

const source = readFileSync("deploy/mac/remudero-janitor.sh", "utf8");
function shellFunction(name: string): string {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `physical maintained function ${name} exists`);
  return source.slice(start, end + 3);
}

function fixture(relative: string, tracked: boolean) {
  const root = mkdtempSync(join(tmpdir(), "rmd-janitor-index-"));
  const repository = gitRepo({ seedCommit: false, kind: "janitor-index-repo" });
  const repo = repository.dir;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: root };
  const git = (...args: string[]) => repository.git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args);
  writeFileSync(join(repo, ".gitignore"), "coverage\nnode_modules\n");
  const artifact = join(repo, relative);
  const payload = join(artifact, "keep.test.ts");
  mkdirSync(dirname(payload), { recursive: true });
  writeFileSync(payload, "committed or generated fixture bytes\n");
  git("add", ".gitignore");
  if (tracked) git("add", "-f", "--", relative);
  git("commit", "--quiet", "-m", "seed private fixture");
  assert.equal(git("status", "--porcelain"), "", "the incident starts in a clean checkout");
  const harness = join(root, "invoke.sh");
  writeFileSync(harness, `#!/bin/bash
set -uo pipefail
${shellFunction("artifact_index_risk")}
${shellFunction("clean_artifact")}
NOW=$(date +%s); AGE_HOURS=6; APPLY="\${APPLY_MODE:-1}"; RUN_USER=$(id -un); USER_HOME="$HOME"
reclaimed_kb=0; removed=0; planned=0; estimated_kb=0
skipped_owner=0; skipped_live=0; skipped_cwd=0; skipped_open=0; skipped_young=0
log() { printf '%s\\n' "$*"; }
rmd_dependency_seed_risk() { return 1; }
rmd_workspace_published() { return 0; }
artifact_owner() { id -un; }
is_live() { return 1; }
is_cwd_in() { return 1; }
is_open() { return 1; }
artifact_mtime() { printf '%s\\n' "$((NOW - 7 * 3600))"; }
rmd_decision_known_kib() { :; }
rmd_retirement_git() {
  local repo="$1"; shift
  if [ "\${FAIL_INDEX:-0}" = 1 ] && [ "$1" = ls-files ]; then return 128; fi
  git -c core.hooksPath=/dev/null -C "$repo" "$@"
}
refresh_process_snapshot() {
  if [ "\${LATE_TRACK:-0}" = 1 ]; then git -c core.hooksPath=/dev/null -C "$FIXTURE_REPO" add -f -- "$FIXTURE_RELATIVE"; fi
  return 0
}
clean_artifact "$1"
`);
  return {
    root, repo, artifact, payload,
    run(extra: Record<string, string> = {}) {
      const result = spawnSync("bash", [harness, artifact], { env: { ...env, FIXTURE_REPO: repo, FIXTURE_RELATIVE: relative, ...extra }, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout;
    },
    close() { repository.cleanup(); rmSync(root, { recursive: true, force: true }); },
  };
}

for (const relative of ["test/ci/coverage", "coverage", "test/fixtures/node_modules", "test/fixtures/[ab]/coverage"]) {
  test(`the janitor preserves tracked source in ${relative} even when clean published and old`, () => {
    const fx = fixture(relative, true);
    try {
      assert.match(fx.run(), /artifact contains tracked source/);
      assert.equal(readFileSync(fx.payload, "utf8"), "committed or generated fixture bytes\n");
      assert.match(fx.run({ APPLY_MODE: "0" }), /artifact contains tracked source/);
    } finally { fx.close(); }
  });
}

test("the janitor still removes an old untracked generated coverage cache", () => {
  const fx = fixture("coverage", false);
  try { assert.match(fx.run(), /REMOVED/); assert.equal(existsSync(fx.artifact), false); }
  finally { fx.close(); }
});

test("the janitor retains an artifact when its Git index cannot be read", () => {
  const fx = fixture("coverage", false);
  try { assert.match(fx.run({ FAIL_INDEX: "1" }), /artifact Git index is unreadable/); assert.equal(existsSync(fx.payload), true); }
  finally { fx.close(); }
});

test("the janitor rechecks tracked membership before chmod or deletion", () => {
  const fx = fixture("coverage", false);
  try { assert.match(fx.run({ LATE_TRACK: "1" }), /changed protected.*artifact contains tracked source/); assert.equal(existsSync(fx.payload), true); }
  finally { fx.close(); }
});
