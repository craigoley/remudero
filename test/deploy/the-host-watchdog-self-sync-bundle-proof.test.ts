// @census-reads: bin/rmd scripts/build-child-entries.mjs — this test runs their branch/self-sync behavior in a fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");
const VERBS = ["progress-watchdog", "deploy-run", "host-alert", "live-edits"] as const;
type BuildModule = {
  OUT_DIR: string;
  CHILD_ENTRIES: ReadonlyArray<{ source: string }>;
  WORKER_ENTRIES: readonly string[];
  buildChildEntries(opts: { root: string }): Promise<unknown>;
};
const build = createRequire(import.meta.url)(SCRIPT) as BuildModule;
const FIXTURE_MAIN = [
  "const facts = { bundled: (globalThis as { __rmd_bundled?: boolean }).__rmd_bundled === true, entry: process.env.RMD_MAIN_ENTRY,",
  "  argv: process.argv.slice(2) };",
  "console.log(JSON.stringify(facts));",
].join("\n");

function fillLaunchTree(root: string): void {
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  for (const source of [...build.CHILD_ENTRIES.map((entry) => entry.source), ...build.WORKER_ENTRIES]) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    writeFileSync(join(root, source), source === "src/run-task.ts" ? `${FIXTURE_MAIN}\n` : `export const at = ${JSON.stringify(source)};\n`);
  }
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "bin", "rmd"), join(root, "bin", "rmd"));
  copyFileSync(SCRIPT, join(root, "scripts", "build-child-entries.mjs"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
}

function launch(root: string, verb: string, selfSynced: boolean): { bundled: boolean; entry?: string } {
  const env = { ...process.env };
  delete env.RMD_MAIN_ENTRY;
  delete env.RMD_SELF_SYNC_DONE;
  env.NODE_V8_COVERAGE = undefined;
  if (selfSynced) env.RMD_SELF_SYNC_DONE = "1";
  const run = spawnSync("bash", [join(root, "bin", "rmd"), verb], { cwd: root, encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
}

test("W1-T14921 a tree on a branch keeps the watchdog verbs on tsx", async () => {
  const repo = gitRepo({ kind: "watchdog-self-sync-proof" });
  const root = repo.dir;
  try {
    fillLaunchTree(root);
    await build.buildChildEntries({ root });
    for (const verb of VERBS) {
      assert.deepEqual(launch(root, verb, false), { bundled: false }, `${verb} on branch main starts tsx before self-sync`);
      assert.deepEqual(launch(root, verb, true), { bundled: true, entry: "bundle:source-hash-match" }, `${verb} after self-sync starts the current bundle`);
    }
  } finally {
    repo.cleanup();
  }
});
