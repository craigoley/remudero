/** Runs the real Azure janitor (deploy/rmd-host-cleanup.sh); every path and probe is a private fixture. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { age, fixture, git, repos, run, SCRIPT, type Fixture } from "#test/helpers/host-cleanup-fixture.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

assert.ok(existsSync(join(REPO_ROOT, SCRIPT)), "the janitor under test exists");

function file(path: string, body = "payload\n"): string {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path;
}
/** The fixture origin with node_modules, coverage, tmp/ and state/ ignored, as remudero ignores them. */
function ignoring(fx: Fixture) {
  const r = repos(fx);
  file(join(r.main, ".gitignore"), "node_modules\ncoverage\ntmp/\nstate/\n");
  git(r.main, "add", ".gitignore"); git(r.main, "commit", "-m", "ignore generated output");
  git(r.main, "push", "origin", "HEAD:main");
  return r;
}
function generated(wt: string): string[] {
  file(join(wt, "node_modules/pkg/index.js")); file(join(wt, "coverage/lcov.info"));
  return [join(wt, "node_modules"), join(wt, "coverage")];
}

test("an idle held Claude worktree loses node_modules and coverage while its unpublished, dirty or locked work stays", () => {
  const fx = fixture();
  try {
    const { main, addWorktree } = ignoring(fx);
    const unpublished = addWorktree("unpublished", "unpublished");
    git(unpublished, "commit", "--allow-empty", "-m", "never pushed");
    const dirty = addWorktree("dirty", "dirty");
    const edit = file(join(dirty, "README"), "local edit\n");
    const locked = addWorktree("locked", "locked");
    git(main, "worktree", "lock", locked);
    const busy = addWorktree("young", "young");
    const held = [unpublished, dirty, locked].flatMap(generated);
    const youngTrees = generated(busy);
    for (const wt of [unpublished, dirty, locked]) age(wt, 7);
    age(busy, 7); file(join(busy, "src.ts"), "edited an hour ago\n"); age(join(busy, "src.ts"), 1);
    const r = run(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_AGENT_SCRATCH: "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const tree of held) assert.equal(existsSync(tree), false, tree + r.stdout);
    for (const wt of [unpublished, dirty, locked]) assert.ok(existsSync(wt), wt + r.stdout);
    for (const tree of youngTrees) assert.ok(existsSync(tree), tree + r.stdout);
    assert.ok(existsSync(edit));
    assert.match(r.stdout, /PRUNE .*unpublished\/node_modules: \d+ bytes, worktree kept for not-proven-published/);
    assert.match(r.stdout, /PRUNE .*locked\/coverage: .*Git worktree is locked/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("an idle published Claude worktree retires with its ignored tmp/ and state/ run scratch, which still holds other worktrees", () => {
  const fx = fixture();
  try {
    const { main, addWorktree } = ignoring(fx);
    const agent = addWorktree("finished", "finished");
    git(agent, "push", "origin", "HEAD:refs/heads/finished");
    file(join(agent, "tmp/openweight-loop/out.json"), "{}\n");
    file(join(agent, "state/openweight-allowance.json"), "{}\n");
    const rootDir = join(fx.home, "rmd-work");
    mkdirSync(rootDir, { recursive: true });
    const plain = join(rootDir, "plain");
    git(main, "worktree", "add", "-b", "plain", plain, "main");
    git(plain, "push", "origin", "HEAD:refs/heads/plain");
    const reservation = file(join(plain, "state/openweight-allowance.json"), "{}\n");
    age(agent, 7); age(plain, 7);
    const r = run(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_WORKTREE_ROOTS: rootDir, RMD_CLEANUP_AGENT_SCRATCH: "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(agent), false, r.stdout);
    assert.ok(existsSync(reservation), r.stdout);
    assert.match(r.stdout, /KEEP .*rmd-work\/plain: ignored data includes paths beyond node_modules\/coverage/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the GitHub publication proof reads ~/.gh-token when cron supplies no GH_TOKEN", () => {
  for (const withToken of [true, false]) {
    const fx = fixture();
    try {
      const { addWorktree } = ignoring(fx);
      const wt = addWorktree("pr-superseded", "pr-superseded");
      git(wt, "commit", "--allow-empty", "-m", "pushed to a PR, then force-pushed past");
      const head = git(wt, "rev-parse", "HEAD").trim();
      // The configured URL names GitHub; insteadOf keeps ls-remote on the local fixture origin.
      const origin = join(fx.root, "origin.git");
      git(wt, "config", "remote.origin.url", "https://github.com/craigoley/remudero.git");
      git(wt, "config", `url.file://${origin}.insteadOf`, "https://github.com/craigoley/remudero.git");
      writeFileSync(join(fx.root, "bin/gh"), `#!/bin/bash
[ "$GH_TOKEN" = fixture-token ] || exit 4
case "$2" in "repos/craigoley/remudero/commits/${head}/pulls") echo 0 ;; *) exit 1 ;; esac
`, { mode: 0o755 });
      if (withToken) writeFileSync(join(fx.home, ".gh-token"), "fixture-token\n", { mode: 0o600 });
      age(wt, 7);
      const r = run(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_AGENT_SCRATCH: "", GH_TOKEN: "",
        PATH: `${join(fx.root, "bin")}:${process.env.PATH}` });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(existsSync(wt), !withToken, r.stdout);
      if (!withToken) assert.match(r.stdout, /not-proven-published HEAD=/);
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("Codex rollout logs idle seven days are deleted while recent, open and other Codex files stay", () => {
  const fx = fixture();
  try {
    const codex = join(fx.home, ".codex");
    const old = [file(join(codex, "sessions/2026/10/01/rollout-2026-10-01T00-00-00-a.jsonl")),
      file(join(codex, "archived_sessions/rollout-2026-10-02T00-00-00-b.jsonl.zst"))];
    const recent = file(join(codex, "sessions/2026/11/05/rollout-2026-11-05T00-00-00-c.jsonl"));
    const open = file(join(codex, "sessions/2026/10/03/rollout-2026-10-03T00-00-00-d.jsonl"));
    const other = file(join(codex, "sessions/2026/10/04/notes.json"));
    const db = file(join(codex, "state_5.sqlite"));
    for (const p of [...old, open, other, db]) age(p, 8 * 24);
    age(recent, 2 * 24);
    writeFileSync(fx.lsofList, open + "\n");
    const r = run(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_AGENT_SCRATCH: "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const p of old) assert.equal(existsSync(p), false, p + r.stdout);
    for (const p of [recent, open, other, db]) assert.ok(existsSync(p), p + r.stdout);
    const off = fixture();
    try {
      const kept = file(join(off.home, ".codex/sessions/2026/10/01/rollout-x.jsonl")); age(kept, 30 * 24);
      const r2 = run(off, { RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_AGENT_SCRATCH: "", RMD_CLEANUP_CODEX_SESSION_DAYS: "0" });
      assert.equal(r2.status, 0, r2.stderr + r2.stdout);
      assert.ok(existsSync(kept), "0 turns the purge off");
    } finally { rmSync(off.root, { recursive: true, force: true }); }
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("idle agent scratch in rmd-work is removed unless it holds state, keys or coordination, is open, recent or a checkout", () => {
  const fx = fixture();
  try {
    const work = join(fx.home, "rmd-work");
    const gone = [file(join(work, "j9552.log")), file(join(work, "t5519/out.txt")), file(join(work, "ledger-grep-notes.txt")),
      file(join(work, "nm-donor/node_modules/pkg/index.js"))].map(p => p.startsWith(join(work, "t5519")) ? join(work, "t5519")
      : p.includes("nm-donor") ? join(work, "nm-donor") : p);
    const kept = [file(join(work, "aa/ledger.ndjson")), file(join(work, "run.pid")), file(join(work, "keys/deploy.pem")),
      file(join(work, "marked/.rmd-janitor-keep"))];
    const recent = file(join(work, "today.md"));
    const open = file(join(work, "tail-me.log"));
    for (const p of [...gone, ...kept.map(dirname), open]) age(p, 7);
    for (const p of kept) age(p, 7);
    age(recent, 1);
    const { main } = repos(fx);
    const checkout = join(work, "operator-main");
    git(main, "worktree", "add", "-b", "operator-main", checkout, "main");
    age(checkout, 7);
    writeFileSync(fx.lsofList, open + "\n");
    const r = run(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: "" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const p of gone) assert.equal(existsSync(p), false, p + r.stdout);
    for (const p of [...kept, recent, open, checkout]) assert.ok(existsSync(p), p + r.stdout);
    assert.match(r.stdout, /KEEP .*rmd-work\/aa: holds state, keys or coordination/);
    const off = run(fx, { RMD_CLEANUP_LIVE_CHECKOUTS: "", RMD_CLEANUP_AGENT_SCRATCH: "" });
    assert.equal(off.status, 0, off.stderr + off.stdout);
    assert.doesNotMatch(off.stdout, /agent scratch idle/, "an empty list turns the sweep off");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
