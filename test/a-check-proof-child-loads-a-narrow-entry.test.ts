import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripComments } from "../src/lib/test-impact-map.js";
import { gitRepo } from "./helpers/git-repo.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const entry = resolve(root, "src/check-proof-main.ts");

// @source-text-subject: the static import graph is the task's isolation contract.
test("W1-T7728: the narrow check-proof entry never imports the run-task module", () => {
  const visited = new Set<string>();
  function walk(path: string): void {
    assert.notEqual(path, resolve(root, "src/run-task.ts"), "a narrow child must not load the CLI");
    if (visited.has(path)) return;
    visited.add(path);
    const source = stripComments(readFileSync(path, "utf8"));
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*)(["'])(\.[^"']+)\1/g);
    for (const [, , specifier] of imports) {
      const target = resolve(dirname(path), specifier!);
      const candidates = [target.replace(/\.js$/, ".ts"), target];
      const next = candidates.find(existsSync);
      assert.ok(next, `cannot resolve ${specifier} from ${path}`);
      walk(next);
    }
  }
  walk(entry);
  assert.ok(visited.has(resolve(root, "src/lib/check-proof.ts")), "the entry must use the extracted executor");
  assert.ok(visited.has(resolve(root, "src/lib/review.ts")), "positive control: the reviewer executor was traversed");
});

test("W1-T7728: the narrow entry and rmd check-proof agree on verdict and exit code", async () => {
  const { checkProofChildArgv } = await import("../src/lib/check-proof.js");
  const fixture = gitRepo({ kind: "narrow-proof" });
  try {
    writeFileSync(resolve(fixture.dir, "marker.txt"), "shared\n");
    fixture.git("add", "marker.txt");
    fixture.git("commit", "-qm", "base marker");
    writeFileSync(resolve(fixture.dir, "marker.txt"), "shared\nadded\n");
    fixture.git("add", "marker.txt");
    fixture.git("commit", "-qm", "head marker");
    const env: NodeJS.ProcessEnv = { ...process.env, RMD_SELF_SYNC_DONE: "1" };
    delete env.NODE_TEST_CONTEXT;
    for (const [pattern, code, verdict] of [["added", 0, "pass"], ["missing", 1, "fail"], ["shared", 5, "pass"]] as const) {
      const args = [`grep: ${pattern} in marker.txt`, "--base", "HEAD~1"];
      const argv = checkProofChildArgv(args[0]!, "HEAD~1");
      assert.equal(argv[2], entry, "the shared builder must launch the narrow entry");
      const narrow = spawnSync(process.execPath, argv, {
        cwd: fixture.dir, env, encoding: "utf8", timeout: 60_000,
      });
      const cli = spawnSync(resolve(root, "bin/rmd"), ["check-proof", ...args], {
        cwd: fixture.dir, env, encoding: "utf8", timeout: 60_000,
      });
      assert.equal(narrow.error, undefined);
      assert.equal(cli.error, undefined);
      assert.equal(narrow.status, code, `${narrow.stdout}\n${narrow.stderr}`);
      assert.equal(cli.status, code, `${cli.stdout}\n${cli.stderr}`);
      const reading = (stdout: string) => stdout.split("\n").filter((line) => /^(verdict:|base:|discrimination:)/.test(line));
      assert.match(narrow.stdout, new RegExp(`^verdict:\\s+${verdict}$`, "m"));
      assert.deepEqual(reading(narrow.stdout), reading(cli.stdout));
      if (code === 5) assert.match(narrow.stdout, /discrimination: executed_stale/);
    }
  } finally {
    fixture.cleanup();
  }
});
