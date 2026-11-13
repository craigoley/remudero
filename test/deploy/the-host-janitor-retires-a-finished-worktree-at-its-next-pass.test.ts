/**
 * W1-T12256: the Azure host janitor retires a linked worktree that is clean, whose HEAD GitHub holds and whose
 * pull requests are all merged or closed, at its next pass instead of after six idle hours. Every case runs the
 * real deploy/rmd-host-cleanup.sh and the real shared guard against a fixture root; GitHub answers through the
 * shared gh shim, and lsof, df and docker are fixture stubs. No case reads or writes a path outside its fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { age, fixture, git, run, type Fixture } from "#test/helpers/host-cleanup-fixture.js";

const GITHUB = "https://github.com/craigoley/remudero.git";

function file(path: string, body = "payload\n") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path; }

interface Rig { fx: Fixture; shim: GhShim; root: string; main: string; origin: string }

/** A fixture with one worktree root (`~/rmd-work`, as on the host), a GitHub-named main clone outside it,
 *  and a gh whose pull-request answer is GH_FINISHED ("<total> <closed>"). gh never proves a commit
 *  that the fixture origin does not hold. */
function rig(): Rig {
  const fx = fixture();
  fx.root = realpathSync(fx.root); fx.home = realpathSync(fx.home);
  const root = join(fx.home, "rmd-work");
  mkdirSync(root, { recursive: true });
  const shim = ghShim();
  shim.addRoute({ when: "--jq length", exit: 1 });
  shim.addRoute({ when: "select(.state", stdoutEnv: "GH_FINISHED" });
  const origin = join(fx.root, "origin.git");
  git(fx.root, "init", "-q", "--bare", "-b", "main", origin);
  const main = join(fx.root, "main");
  git(fx.root, "clone", "-q", origin, main);
  file(join(main, "package.json"), '{"name":"fixture"}\n');
  file(join(main, ".gitignore"), "node_modules\ncoverage\n.env\n");
  git(main, "add", "."); git(main, "commit", "-q", "-m", "base"); git(main, "push", "-q", "origin", "HEAD:main");
  // The configured URL names GitHub; insteadOf keeps ls-remote on the local fixture origin.
  git(main, "remote", "set-url", "origin", GITHUB);
  git(main, "config", `url.file://${origin}.insteadOf`, GITHUB);
  return { fx, shim, root, main, origin };
}
function drop(r: Rig) { rmSync(r.fx.root, { recursive: true, force: true }); rmSync(r.shim.dir, { recursive: true, force: true }); }

function pass(r: Rig, extra: Record<string, string> = {}) {
  const out = run(r.fx, {
    RMD_CLEANUP_WORKTREE_ROOTS: r.root, RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_AGENT_SCRATCH: "",
    RMD_CLEANUP_PRESERVE_ROOTS: "", RMD_CLEANUP_DUMP_ROOTS: "",
    RMD_CLEANUP_GH_TOKEN_FILE: join(r.fx.root, "no-token"), GH_TOKEN: "fixture-token",
    PATH: `${r.shim.dir}:${process.env.PATH}`, GH_FINISHED: "1 1", ...extra,
  });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  return out.stdout;
}

/** A linked worktree on a branch at the published main tip, with a file under coverage/ written just now. */
function worktree(r: Rig, name: string, where = r.root) {
  const path = join(where, name);
  git(r.main, "worktree", "add", "-q", "-b", name, path, "main");
  file(join(path, "coverage/lcov.info"));
  return path;
}
const listed = (r: Rig, path: string) => git(r.main, "worktree", "list", "--porcelain").includes(path);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("W1-T12256 criterion 1: a clean published worktree whose pull requests are finished is retired despite a recent write", () => {
  const r = rig();
  try {
    const done = worktree(r, "wt-done");
    // worktree() wrote coverage/lcov.info and Git wrote HEAD just now: both are inside the six idle hours.
    const out = pass(r);
    assert.equal(existsSync(done), false, out);
    assert.equal(listed(r, done), false, "Git no longer registers the worktree");
    assert.match(out, new RegExp(`REMOVE ${escape(done)} \\(linked worktree, pull request finished\\)`));
    assert.doesNotMatch(out, new RegExp(`KEEP ${escape(done)}: (written within|recent or unverified Git HEAD)`));
    assert.ok(existsSync(r.main), "the main clone stays");
    assert.match(git(r.main, "branch", "--list", "wt-done"), /wt-done/, "the branch stays");
  } finally { drop(r); }
});

