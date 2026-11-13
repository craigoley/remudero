/**
 * W1-T12268: the installed copies of the Mac janitor refresh themselves from `origin/main`.
 *
 * On 2026-11-11 both installed copies on the Mac agent account were last installed on
 * 2026-11-07 and lacked the tsx cache trim that merged as W1-T12252; only a person ran the
 * installers. These cases run the real installers from a fixture checkout whose `origin/main`
 * ref moves without a fetch, then run the installed passes the schedules run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { fixture, type Fixture } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ORIGIN = "https://github.com/craigoley/remudero.git";
const GUARDS = ["deploy/workspace-retirement-guard.sh", "deploy/dependency-seed-guard.sh"];
const MAC_FILES = readdirSync(join(REPO_ROOT, "deploy/mac")).map((name) => `deploy/mac/${name}`);
const JANITOR_SET = ["workspace-retirement-guard.sh", "dependency-seed-guard.sh", "tmp-reclaim.sh", "cache-reclaim.py",
  "retire-legacy-sweeper.py", "preserve-retire.py", "remudero-janitor.sh"];
const SUPPORT_SET = ["dependency-seed-guard.sh", "tmp-reclaim.sh", "cache-reclaim.py"];
const CHANGE = "\n# W1-T12268 fixture: a change that merged to main\n";

interface World { fx: Fixture; repo: GitRepo; launchctl: GhShim; tab: string; writes: string; path: string }

/** A checkout of the maintained sources whose `origin` is the remudero repository, with `origin/main` at HEAD. */
function world(t: TestContext): World {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const repo = gitRepo({ scope: t, kind: "janitor-refresh-src" });
  for (const file of [...GUARDS, ...MAC_FILES]) {
    mkdirSync(dirname(join(repo.dir, file)), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), join(repo.dir, file));
  }
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "chore: maintained janitor sources");
  repo.addRemote("origin", ORIGIN);
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const tab = join(fx.root, "crontab.txt");
  writeFileSync(tab, "5 * * * * /usr/bin/true # someone else's job\n17 * * * * tmp-reclaim.sh --apply # remudero-tmp-reclaim\n");
  // A stand-in crontab reads the fixture table and counts every write; the real table is never touched.
  const writes = join(fx.root, "crontab-writes.txt");
  writeFileSync(join(fx.root, "bin/crontab"), `#!/bin/bash\nif [ "$1" = -l ]; then cat '${tab}'; else cat > '${tab}'; echo write >> '${writes}'; fi\n`, { mode: 0o755 });
  const launchctl = ghShim([], { kind: "janitor-refresh-launchctl", command: "launchctl" });
  t.after(() => rmSync(launchctl.dir, { recursive: true, force: true }));
  const path = `${launchctl.dir}:${join(fx.root, "bin")}:${process.env.PATH}`;
  return { fx, repo, launchctl, tab, writes, path };
}

/** Move `origin/main` one commit ahead, the way a fetch after a merge does, and put HEAD and the working tree back. */
function mergeToMain(w: World, files: string[], edit: (text: string) => string = (text) => text + CHANGE): string {
  for (const file of files) writeFileSync(join(w.repo.dir, file), edit(readFileSync(join(w.repo.dir, file), "utf8")));
  w.repo.git("commit", "--quiet", "-am", "fix: a janitor change on main");
  w.repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  w.repo.git("reset", "--quiet", "--hard", "HEAD~1");
  return w.repo.git("rev-parse", "refs/remotes/origin/main");
}

function env(w: World, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HOME: w.fx.home, TMPDIR: w.fx.scratch, PATH: w.path, ...extra };
}

function sh(w: World, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("bash", args, { encoding: "utf8", env: env(w, extra) });
  return { status: r.status, out: r.stdout + r.stderr };
}

function installHomeBin(w: World, dest: string) {
  const r = sh(w, [join(w.repo.dir, "deploy/mac/install-janitor.sh")], { REMUDERO_JANITOR_INSTALL_DIR: dest });
  assert.equal(r.status, 0, r.out);
}

const supportDir = (w: World) => join(w.fx.home, "Library", "Application Support", "remudero");

/** The env of the scheduled hourly temp cleaner, aimed at an empty fixture root. */
function reclaimEnv(w: World): Record<string, string> {
  const root = join(w.fx.root, "reclaim-root"); mkdirSync(root, { recursive: true });
  return {
    RMD_RECLAIM_ROOT: root, RMD_RECLAIM_SESSION_ROOT: join(w.fx.root, "no-sessions"), RMD_RECLAIM_FREE_PCT: "50",
    RMD_RECLAIM_REPORT: join(w.fx.root, "kept.txt"), RMD_RECLAIM_LSOF: join(w.fx.root, "bin/lsof"),
    RMD_RECLAIM_KEEP_FILE: join(w.fx.root, "keep.txt"), REMUDERO_JANITOR_DECISION_LOG: join(w.fx.root, "decisions.tsv"),
  };
}

