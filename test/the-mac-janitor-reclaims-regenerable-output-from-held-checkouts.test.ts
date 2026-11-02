/** Runs the actual account janitor and publication guard; every target and probe is a private fixture. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ghFailing } from "#test/helpers/gh-stub.js";
import { age, fixture, git, type Fixture } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const janitor = join(REPO_ROOT, "deploy/mac/remudero-janitor.sh");
const guard = join(REPO_ROOT, "deploy/workspace-retirement-guard.sh");
const native = (name: string) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
function setup() {
  const fx = fixture();
  fx.root = realpathSync(fx.root); fx.home = realpathSync(fx.home); fx.scratch = realpathSync(fx.scratch);
  const bin = join(fx.root, "bin"), stat = native("stat");
  // Fixtures cannot backdate ctime; report the aged mtime in its place.
  writeFileSync(join(bin, "stat"), `#!/bin/bash
if [ "$2" = '%m %c' ]; then shift 2; exec '${stat}' -f '%m %m' "$@"; fi
if [ "$2" = '%Y %Z' ]; then shift 2; exec '${stat}' -c '%Y %Y' "$@"; fi
exec '${stat}' "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "1 /bin/sh\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, "lsof"), '#!/bin/bash\ncase " $* " in *" -d cwd "*) exit 0 ;; esac\nexit 1\n', { mode: 0o755 });
  // No test may reach the real GitHub API through an installed gh.
  // The shared stub (test/helpers/gh-stub.ts) is copied in, not re-hand-written: the fixture-copy
  // census counts a hand-rolled gh PATH shim per file, and its ceiling is not ours to raise.
  cpSync(ghFailing(), bin, { recursive: true });
  mkdirSync(join(fx.home, "Remudero"), { recursive: true });
  return fx;
}
function file(path: string, body = "payload\n") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path; }
function run(fx: Fixture, extra: Record<string, string> = {}) {
  const r = spawnSync("bash", [janitor, "--apply"], { encoding: "utf8", timeout: 120_000, env: {
    ...process.env, HOME: fx.home, TMPDIR: fx.scratch, PATH: `${join(fx.root, "bin")}:${process.env.PATH}`,
    REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
    REMUDERO_JANITOR_DIRECTORY_ROOTS: fx.scratch, REMUDERO_JANITOR_LOG: join(fx.root, "janitor.log"),
    REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "janitor.lock"), ...extra,
  } });
  assert.equal(r.status, 0, r.stderr + r.stdout); return r.stdout;
}
/** A published origin and a clone of it whose node_modules and coverage are ignored output. */
function origin(fx: Fixture, name = "origin.git") {
  const bare = join(fx.root, name);
  git(fx.root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = join(fx.root, `${name}-seed`);
  git(fx.root, "clone", "-q", bare, seed);
  file(join(seed, "package.json"), '{"name":"fixture"}\n');
  file(join(seed, ".gitignore"), "node_modules\ncoverage\n");
  git(seed, "add", "."); git(seed, "commit", "-q", "-m", "base"); git(seed, "push", "-q", "origin", "HEAD:main");
  return bare;
}
function generated(checkout: string) {
  file(join(checkout, "node_modules/pkg/index.js")); file(join(checkout, "coverage/lcov.info"));
  return [join(checkout, "node_modules"), join(checkout, "coverage")];
}

test("an idle unpublished, dirty checkout loses its ignored node_modules and coverage but keeps its commits and edits", () => {
  const fx = setup();
  try {
    const bare = origin(fx);
    const work = join(fx.home, "Remudero/unpublished-work");
    git(fx.root, "clone", "-q", bare, work);
    git(work, "commit", "-q", "--allow-empty", "-m", "never pushed");
    const head = git(work, "rev-parse", "HEAD").trim();
    const notes = file(join(work, "notes.txt"), "uncommitted edit\n");
    const [deps, cov] = generated(work);
    const busy = join(fx.home, "Remudero/busy-work");
    git(fx.root, "clone", "-q", bare, busy);
    const busyDeps = generated(busy);
    age(join(fx.home, "Remudero"), 7);
    file(join(busy, "src.ts"), "edited an hour ago\n"); age(join(busy, "src.ts"), 1);
    const out = run(fx);
    assert.equal(existsSync(deps!), false, out);
    assert.equal(existsSync(cov!), false, out);
    assert.ok(existsSync(notes), out);
    assert.equal(git(work, "rev-parse", "HEAD").trim(), head);
    for (const dir of busyDeps) assert.ok(existsSync(dir), out);
    assert.match(out, /SKIP recent-checkout-activity .*busy-work\/node_modules/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a locked worktree parked inside a repository's .git directory has its dependencies reclaimed", () => {
  const fx = setup();
  try {
    const bare = origin(fx);
    const main = join(fx.home, "Remudero/operator");
    git(fx.root, "clone", "-q", bare, main);
    const parked = join(main, ".git/operator-plan-workspaces/scope-1");
    git(main, "worktree", "add", "-q", "-b", "scope-1", parked, "main");
    git(main, "worktree", "lock", parked);
    git(parked, "commit", "-q", "--allow-empty", "-m", "scope work");
    const [deps] = generated(parked);
    age(join(fx.home, "Remudero"), 7);
    const out = run(fx);
    assert.equal(existsSync(deps!), false, out);
    assert.ok(existsSync(join(parked, "package.json")), out);
    assert.match(git(main, "worktree", "list", "--porcelain"), /locked/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("an orphaned worktree whose repository was deleted has its node_modules reclaimed and its files kept", () => {
  const fx = setup();
  try {
    const bare = origin(fx);
    const lender = join(fx.home, "Remudero/lender");
    git(fx.root, "clone", "-q", bare, lender);
    const orphan = join(fx.home, "Remudero/orphan");
    git(lender, "worktree", "add", "-q", "-b", "orphan", orphan, "main");
    const edit = file(join(orphan, "unsaved.ts"), "only copy\n");
    const [deps] = generated(orphan);
    rmSync(lender, { recursive: true, force: true });
    age(join(fx.home, "Remudero"), 7);
    const out = run(fx);
    assert.equal(existsSync(deps!), false, out);
    assert.ok(existsSync(edit), out);
    assert.ok(existsSync(join(orphan, ".git")), out);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a run folder's reports retire after seven idle days and its saved work after thirty while keys and state stay", () => {
  const fx = setup();
  try {
    const base = join(fx.home, "Remudero");
    const folder = (name: string, entry: string, days: number) => {
      const dir = join(base, name); file(join(dir, entry), "kept for review\n"); age(dir, days * 24); return dir;
    };
    const gone = [folder("old-report", "summary.md", 8), folder("old-script", "probe.mjs", 8),
      folder("old-bundle", "work.bundle", 31), folder("old-patch", "fix.patch", 31)];
    const kept = [folder("recent-report", "summary.md", 5), folder("recent-bundle", "work.bundle", 20),
      folder("old-key", "deploy.pem", 60), folder("old-ledger", "ledger.ndjson", 60), folder("marked", ".rmd-janitor-keep", 60)];
    const out = run(fx, { REMUDERO_JANITOR_DIRECTORY_ROOTS: base });
    for (const dir of gone) assert.equal(existsSync(dir), false, dir + out);
    for (const dir of kept) assert.ok(existsSync(dir), dir + out);
    assert.match(out, /recent-report \(unversioned source, manifest or report idle \d+h < 7d\)/);
    assert.match(out, /recent-bundle \(saved work or evidence idle \d+h < 30d\)/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a commit GitHub lists in a pull request counts as published even after the PR head moved on", () => {
  const fx = setup();
  try {
    const bare = origin(fx);
    const work = join(fx.root, "work");
    git(fx.root, "clone", "-q", bare, work);
    // The configured URL names GitHub; insteadOf keeps ls-remote on the local fixture.
    git(work, "remote", "set-url", "origin", "https://github.com/craigoley/remudero.git");
    git(work, "config", `url.file://${bare}.insteadOf`, "https://github.com/craigoley/remudero.git");
    git(work, "commit", "-q", "--allow-empty", "-m", "pushed to a PR, then superseded");
    const head = git(work, "rev-parse", "HEAD").trim();
    const calls = join(fx.root, "gh-calls");
    writeFileSync(join(fx.root, "bin/gh"), `#!/bin/bash
printf '%s\\n' "$*" >> '${calls}'
case "$2" in "repos/craigoley/remudero/commits/\${GH_KNOWN:-none}/pulls") echo 1 ;; *) echo 0 ;; esac
`, { mode: 0o755 });
    const probe = (known: string) => spawnSync("bash", ["-c", `source '${guard}'; rmd_workspace_published "$1" && echo published || echo "held $RMD_PUB_REASON"`, "_", work],
      { encoding: "utf8", env: { ...process.env, PATH: `${join(fx.root, "bin")}:${process.env.PATH}`, GH_KNOWN: known } }).stdout.trim();
    assert.equal(probe(head), "published");
    assert.equal(probe("0000000000000000000000000000000000000000"), "held not-proven-published");
    git(work, "remote", "set-url", "origin", bare);
    rmSync(calls, { force: true });
    assert.equal(probe(head), "held not-proven-published");
    assert.equal(existsSync(calls), false, "a non-GitHub origin never asks gh");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
