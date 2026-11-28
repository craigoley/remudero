// @census-reads: bin/rmd scripts/build-child-entries.mjs — the launcher test copies bin/rmd and the bundle script into its fixture tree.
// W1-T14921: host-alert, live-edits, progress-watchdog and deploy-run start from the run-task bundle when it is
// current, with the review rule: an existing bundle only, no build, no daemon boot attempt.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const SCRIPT = join(REPO_ROOT, "scripts", "build-child-entries.mjs");
const VERBS = ["progress-watchdog", "deploy-run", "host-alert", "live-edits"] as const;

type Choice = { kind: "bundle" | "tsx"; reason: string; bundle?: string };
interface BuildModule {
  OUT_DIR: string;
  CHILD_ENTRIES: ReadonlyArray<{ name: string; source: string }>;
  WORKER_ENTRIES: readonly string[];
  MAIN_OFF_NAME: string;
  BUNDLED_MAIN_VERBS: readonly string[];
  mainEntry(root: string, verb: string, opts?: { build?: (opts: object) => Promise<unknown> }): Promise<Choice>;
  readMainAttempt(root: string): unknown;
  buildChildEntries(opts: { root: string }): Promise<{ sourceHash: string }>;
}
/** Required, as src/lib/main-entry.ts requires it: one instance of the script per process. */
const build = createRequire(import.meta.url)(SCRIPT) as BuildModule;

/** The line the fixture main prints: whether it runs bundled, what the launcher told it, and its argv. */
const FIXTURE_MAIN = [
  "const facts = { bundled: (globalThis as { __rmd_bundled?: boolean }).__rmd_bundled === true, entry: process.env.RMD_MAIN_ENTRY,",
  "  argv: process.argv.slice(2) };",
  "console.log(JSON.stringify(facts));",
].join("\n");

