/**
 * The coverage precheck reads its affected-suite scope from a WORKER worktree. Its census and
 * plan-reading listings must come from the HARNESS's own scripts/diff-class.mjs, reading the worktree
 * only as data: the worktree's copy is worker-written code, and the host must not execute it. The
 * worktree's own coverage runner does run (its suites are the worker's code by design), but with the
 * proof env and a throwaway HOME, never the daemon's credentials.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as affected from "../src/lib/affected-suites.js";
import * as runTask from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = {
  GH_TOKEN: "ghs_fixture_gh_token",
  GITHUB_TOKEN: "ghs_fixture_github_token",
  ANTHROPIC_API_KEY: "sk-fixture-anthropic",
  OPENAI_API_KEY: "sk-fixture-openai",
  GH_APP_PRIVATE_KEY_PATH: "/fixture/app-key.pem",
} as const;

/** A committed tree whose scripts/ are planted: each records that it ran, and with what env. */
function plantedTree() {
  const tree = gitRepo({ kind: "planted-selector" });
  const put = (path: string, content: string) => {
    mkdirSync(join(tree.dir, path, ".."), { recursive: true });
    writeFileSync(join(tree.dir, path), content);
  };
  const ranMarker = join(tree.dir, ".selector-ran");
  const runnerEnv = join(tree.dir, ".runner-env.json");
  put("src/a.ts", "export const a = 1;\n");
  put("test/census.test.ts", 'import { readFileSync } from "node:fs";\nreadFileSync(join(ROOT, "src/a.ts"), "utf8");\n');
  put("test/unrelated.test.ts", "export {};\n");
  put("docs/x.md", "# x\n");
  put("scripts/diff-class.mjs", [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(ranMarker)}, JSON.stringify(process.env));`,
    'console.log("test/planted.test.ts");', "",
  ].join("\n"));
  put("scripts/diff-coverage-local.mjs", [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(runnerEnv)}, JSON.stringify(process.env));`, "",
  ].join("\n"));
  put(".gitignore", "node_modules\n.selector-ran\n.runner-env.json\n.probe/\n");
  symlinkSync(join(HARNESS, "node_modules"), join(tree.dir, "node_modules"), "dir");
  tree.git("add", "-A");
  tree.git("commit", "-q", "-m", "planted scripts");
  return { tree, ranMarker, runnerEnv };
}

/** Run `fn` with the daemon-shaped credential vars set, restoring the parent env after. */
async function withSecrets<T>(extra: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const vars = { ...SECRETS, ...extra };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a worker worktree's own diff-class.mjs never runs while its affected-suite input is read", async () => {
  const fx = plantedTree();
  const scratch = join(fx.tree.dir, ".probe");
  mkdirSync(scratch);
  const probeLog = join(scratch, "probe.log");
  const probe = join(scratch, "probe.mjs");
  writeFileSync(probe, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify({ gh: process.env.GH_TOKEN ?? null }) + "\\n");`, "",
  ].join("\n"));
  try {
    await withSecrets({ NODE_OPTIONS: `--import=${pathToFileURL(probe).href}` }, () => {
      // POSITIVE CONTROL: a node child given the parent env runs the probe and sees the token.
      spawnSync(process.execPath, ["-e", ""], { env: process.env });
      assert.match(readFileSync(probeLog, "utf8"), /ghs_fixture_gh_token/);
      writeFileSync(probeLog, "");

      const input = affected.readAffectedSuitesInput(fx.tree.dir, ["src/a.ts", "docs/x.md"]);
      assert.equal(existsSync(fx.ranMarker), false, "the worktree's scripts/diff-class.mjs ran on the host");
      assert.ok(input.pathReaders.includes("test/census.test.ts"), `harness census read the tree: ${input.pathReaders.join(",")}`);
      assert.ok(!input.pathReaders.includes("test/planted.test.ts"));
      assert.ok(input.files.has("src/a.ts"));
      assert.doesNotMatch(readFileSync(probeLog, "utf8"), /ghs_fixture/, "a listing child inherited a credential");
    });
    // The listing child's env is an allowlist under a throwaway HOME.
    const env = affected.affectedListingEnv(join(scratch, "listing-home"), { ...SECRETS, PATH: "/bin", NODE_V8_COVERAGE: "/x" });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "TMPDIR"]);
    assert.equal(env.HOME, join(scratch, "listing-home"));

    // A harness-root caller reads exactly what diff-class printed under the old, cwd-rooted argv.
    const changed = ["src/lib/tmp.ts", "docs/x.md"];
    const list = join(scratch, "changed.txt");
    writeFileSync(list, changed.join("\n") + "\n");
    const old = (flag: string) => spawnSync(process.execPath, ["--import", "tsx", join(HARNESS, "scripts", "diff-class.mjs"), flag, "--changed-files", list], { cwd: HARNESS, encoding: "utf8" })
      .stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const expected = [...old("--list-census-suites"), ...old("--list-plan-reading-suites")];
    assert.ok(expected.length > 10, `the harness listings are non-trivial: ${expected.length}`);
    assert.deepEqual(affected.readAffectedSuitesInput(HARNESS, changed).pathReaders, expected);
  } finally {
    fx.tree.cleanup();
  }
});

test("the coverage precheck scopes a worker worktree with the harness selector and runs its runner without daemon credentials", async () => {
  const fx = plantedTree();
  try {
    const result = await withSecrets({}, () => runTask.coveragePrecheck(fx.tree.dir, {
      changedFiles: () => ["src/a.ts"],
      manifest: () => ({ thresholdMs: 10_000, files: { "test/census.test.ts": 100 } }),
    }));
    assert.equal(existsSync(fx.ranMarker), false, "the worktree's scripts/diff-class.mjs ran on the host");
    assert.deepEqual(result, { outcome: "covered", reason: "1 scoped suite(s) cover every added src line", suites: 1 });
    assert.ok(existsSync(fx.runnerEnv), "the worktree's coverage runner ran");
    const seen = JSON.parse(readFileSync(fx.runnerEnv, "utf8")) as Record<string, string>;
    for (const name of Object.keys(SECRETS)) assert.equal(seen[name], undefined, `${name} reached the worker's runner`);
    assert.notEqual(seen.HOME, homedir());
    assert.notEqual(seen.HOME, process.env.HOME);
  } finally {
    fx.tree.cleanup();
  }
});
