import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {test, type TestContext} from "node:test";
import {gitRepo} from "#test/helpers/git-repo.js";
import {REPO_ROOT} from "#test/helpers/repo-root.js";

const ignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
function fixture(t: TestContext, rules = ignore) {
  const repo = gitRepo({scope: t, seedCommit: false, kind: "root-scratch-ignore"});
  writeFileSync(join(repo.dir, ".gitignore"), rules);
  const check = (paths: string[], noIndex = true) => {
    const result = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore",
      ...(noIndex ? ["--no-index"] : []), "--stdin"], {cwd: repo.dir, encoding: "utf8", timeout: 5000,
      env: {...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null"},
      input: paths.join("\n") + "\n"});
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
  };
  return {...repo, check};
}

test("the approved root scratch directory is ignored by real Git without deleting its contents", t => {
  const repo = fixture(t);
  mkdirSync(join(repo.dir, ".tmp-w"));
  const payload = join(repo.dir, ".tmp-w", "unpublished.ts");
  writeFileSync(payload, "preserve private fixture content\n");
  assert.deepEqual(repo.check(["node_modules/control.js", ".tmp-w/unpublished.ts"]),
    ["node_modules/control.js", ".tmp-w/unpublished.ts"]);
  assert.equal(readFileSync(payload, "utf8"), "preserve private fixture content\n");
});

test("the scratch ignore excludes neither nested names nor a root file with the same name", t => {
  const repo = fixture(t);
  writeFileSync(join(repo.dir, ".tmp-w"), "a file, not the scratch directory\n");
  assert.deepEqual(repo.check(["nested/.tmp-w/source.ts", ".tmp-w-keep/source.ts", ".tmp-w"]), []);
});

test("the scratch ignore leaves already tracked source in the Git index and on disk", t => {
  const repo = fixture(t);
  mkdirSync(join(repo.dir, ".tmp-w"));
  const payload = join(repo.dir, ".tmp-w", "tracked.ts");
  writeFileSync(payload, "tracked private fixture source\n");
  repo.git("add", "-f", "--", ".tmp-w/tracked.ts");
  assert.equal(repo.git("ls-files", "--", ".tmp-w/tracked.ts"), ".tmp-w/tracked.ts");
  assert.deepEqual(repo.check([".tmp-w/tracked.ts"], false), []);
  assert.equal(readFileSync(payload, "utf8"), "tracked private fixture source\n");
});
