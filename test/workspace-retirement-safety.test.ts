import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { age, fixture, git, repos, run, type Fixture } from "./helpers/host-cleanup-fixture.js";

const GUARD = join(process.cwd(), "deploy/workspace-retirement-guard.sh");
const MAC = join(process.cwd(), "deploy/mac/remudero-janitor.sh");
function publication(repo: string, scope = "head") {
  return spawnSync("bash", ["-c", 'set -uo pipefail; source "$1"; rmd_workspace_published "$2" "$3"; rc=$?; echo "$RMD_PUB_REASON"; exit "$rc"', "proof", GUARD, repo, scope], { encoding: "utf8" });
}
function mac(fx: Fixture, apply = true, extra: Record<string, string> = {}) {
  return spawnSync("bash", [MAC, apply ? "--apply" : "--dry-run"], { encoding: "utf8", env: {
    ...process.env, HOME: fx.home, TMPDIR: fx.scratch, PATH: `${join(fx.root, "bin")}:${process.env.PATH}`,
    REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
    REMUDERO_JANITOR_LOG: join(fx.root, "mac.log"), REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "mac.lock"),
    ...extra,
  } });
}
function reporting(fx: Fixture, body: string, input?: string) {
  return spawnSync("bash", ["-c", `set -euo pipefail; source "$1"; ${body}`, "report", GUARD, join(fx.root, "decisions.tsv")], {
    encoding: "utf8", input, env: { ...process.env, HOME: fx.home, TMPDIR: fx.scratch },
  });
}
// The production Mac guard uses mtime AND ctime. A fixture cannot backdate
// ctime, so this probe supplies an aged ctime equal to mtime without changing
// production logic. A separate case below exercises the actual ctime guard.
function macProbes(fx: Fixture) {
  const nativeStat = execFileSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).trim();
  writeFileSync(join(fx.root, "bin/stat"), `#!/bin/bash\nif [ "$2" = '%m %c' ]; then shift 2; exec '${nativeStat}' -f '%m %m' "$@"; fi\nif [ "$2" = '%Y %Z' ]; then shift 2; exec '${nativeStat}' -c '%Y %Y' "$@"; fi\nexec '${nativeStat}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(fx.root, "bin/ps"), "#!/bin/bash\nprintf '1 /bin/sh\\n'\n", { mode: 0o755 });
  writeFileSync(join(fx.root, "bin/lsof"), `#!/bin/bash
if [ "\${FAKE_LSOF_FAIL:-0}" = 1 ]; then exit 2; fi
case " $* " in
  *" +D "*)
    target="\${@: -1}"; rc=1
    while IFS= read -r p; do
      case "$p" in "$target"|"$target"/*) printf 'p1\\nn%s\\n' "$p"; rc=0 ;; esac
    done < '${fx.lsofList}'
    exit "$rc" ;;
esac
while IFS= read -r p; do [ -n "$p" ] && printf 'p1\\nn%s\\n' "$p"; done < '${fx.lsofList}'
exit 0
`, { mode: 0o755 });
}

test("workspace retirement requires fresh publication, not stale remote refs or landed task trailers", () => {
  const fx = fixture();
  try {
    const { main, addWorktree } = repos(fx);
    const wt = addWorktree("candidate", "run-W1-T123-1");
    git(wt, "commit", "--allow-empty", "-m", "private work");
    git(wt, "push", "origin", "HEAD:temporary");
    assert.equal(publication(wt).status, 0);
    git(main, "push", "origin", ":temporary");
    git(main, "commit", "--allow-empty", "-m", "landed\n\nRemudero-Task: W1-T123");
    git(main, "push", "origin", "HEAD:main");
    assert.notEqual(publication(wt).status, 0);
    git(wt, "push", "origin", "HEAD:refs/pull/42/head");
    assert.equal(publication(wt).status, 0, "exact published PR tip survives branch deletion");
    git(wt, "remote", "set-url", "origin", join(fx.root, "missing-origin"));
    const missing = publication(wt);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /publication-unverified/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("standalone publication includes side branches, tags, stash and reflog-only work", () => {
  for (const kind of ["branch", "tag", "stash", "reflog"]) {
    const fx = fixture();
    try {
      const { main } = repos(fx);
      assert.equal(publication(main, "all").status, 0);
      if (kind === "stash") {
        writeFileSync(join(main, "README"), "unpublished stash");
        git(main, "stash", "push");
      } else {
        git(main, "checkout", "-b", "private");
        git(main, "commit", "--allow-empty", "-m", "private");
        if (kind === "tag") git(main, "tag", "private-tag");
        git(main, "checkout", "main");
        if (kind !== "branch") git(main, "branch", "-D", "private");
      }
      assert.notEqual(publication(main, "all").status, 0, kind);
      assert.equal(publication(main).status, 0, "HEAD alone remains published");
    } finally { rmSync(fx.root, { recursive: true, force: true }); }
  }
});

test("retirement object reads never hydrate a partial clone, including on older Git", () => {
  const fx = fixture();
  try {
    const { main } = repos(fx);
    const origin = join(fx.root, "origin.git");
    git(origin, "config", "uploadpack.allowFilter", "true");
    const partial = join(fx.root, "partial");
    git(fx.root, "clone", "--filter=blob:none", "--single-branch", `file://${origin}`, partial);
    git(main, "commit", "--allow-empty", "-m", "remote object not present locally");
    git(main, "push", "origin", "HEAD:main");
    const missing = git(main, "rev-parse", "HEAD").trim();
    const packs = join(partial, ".git/objects/pack");
    const before = readdirSync(packs).sort();
    const read = spawnSync("bash", ["-c", 'source "$1"; rmd_retirement_git "$2" cat-file -e "$3"', "proof", GUARD, partial, missing]);
    assert.notEqual(read.status, 0, "missing objects must remain missing, not be fetched");
    assert.notEqual(publication(partial).status, 0, "unavailable ancestry fails closed");
    assert.deepEqual(readdirSync(packs).sort(), before, "no new object packs");

    // Model Azure's Git 2.43, which silently ignores GIT_NO_LAZY_FETCH.
    const nativeGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const calls = join(fx.root, "git-calls");
    writeFileSync(join(fx.root, "bin/git"), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = --no-lazy-fetch ]; then exit 129; fi\nexec '${nativeGit}' "$@"\n`, { mode: 0o755 });
    const old = spawnSync("bash", ["-c", 'source "$1"; rmd_retirement_git "$2" cat-file -e HEAD', "proof", GUARD, partial], {
      env: { ...process.env, PATH: `${join(fx.root, "bin")}:${process.env.PATH}` },
    });
    assert.notEqual(old.status, 0, "old Git must hold the promisor before reading objects");
    assert.doesNotMatch(readFileSync(calls, "utf8"), /cat-file/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("Mac janitor retires only published idle workspaces across Remudero, operator descendants and rmd-work", () => {
  const fx = fixture();
  try {
    macProbes(fx);
    const { main } = repos(fx);
    mkdirSync(join(fx.home, "Remudero"));
    const operator = join(fx.home, "Remudero/remudero");
    git(fx.root, "clone", join(fx.root, "origin.git"), operator);
    const roots = [join(fx.home, "Remudero"), join(fx.home, "Remudero/remudero/.session-scratch"), join(fx.home, "rmd-work")];
    // The Mac-only allowlist must not silently become Linux deletion scope.
    // Linux still exercises every Git/activity guard inside its real rmd-work root.
    if (process.platform === "darwin") roots.push(join(fx.home, "Developer/remudero-operator-worktrees"));
    const guardedRoot = roots.at(-1)!;
    const removed: string[] = [];
    for (const [i, root] of roots.entries()) {
      mkdirSync(root, { recursive: true });
      const wt = join(root, "old-published");
      git(main, "worktree", "add", "--detach", wt, "main");
      // Include a large regenerable tree without making its files untracked source.
      writeFileSync(join(main, ".git/info/exclude"), "node_modules\n");
      writeFileSync(join(wt, "package.json"), '{"name":"remudero"}');
      git(wt, "add", "package.json"); git(wt, "commit", "-m", `manifest ${i}`);
      git(wt, "push", "origin", `HEAD:refs/heads/published-${i}`);
      mkdirSync(join(wt, "node_modules")); writeFileSync(join(wt, "node_modules/data"), "cache");
      age(wt, 7); removed.push(wt);
    }
    const privateWt = join(guardedRoot, "unpushed");
    git(main, "worktree", "add", "-b", "private", privateWt, "main");
    git(privateWt, "commit", "--allow-empty", "-m", "unpublished"); age(privateWt, 7);
    const dirty = join(guardedRoot, "dirty");
    git(main, "worktree", "add", "-b", "dirty", dirty, "main");
    writeFileSync(join(dirty, "work.txt"), "keep me"); age(dirty, 7);
    const young = join(guardedRoot, "young");
    git(main, "worktree", "add", "-b", "young", young, "main"); age(young, 5);
    const nestedRecent = join(guardedRoot, "old-root-young-child");
    git(main, "worktree", "add", "-b", "child", nestedRecent, "main"); age(nestedRecent, 7);
    age(join(nestedRecent, "README"), 1);
    const held = join(guardedRoot, "held");
    git(main, "worktree", "add", "-b", "held", held, "main"); age(held, 7);
    // An ordinary shell in the canonical operator checkout must not hold
    // every unrelated nested worktree. The specific held child still stays.
    writeFileSync(fx.lsofList, `${realpathSync(held)}\n${realpathSync(operator)}\n`);
    const tracked = join(operator, "tracked-gitlink");
    git(main, "worktree", "add", "-b", "tracked-child", tracked, "main");
    git(operator, "add", "tracked-gitlink"); git(operator, "commit", "-m", "tracked nested source"); age(tracked, 7);
    const orphan = join(guardedRoot, "broken"); mkdirSync(orphan);
    writeFileSync(join(orphan, ".git"), "gitdir: /missing/.git/worktrees/only-work\n"); age(orphan, 7);
    // Inactive unmarked scratch is now eligible; important unversioned data can opt out explicitly.
    const unknown = join(roots[2], "data"); mkdirSync(unknown); writeFileSync(join(unknown, "important"), "keep");
    writeFileSync(join(unknown, ".rmd-janitor-keep"), "important data"); age(unknown, 7);
    const disposable = join(roots[2], "disposable-data"); mkdirSync(disposable);
    writeFileSync(join(disposable, "payload.bin"), "scratch"); age(disposable, 7);
    const r = mac(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const wt of removed) assert.equal(existsSync(wt), false, r.stdout);
    assert.equal(existsSync(disposable), false, r.stdout);
    for (const wt of [privateWt, dirty, young, nestedRecent, held, orphan, unknown, operator, tracked]) assert.equal(existsSync(wt), true, r.stdout);
    assert.match(r.stdout, /protected tracked-nested-source/);
    assert.match(r.stdout, /not-proven-published/);
    assert.match(r.stdout, /unknown-directory/);
    const report = readFileSync(join(fx.home, ".local/state/remudero/janitor-decisions.tsv"), "utf8");
    assert.match(report, /\tkeep\tunpublished\t/);
    assert.match(report, /\tkeep\tgit_unknown\t/);
    assert.match(report, /\tkeep\tyounger_than_guard\t/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("Mac janitor refuses young ctime, missing probes and short guard overrides; dry run preserves files", () => {
  const fx = fixture();
  try {
    macProbes(fx);
    const { main } = repos(fx);
    const wt = join(fx.home, "rmd-work/old"); mkdirSync(join(fx.home, "rmd-work"));
    git(main, "worktree", "add", "-b", "old", wt, "main"); age(wt, 7);
    assert.equal(mac(fx, false).status, 0); assert.equal(existsSync(wt), true);
    const blind = mac(fx, true, { FAKE_LSOF_FAIL: "1" });
    assert.equal(blind.status, 0); assert.equal(existsSync(wt), true); assert.match(blind.stdout, /unverified/);
    assert.equal(mac(fx, true, { REMUDERO_JANITOR_WORKTREE_AGE_HOURS: "2" }).status, 2);
    rmSync(join(fx.root, "bin/stat"));
    assert.equal(mac(fx).status, 0); assert.equal(existsSync(wt), true, "recent real ctime protects backdated mtime");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("temporary-directory globs cannot bypass publication safety and deep Git discovery", () => {
  const fx = fixture();
  try {
    const { main } = repos(fx);
    const unit = join(fx.scratch, "rmd-unpublished");
    const repo = join(unit, "a/b/c/d/e/repo"); mkdirSync(join(unit, "a/b/c/d/e"), { recursive: true });
    git(fx.root, "clone", main, repo); git(repo, "commit", "--allow-empty", "-m", "never pushed"); age(unit, 7);
    const r = run(fx, { RMD_CLEANUP_ONLY_TMP: "1" });
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(existsSync(repo), true, r.stdout);
    assert.match(r.stdout, /not-proven-published/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("Linux janitor protects recent real ctime even when the entire payload mtime was backdated", () => {
  const fx = fixture();
  try {
    const { addWorktree } = repos(fx);
    const wt = addWorktree("backdated", "backdated"); age(wt, 7);
    const r = run(fx, { RMD_CLEANUP_FIND: "find" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(wt), true, r.stdout);
    assert.match(r.stdout, /written within 360 min|recent or unverified Git HEAD activity/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a metadata-only branch checkout protects an old workspace without treating every Git fetch as activity", () => {
  const fx = fixture();
  try {
    macProbes(fx);
    const { main } = repos(fx);
    const root = join(fx.home, "rmd-work"); mkdirSync(root);
    const wt = join(root, "branch-switched");
    git(main, "worktree", "add", "-b", "old", wt, "main"); age(wt, 7);
    git(wt, "checkout", "-b", "new-session");
    const r = mac(fx);
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(existsSync(wt), true);
    assert.match(r.stdout, /recent-or-unverified-git-head/);
    const linux = run(fx, { RMD_CLEANUP_WORKTREE_ROOTS: root });
    assert.equal(linux.status, 0, linux.stderr + linux.stdout); assert.equal(existsSync(wt), true);
    assert.match(linux.stdout, /recent or unverified Git HEAD activity/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a local remote inside the retirement unit and bare object stores never authorize deletion", () => {
  const fx = fixture();
  try {
    const { main } = repos(fx);
    const unit = join(fx.scratch, "rmd-with-local-origin"); mkdirSync(unit);
    const origin = join(unit, "origin.git");
    git(fx.root, "clone", "--bare", main, origin);
    const repo = join(unit, "repo"); git(fx.root, "clone", origin, repo); age(unit, 7);
    const r = run(fx, { RMD_CLEANUP_ONLY_TMP: "1" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(origin), true); assert.equal(existsSync(repo), true);
    assert.match(r.stdout, /bare repository/);
    const unsafe = spawnSync("bash", ["-c", 'source "$1"; rmd_remote_outside_retirement "$2" "$3"', "proof", GUARD, repo, unit]);
    assert.notEqual(unsafe.status, 0);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("Mac installer installs both safety helpers and preserves the previous script without changing schedules", () => {
  const fx = fixture();
  try {
    const dest = join(fx.root, "install"); mkdirSync(dest); writeFileSync(join(dest, "remudero-janitor.sh"), "old script");
    const r = spawnSync("bash", ["deploy/mac/install-janitor.sh"], { encoding: "utf8", env: { ...process.env, REMUDERO_JANITOR_INSTALL_DIR: dest } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const name of ["workspace-retirement-guard.sh", "dependency-seed-guard.sh", "remudero-janitor.sh", "tmp-reclaim.sh", "cache-reclaim.py", "retire-legacy-sweeper.py"]) assert.equal(existsSync(join(dest, name)), true);
    assert.equal(readFileSync(join(dest, "remudero-janitor.sh"), "utf8"), readFileSync(MAC, "utf8"));
    assert.equal(readFileSync(join(dest, "tmp-reclaim.sh"), "utf8"), readFileSync("deploy/mac/tmp-reclaim.sh", "utf8"));
    assert.match(r.stdout, /schedules unchanged/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("a parent launcher keeps its referenced child active while inactive published siblings retire", () => {
  const fx = fixture();
  try {
    macProbes(fx); const { main } = repos(fx);
    const parent = join(fx.home, "Remudero", "jobs"); mkdirSync(parent, { recursive: true });
    const names = ["idle-published", "relative-worker", "cwd-worker", "unpublished", "dirty", "cash-reservations", "young"];
    const paths = names.map(name => { const p = join(parent, name); git(main, "worktree", "add", "-b", name, p, "main"); return p; });
    git(paths[3]!, "commit", "--allow-empty", "-m", "unpublished changes");
    writeFileSync(join(paths[4]!, "work.txt"), "uncommitted");
    const cash = join(paths[5]!, "state", "openweight-allowance.json"); mkdirSync(dirname(cash), { recursive: true });
    writeFileSync(cash, '{"reservations":{"uncertain":"held"}}\n');
    const exclude = join(main, ".git/info/exclude"); writeFileSync(exclude, "state/\n");
    for (const p of paths) age(p, 8); age(paths[6]!, 5);
    writeFileSync(fx.lsofList, `${realpathSync(parent)}\n${realpathSync(paths[2]!)}\n`);
    writeFileSync(join(fx.root, "bin/ps"), "#!/bin/bash\nprintf '1 node relative-worker/entry.mjs\\n'\n", { mode: 0o755 });
    const r = mac(fx); assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(existsSync(paths[0]!), false, r.stdout);
    for (const p of paths.slice(1)) assert.ok(existsSync(p), p + r.stdout);
    assert.equal(readFileSync(cash, "utf8"), '{"reservations":{"uncertain":"held"}}\n');
    assert.match(r.stdout, /not-proven-published/); assert.match(r.stdout, /ignored-or-unverified/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("the scheduled Mac janitor invokes nested-cache cleanup from its installed helper", () => {
  const fx = fixture();
  try {
    macProbes(fx);
    const job = join(fx.scratch, "historical-ci"); const cache = join(job, "tsx-501");
    mkdirSync(cache, { recursive: true }); mkdirSync(join(job, "fixture", ".git"), { recursive: true });
    const file = join(cache, `17920-${"a".repeat(40)}`); writeFileSync(file, "compiled cache"); age(job, 8);
    const recentCache = join(fx.home, ".codex/work-artifacts/job/.next/cache/turbopack");
    mkdirSync(recentCache, { recursive: true }); writeFileSync(join(recentCache, "payload"), "recent cache");
    const dest = join(fx.root, "installed");
    const install = spawnSync("bash", ["deploy/mac/install-janitor.sh"], { encoding: "utf8", env: { ...process.env, REMUDERO_JANITOR_INSTALL_DIR: dest } });
    assert.equal(install.status, 0, install.stderr);
    const r = spawnSync("bash", [join(dest, "remudero-janitor.sh"), "--apply"], { encoding: "utf8", env: {
      ...process.env, PATH: `${join(fx.root, "bin")}:${process.env.PATH}`,
      REMUDERO_JANITOR_ACCOUNT_HOME: fx.home, REMUDERO_JANITOR_SCAN_ROOTS: fx.scratch,
      REMUDERO_JANITOR_LOG: join(fx.root, "mac.log"), REMUDERO_JANITOR_LOCK_DIR: join(fx.root, "mac.lock"),
      RMD_RECLAIM_TSX_FIND: join(fx.root, "bin/find-age"),
    } });
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(existsSync(file), false, r.stdout);
    assert.ok(existsSync(join(job, "fixture", ".git")));
    assert.match(r.stdout, /generated-cache: pruned tsx cache files=1/);
    assert.match(readFileSync(join(fx.root, "mac.log"), "utf8"), /cache-reclaim:.*"sourceOrGitRetired":false/);
    const rows = readFileSync(join(fx.home, ".local/state/remudero/janitor-decisions.tsv"), "utf8").trim().split("\n").map(line => line.split("\t"));
    assert.ok(rows.some(row => row[2] === "remove" && row[3] === "generated_cache_eligible" && row[4]!.includes("pruned tsx cache files=1")));
    assert.ok(rows.some(row => row[2] === "keep" && row[3] === "cache_recent_foreign_or_flagged" && row[4]!.includes(recentCache) && row[5] === "unknown"));
    assert.match(r.stdout, /retirement skips: cache_recent_foreign_or_flagged=1/);
    assert.ok(existsSync(join(recentCache, "payload")));
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("janitor reporting keeps completion informational and types TSX outcomes without path guesses", () => {
  const fx = fixture();
  try {
    const r = reporting(fx, `
rmd_decision_record "$2" '=== done: live-skip=7 young-skip=2 ==='
rmd_decision_record "$2" 'SKIP live /private/path'
rmd_decision_record "$2" 'generated-cache: KEEP RISKY (TSX cache process command references path): /private/cache with spaces'
rmd_decision_record "$2" 'generated-cache: KEEP RISKY (TSX cache open file or lsof scan uncertain): /private/live-cache'
rmd_decision_record "$2" 'generated-cache: KEEP RISKY (TSX discovery incomplete): /private/root'
rmd_decision_record "$2" 'generated-cache: pruned tsx cache files=2 (older than 360 min): /private/cache'
rmd_decision_record "$2" 'generated-cache: would prune tsx cache files=2 (older than 360 min): /private/cache'
rmd_decision_record "$2" 'generated-cache: KEEP RISKY (TSX cache prune incomplete): /private/cache'
rmd_decision_record "$2" $'SKIP unknown-directory /private/percent%tab\\tline\\nreturn\\r'
`);
    assert.equal(r.status, 0, r.stderr);
    const rows = readFileSync(join(fx.root, "decisions.tsv"), "utf8").trim().split("\n").map(line => line.split("\t"));
    assert.deepEqual(rows.map(row => row.slice(2, 4)), [
      ["info", "other"], ["keep", "active"], ["keep", "active"], ["keep", "probe_unknown"],
      ["keep", "discovery_incomplete"], ["remove", "generated_cache_eligible"],
      ["planned", "generated_cache_eligible"], ["info", "removal_unverified"], ["keep", "unknown_directory"],
    ]);
    assert.ok(rows.every(row => row.length === 7 && row[5] === "unknown" && row[6] === "unknown"));
    assert.equal(rows[8]![4], "SKIP unknown-directory /private/percent%25tab%09line%0Areturn%0D");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("janitor reporting translates bounded cache JSON including deferred and unverified removals", () => {
  const fx = fixture();
  try {
    const receipt = { version: 1, inspection: { mode: "artifacts", discoveryComplete: false, candidateEvaluationComplete: false, undiscoveredCandidateCount: null }, decisions: [
      { action: "keep", reason: "reference-corpus-incomplete", deferred: true, path: "/private/deferred cache" },
      { action: "keep", reason: "recent-foreign-or-flagged", path: "/private/recent", pathAllocatedBytes: 4096 },
      { action: "would-remove", path: "/private/planned", pathAllocatedBytes: 8192 },
      { action: "removed", path: "/private/removed", pathAllocatedBytes: 0 },
      { action: "removed-unverified", reason: "post-removal-verification-unavailable", path: "/private/partial" },
      { action: "keep", reason: "[Errno 13] Permission denied", path: "/private/unknown", pathAllocatedBytes: true },
    ] };
    const r = reporting(fx, 'rmd_decision_cache_json "$2"; rmd_decision_summary "$2"', `cache-reclaim: ${JSON.stringify(receipt)}\n`);
    assert.equal(r.status, 0, r.stderr);
    const rows = readFileSync(join(fx.root, "decisions.tsv"), "utf8").trim().split("\n").map(line => line.split("\t"));
    assert.deepEqual(rows.map(row => row.slice(2, 4)), [
      ["keep", "cache_reference_corpus_incomplete"], ["keep", "cache_recent_foreign_or_flagged"],
      ["planned", "generated_cache_eligible"], ["remove", "generated_cache_eligible"],
      ["remove", "cache_removal_unverified"], ["keep", "cache_probe_unknown"], ["info", "cache_inspection_incomplete"],
    ]);
    assert.deepEqual(rows.map(row => row[5]), ["unknown", "4096", "8192", "0", "unknown", "unknown", "unknown"]);
    assert.match(r.stdout, /cache_reference_corpus_incomplete=1 known-observed-bytes=0 unknown-size-decisions=1 total-bytes=unknown/);
    assert.match(r.stdout, /cache_recent_foreign_or_flagged=1 known-observed-bytes=4096 unknown-size-decisions=0 total-bytes=unknown/);
    assert.match(r.stdout, /unique-total=unknown/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("janitor skipped sizes reuse only successful existing probes and keep legacy unknown rows", () => {
  const fx = fixture();
  try {
    const r = reporting(fx, `
du() { echo unexpected-size-scan >&2; return 99; }
find() { echo unexpected-tree-scan >&2; return 99; }
rmd_decision_known_kib 8 0; rmd_decision_record "$2" 'SKIP open /private/known'
rmd_decision_known_kib 9 1; rmd_decision_record "$2" 'SKIP open /private/failed'
rmd_decision_known_kib '' 0; rmd_decision_record "$2" 'SKIP open /private/missing'
rmd_decision_known_kib 000 0; rmd_decision_record "$2" 'SKIP open /private/empty'
rmd_decision_known_kib 99999999999999999999 0; rmd_decision_record "$2" 'SKIP open /private/overflow'
printf '%s\\tlegacy-time\\tkeep\\tactive\\tSKIP open legacy\\n' "$RMD_DECISION_PASS_ID" >> "$2"
rmd_decision_summary "$2"
`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const rows = readFileSync(join(fx.root, "decisions.tsv"), "utf8").trim().split("\n").map(line => line.split("\t"));
    assert.deepEqual(rows.slice(0, 5).map(row => row[5]), ["8192", "unknown", "unknown", "0", "unknown"]);
    assert.match(r.stdout, /active=6 known-observed-bytes=8192 unknown-size-decisions=4 total-bytes=unknown/);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

test("janitor reporting refuses malformed cache receipts before recording a partial success", () => {
  const fx = fixture();
  try {
    const input = 'cache-reclaim: {"version":1,"decisions":[{"action":"removed"},{"action":"invented"}]}\n';
    const r = reporting(fx, 'if rmd_decision_cache_json "$2"; then exit 9; fi; rmd_decision_record "$2" "cache report unrecognized" info cache_report_unknown', input);
    assert.equal(r.status, 0, r.stderr);
    const rows = readFileSync(join(fx.root, "decisions.tsv"), "utf8").trim().split("\n").map(line => line.split("\t"));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.slice(2, 4), ["info", "cache_report_unknown"]);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