/** Fill `root` with every declared child and worker entry, the real launcher and bundle script, and this repo's node_modules. */
function fillLaunchTree(root: string): string {
  writeFileSync(join(root, "package.json"), '{ "name": "fixture", "type": "module" }\n');
  writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
  for (const source of [...build.CHILD_ENTRIES.map((e) => e.source), ...build.WORKER_ENTRIES]) {
    mkdirSync(dirname(join(root, source)), { recursive: true });
    writeFileSync(join(root, source), source === "src/run-task.ts" ? `${FIXTURE_MAIN}\n` : `export const at = ${JSON.stringify(source)};\n`);
  }
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "bin", "rmd"), join(root, "bin", "rmd"));
  copyFileSync(SCRIPT, join(root, "scripts", "build-child-entries.mjs"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  return root;
}

/** A tree that is not a git checkout, so its HEAD is on no branch, as in a daemon's detached tree. */
const detachedTree = (): string => fillLaunchTree(mkdtempSync(join(tmpdir(), "rmd-watchdog-bundle-tree-")));

const out = (root: string, file: string): string => join(root, build.OUT_DIR, file);

/** Where and how `bin/rmd` is called: its cwd (default: its own tree), its args, and the self-sync guard. */
type From = { cwd?: string; args?: string[]; selfSynced?: boolean };

function launch(root: string, verb: string, from: From = {}): { bundled: boolean; entry?: string; argv: string[] } {
  const { cwd = root, args = ["--flag"], selfSynced = false } = from;
  const env = { ...process.env };
  delete env.RMD_MAIN_ENTRY;
  delete env.RMD_SELF_SYNC_DONE;
  if (selfSynced) env.RMD_SELF_SYNC_DONE = "1";
  // W1-T2732: blank the coverage session var: enrolled, the child's coverage names fixture files gone by report time.
  env.NODE_V8_COVERAGE = undefined;
  const run = spawnSync("bash", [join(root, "bin", "rmd"), verb, ...args], { cwd, encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
}

test("W1-T14921 the watchdog verbs start from a current bundle", async () => {
  const root = detachedTree();
  try {
    for (const verb of VERBS) assert.ok(build.BUNDLED_MAIN_VERBS.includes(verb), `${verb} is a bundled verb`);
    await build.buildChildEntries({ root });
    for (const verb of VERBS) {
      const choice = await build.mainEntry(root, verb, { build: () => Promise.reject(new Error(`${verb} must not build`)) });
      assert.deepEqual(choice, { kind: "bundle", reason: "source-hash-match", bundle: out(root, "run-task.mjs") });
      const started = launch(root, verb);
      assert.equal(started.bundled, true, `bin/rmd starts ${verb} from the bundle under plain node`);
      assert.equal(started.entry, "bundle:source-hash-match");
      assert.deepEqual(started.argv, [verb, "--flag"]);
    }
    assert.equal(build.readMainAttempt(root), null, "no watchdog verb writes a daemon boot attempt");
    const other = launch(root, "status");
    assert.deepEqual([other.bundled, other.entry], [false, undefined], "every other verb runs on tsx exactly as before");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T14921 a doubtful bundle starts tsx and builds nothing", async () => {
  const root = detachedTree();
  const refuse = (verb: string) => () => Promise.reject(new Error(`${verb} must not build`));
  try {
    for (const verb of VERBS) {
      assert.deepEqual(await build.mainEntry(root, verb, { build: refuse(verb) }), { kind: "tsx", reason: "no-manifest" });
      const started = launch(root, verb);
      assert.deepEqual([started.bundled, started.entry], [false, undefined], `a missing bundle starts ${verb} on tsx as before`);
    }
    assert.equal(existsSync(out(root, "manifest.json")), false, "nothing was built");

    const { sourceHash } = await build.buildChildEntries({ root });
    const kept = `${FIXTURE_MAIN}\n`;
    writeFileSync(join(root, "src", "run-task.ts"), `${kept}// changed\n`);
    for (const verb of VERBS) {
      assert.deepEqual(await build.mainEntry(root, verb, { build: refuse(verb) }), { kind: "tsx", reason: "source-changed" });
      assert.equal(launch(root, verb).bundled, false, `a stale bundle starts ${verb} on tsx`);
    }
    const manifest = JSON.parse(readFileSync(out(root, "manifest.json"), "utf8")) as { sourceHash: string };
    assert.equal(manifest.sourceHash, sourceHash, "the stale bundle is left as it was, not rebuilt");
    writeFileSync(join(root, "src", "run-task.ts"), kept);

    writeFileSync(out(root, build.MAIN_OFF_NAME), "");
    for (const verb of VERBS) {
      assert.deepEqual(await build.mainEntry(root, verb, { build: refuse(verb) }), { kind: "tsx", reason: "switched-off" });
      assert.equal(launch(root, verb).bundled, false, `a switched-off bundle starts ${verb} on tsx`);
    }
    unlinkSync(out(root, build.MAIN_OFF_NAME));

    unlinkSync(out(root, "run-task.mjs.map"));
    for (const verb of VERBS) {
      assert.deepEqual(await build.mainEntry(root, verb, { build: refuse(verb) }), { kind: "tsx", reason: "map-missing" });
      assert.equal(launch(root, verb).bundled, false, `a map-less bundle starts ${verb} on tsx`);
    }
    assert.equal(existsSync(out(root, "run-task.mjs.map")), false, "the map was not rebuilt");
    assert.equal(build.readMainAttempt(root), null, "no watchdog verb writes a daemon boot attempt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A tree on a branch can self-sync and re-exec its .ts entry, which a bundled main (no tsx loader) could not start.
// Self-sync acts on --repo-root, else the cwd's tree, else bin/rmd's own tree: none of them may be on a branch.
test("W1-T14921 a tree on a branch keeps the watchdog verbs on tsx", async () => {
  const repo = gitRepo({ kind: "watchdog-bundle-branch" });
  const checkout = gitRepo({ kind: "watchdog-bundle-caller" });
  const outside = mkdtempSync(join(tmpdir(), "rmd-watchdog-bundle-outside-"));
  try {
    const root = fillLaunchTree(repo.dir);
    await build.buildChildEntries({ root });
    const below = join(checkout.dir, "below");
    mkdirSync(below);
    const choice = (verb: string, from?: From) => {
      const started = launch(root, verb, from);
      return [started.bundled, started.entry];
    };
    const onTsx = [false, undefined];
    const fromBundle = [true, "bundle:source-hash-match"];
    for (const verb of VERBS) {
      assert.deepEqual(choice(verb), onTsx, `${verb} on branch main starts tsx`);
      assert.deepEqual(choice(verb, { cwd: outside }), onTsx, `${verb}: bin/rmd's own tree is on a branch`);
    }

    repo.git("checkout", "--quiet", "--detach");
    for (const verb of VERBS) {
      assert.deepEqual(choice(verb), fromBundle, `${verb} from the detached tree starts the bundle`);
      assert.deepEqual(choice(verb, { cwd: outside }), fromBundle, `${verb} from no checkout syncs the detached tree`);
      assert.deepEqual(choice(verb, { cwd: checkout.dir }), onTsx, `${verb} from a checkout on main starts tsx`);
      assert.deepEqual(choice(verb, { cwd: below }), onTsx, `${verb} from below a checkout on main starts tsx`);
      const named = { args: ["--repo-root", checkout.dir] };
      assert.deepEqual(choice(verb, named), onTsx, `${verb} naming --repo-root starts tsx`);
      for (const from of [{ cwd: checkout.dir }, named]) {
        assert.deepEqual(choice(verb, { ...from, selfSynced: true }), fromBundle, `${verb}: the guard rules out a re-exec`);
      }
    }

    checkout.git("checkout", "--quiet", "--detach");
    for (const verb of VERBS) {
      assert.deepEqual(choice(verb, { cwd: checkout.dir }), fromBundle, `${verb} from a detached checkout starts the bundle`);
    }
  } finally {
    repo.cleanup();
    checkout.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});