test("W1-T12256 criterion 2: a dirty, unpushed, locked or ignored-data worktree stays", () => {
  const r = rig();
  try {
    const dirty = worktree(r, "wt-dirty");
    file(join(dirty, "notes.txt"), "uncommitted\n");
    const unpushed = worktree(r, "wt-unpushed");
    git(unpushed, "commit", "-q", "--allow-empty", "-m", "never pushed");
    const locked = worktree(r, "wt-locked");
    git(r.main, "worktree", "lock", locked);
    const ignored = worktree(r, "wt-ignored");
    file(join(ignored, ".env"), "SECRET=1\n");
    const out = pass(r);
    for (const path of [dirty, unpushed, locked, ignored]) {
      assert.ok(existsSync(join(path, "package.json")), `${path}\n${out}`);
      assert.ok(listed(r, path), path);
    }
    // Not finished, so the six hours of today hold the dirty, unpushed and ignored-data ones.
    for (const path of [dirty, unpushed, ignored]) {
      assert.match(out, new RegExp(`KEEP ${escape(path)}: recent or unverified Git HEAD activity`));
    }
    assert.match(out, new RegExp(`KEEP ${escape(locked)}: Git worktree is locked`));
    assert.doesNotMatch(out, /pull request finished/);
    assert.equal(existsSync(join(ignored, ".env")), true, "the ignored data stays");
  } finally { drop(r); }
});

