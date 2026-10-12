// The branch reaper asks whether each remote branch name appears in source. `git grep -F` with one
// `-e` per name cost 12 s of CPU for 224 names on 2026-10-12, every few minutes; one longest-first
// `-P` alternation gives the same hits in 0.2 s.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { namedInSourcePatterns, readNamedInSource } from "../src/lib/branch-reaper.js";
import { gitRepo } from "./helpers/git-repo.js";

const NAMES = ["heartbeat", "heartbeat-azure", "diag/drain.x", "a.b", "c+d", "absent-name", "main"];

function fixture(t: test.TestContext): string {
  const repo = gitRepo({ kind: "named-in-source" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "scripts"));
  writeFileSync(join(repo.dir, "src", "one.ts"), "const b = 'heartbeat-azure';\nconst p = 'diag/drain.x';\nconst q = 'aXb';\n");
  writeFileSync(join(repo.dir, "scripts", "two.mjs"), "// c+d and main\n");
  repo.git("add", "src/one.ts", "scripts/two.mjs");
  return repo.dir;
}

function realGit(root: string, seen: string[][]): (cmd: string, args: string[]) => string {
  return (cmd, args) => {
    seen.push(args);
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8" });
  };
}

test("the branch reaper scans every name in one PCRE pass and finds what the per-name scan finds", (t) => {
  const root = fixture(t);
  const seen: string[][] = [];
  const named = readNamedInSource(realGit(root, seen), NAMES, root);
  assert.deepEqual([...named].sort(), ["c+d", "diag/drain.x", "heartbeat", "heartbeat-azure", "main"]);
  assert.equal(seen.length, 1, "one git call for every name");
  assert.ok(seen[0].includes("-P"), "the scan is one PCRE alternation");
  assert.equal(seen[0].filter((arg) => arg === "-e").length, 1, "never one -e per name");

  const fixed = execFileSync("git", ["grep", "-n", "-o", "-F", ...NAMES.flatMap((n) => ["-e", n]), "--", "src/", "scripts/"], { cwd: root, encoding: "utf8" });
  const pcre = execFileSync("git", ["grep", "-n", "-o", "-P", "-e", namedInSourcePatterns(NAMES)[0], "--", "src/", "scripts/"], { cwd: root, encoding: "utf8" });
  assert.equal(pcre, fixed, "the longest-first alternation hits exactly what -F hits");
});

test("the branch reaper falls back to the -F scan when git has no PCRE", (t) => {
  const root = fixture(t);
  const seen: string[][] = [];
  const git = realGit(root, seen);
  const failures: string[] = [];
  const named = readNamedInSource((cmd, args) => {
    if (args.includes("-P")) {
      seen.push(args);
      throw Object.assign(new Error("fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE"), { status: 128 });
    }
    return git(cmd, args);
  }, NAMES, root, (why) => failures.push(why));
  assert.deepEqual([...named].sort(), ["c+d", "diag/drain.x", "heartbeat", "heartbeat-azure", "main"]);
  assert.deepEqual(failures, [], "a missing PCRE is not a scan failure");
  assert.ok(seen.at(-1)?.includes("-F"), "the retry is the fixed-string scan");
});

test("the branch reaper's PCRE patterns stay under one argument's limit and keep every name once, longest first", () => {
  const names = Array.from({ length: 3000 }, (_, i) => `run-W1-T${i}-${"9".repeat(13)}${i % 7 === 0 ? "-x.y" : ""}`);
  const patterns = namedInSourcePatterns([...names, names[0]]);
  assert.ok(patterns.length > 1, "a long list splits");
  for (const pattern of patterns) assert.ok(pattern.length <= 64 * 1024, "each pattern fits one argv string");
  const parts = patterns.flatMap((pattern) => pattern.split("|")).map((part) => part.replace(/\\(.)/g, "$1"));
  assert.deepEqual([...parts].sort(), [...names].sort(), "every name exactly once");
  for (let i = 1; i < parts.length; i++) assert.ok(parts[i - 1].length >= parts[i].length, "longest first");
});

test("a branch name outside printable ASCII keeps the -F scan", (t) => {
  const root = fixture(t);
  const seen: string[][] = [];
  readNamedInSource(realGit(root, seen), ["heartbeat", "café"], root);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes("-F") && !seen[0].includes("-P"));
});
