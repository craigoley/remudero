/**
 * W1-T12255: the Mac janitor retires a linked worktree that is clean, whose HEAD GitHub holds and whose pull
 * requests are all merged or closed, at its next pass instead of after six idle hours. Every fixture runs the
 * real janitor and the real guard; GitHub is answered by the shared gh shim, the process table by stubs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ghShim, type GhShim } from "#test/helpers/gh-shim.js";
import { age, fixture, git, type Fixture } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const janitor = join(REPO_ROOT, "deploy/mac/remudero-janitor.sh");
const guard = join(REPO_ROOT, "deploy/workspace-retirement-guard.sh");
const GITHUB = "https://github.com/craigoley/remudero.git";
const native = (name: string) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();

function file(path: string, body = "payload\n") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path; }

interface Rig { fx: Fixture; shim: GhShim; decisions: string }
/** A fixture whose gh answers the pull-request query from GH_FINISHED / GH_PULLS, with scripted ps and lsof. */
function rig(): Rig {
  const fx = fixture();
  fx.root = realpathSync(fx.root); fx.home = realpathSync(fx.home); fx.scratch = realpathSync(fx.scratch);
  const bin = join(fx.root, "bin"), stat = native("stat");
  // Fixtures cannot backdate ctime; report the aged mtime in its place.
  writeFileSync(join(bin, "stat"), `#!/bin/bash
if [ "$2" = '%m %c' ]; then shift 2; exec '${stat}' -f '%m %m' "$@"; fi
if [ "$2" = '%Y %Z' ]; then shift 2; exec '${stat}' -c '%Y %Y' "$@"; fi
exec '${stat}' "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "1 /bin/sh\\n"\n[ -z "$PS_EXTRA" ] || printf "2 %s\\n" "$PS_EXTRA"\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), `#!/bin/bash
case " $* " in
  *" -d cwd "*) [ -z "$LSOF_CWD" ] || printf 'p2\\nn%s\\n' "$LSOF_CWD"; exit 0 ;;
esac
[ "$LSOF_FAIL" != 1 ] || exit 2
[ -z "$LSOF_OPEN" ] || { printf 'sh 2 u REG 1,2 0 1 %s\\n' "$LSOF_OPEN"; exit 0; }
exit 1
`, { mode: 0o755 });
  const shim = ghShim();
  shim.addRoute({ when: "--jq length", stdoutEnv: "GH_PULLS" });
  shim.addRoute({ when: "select(.state", stdoutEnv: "GH_FINISHED" });
  mkdirSync(join(fx.home, "Remudero"), { recursive: true });
  return { fx, shim, decisions: join(fx.root, "decisions.tsv") };
}
function drop(r: Rig) { rmSync(r.fx.root, { recursive: true, force: true }); rmSync(r.shim.dir, { recursive: true, force: true }); }
function env(r: Rig, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { fx, shim } = r;
  return {
    ...process.env, HOME: fx.home, TMPDIR: fx.scratch, PATH: `${shim.dir}:${join(fx.root, "bin")}:${process.env.PATH}`,
    GH_FINISHED: "1 1", GH_PULLS: "1", PS_EXTRA: "", LSOF_CWD: "", LSOF_OPEN: "", LSOF_FAIL: "0",
    REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
    REMUDERO_JANITOR_DIRECTORY_ROOTS: fx.scratch, REMUDERO_JANITOR_LOG: join(fx.root, "janitor.log"),
    REMUDERO_JANITOR_DECISION_LOG: r.decisions, REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "janitor.lock"), ...extra,
  };
}
function pass(r: Rig, extra: Record<string, string> = {}, flag = "--apply") {
  const out = spawnSync("bash", [janitor, flag], { encoding: "utf8", timeout: 120_000, env: env(r, extra) });
  assert.equal(out.status, 0, out.stderr + out.stdout);
  return out.stdout;
}
/** A GitHub-named clone of a local bare origin: one commit on main, node_modules, coverage and .env ignored. */
function clone(r: Rig, where: string) {
  const { fx } = r;
  const bare = join(fx.root, "origin.git");
  if (!existsSync(bare)) {
    git(fx.root, "init", "-q", "--bare", "-b", "main", bare);
    const seed = join(fx.root, "seed");
    git(fx.root, "clone", "-q", bare, seed);
    file(join(seed, "package.json"), '{"name":"fixture"}\n');
    file(join(seed, ".gitignore"), "node_modules\ncoverage\n.env\n");
    git(seed, "add", "."); git(seed, "commit", "-q", "-m", "base"); git(seed, "push", "-q", "origin", "HEAD:main");
  }
  git(fx.root, "clone", "-q", bare, where);
  // The configured URL names GitHub; insteadOf keeps ls-remote on the local fixture.
  git(where, "remote", "set-url", "origin", GITHUB);
  git(where, "config", `url.file://${bare}.insteadOf`, GITHUB);
  return where;
}
function worktree(main: string, path: string) {
  git(main, "worktree", "add", "-q", "--detach", path, "main");
  file(join(path, "coverage/lcov.info"));
  return path;
}
const rows = (r: Rig) => readFileSync(r.decisions, "utf8").split("\n").filter((l) => l.length > 0).map((l) => l.split("\t"));
const removalRows = (r: Rig, path: string) => rows(r).filter((c) => c[2] === "remove" && c[4]!.includes(`REMOVED-WORKTREE`) && c[4]!.includes(path));

