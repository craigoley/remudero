import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function commit(repo: GitRepo, message: string): string {
  repo.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "-m", message);
  const sha = repo.git("rev-parse", "HEAD");
  repo.git("update-ref", "refs/remotes/origin/main", sha);
  return sha;
}

function check(repo: GitRepo, ...args: string[]) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/task-shipped.mjs"), ...args], {
    cwd: repo.dir,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

test("W1-T9742: a trailer reads shipped and a filing subject does not", (t) => {
  const repo = gitRepo({ scope: t });
  const shipped = commit(repo, "fix(scope): ship behavior (#123)\n\nRemudero-Task:\tW1-T9619 \t");
  const filing = commit(repo, "chore(plan): file W1-T9742 (#124)");
  const timestamp = Number(repo.git("show", "-s", "--format=%ct", filing));
  const before = Math.floor(Date.now() / 1000) - timestamp;
  const result = check(repo, "W1-T9619");
  const after = Math.floor(Date.now() / 1000) - timestamp;
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stdout, /^shipped: W1-T9619$/m);
  assert.ok(result.stdout.includes(`shipped commit: ${shipped}`));
  assert.ok(result.stdout.includes(`origin/main: ${filing}`));
  assert.match(result.stdout, /^age_seconds: \d+ \(committed .+\)$/m);
  const age = Number(result.stdout.match(/^age_seconds: (\d+)/m)![1]);
  assert.ok(age >= before && age <= after);
  assert.ok(result.stdout.includes(`(committed ${new Date(timestamp * 1000).toISOString()})`));
  assert.ok(result.stdout.includes(`positive control: W1-T9619 at ${shipped}`));

  const named = check(repo, "W1-T9742");
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /^not shipped: W1-T9742$/m);
  assert.ok(named.stdout.includes(`named only: ${filing} chore(plan): file W1-T9742`));
  assert.match(named.stdout, /run-W1-T9742-\*.*merged with no trailer.*not visible/);
  assert.match(named.stdout, /--paginate/);
  assert.match(named.stdout, /\.merged_at!=null/);
  assert.ok(named.stdout.includes('startswith("run-W1-T9742-")'));
});

test("W1-T9742: a failed positive control answers unmeasured, never not shipped", (t) => {
  const repo = gitRepo({ scope: t });
  commit(repo, "chore(plan): file W1-T9742");
  const result = check(repo, "W1-T9742");
  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stdout, /^unmeasured:.*no trailer.*positive control/m);
  assert.doesNotMatch(result.stdout, /^not shipped:/m);

  repo.git("update-ref", "-d", "refs/remotes/origin/main");
  const missing = check(repo, "W1-T9742");
  assert.equal(missing.status, 3, missing.stderr);
  assert.match(missing.stdout, /^unmeasured:.*origin\/main/m);
  assert.doesNotMatch(missing.stdout, /^not shipped:/m);
});

test("W1-T9742: trailers match whole physical lines and exact ids", (t) => {
  const repo = gitRepo({ scope: t });
  commit(repo, "fix(scope): control\n\nRemudero-Task: W1-T9");
  commit(repo, "fix(scope): misleading mentions\n\nRemudero-Task: W1-T97420\n" +
    "quoted Remudero-Task: W1-T9742\n Remudero-Task: W1-T9742\n" +
    "Remudero-Task: W1-T9742 extra\nRemudero-Task:\nW1-T9742");
  const result = check(repo, "W1-T9742");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^not shipped: W1-T9742$/m);
  assert.doesNotMatch(result.stdout, /^named only:/m);
});

test("W1-T9742: the local scan finds old trailers and reports every matching commit", (t) => {
  const repo = gitRepo({ scope: t });
  const first = commit(repo, "fix(scope): first shipment\n\nRemudero-Task: W1-T9742");
  for (let i = 0; i < 101; i += 1) commit(repo, `chore(scope): unrelated ${i}`);
  const second = commit(repo, "fix(scope): second shipment\n\nRemudero-Task: W1-T9742");
  const head = commit(repo, "fix(scope): newest control\n\nRemudero-Task: W1-T10");
  repo.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "-m",
    "fix(scope): local unshipped work\n\nRemudero-Task: W1-T11");
  const result = check(repo, "W1-T9742");
  assert.equal(result.status, 4, result.stderr);
  assert.ok(result.stdout.includes(`shipped commit: ${first}`));
  assert.ok(result.stdout.includes(`shipped commit: ${second}`));
  assert.ok(result.stdout.includes(`positive control: W1-T10 at ${head}`));
  const localOnly = check(repo, "W1-T11");
  assert.equal(localOnly.status, 0, localOnly.stderr);
  assert.ok(localOnly.stdout.includes(`origin/main: ${head}`));
});

test("W1-T9742: invalid arguments cannot report a measured zero", (t) => {
  const repo = gitRepo({ scope: t });
  for (const args of [[], ["W1-T9742", "extra"], ["W1-T.*"], ["--help"]]) {
    const result = check(repo, ...args);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stdout, /^unmeasured:.*usage/m);
    assert.doesNotMatch(result.stdout, /^not shipped:/m);
  }
});
