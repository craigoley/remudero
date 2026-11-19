/**
 * W1-T11468: a checkout whose lockfile moves under its node_modules is re-primed from the seed
 * store, or told exactly how. The fixtures are real: lockfile-bearing checkouts, a real seed store
 * under a temporary HOME, and the checkout's own scripts/dependency-seeds.mjs. The lock shape is
 * the 2026-11-18 one: the lock wants playwright 1.65.1 and the materialized seed holds 1.65.0.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { defaultDependencySeedRoot, materializeDependencySeed } from "#src/lib/dependency-seeds.js";
import { makeTempDir } from "#src/lib/tmp.js";
// @ts-expect-error -- ESM provenance helper outside source tsconfig roots.
import * as provenance from "#scripts/lib/author-dependency-provenance.mjs";
import { gitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const HOOK = join(REPO_ROOT, "hooks/post-merge");
const CLI = join(REPO_ROOT, "scripts/dependency-seeds.mjs");
const AUTHOR = join(REPO_ROOT, "scripts/preflight-author.mjs");
const OLD = { playwright: "1.65.0", nested: "1.0.0" }, NEW = { playwright: "1.65.1", nested: "1.0.1" };
type Versions = typeof OLD;

function versionsOf(v: Versions): Record<string, string> {
  return { tsx: "4.20.0", typescript: "5.9.0", "@commitlint/cli": "19.8.0", playwright: v.playwright };
}

/** package.json, package-lock.json and a workspace manifest: the seed identity's inputs. */
function writeInputs(dir: string, v: Versions): void {
  const devDependencies = versionsOf(v), workspace = { name: "@fixture/local", version: "1.0.0", dependencies: { nested: v.nested } };
  mkdirSync(join(dir, "packages/local"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", private: true, workspaces: ["packages/local"], devDependencies }, null, 2));
  writeFileSync(join(dir, "packages/local/package.json"), JSON.stringify(workspace, null, 2));
  const packages: Record<string, unknown> = {
    "": { name: "fixture", version: "1.0.0", workspaces: ["packages/local"], devDependencies },
    "packages/local": workspace,
    "packages/local/node_modules/nested": { version: v.nested },
    "node_modules/@fixture/local": { resolved: "packages/local", link: true },
  };
  for (const [name, version] of Object.entries(devDependencies)) packages[`node_modules/${name}`] = { version, dev: true };
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages }, null, 2));
}

/** What `npm ci` leaves behind for these inputs: packages, tool bins and the workspace's own modules. */
function writeModules(dir: string, v: Versions): void {
  const modules = join(dir, "node_modules");
  for (const [name, version] of Object.entries(versionsOf(v))) {
    mkdirSync(join(modules, name), { recursive: true });
    writeFileSync(join(modules, name, "package.json"), JSON.stringify({ name, version }));
  }
  const bins: Record<string, string> = { tsx: "tsx/cli.mjs", tsc: "typescript/bin/tsc", commitlint: "@commitlint/cli/cli.js" };
  mkdirSync(join(modules, ".bin"), { recursive: true });
  for (const [bin, target] of Object.entries(bins)) {
    mkdirSync(join(modules, target, ".."), { recursive: true });
    writeFileSync(join(modules, target), `#!/usr/bin/env node\n// ${bin} ${v.playwright}\n`);
    symlinkSync(join("..", target), join(modules, ".bin", bin));
  }
  mkdirSync(join(modules, "@fixture"), { recursive: true });
  symlinkSync("../../packages/local", join(modules, "@fixture/local"));
  mkdirSync(join(dir, "packages/local/node_modules/nested"), { recursive: true });
  writeFileSync(join(dir, "packages/local/node_modules/nested/package.json"), JSON.stringify({ name: "nested", version: v.nested }));
}

function writeInstall(dir: string, v: Versions): void {
  mkdirSync(dir, { recursive: true });
  writeInputs(dir, v);
  writeModules(dir, v);
}