/** The guard's answer for one commit, from a GitHub-named clone and a scripted pull-request answer. */
function finished(r: Rig, work: string, answer: string, shim: GhShim = r.shim) {
  const head = git(work, "rev-parse", "HEAD").trim();
  return spawnSync("bash", ["-c", `source '${guard}'; rmd_commit_pulls_finished "$1" "$2" && echo finished || echo unfinished`, "_", work, head],
    { encoding: "utf8", env: { ...process.env, PATH: `${shim.dir}:${process.env.PATH}`, GH_FINISHED: answer } }).stdout.trim();
}

test("W1-T12255 criterion 1: the guard calls a commit finished only when every pull request of it is closed", () => {
  const r = rig();
  const failing = ghShim([{ when: "commits", exit: 1 }]);
  try {
    const work = clone(r, join(r.fx.root, "work"));
    assert.equal(finished(r, work, "1 1"), "finished", "one merged pull request");
    assert.equal(finished(r, work, "3 3"), "finished", "several, all closed");
    assert.equal(finished(r, work, "2 1"), "unfinished", "one of two still open");
    assert.equal(finished(r, work, "1 0"), "unfinished", "an open pull request");
    assert.equal(finished(r, work, "0 0"), "unfinished", "a commit with no pull request");
    assert.equal(finished(r, work, ""), "unfinished", "an empty answer cannot be read");
    assert.equal(finished(r, work, "x y"), "unfinished", "a garbled answer cannot be read");
    assert.equal(finished(r, work, "1 1", failing), "unfinished", "a failing gh cannot be read");
    git(work, "remote", "set-url", "origin", join(r.fx.root, "origin.git"));
    assert.equal(finished(r, work, "1 1"), "unfinished", "a non-GitHub origin is never asked");
  } finally { drop(r); rmSync(failing.dir, { recursive: true, force: true }); }
});

test("W1-T12255 criterion 2: a pass retires a clean published worktree with finished pull requests despite recent file activity", () => {
  const r = rig();
  try {
    const main = clone(r, join(r.fx.home, "Remudero/operator"));
    const done = worktree(main, join(r.fx.home, "Remudero/wt-done"));
    // worktree() wrote coverage/lcov.info just now: a file changed minutes ago, ignored, so the tree stays clean.
    const out = pass(r);
    assert.equal(existsSync(done), false, out);
    assert.match(out, /REMOVED-WORKTREE pull-request-finished .*wt-done/);
    assert.doesNotMatch(out, /SKIP recent-file-activity \dh .*wt-done/);
    assert.doesNotMatch(git(main, "worktree", "list", "--porcelain"), /wt-done/);
  } finally { drop(r); }
});

test("W1-T12255 criterion 3: such a worktree stays when dirty, unpublished, locked or holding ignored data", () => {
  const r = rig();
  try {
    const main = clone(r, join(r.fx.home, "Remudero/operator"));
    const dirty = worktree(main, join(r.fx.home, "Remudero/wt-dirty"));
    file(join(dirty, "notes.txt"), "uncommitted\n");
    const unpushed = worktree(main, join(r.fx.home, "Remudero/wt-unpushed"));
    git(unpushed, "commit", "-q", "--allow-empty", "-m", "never pushed");
    const locked = worktree(main, join(r.fx.home, "Remudero/wt-locked"));
    git(main, "worktree", "lock", locked);
    const ignored = worktree(main, join(r.fx.home, "Remudero/wt-ignored"));
    file(join(ignored, ".env"), "SECRET=1\n");
    const out = pass(r, { GH_PULLS: "" });
    for (const path of [dirty, unpushed, locked, ignored]) assert.ok(existsSync(path), `${path}\n${out}`);
    // A dirty or unpublished worktree is not finished, so the six hours of today hold it.
    assert.match(out, /SKIP recent-file-activity \dh .*wt-dirty/);
    assert.match(out, /SKIP recent-file-activity \dh .*wt-unpushed/);
    assert.match(out, /SKIP worktree-locked .*wt-locked/);
    assert.match(out, /SKIP ignored-or-unverified .*wt-ignored/);
    assert.doesNotMatch(out, /REMOVED-WORKTREE/);
  } finally { drop(r); }
});

