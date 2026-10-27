import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { gitRepo } from "./helpers/git-repo.js";
// @ts-ignore executable module without declarations
import { main, runCensusSuitesViaChild } from "../scripts/census-precheck.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MEMBER = { testFile: "test/population.test.ts", script: "census:population", walks: ["lib/"] };
const SKILL = "test/rules/every-applies-to-skill-is-selectable-and-bounded.test.ts";

function fixture(baseCount = 1) {
  const repo = gitRepo({ kind: "census-private-base" });
  const write = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), data);
  };
  write("src/lib/ci-parity.ts", `export const CENSUS_ADMITTED_MEMBERS = ${JSON.stringify([MEMBER])};\n`);
  write(MEMBER.testFile, [
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'import { test } from "node:test";',
    'test("population stays within its ceiling", () => {',
    '  assert.ok(JSON.parse(readFileSync("lib/population.json", "utf8")).length <= 1);',
    '});',
  ].join("\n"));
  // The always-on skill census joins every nonempty diff, so the base carries a healthy stand-in for it.
  write(SKILL, 'import { test } from "node:test";\ntest("skill census stand-in", () => undefined);\n');
  write("lib/population.json", JSON.stringify(Array(baseCount).fill("item")));
  write(".gitattributes", "lib/ignored.bin export-ignore\nlib/subst.txt export-subst\n");
  write("lib/ignored.bin", Buffer.from([0, 255, 10, 128]));
  write("lib/subst.txt", "$Format:%H$\n");
  write("lib/nested/space name.txt", "base bytes\r\n");
  write("lib/empty", "");
  write("lib/executable", "#!/bin/sh\nexit 0\n");
  chmodSync(join(repo.dir, "lib/executable"), 0o755);
  symlinkSync("nested/space name.txt", join(repo.dir, "lib/link"));
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "base population");
  repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
  repo.git("switch", "--quiet", "-c", "work");
  write("lib/population.json", JSON.stringify(["item", "growth"]));
  write("lib/nested/space name.txt", "head bytes\n");
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", "grow population");
  return repo;
}

function cli(root: string) {
  return spawnSync(process.execPath, [join(ROOT, "scripts/census-precheck.mjs"), "--root", root, "--base", "main"], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GIT_|NODE_TEST_CONTEXT$|RMD_CENSUS_SNAPSHOT$)/.test(key))),
  });
}

test("W1-T9740: census-precheck measures its base with a read-only common dir", {
  skip: process.getuid?.() === 0 ? "root bypasses chmod write denial" : false,
}, () => {
  const repo = fixture();
  const common = join(repo.dir, ".git");
  try {
    execFileSync("chmod", ["-R", "a-w", common]);
    assert.throws(() => writeFileSync(join(common, "permission-control"), "must fail"), { code: "EACCES" });
    const result = cli(repo.dir);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /census-suite: test\/population.test.ts fails/);
    assert.doesNotMatch(result.stderr, /NOT MEASURED/);
    writeFileSync(join(repo.dir, "lib/population.json"), '["item"]');
    const clean = cli(repo.dir);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /census-precheck: OK/);
  } finally {
    execFileSync("chmod", ["-R", "u+w", common]);
    repo.cleanup();
  }
});

function tree(root: string, prefix = ""): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  for (const name of readdirSync(join(root, prefix)).sort()) {
    if (!prefix && [".git", "node_modules"].includes(name)) continue;
    const path = join(prefix, name);
    const stat = lstatSync(join(root, path));
    entries[path] = stat.isSymbolicLink() ? { link: readlinkSync(join(root, path)) }
      : stat.isDirectory() ? tree(root, path)
      : { bytes: readFileSync(join(root, path)).toString("hex"), executable: (stat.mode & 0o111) !== 0 };
  }
  return entries;
}

test("W1-T9740: the base tree equals a worktree checkout of the merge base", () => {
  const repo = fixture();
  const expectedRoot = join(repo.dir, "expected");
  let measuredRoot: string | undefined;
  try {
    repo.addWorktree(expectedRoot, "expected-base", "main");
    const commonEntries = readdirSync(join(repo.dir, ".git/worktrees")).sort();
    const originalIndex = readFileSync(join(repo.dir, ".git/index"));
    let runs = 0;
    const status = main(["--root", repo.dir, "--base", "main"], {
      admitted: () => [MEMBER],
      runSuites: ({ root, files }: { root: string; files: string[] }) => {
        runs++;
        if (root === repo.dir) {
          // The head run is the member plus the always-on skill census; only the member is red.
          assert.deepEqual([...files].sort(), [MEMBER.testFile, SKILL].sort());
          return [MEMBER.testFile];
        }
        assert.deepEqual(files, [MEMBER.testFile]);
        measuredRoot = root;
        assert.deepEqual(tree(root), tree(expectedRoot));
        assert.equal(readlinkSync(join(root, "node_modules")), join(ROOT, "node_modules"));
        assert.equal(repo.git("-C", root, "diff", "--cached", "--exit-code", "HEAD"), "");
        assert.equal(repo.git("-C", root, "rev-parse", "HEAD"), repo.git("rev-parse", "main"));
        assert.equal(repo.git("-C", root, "rev-parse", "origin/main"), repo.git("rev-parse", "main"));
        assert.deepEqual(readdirSync(join(repo.dir, ".git/worktrees")).sort(), commonEntries);
        return [];
      },
    });
    assert.equal(status, 1);
    assert.equal(runs, 2);
    assert.ok(measuredRoot, "the base runner must be reached");
    assert.equal(existsSync(dirname(measuredRoot)), false, "remove the entire temporary base");
    assert.deepEqual(readFileSync(join(repo.dir, ".git/index")), originalIndex);
  } finally {
    repo.git("worktree", "remove", "--force", expectedRoot);
    repo.cleanup();
  }
});

test("a census already red at the base stays excused, and a missing base object stays not measured", (t) => {
  const repo = fixture(2);
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.join(" ")));
  try {
    assert.equal(main(["--root", repo.dir, "--base", "main"]), 0, errors.join("\n"));
    const baseTree = repo.git("rev-parse", "main^{tree}");
    assert.equal(main(["--root", repo.dir, "--base", "main"], {
      runSuites: (input: { root: string; files: string[] }) => {
        const failing = runCensusSuitesViaChild(input);
        if (input.root === repo.dir) rmSync(join(repo.dir, ".git/objects", baseTree.slice(0, 2), baseTree.slice(2)));
        return failing;
      },
    }), 2);
    assert.match(errors.join("\n"), /census suites NOT MEASURED - merge-base census run could not be measured:/);
    assert.match(errors.join("\n"), /(?:tree|object)/);
  } finally {
    repo.cleanup();
  }
});
