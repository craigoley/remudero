// W1-T4588: rule 1 of hooks/deny-floor.sh (force-push to a default branch) grepped the WHOLE command
// line for a force flag and, separately, for `main`. A plain push of a feature branch chained with a
// REST pull-request create -- gh's `-f title=... -f base=main` -- satisfied both and was refused, four
// times in one session. The rule is now judged per command segment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK_PATH = fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url));

function run(command: string): { status: number | null; stderr: string } {
  const cacheHome = mkdtempSync(join(tmpdir(), "rmd-denyfloor-seg-"));
  try {
    const r = spawnSync("bash", [HOOK_PATH], {
      input: JSON.stringify({ tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, XDG_CACHE_HOME: cacheHome },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(cacheHome, { recursive: true, force: true });
  }
}

const FORCE_REFUSAL = /git push --force to a default branch/;

test("W1-T4588: a plain feature-branch push beside a gh call carrying -f base=main is not a force-push to main", () => {
  for (const command of [
    "git push -q -u origin run-W1-T1-1 && gh api --method POST repos/o/r/pulls -f title=x -f head=run-W1-T1-1 -f base=main",
    "git push origin feature-branch; gh api --method POST repos/o/r/pulls -f base=main -f title=y",
    "git push --force-with-lease=run-x:abc origin run-x && echo main",
    "git push --force origin run-x && echo 'merged to main'",
  ]) {
    const { stderr } = run(command);
    assert.doesNotMatch(stderr, FORCE_REFUSAL, `wrongly refused: ${command}`);
  }
});

test("W1-T4588: a forced push to a default branch is still refused in any segment", () => {
  for (const command of [
    "git push --force origin main",
    "git push -f origin master",
    "echo ready && git push --force origin main",
    "git fetch origin; git push -f origin HEAD:main",
    "true || git push origin main --force",
  ]) {
    const { status, stderr } = run(command);
    assert.equal(status, 2, `must refuse: ${command}`);
    assert.match(stderr, FORCE_REFUSAL);
  }
});