function blob(w: World, commit: string, file: string): string { return w.repo.git("rev-parse", `${commit}:${file}`); }
function hashOf(w: World, path: string): string { return w.repo.git("hash-object", "--no-filters", "--", path); }
function snapshot(w: World, dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, statSync(join(dir, name)).isFile() ? hashOf(w, join(dir, name)) : "dir"]));
}
const refreshLines = (out: string) => out.split("\n").filter((line) => line.includes("janitor refresh:"));

test("W1-T12268 criterion 1: each installer records its checkout and layout beside the files, after every copy", (t) => {
  const w = world(t);
  const checkout = realpathSync(w.repo.dir);
  const homeBin = join(w.fx.root, "bin-layout");
  installHomeBin(w, homeBin);
  assert.equal(readFileSync(join(homeBin, "install-source"), "utf8"), `checkout=${checkout}\nlayout=home-bin\norigin=${ORIGIN}\n`);
  const shared = join(w.fx.root, "Shared");
  assert.equal(sh(w, [join(w.repo.dir, "deploy/mac/install-janitor.sh"), "--shared-root", shared]).status, 0);
  assert.equal(readFileSync(join(shared, "remudero-mac/install-source"), "utf8"), `checkout=${checkout}\nlayout=shared\norigin=${ORIGIN}\n`);
  const support = sh(w, [join(w.repo.dir, "deploy/mac/install-tmp-reclaim.sh")]);
  assert.equal(support.status, 0, support.out);
  assert.equal(readFileSync(join(supportDir(w), "install-source"), "utf8"), `checkout=${checkout}\nlayout=application-support\norigin=${ORIGIN}\n`);
  // A linked worktree records the repository that holds it, which outlives the worktree.
  const linked = w.repo.addWorktree(join(w.fx.root, "linked"), "linked-work");
  const fromLinked = join(w.fx.root, "from-linked");
  const r = sh(w, [join(linked.dir, "deploy/mac/install-janitor.sh")], { REMUDERO_JANITOR_INSTALL_DIR: fromLinked });
  assert.equal(r.status, 0, r.out);
  assert.match(readFileSync(join(fromLinked, "install-source"), "utf8"), new RegExp(`^checkout=${checkout}\n`));
  // An incomplete source set fails before any copy, so no record names it.
  rmSync(join(linked.dir, "deploy/mac/preserve-retire.py"));
  const partial = join(w.fx.root, "partial");
  assert.equal(sh(w, [join(linked.dir, "deploy/mac/install-janitor.sh")], { REMUDERO_JANITOR_INSTALL_DIR: partial }).status, 2);
  assert.equal(existsSync(join(partial, "install-source")), false);
});

test("W1-T12268 criterion 2: a scheduled pass installs the changed files of origin/main after its own work and prints both hashes", (t) => {
  const w = world(t);
  const dest = join(w.fx.root, "bin-layout");
  installHomeBin(w, dest);
  const before = { tmp: hashOf(w, join(dest, "tmp-reclaim.sh")), cache: hashOf(w, join(dest, "cache-reclaim.py")) };
  const main = mergeToMain(w, ["deploy/mac/tmp-reclaim.sh", "deploy/mac/cache-reclaim.py"]);
  const r = sh(w, [join(dest, "tmp-reclaim.sh"), "--apply"], reclaimEnv(w));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(refreshLines(r.out), [
    `janitor refresh: replaced tmp-reclaim.sh ${before.tmp} -> ${blob(w, main, "deploy/mac/tmp-reclaim.sh")}`,
    `janitor refresh: replaced cache-reclaim.py ${before.cache} -> ${blob(w, main, "deploy/mac/cache-reclaim.py")}`,
    `janitor refresh: installed 2 files from ${main.slice(0, 12)}`,
  ]);
  assert.ok(r.out.indexOf("session scratch files") < r.out.indexOf("janitor refresh:"), "the refresh runs after the pass's own work");
  for (const [name, file] of [["tmp-reclaim.sh", "deploy/mac/tmp-reclaim.sh"], ["cache-reclaim.py", "deploy/mac/cache-reclaim.py"]] as const) {
    assert.equal(hashOf(w, join(dest, name)), blob(w, main, file));
  }
  assert.equal(readFileSync(join(dest, "install-source"), "utf8").includes("layout=home-bin"), true, "the record is kept");
  assert.deepEqual(readdirSync(w.fx.scratch).filter((name) => name.startsWith("rmd-janitor-refresh")), [], "the staged copy is removed");
  const again = sh(w, [join(dest, "tmp-reclaim.sh"), "--refresh-install", "--apply"]);
  assert.deepEqual(refreshLines(again.out), [`janitor refresh: current at ${main.slice(0, 12)}`]);
});

