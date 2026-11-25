import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T14645 — a recursive rg from the root skips plan/tasks.d; naming it (or a shard) still reads it.
const RGIGNORE = join(REPO_ROOT, ".rgignore");
const NEEDLE = "needle-w1-t14645";
const hasRg = spawnSync("rg", ["--version"]).status === 0;

function rg(cwd: string, ...args: string[]): string {
  return spawnSync("rg", ["--no-messages", "-l", NEEDLE, ...args], { cwd, encoding: "utf8" }).stdout;
}

test("rg from the root skips plan/tasks.d, but a named path is still searched", { skip: !hasRg }, () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-rgignore-"));
  try {
    mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    copyFileSync(RGIGNORE, join(root, ".rgignore"));
    writeFileSync(join(root, "plan", "tasks.d", "shard.yaml"), `${NEEDLE}\n`);
    writeFileSync(join(root, "src", "code.ts"), `${NEEDLE}\n`);

    const recursive = rg(root, "--no-ignore-vcs", ".");
    assert.match(recursive, /src[\\/]code\.ts/);
    assert.doesNotMatch(recursive, /tasks\.d/);

    assert.match(rg(root, "--no-ignore-vcs", "plan/tasks.d"), /shard\.yaml/);
    assert.match(rg(root, "--no-ignore-vcs", "plan/tasks.d/shard.yaml"), /shard\.yaml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