test("W1-T12255 criterion 4: such a worktree stays when a process uses it or the pass cannot read one", () => {
  const r = rig();
  try {
    const main = clone(r, join(r.fx.home, "Remudero/operator"));
    const probes: Array<[string, (path: string) => Record<string, string>, RegExp]> = [
      ["named", (path) => ({ PS_EXTRA: `node ${path}/node_modules/.bin/vitest` }), /SKIP live .*wt-named/],
      ["cwd", (path) => ({ LSOF_CWD: path }), /SKIP cwd .*wt-cwd/],
      ["open", (path) => ({ LSOF_OPEN: `${path}/package.json` }), /SKIP open .*wt-open/],
      ["blind", () => ({ LSOF_FAIL: "1" }), /SKIP unverified-open .*wt-blind/],
    ];
    for (const [name, extra, skip] of probes) {
      // One worktree per probe: an unused finished one would be retired by the pass before its turn.
      const path = worktree(main, join(r.fx.home, `Remudero/wt-${name}`));
      const out = pass(r, extra(path));
      assert.ok(existsSync(path), `${path}\n${out}`);
      assert.match(out, skip);
      assert.equal(removalRows(r, path).length, 0, out);
      // Once the process lets go, the same worktree is retired: the skip was the process, nothing else.
      const after = pass(r);
      assert.equal(existsSync(path), false, after);
    }
  } finally { drop(r); }
});

test("W1-T12255 criterion 5: a worktree with an open or no pull request keeps the six-hour rule", () => {
  const r = rig();
  try {
    const main = clone(r, join(r.fx.home, "Remudero/operator"));
    const open = worktree(main, join(r.fx.home, "Remudero/wt-open-pr"));
    const none = worktree(main, join(r.fx.home, "Remudero/wt-no-pr"));
    for (const answer of ["1 0", "0 0"]) {
      const out = pass(r, { GH_FINISHED: answer });
      assert.ok(existsSync(open) && existsSync(none), out);
      assert.match(out, /SKIP recent-file-activity \dh .*wt-open-pr/);
      assert.match(out, /SKIP recent-file-activity \dh .*wt-no-pr/);
    }
    age(join(r.fx.home, "Remudero"), 7);
    age(main, 7);
    const out = pass(r, { GH_FINISHED: "1 0" });
    assert.equal(existsSync(open), false, out);
    assert.match(out, /REMOVED-WORKTREE 7h .*wt-open-pr/);
    assert.doesNotMatch(out, /pull-request-finished/);
  } finally { drop(r); }
});

test("W1-T12255 criterion 6: a symlink in a root to a finished worktree outside every root leaves it in place", () => {
  const r = rig();
  try {
    const outside = join(r.fx.root, "outside");
    mkdirSync(outside, { recursive: true });
    const main = clone(r, join(outside, "main"));
    const done = worktree(main, join(outside, "wt-done"));
    symlinkSync(done, join(r.fx.home, "Remudero/wt-link"));
    symlinkSync(done, join(r.fx.scratch, "rmd-link"));
    const out = pass(r);
    assert.ok(existsSync(join(done, "package.json")), out);
    assert.match(git(main, "worktree", "list", "--porcelain"), /wt-done/);
    assert.doesNotMatch(out, /REMOVED-WORKTREE/);
    assert.equal(removalRows(r, "wt-done").length, 0);
  } finally { drop(r); }
});

test("W1-T12255 criterion 7: a dry run names each worktree and its reason and removes nothing; an applied pass writes one row each", () => {
  const r = rig();
  try {
    const main = clone(r, join(r.fx.home, "Remudero/operator"));
    const one = worktree(main, join(r.fx.home, "Remudero/wt-one"));
    const two = worktree(main, join(r.fx.home, "Remudero/wt-two"));
    const dry = pass(r, {}, "--dry-run");
    assert.ok(existsSync(one) && existsSync(two), dry);
    for (const name of ["wt-one", "wt-two"]) assert.match(dry, new RegExp(`WOULD-REMOVE-WORKTREE pull-request-finished .*${name}`));
    assert.equal(rows(r).filter((c) => c[4]!.includes("REMOVED-WORKTREE")).length, 0, "a dry run records no removal");
    const out = pass(r);
    assert.equal(existsSync(one) || existsSync(two), false, out);
    for (const path of [one, two]) {
      const mine = removalRows(r, path);
      assert.equal(mine.length, 1, `${path}\n${out}`);
      assert.match(mine[0]![4]!, /pull-request-finished/);
      assert.match(mine[0]![5]!, /^[0-9]+$/, "the bytes freed are a number");
      assert.ok(Number(mine[0]![5]) > 0);
    }
  } finally { drop(r); }
});