test("W1-T12256 criterion 3: a worktree held open, mounted in a container, or with unreadable open files or mounts stays", () => {
  const r = rig();
  try {
    const dockerMounted = join(r.fx.root, "docker-mounted");
    const dockerBlind = join(r.fx.root, "docker-blind");
    writeFileSync(dockerBlind, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    const probes: Array<[string, (path: string) => Record<string, string>, (path: string) => RegExp]> = [
      ["open", (path) => (writeFileSync(r.fx.lsofList, `${path}/package.json\n`), {}),
        (path) => new RegExp(`KEEP ${escape(path)}: held open by a process`)],
      ["lsof-blind", () => ({ FAKE_LSOF_FAIL: "1" }),
        (path) => new RegExp(`KEEP ${escape(path)}: held open by a process`)],
      ["mounted", (path) => {
        writeFileSync(dockerMounted, `#!/usr/bin/env bash\ncase "$1" in ps) echo c1 ;; inspect) echo '${path}' ;; esac\n`, { mode: 0o755 });
        return { RMD_CLEANUP_DOCKER: dockerMounted };
      }, (path) => new RegExp(`KEEP ${escape(path)}: Docker mount \\(running container mount\\)`)],
      ["docker-blind", () => ({ RMD_CLEANUP_DOCKER: dockerBlind }),
        (path) => new RegExp(`KEEP ${escape(path)}: Docker mount snapshot failed \\(unknown\\)`)],
    ];
    for (const [name, extra, keep] of probes) {
      // One worktree per probe: a free finished one would be retired before its turn.
      const path = worktree(r, `wt-${name}`);
      const out = pass(r, extra(path));
      assert.ok(existsSync(join(path, "package.json")), `${path}\n${out}`);
      assert.match(out, keep(path));
      assert.doesNotMatch(out, new RegExp(`REMOVE ${escape(path)}`));
      // Once the hold is gone, the same worktree is retired: the hold kept it, nothing else.
      writeFileSync(r.fx.lsofList, "");
      const after = pass(r);
      assert.equal(existsSync(path), false, after);
    }
  } finally { drop(r); }
});

test("W1-T12256 criterion 4: an open pull request, no pull request and a standalone clone keep the six-hour rule", () => {
  const r = rig();
  try {
    // A standalone clone stays under the six hours even when its commit's pull requests are finished.
    const clone = join(r.root, "clone-done");
    git(r.fx.root, "clone", "-q", r.origin, clone);
    git(clone, "remote", "set-url", "origin", GITHUB);
    git(clone, "config", `url.file://${r.origin}.insteadOf`, GITHUB);
    file(join(clone, "coverage/lcov.info"));
    const finishedOut = pass(r, { GH_FINISHED: "1 1" });
    assert.ok(existsSync(join(clone, "package.json")), finishedOut);
    assert.match(finishedOut, new RegExp(`KEEP ${escape(clone)}: recent or unverified Git HEAD activity`));
    assert.doesNotMatch(finishedOut, new RegExp(`REMOVE ${escape(clone)}`));
    const open = worktree(r, "wt-open-pr");
    const none = worktree(r, "wt-no-pr");
    for (const answer of ["1 0", "0 0"]) {
      const out = pass(r, { GH_FINISHED: answer });
      for (const path of [open, none]) {
        assert.ok(existsSync(path), `${path}\n${out}`);
        assert.match(out, new RegExp(`KEEP ${escape(path)}: recent or unverified Git HEAD activity`));
      }
    }
    // Past the six hours the rule of today retires the open-pull-request worktree, by its old label.
    age(open, 7);
    const later = pass(r, { GH_FINISHED: "1 0" });
    assert.equal(existsSync(open), false, later);
    assert.match(later, new RegExp(`REMOVE ${escape(open)} \\(linked worktree\\)`));
    assert.doesNotMatch(later, /pull request finished/);
  } finally { drop(r); }
});

test("W1-T12256 criterion 5: a symlink in a root to a finished worktree outside every root leaves the worktree in place", () => {
  const r = rig();
  try {
    const outside = join(r.fx.root, "outside");
    mkdirSync(outside, { recursive: true });
    const done = worktree(r, "wt-outside", outside);
    const link = join(r.root, "wt-link");
    symlinkSync(done, link);
    const out = pass(r);
    assert.ok(existsSync(join(done, "package.json")), out);
    assert.ok(listed(r, done), "Git still registers the worktree");
    assert.match(out, new RegExp(`KEEP ${escape(link)}: not a regular directory`));
    assert.doesNotMatch(out, /REMOVE .*wt-(link|outside)/);
  } finally { drop(r); }
});

test("W1-T12256 criterion 6: a dry run names the worktree and removes nothing; an applied pass tallies its bytes and audits it", () => {
  const r = rig();
  try {
    const done = worktree(r, "wt-done");
    file(join(done, "node_modules/dep/index.js"), "x".repeat(64 * 1024));
    const dry = pass(r, { DRY_RUN: "1" });
    assert.ok(existsSync(join(done, "package.json")), dry);
    assert.ok(listed(r, done));
    assert.match(dry, new RegExp(`REMOVE ${escape(done)} \\(linked worktree, pull request finished\\)`));
    assert.match(dry, new RegExp(`DRYRUN would: git worktree remove ${escape(done)}`));
    const audit = join(r.fx.home, ".local/state/remudero/janitor-audit.log");
    assert.equal(existsSync(audit) ? readFileSync(audit, "utf8").includes(done) : false, false, "a dry run audits nothing");

    const out = pass(r);
    assert.equal(existsSync(done), false, out);
    const total = out.match(new RegExp(`reclaim-total sweep ${escape(r.root)}: reclaimed [0-9]+ MB \\(([0-9]+) bytes\\) in 1 entries`));
    assert.ok(total, out);
    assert.ok(Number(total[1]) >= 64 * 1024, `the tally holds the worktree's bytes: ${total[1]}`);
    const rows = readFileSync(audit, "utf8").split("\n").filter((l) => l.includes(`REMOVE ${done} (linked worktree, pull request finished)`));
    assert.equal(rows.length, 1, readFileSync(audit, "utf8"));
    assert.match(rows[0]!, /dry_run=0/);
  } finally { drop(r); }
});