function writable(path: string): void {
  if (!existsSync(path) && !lstatExists(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  chmodSync(path, st.mode | 0o700);
  if (st.isDirectory()) for (const name of readdirSync(path)) writable(join(path, name));
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Every entry's kind, name, link target and content digest, so "byte-identical" means exactly that. */
function tree(path: string, skip: readonly string[] = []): string {
  const hash = createHash("sha256");
  const visit = (p: string, rel: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) hash.update(`L ${rel} ${readlinkSync(p)}\n`);
    else if (st.isDirectory()) {
      hash.update(`D ${rel}\n`);
      for (const name of readdirSync(p).sort()) if (rel !== "." || !skip.includes(name)) visit(join(p, name), `${rel}/${name}`);
    } else hash.update(`F ${rel} ${st.mode & 0o777} ${createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
  };
  visit(path, ".");
  return hash.digest("hex");
}

const installed = (dir: string, name: string): string =>
  (JSON.parse(readFileSync(join(dir, name, "package.json"), "utf8")) as { version: string }).version;
const marker = (dir: string): { seed: string; checkout: string; key: string } =>
  JSON.parse(readFileSync(join(dir, "node_modules/.rmd-dependency-seed.json"), "utf8"));

/** A temporary HOME holding a real seed store, two donor installs and the standalone tool. */
function scene(t: TestContext) {
  const base = realpathSync(makeTempDir("w1-t11468"));
  t.after(() => { writable(base); rmSync(base, { recursive: true, force: true }); });
  const home = join(base, "home");
  mkdirSync(home);
  const store = defaultDependencySeedRoot(home);
  const donorOld = join(base, "donor-1.65.0"), donorNew = join(base, "donor-1.65.1");
  writeInstall(donorOld, OLD);
  writeInstall(donorNew, NEW);
  const prime = (target: string, ...extra: string[]) => spawnSync(process.execPath, [CLI, "prime", target, ...extra], {
    encoding: "utf8", env: { ...process.env, HOME: home, RMD_DEPENDENCY_SEED_ROOT: "" },
  });
  const primeOk = (target: string, ...extra: string[]) => {
    const r = prime(target, ...extra);
    assert.equal(r.status, 0, `prime ${target} ${extra.join(" ")}: ${r.stderr}`);
    return JSON.parse(r.stdout) as { status: string; seed?: string; replaced?: boolean };
  };
  /** A checkout primed from the 1.65.0 seed whose lockfile then moved to 1.65.1. */
  const stale = (dir: string): string => {
    mkdirSync(dir, { recursive: true });
    writeInputs(dir, OLD);
    assert.equal(primeOk(dir, "--source", donorOld, "--proof").status, "materialized");
    writeInputs(dir, NEW);
    return dir;
  };
  const generations = (): Record<string, string> => Object.fromEntries((existsSync(store) ? readdirSync(store) : [])
    .filter(name => /^[a-f0-9]{64}$/.test(name)).sort()
    .map(name => [name, tree(join(store, name), ["ready.json", "consumers"])]));
  return { base, home, store, donorOld, donorNew, prime, primeOk, stale, generations };
}

// --- criteria 1 and 2: the host post-merge hook --------------------------------------------------

function executable(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text, { mode: 0o755 });
}

function hookFixture(t: TestContext, layout: "seed-linked" | "absent" | "whole-directory-symlink" | "real-install") {
  assert.ok(existsSync(HOOK), "hooks/post-merge must exist: nothing re-primes a host checkout whose lockfile moves under a merge");
  const repo = gitRepo({ kind: "w1-t11468-post-merge" });
  t.after(() => repo.cleanup());
  const top = realpathSync(repo.dir);
  const side = realpathSync(makeTempDir("w1-t11468-hook"));
  t.after(() => rmSync(side, { recursive: true, force: true }));
  mkdirSync(join(top, "hooks"));
  copyFileSync(HOOK, join(top, "hooks/post-merge"));
  writeFileSync(join(top, ".gitignore"), "node_modules\n");
  writeInputs(top, OLD);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "lock 1.65.0");
  repo.git("config", "core.hooksPath", join(top, "hooks"));
  const donor = join(side, "donor-install");
  if (layout === "seed-linked") {
    mkdirSync(join(top, "node_modules"));
    mkdirSync(join(side, "seed/typescript"), { recursive: true });
    symlinkSync(join(side, "seed/typescript"), join(top, "node_modules/typescript"));
  } else if (layout === "whole-directory-symlink") {
    writeInstall(donor, OLD);
    symlinkSync(join(donor, "node_modules"), join(top, "node_modules"));
  } else if (layout === "real-install") writeModules(top, OLD);
  const bin = join(side, "tools"), home = join(side, "home"), calls = join(side, "calls");
  mkdirSync(home);
  executable(join(bin, "uname"), "#!/bin/sh\necho Linux\n");
  executable(join(bin, "remudero-dependencies"), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CALLS"\necho \'{"status":"materialized","method":"readonly-links","key":"moved-lock"}\'\n');
  // The account's own installed tool must never answer for the fixture's: drop PATH entries holding one.
  const path = (process.env.PATH ?? "").split(":").filter(dir => dir && !existsSync(join(dir, "remudero-dependencies")));
  const env = { ...process.env, HOME: home, PATH: [bin, ...path].join(":"), CALLS: calls,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: top, env, encoding: "utf8" });
  const recorded = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  /** Commit `change` on a side branch, then fast-forward main onto it: what a host fast-forward does. */
  const merge = (branch: string, change: () => void) => {
    assert.equal(git("checkout", "--quiet", "-b", branch).status, 0);
    change();
    assert.equal(git("add", "-A").status, 0);
    assert.equal(git("commit", "--quiet", "-m", branch).status, 0);
    assert.equal(git("checkout", "--quiet", "main").status, 0);
    const result = git("merge", "--ff-only", branch);
    assert.equal(result.status, 0, `the hook never fails the merge: ${result.stderr}`);
    return result;
  };
  const tool = join(bin, "remudero-dependencies");
  return { top, donor, env, home, bin, tool, git, recorded, merge };
}

test("W1-T11468 criterion 1: a merge that changes package-lock.json in a seed-linked host checkout runs remudero-dependencies prime for that checkout, and a merge that leaves the lockfile unchanged runs nothing", (t) => {
  const f = hookFixture(t, "seed-linked");
  const quiet = f.merge("readme-only", () => writeFileSync(join(f.top, "README.md"), "no lock change\n"));
  assert.deepEqual(f.recorded(), [], "a merge that leaves the lockfile unchanged runs nothing");
  assert.doesNotMatch(quiet.stderr, /post-merge:/);

  const moved = f.merge("lock-moves", () => writeInputs(f.top, NEW));
  assert.deepEqual(f.recorded(), [`prime ${f.top}`], "a moved lockfile re-primes exactly this checkout");
  assert.match(moved.stderr, /post-merge: package-lock\.json changed; re-priming .*node_modules/);
  assert.match(moved.stderr, /"key":"moved-lock"/, "the hook reports the prime's own outcome");

  // An absent node_modules is primed too; a refusing tool still leaves a successful merge.
  rmSync(join(f.top, "node_modules"), { recursive: true });
  executable(f.tool, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CALLS"\nprintf "dependency-seeds: store unavailable\\nprivate detail\\n" >&2\nexit 7\n');
  const refused = f.merge("lock-moves-again", () => writeInputs(f.top, OLD));
  assert.deepEqual(f.recorded(), [`prime ${f.top}`, `prime ${f.top}`]);
  assert.match(refused.stderr, /dependency-seeds: store unavailable/);
  assert.doesNotMatch(refused.stderr, /private detail/, "only the first refusal line is printed");

  // Darwin, and a host with no tool, stay silent.
  executable(join(f.bin, "uname"), "#!/bin/sh\necho Darwin\n");
  f.merge("darwin", () => writeInputs(f.top, NEW));
  assert.equal(f.recorded().length, 2, "a Mac checkout is healed by the author precheck, not the hook");
});

test("W1-T11468 criterion 2: when node_modules is a whole-directory symlink or a real install, the hook changes nothing on disk and prints the exact remedy, and the author precheck's version-differs refusal names that same remedy", (t) => {
  for (const layout of ["whole-directory-symlink", "real-install"] as const) {
    const f = hookFixture(t, layout);
    const modules = join(f.top, "node_modules");
    const before = { link: layout === "whole-directory-symlink" ? readlinkSync(modules) : "", bytes: tree(realpathSync(modules)) };
    const result = f.merge(`lock-moves-${layout}`, () => writeInputs(f.top, NEW));
    assert.deepEqual(f.recorded(), [], `${layout}: the hook never primes over a layout other checkouts may borrow`);
    assert.equal(layout === "whole-directory-symlink" ? readlinkSync(modules) : "", before.link, `${layout}: the link target is unchanged`);
    assert.equal(tree(realpathSync(modules)), before.bytes, `${layout}: the install is byte-identical`);
    const remedy = /Remedy: (.*)$/m.exec(result.stderr)?.[1];
    assert.ok(remedy, `${layout}: the hook prints a remedy: ${result.stderr}`);
    const expected = layout === "whole-directory-symlink"
      ? `rm ${modules} (the link only: never -r and no trailing slash), then ${f.tool} prime ${f.top}`
      : `mv ${modules} ${modules}.before-prime (other checkouts may borrow it), then ${f.tool} prime ${f.top}`;
    assert.equal(remedy, expected);

    // The author precheck, reading the same checkout, refuses with that same remedy and no env values.
    const env = { ...f.env, RMD_FIXTURE_SECRET: "never-print-this-value" };
    const read = provenance.authorDependencyProvenance(f.top, { env });
    assert.equal(read.state, "unavailable");
    assert.match(read.reason, /^installed package version differs: node_modules\/playwright/);
    assert.ok(read.reason.includes(`Remedy: ${expected}`), `${layout}: ${read.reason}`);
    assert.doesNotMatch(read.reason, /never-print-this-value/);

    // With no tool on PATH both resolve the account-local fallback, ~/.local/bin/remudero-dependencies.
    const fallback = join(f.home, ".local/bin/remudero-dependencies");
    executable(fallback, "#!/usr/bin/env bash\nexit 0\n");
    rmSync(f.tool);
    const viaHome = f.merge(`lock-moves-back-${layout}`, () => writeInputs(f.top, OLD));
    const fallbackRemedy = expected.replace(f.tool, fallback);
    assert.equal(/Remedy: (.*)$/m.exec(viaHome.stderr)?.[1], fallbackRemedy);
    writeInputs(f.top, NEW);
    assert.ok(provenance.authorDependencyProvenance(f.top, { env: f.env }).reason.includes(`Remedy: ${fallbackRemedy}`));
    writeInputs(f.top, OLD);
  }
});

// --- criterion 3: the author preflight heals its own seed materialization ----------------------

type AuthorMain = (argv: string[], deps: { root: string; select?: () => unknown; spawn?: typeof spawnSync }) => number;

/** A committed author checkout primed at 1.65.0 whose head moved the lock to 1.65.1. */
function authorFixture(t: TestContext, s: ReturnType<typeof scene>, seedScript: "real" | "noop" | "refuse") {
  const repo = gitRepo({ kind: "w1-t11468-author", seedCommit: false });
  t.after(() => { writable(repo.dir); repo.cleanup(); });
  const root = realpathSync(repo.dir);
  for (const dir of ["test/setup", "src/lib", "scripts"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), process.versions.node + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ncoverage\n");
  writeInputs(root, OLD);
  if (seedScript === "real") {
    copyFileSync(CLI, join(root, "scripts/dependency-seeds.mjs"));
    for (const file of ["src/lib/dependency-seeds.ts", "src/lib/clock.ts"]) copyFileSync(join(REPO_ROOT, file), join(root, file));
  } else if (seedScript === "noop") {
    writeFileSync(join(root, "scripts/dependency-seeds.mjs"), "console.log(JSON.stringify({ status: 'present' }));\n");
  } else {
    writeFileSync(join(root, "scripts/dependency-seeds.mjs"), "console.error('dependency-seeds: fixture refusal line\\nsecond private line'); process.exitCode = 1;\n");
  }
  writeFileSync(join(root, "scripts/diff-class.mjs"), "// This fixture has no census path readers.\n");
  writeFileSync(join(root, "scripts/census-precheck.mjs"),
    "import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('coverage', { recursive: true }); writeFileSync('coverage/census-started', 'yes'); process.exitCode = 1;\n");
  writeFileSync(join(root, "test/setup/tmp-hygiene.ts"), "export {};\n");
  writeFileSync(join(root, "src/run-task.ts"), "console.log('fixture static preflight');\n");
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "test/leaf.test.ts"), "import { test } from 'node:test'; test('leaf', () => {});\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "test: baseline at playwright 1.65.0");
  repo.git("remote", "add", "origin", root);
  repo.git("checkout", "-b", "run-unfiled-w1-t11468-fixture");
  assert.equal(s.primeOk(root, "--source", s.donorOld, "--proof").status, "materialized");
  writeInputs(root, NEW);
  writeFileSync(join(root, "src/leaf.ts"), "export const value = 2;\n");
  repo.git("add", ".");
  repo.git("commit", "-m", "chore: playwright 1.65.1");
  const primes: string[][] = [];
  const spawn = ((file: string, args: readonly string[], opts: Parameters<typeof spawnSync>[2]) => {
    if (args.some(arg => arg.endsWith("dependency-seeds.mjs"))) primes.push([file, ...args]);
    return spawnSync(file, args, opts);
  }) as typeof spawnSync;
  const select = () => ({ fullRun: false, suites: ["test/leaf.test.ts"], reasons: ["W1-T11468 fixture"] });
  return {
    root, primes,
    run: async () => ((await import(pathToFileURL(AUTHOR).href)) as { main: AuthorMain }).main([], { root, select, spawn }),
    receipt: () => JSON.parse(readFileSync(join(root, "coverage/preflight-author.json"), "utf8")),
    censusStarted: () => existsSync(join(root, "coverage/census-started")),
  };
}

test("W1-T11468 criterion 3: when the author dependency precheck reads an installed package version that differs from the lockfile and the checkout's node_modules is its own seed materialization, the author preflight runs the checkout's scripts/dependency-seeds.mjs prime with --proof for that checkout once, re-runs the provenance check, and starts census only when it reads present", async (t) => {
  const s = scene(t);
  // A generation for the new lock already exists (the 2026-11-18 recovery's fresh-donor seed); later primes reuse it.
  assert.equal(s.primeOk(s.stale(join(s.base, "first-healed")), "--source", s.donorNew, "--proof").status, "materialized");

  const healed = authorFixture(t, s, "real");
  const store = marker(healed.root).seed.replace(/\/[a-f0-9]{64}$/, "");
  assert.equal(installed(join(healed.root, "node_modules"), "playwright"), OLD.playwright, "positive control: the materialization is behind its lock");
  assert.equal(await healed.run(), 1, "the fixture census refuses, so the run stops right after it starts");
  assert.deepEqual(healed.primes, [[process.execPath, "--experimental-strip-types", join(healed.root, "scripts/dependency-seeds.mjs"), "prime", healed.root, "--proof", "--root", store]],
    "the checkout's own seed tool, with --proof, for this checkout, once");
  const receipt = healed.receipt();
  assert.equal(receipt.dependencyProvenance.reprime.status, 0);
  assert.equal(receipt.dependencyProvenance.before.state, "present", "the provenance re-check reads present");
  assert.equal(installed(join(healed.root, "node_modules"), "playwright"), NEW.playwright);
  assert.equal(healed.censusStarted(), true, "census starts once the re-check reads present");
  assert.equal(receipt.steps[0]?.name, "census-precheck");

  // A prime that reports success without healing is not believed: the re-check refuses before census.
  const unhealed = authorFixture(t, s, "noop");
  assert.equal(await unhealed.run(), 1);
  assert.equal(unhealed.primes.length, 1, "re-primed once, never in a loop");
  const kept = unhealed.receipt();
  assert.equal(kept.verdict, "refused");
  assert.match(kept.error, /installed dependency precheck unavailable: installed package version differs: node_modules\/playwright/);
  assert.equal(unhealed.censusStarted(), false, "census never starts while the re-check reads unavailable");
  assert.deepEqual(kept.steps, []);

  // A refusing prime: the refusal names its first line and the remedy.
  const refused = authorFixture(t, s, "refuse");
  assert.equal(await refused.run(), 1);
  assert.equal(refused.primes.length, 1);
  const named = refused.receipt();
  assert.match(named.error, /re-prime refused: dependency-seeds: fixture refusal line/);
  assert.doesNotMatch(named.error, /second private line/);
  assert.match(named.error, /Remedy: .* prime /);
  assert.equal(refused.censusStarted(), false);
});

// --- criterion 4: prime replaces its own stale materialization ---------------------------------

test("W1-T11468 criterion 4: prime replaces a checkout's own seed materialization that differs from the lockfile instead of refusing dependency seed version mismatch, materializing a new seed generation when none matches the lockfile (the 2026-11-18 playwright 1.65.0 to 1.65.1 case)", (t) => {
  const s = scene(t);
  const wt = s.stale(join(s.base, "worktree"));
  const old = marker(wt);
  const oldGeneration = tree(old.seed);
  assert.equal(installed(join(wt, "node_modules"), "playwright"), OLD.playwright, "positive control: the lock moved past the materialization");

  const replaced = s.prime(wt, "--source", s.donorNew, "--proof");
  assert.equal(replaced.status, 0, `prime must replace its own stale materialization: ${replaced.stderr}`);
  assert.doesNotMatch(replaced.stderr, /dependency seed version mismatch/);
  const result = JSON.parse(replaced.stdout) as { status: string; seed: string; replaced?: boolean; installed: boolean };
  assert.equal(result.status, "materialized");
  assert.equal(result.replaced, true);
  assert.notEqual(result.seed, old.seed, "a new seed generation was materialized for the new lock");
  assert.equal(installed(join(wt, "node_modules"), "playwright"), NEW.playwright);
  assert.equal(installed(join(wt, "packages/local/node_modules"), "nested"), NEW.nested, "the workspace's own modules are replaced too");
  assert.equal(marker(wt).seed, result.seed);
  assert.equal(marker(wt).checkout, wt);
  assert.equal(tree(old.seed), oldGeneration, "the old generation is byte-identical");
  assert.deepEqual(readdirSync(wt).filter(name => name.startsWith(".rmd-dependency-")), [], "no stage or retired directory is left behind");
  assert.equal(provenance.authorDependencyProvenance(wt).state, "present", "the author precheck now reads present");
  assert.deepEqual(s.primeOk(wt, "--proof"), { status: "present" }, "a later prime reuses the replacement");

  // With no donor and no matching generation, the tool's own `npm ci --ignore-scripts` stage builds one.
  const third = s.stale(join(s.base, "third-lock"));
  writeInputs(third, { playwright: "1.65.2", nested: "1.0.2" });
  const installs: string[][] = [];
  const fresh = materializeDependencySeed(third, { root: s.store, proof: true, env: { ...process.env, HOME: s.home },
    runInstall: (stage, args) => { installs.push(args); writeModules(stage, { playwright: "1.65.2", nested: "1.0.2" }); } });
  assert.equal(fresh.status, "materialized");
  assert.deepEqual(installs.map(args => args.slice(0, 2)), [["ci", "--ignore-scripts"]]);
  if (fresh.status === "materialized") { assert.equal(fresh.installed, true); assert.equal(fresh.replaced, true); }
  assert.equal(installed(join(third, "node_modules"), "playwright"), "1.65.2");
});

// --- criterion 5: only that checkout's node_modules is replaced --------------------------------

test("W1-T11468 criterion 5: invariant:only-this-worktree-is-replaced — only that checkout's node_modules is replaced: a whole-directory symlink, a real install with no consumer marker naming the checkout, every seed generation and every other checkout's node_modules are byte-identical before and after, and the seed integrity checks are unchanged", (t) => {
  const s = scene(t);
  const wt = s.stale(join(s.base, "worktree")), other = s.stale(join(s.base, "other-worktree"));
  const borrowed = join(s.base, "borrowed-install");
  writeInstall(borrowed, OLD);
  const linked = join(s.base, "linked");
  mkdirSync(linked);
  writeInputs(linked, NEW);
  symlinkSync(join(borrowed, "node_modules"), join(linked, "node_modules"));
  const real = join(s.base, "real-install");
  writeInstall(real, OLD);
  writeInputs(real, NEW);
  const copied = join(s.base, "copied-materialization");
  mkdirSync(copied);
  writeInputs(copied, NEW);
  cpSync(join(wt, "node_modules"), join(copied, "node_modules"), { recursive: true, verbatimSymlinks: true });
  const unreadable = join(s.base, "unreadable-marker");
  writeInstall(unreadable, OLD);
  writeInputs(unreadable, NEW);
  writeFileSync(join(unreadable, "node_modules/.rmd-dependency-seed.json"), "not a marker");
  const snapshot = () => ({
    other: tree(join(other, "node_modules")), otherWorkspace: tree(join(other, "packages/local/node_modules")),
    link: readlinkSync(join(linked, "node_modules")), borrowed: tree(join(borrowed, "node_modules")),
    real: tree(join(real, "node_modules")), copied: tree(join(copied, "node_modules")), unreadable: tree(join(unreadable, "node_modules")),
  });
  const before = snapshot(), generationsBefore = s.generations();
  assert.equal(Object.keys(generationsBefore).length, 1, "positive control: one 1.65.0 generation");

  // The precheck never re-primes a layout that is not this checkout's own materialization.
  for (const dir of [linked, real, copied, unreadable]) {
    const read = provenance.authorDependencyProvenance(dir);
    assert.match(read.reason, /installed package version differs/, dir);
    const runs: unknown[] = [];
    assert.equal(provenance.reprimeOwnSeedMaterialization(dir, read, { run: (...args: unknown[]) => { runs.push(args); return { status: 0 }; } }), undefined, dir);
    assert.deepEqual(runs, [], `${dir}: no prime is run`);
    const r = s.prime(dir, "--source", s.donorNew, "--proof");
    assert.notEqual(r.status, 0, `${dir}: prime refuses an occupied destination that is not its own materialization`);
    assert.match(r.stderr, /dependency seed version mismatch for playwright/);
  }
  assert.deepEqual(snapshot(), before, "no refused layout changed");
  assert.deepEqual(s.generations(), generationsBefore, "no generation was created or changed by a refusal");

  // Positive control: this checkout is replaced, and nothing else moves.
  assert.equal(s.primeOk(wt, "--source", s.donorNew, "--proof").replaced, true);
  assert.equal(installed(join(wt, "node_modules"), "playwright"), NEW.playwright);
  assert.deepEqual(snapshot(), before, "every other checkout, the symlink, its donor and the unmarked install are byte-identical");
  const generationsAfter = s.generations();
  for (const [key, digest] of Object.entries(generationsBefore)) assert.equal(generationsAfter[key], digest, `generation ${key} is byte-identical`);
  const fresh = Object.keys(generationsAfter).find(key => !(key in generationsBefore));
  assert.ok(fresh, "the replacement came from a new generation");

  // Seed integrity is unchanged: a corrupt generation that matches the lock is never materialized from.
  const third = s.stale(join(s.base, "third-worktree"));
  const thirdBefore = tree(join(third, "node_modules"));
  const corrupt = join(s.store, fresh, "node_modules/playwright/package.json"), corruptMode = statSync(corrupt).mode;
  chmodSync(corrupt, 0o755);
  const refusedCorrupt = s.prime(third, "--proof");
  assert.notEqual(refusedCorrupt.status, 0, "a writable generation is refused");
  assert.match(refusedCorrupt.stderr, /immutable dependency payload is writable or unverified/);
  assert.equal(tree(join(third, "node_modules")), thirdBefore, "the checkout is untouched when its new seed is corrupt");
  chmodSync(corrupt, corruptMode);

  // ...and a stale materialization whose own seed no longer verifies is never replaced.
  const oldSeed = marker(other).seed;
  const oldFile = join(oldSeed, "node_modules/playwright/package.json"), oldMode = statSync(oldFile).mode;
  chmodSync(oldFile, 0o755);
  const refusedUnverified = s.prime(other, "--proof");
  assert.notEqual(refusedUnverified.status, 0, "a materialization its seed cannot verify is not replaced");
  assert.equal(tree(join(other, "node_modules")), before.other, "the other checkout is byte-identical");
  chmodSync(oldFile, oldMode);
});