test("W1-T12268 criterion 3: the refresh reads the origin/main ref, never the working tree, and runs no fetch", (t) => {
  const w = world(t);
  const dest = join(w.fx.root, "bin-layout");
  installHomeBin(w, dest);
  const main = mergeToMain(w, ["deploy/mac/tmp-reclaim.sh"]);
  // The working tree holds neither main's change nor anything committed: an edit only.
  writeFileSync(join(w.repo.dir, "deploy/mac/remudero-janitor.sh"), "#!/bin/bash\necho working-tree-only\n");
  const calls = join(w.fx.root, "git-calls.txt");
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const wrapper = join(w.fx.root, "git-wrapper"); mkdirSync(wrapper);
  writeFileSync(join(wrapper, "git"), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  const r = sh(w, [join(dest, "tmp-reclaim.sh"), "--refresh-install", "--apply"], { PATH: `${wrapper}:${w.path}` });
  assert.equal(r.status, 0, r.out);
  assert.equal(refreshLines(r.out).at(-1), `janitor refresh: installed 1 files from ${main.slice(0, 12)}`);
  assert.equal(hashOf(w, join(dest, "tmp-reclaim.sh")), blob(w, main, "deploy/mac/tmp-reclaim.sh"));
  assert.equal(readFileSync(join(dest, "remudero-janitor.sh"), "utf8"), readFileSync(join(REPO_ROOT, "deploy/mac/remudero-janitor.sh"), "utf8"));
  const gitCalls = readFileSync(calls, "utf8").split("\n").filter(Boolean);
  assert.ok(gitCalls.some((call) => call.includes("archive")), gitCalls.join("\n"));
  assert.equal(gitCalls.filter((call) => /\b(fetch|pull|remote update|ls-remote)\b/.test(call)).length, 0, gitCalls.join("\n"));
});

test("W1-T12268 criterion 4: an unreadable record, checkout or ref, or an incomplete source set keeps every file", (t) => {
  const w = world(t);
  const dest = join(w.fx.root, "bin-layout");
  installHomeBin(w, dest);
  mergeToMain(w, ["deploy/mac/tmp-reclaim.sh"]);
  const record = readFileSync(join(dest, "install-source"), "utf8");
  const cases: Array<[string, () => void, RegExp]> = [
    ["no record", () => rmSync(join(dest, "install-source")), /kept \(no install-source record in /],
    ["unknown layout", () => writeFileSync(join(dest, "install-source"), record.replace("layout=home-bin", "layout=other")), /kept \(install-source names an unknown layout: other\)/],
    ["missing checkout", () => writeFileSync(join(dest, "install-source"), record.replace(/^checkout=.*$/m, `checkout=${join(w.fx.root, "gone")}`)), /kept \(checkout unreadable or owned by another account: /],
    ["changed origin", () => w.repo.git("remote", "set-url", "origin", "https://github.com/someone/else.git"), /kept \(checkout origin https:\/\/github\.com\/someone\/else\.git is not the recorded origin /],
    ["foreign origin recorded", () => { w.repo.git("remote", "set-url", "origin", "https://example.invalid/remudero.git"); writeFileSync(join(dest, "install-source"), record.replace(ORIGIN, "https://example.invalid/remudero.git")); }, /kept \(origin is not the remudero repository: /],
    ["unreadable ref", () => w.repo.git("update-ref", "-d", "refs/remotes/origin/main"), /kept \(origin\/main unreadable in /],
    ["incomplete source set", () => { w.repo.git("rm", "--quiet", "deploy/mac/preserve-retire.py"); w.repo.git("commit", "--quiet", "-m", "drop"); w.repo.git("update-ref", "refs/remotes/origin/main", "HEAD"); },
      /kept \(source set at origin\/main is not complete: deploy\/mac\/preserve-retire\.py missing\)/],
  ];
  const main = w.repo.git("rev-parse", "refs/remotes/origin/main");
  for (const [name, breakIt, cause] of cases) {
    breakIt();
    const files = snapshot(w, dest);
    const r = sh(w, [join(dest, "tmp-reclaim.sh"), "--apply"], reclaimEnv(w));
    assert.equal(r.status, 0, `${name}: ${r.out}`);
    assert.match(r.out, /session scratch files deleted/, `${name}: the pass finishes its own work`);
    const lines = refreshLines(r.out);
    assert.equal(lines.length, 1, `${name}: ${lines.join("\n")}`);
    assert.match(lines[0]!, cause, name);
    assert.deepEqual(snapshot(w, dest), files, `${name}: every installed file is kept`);
    // Restore the world for the next case.
    writeFileSync(join(dest, "install-source"), record);
    w.repo.git("remote", "set-url", "origin", ORIGIN);
    w.repo.git("update-ref", "refs/remotes/origin/main", main);
  }
});

test("W1-T12268 criterion 5: a dry run only reports, and a refresh changes no crontab line and no launchd job", (t) => {
  const w = world(t);
  const install = sh(w, [join(w.repo.dir, "deploy/mac/install-tmp-reclaim.sh")]);
  assert.equal(install.status, 0, install.out);
  const tabBefore = readFileSync(w.tab, "utf8");
  const writesBefore = readFileSync(w.writes, "utf8");
  const dest = supportDir(w);
  const old = hashOf(w, join(dest, "tmp-reclaim.sh"));
  const main = mergeToMain(w, ["deploy/mac/tmp-reclaim.sh"]);
  const files = snapshot(w, dest);
  const dry = sh(w, [join(dest, "tmp-reclaim.sh")], reclaimEnv(w));
  assert.equal(dry.status, 0, dry.out);
  assert.deepEqual(refreshLines(dry.out), [
    `janitor refresh: would install 1 files from ${main.slice(0, 12)}`,
    `janitor refresh: would replace tmp-reclaim.sh ${old} -> ${blob(w, main, "deploy/mac/tmp-reclaim.sh")}`,
  ]);
  assert.deepEqual(snapshot(w, dest), files, "a dry run replaces nothing");
  const applied = sh(w, [join(dest, "tmp-reclaim.sh"), "--apply"], reclaimEnv(w));
  assert.match(applied.out, /janitor refresh: installed 1 files from /);
  assert.equal(readFileSync(w.tab, "utf8"), tabBefore);
  assert.equal(readFileSync(w.writes, "utf8"), writesBefore, "no crontab is written");
  assert.deepEqual(w.launchctl.calls(), [], "no launchd job is touched");
});

test("W1-T12268 criterion 6: the Application Support copy and the shared copy both refresh in their scheduled passes", (t) => {
  const w = world(t);
  assert.equal(sh(w, [join(w.repo.dir, "deploy/mac/install-tmp-reclaim.sh")]).status, 0);
  const shared = join(w.fx.root, "Shared");
  assert.equal(sh(w, [join(w.repo.dir, "deploy/mac/install-janitor.sh"), "--shared-root", shared]).status, 0);
  const launcher = readFileSync(join(shared, "remudero-mac-janitor.sh"), "utf8");
  const main = mergeToMain(w, [...GUARDS, "deploy/mac/tmp-reclaim.sh", "deploy/mac/remudero-janitor.sh", "deploy/mac/remudero-mac-janitor.sh"]);

  // The hourly temp cleaner's copy: its own three files.
  const hourly = sh(w, [join(supportDir(w), "tmp-reclaim.sh"), "--apply"], reclaimEnv(w));
  assert.equal(hourly.status, 0, hourly.out);
  assert.match(hourly.out, new RegExp(`janitor refresh: installed 2 files from ${main.slice(0, 12)}`));
  for (const name of SUPPORT_SET) {
    const file = name.endsWith("guard.sh") ? `deploy/${name}` : `deploy/mac/${name}`;
    assert.equal(hashOf(w, join(supportDir(w), name)), blob(w, main, file), name);
  }
  assert.equal(existsSync(join(supportDir(w), "remudero-janitor.sh")), false, "the layout installs only its own files");

  // The shared copy, through the launcher the half-hourly schedule runs.
  const janitor = sh(w, [join(shared, "remudero-mac-janitor.sh"), "--apply"], {
    REMUDERO_JANITOR_ACCOUNT_HOME: w.fx.home, REMUDERO_JANITOR_SCAN_ROOTS: w.fx.scratch,
    REMUDERO_JANITOR_LOG: join(w.fx.root, "mac.log"), REMUDERO_JANITOR_LOCK_DIR: join(w.fx.root, "mac.lock"),
    RMD_RECLAIM_TSX_FIND: join(w.fx.root, "bin/find-age"), REMUDERO_MAC_JANITOR_BIN: "",
  });
  assert.equal(janitor.status, 0, janitor.out);
  assert.match(janitor.out, new RegExp(`janitor refresh: installed 4 files from ${main.slice(0, 12)}`));
  for (const name of JANITOR_SET) {
    const file = name.endsWith("guard.sh") ? `deploy/${name}` : `deploy/mac/${name}`;
    assert.equal(hashOf(w, join(shared, "remudero-mac", name)), blob(w, main, file), name);
  }
  assert.equal(readFileSync(join(shared, "remudero-mac-janitor.sh"), "utf8"), launcher, "the code-only refresh leaves the launcher");
  assert.deepEqual(w.launchctl.calls(), []);
});
