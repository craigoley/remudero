/**
 * deploy/mac/tmp-reclaim.sh — test shards leave whole temp trees of fixture repositories behind
 * (rmd-s2-final.<id> holding rmd-cow-wt-<id>-dirty repos with no remote at all). They were held forever as
 * "Git checkout/worktree". A tree whose every repository has no remote, or only a path remote inside
 * the same tree, is disposable once idle; a repository with a network remote, or a remote or store
 * outside the tree, still holds it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

const SCRIPT = join(REPO_ROOT, "deploy", "mac", "tmp-reclaim.sh");
const osNowMs = () => Number(spawnSync("date", ["+%s"], { encoding: "utf8" }).stdout.trim()) * 1000;
const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const git = (cwd: string, ...args: string[]) => sh(cwd, "git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args);
function age(path: string, hours: number) {
  const when = new Date(osNowMs() - hours * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}${p(when.getHours())}${p(when.getMinutes())}`;
  sh(dirname(path), "find", path, "-exec", "touch", "-h", "-t", stamp, "{}", "+");
}
function fixtureRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "fixture\n");
  git(dir, "add", "a.txt"); git(dir, "commit", "-q", "-m", "fixture");
  writeFileSync(join(dir, "dirty.txt"), "fixture edit\n");
}
function fileContents(dir: string) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()
    .filter(path => statSync(join(dir, path)).isFile())
    .map(path => [path, createHash("sha256").update(readFileSync(join(dir, path))).digest("hex")]);
}

test("an idle temp tree of remote-less fixture repositories is removed while network-remote, outside-remote, spend-holding and young trees stay", () => {
  const base = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fixture-reclaim-`));
  try {
    const root = join(base, "tmp"); mkdirSync(root);
    const bin = join(base, "bin"); mkdirSync(bin);
    const find = sh(base, "sh", "-c", "command -v find").trim();
    // A fixture can backdate mtime, not ctime: read -cmin as -mmin, like the suite's other cases.
    writeFileSync(join(bin, "find"), `#!/bin/bash\nargs=(); for arg; do if [ "$arg" = -cmin ]; then args+=(-mmin); else args+=("$arg"); fi; done\nexec '${find}' "\${args[@]}"\n`, { mode: 0o755 });
    writeFileSync(join(bin, "crontab"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    const lsof = join(base, "lsof");
    writeFileSync(lsof, "#!/bin/bash\ncase \" $* \" in *\" cwd \"*) exit 0 ;; esac\nexit 1\n", { mode: 0o755 });

    const shard = join(root, "rmd-s2-final.abc123");
    fixtureRepo(join(shard, "rmd-cow-wt-Wurc1L-dirty"));
    const lender = join(shard, "rmd-cow-wt-SShIh8-plain");
    fixtureRepo(lender);
    git(shard, "clone", "-q", lender, join(shard, "rmd-cow-wt-SShIh8-clone")); // path remote inside the tree
    const real = join(root, "remudero-pr-1");
    fixtureRepo(real);
    git(real, "remote", "add", "origin", "https://github.com/craigoley/remudero.git");
    const push = join(root, "rmd-s2-push-network.abc123");
    const pushRepo = join(push, "repo");
    const pushLender = join(push, "lender");
    fixtureRepo(pushLender);
    fixtureRepo(pushRepo);
    git(pushRepo, "remote", "add", "origin", pushLender);
    git(pushRepo, "config", "remote.origin.pushurl", "ssh://git@github.com/craigoley/remudero.git");
    const pushBefore = fileContents(push);
    const outside = join(base, "elsewhere.git");
    git(base, "init", "-q", "--bare", outside);
    const borrower = join(root, "rmd-s3-borrower.def456");
    fixtureRepo(join(borrower, "repo"));
    git(join(borrower, "repo"), "remote", "add", "origin", outside); // a path remote outside the tree
    const cash = join(root, "rmd-s5-cash.jkl012");
    fixtureRepo(join(cash, "repo"));
    writeFileSync(join(cash, "openweight-allowance.json"), '{"reservations":{"r1":{"settledUsd":null}}}\n');
    const young = join(root, "rmd-s4-running.ghi789");
    fixtureRepo(join(young, "repo"));
    for (const e of [shard, real, push, borrower, cash]) age(e, 8);
    age(young, 8);
    // Recent work holds the tree while older working files and Git metadata remain intact.
    age(join(young, "repo/dirty.txt"), 2);
    const youngBefore = fileContents(young);

    const report = join(base, "kept.txt");
    const r = spawnSync("bash", [SCRIPT, "--apply"], { encoding: "utf8", env: {
      ...process.env, RMD_RECLAIM_ROOT: root, RMD_RECLAIM_SESSION_ROOT: join(base, "sessions"), RMD_RECLAIM_FREE_PCT: "30",
      RMD_RECLAIM_REPORT: report, RMD_RECLAIM_LSOF: lsof, RMD_RECLAIM_KEEP_FILE: join(base, "keep.txt"),
      RMD_RECLAIM_TSX_FIND: join(bin, "find"), TMPDIR: base, PATH: `${bin}:${process.env.PATH}`,
    } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const kept = existsSync(report) ? readFileSync(report, "utf8") : "";
    assert.equal(existsSync(shard), false, kept + r.stdout);
    for (const p of [real, push, borrower, cash, young]) assert.ok(existsSync(p), p + kept);
    assert.deepEqual(fileContents(push), pushBefore, "network push destination preserves every repository file");
    assert.deepEqual(fileContents(young), youngBefore, "a mixed-age repository keeps every file");
    git(join(young, "repo"), "fsck", "--no-dangling");
    assert.match(kept, /Git checkout\/worktree: .*remudero-pr-1/);
    assert.match(kept, /Git checkout\/worktree: .*rmd-s2-push-network/);
    assert.match(kept, /Git checkout\/worktree: .*rmd-s3-borrower/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
