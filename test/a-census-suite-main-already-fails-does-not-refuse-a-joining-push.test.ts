import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore executable mjs has no declaration file.
import * as precheck from "../scripts/census-precheck.mjs";

const PROOF = "test/a-census-suite-main-already-fails-does-not-refuse-a-joining-push.test.ts";
const MEMBER = { testFile: "test/population.test.ts", script: "census:population", walks: ["population/"] };
const SUITE = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
test("population is healthy", () => assert.equal(readFileSync("population/value", "utf8"), "healthy"));
`;

function fixture(base = "unhealthy", suiteAtBase = true) {
  const repo = gitRepo({ kind: "census-base-comparison" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), text);
  };
  write("population/value", base);
  if (suiteAtBase) write(MEMBER.testFile, SUITE);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base census");
  repo.git("switch", "--quiet", "-c", "work");
  write("population/value", "unhealthy");
  write("population/joining", "new member");
  write(MEMBER.testFile, SUITE);
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "joining population");
  return repo;
}

test(`${PROOF}: injected runSuites passes both-red, refuses head-only red, and exits 2 for an unrunnable base`, (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.join(" ")));
  t.mock.method(console, "log", () => {});
  for (const [baseResult, expected] of [["red", 0], ["green", 1], ["unrunnable", 2]] as const) {
    const repo = fixture();
    const before = repo.git("worktree", "list", "--porcelain");
    const calls: { root: string; files: string[] }[] = [];
    errors.length = 0;
    const result = precheck.main(["--root", repo.dir, "--base", "main"], {
      admitted: () => [MEMBER],
      runSuites: ({ root, files }: { root: string; files: string[] }) => {
        calls.push({ root, files });
        if (root === repo.dir) return files;
        assert.equal(readFileSync(join(root, "population/value"), "utf8"), "unhealthy");
        assert.equal(existsSync(join(root, "population/joining")), false);
        assert.ok(existsSync(join(root, "node_modules/tsx")));
        if (baseResult === "unrunnable") throw new Error("base loader unavailable");
        return baseResult === "red" ? files : [];
      },
    });
    assert.equal(result, expected, errors.join("\n"));
    assert.equal(calls.length, 2, "one head run, then one base run of the failing suites");
    assert.deepEqual(calls.map((c) => c.files), [[MEMBER.testFile], [MEMBER.testFile]]);
    assert.notEqual(calls[1].root, repo.dir);
    assert.equal(existsSync(calls[1].root), false, "temporary base tree is removed on every outcome");
    assert.equal(repo.git("worktree", "list", "--porcelain"), before);
    if (expected === 1) assert.ok(errors.some((e) => e.includes(`census-suite: ${MEMBER.testFile} fails`)));
    if (expected === 2) assert.ok(errors.some((e) => /NOT MEASURED.*base loader unavailable/.test(e)));
  }
});

test(`${PROOF}: a green head never creates or runs a base tree`, (t) => {
  t.mock.method(console, "log", () => {});
  const repo = fixture();
  let runs = 0;
  assert.equal(precheck.main(["--root", repo.dir, "--base", "main"], {
    admitted: () => [MEMBER],
    runSuites: ({ root }: { root: string }) => {
      assert.equal(root, repo.dir);
      runs++;
      return [];
    },
  }), 0);
  assert.equal(runs, 1);
});

test(`${PROOF}: the real child compares both trees and treats a missing base suite as not measured`, (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.join(" ")));
  t.mock.method(console, "log", () => {});
  for (const [base, suiteAtBase, expected] of [["unhealthy", true, 0], ["healthy", true, 1], ["healthy", false, 2]] as const) {
    const repo = fixture(base, suiteAtBase);
    const before = repo.git("worktree", "list", "--porcelain");
    errors.length = 0;
    assert.equal(precheck.main(["--root", repo.dir, "--base", "main"], { admitted: () => [MEMBER] }), expected, errors.join("\n"));
    assert.equal(repo.git("worktree", "list", "--porcelain"), before);
    if (expected === 2) assert.ok(errors.some((e) => /NOT MEASURED/.test(e)), errors.join("\n"));
  }
});
