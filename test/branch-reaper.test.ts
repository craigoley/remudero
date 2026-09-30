import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

import { readNamedInSource } from "../src/lib/branch-reaper.js";
import { reapBranchesCommand } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

function gitGrepFailure(status: number | null, message: string): Error {
  return Object.assign(new Error(message), { status });
}

test("W1-T4205: a git-grep error keeps the branch held", () => {
  const exec = (cmd: string, args: string[]): string => {
    if (cmd === "gh") return args.join(" ").includes("pulls?state=all") ? "stale-topic\tclosed\tfalse\n" : "";
    if (args[0] === "ls-remote") return ["main", "stale-topic"].map((n) => `tip-${n}\trefs/heads/${n}`).join("\n");
    if (args[0] === "for-each-ref") return args.includes("--merged=origin/main")
      ? "origin/main\n"
      : ["main", "stale-topic"].map((n) => `origin/${n}\ttip-${n}\t1`).join("\n");
    if (args[0] === "grep" && args.includes("-F")) throw gitGrepFailure(128, "fatal: pathspec 'deploy/' did not match any files");
    return "";
  };
  const lines: string[] = [];
  const log = mock.method(console, "log", (...a: unknown[]) => { lines.push(a.join(" ")); });
  const err = mock.method(console, "error", (...a: unknown[]) => { lines.push(a.join(" ")); });
  try {
    reapBranchesCommand([], { exec, mergedHeadShaCache: new Map(), root: process.cwd() });
  } finally {
    log.mock.restore();
    err.mock.restore();
  }
  const out = lines.join("\n");
  assert.match(out, /deletable: 0/, "a closed-unmerged head must not be reapable while the source scan failed");
  assert.match(out, /guarded:\s+2/, "every branch stays held when the name scan could not run");
  assert.match(out, /did not match any files/, "the failure is named");

  const named = readNamedInSource(() => { throw gitGrepFailure(null, "spawn git ENOENT"); }, ["a", "b"]);
  assert.deepEqual([...named].sort(), ["a", "b"], "a spawn failure (no exit status) holds every name too");
});

test("W1-T4205: a repo without deploy/ still finds a name under src/", (t) => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}named-src-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const seen: string[][] = [];
  const exec = (_cmd: string, args: string[]): string => {
    seen.push(args);
    if (args.includes("deploy/")) throw gitGrepFailure(128, "fatal: pathspec 'deploy/' did not match any files");
    return "src/lib/where.ts:3:topic-branch\n";
  };
  const named = readNamedInSource(exec, ["topic-branch", "other"], root);
  assert.deepEqual([...named], ["topic-branch"]);
  assert.deepEqual(seen[0]?.slice(seen[0].indexOf("--") + 1), ["src/"], "only the pathspecs that exist are searched");
  assert.equal(readNamedInSource(exec, ["topic-branch"], join(root, "nowhere")).size, 0, "no source roots at all names nothing");
  assert.equal(seen.length, 1, "no grep runs when no source root exists");
});

test("W1-T4205: git grep exit 1 still reads as not named and reports no failure", () => {
  const failures: string[] = [];
  const named = readNamedInSource(() => { throw gitGrepFailure(1, "no match"); }, ["topic"], undefined, (why) => failures.push(why));
  assert.equal(named.size, 0);
  assert.deepEqual(failures, []);
  const reported: string[] = [];
  readNamedInSource(() => { throw gitGrepFailure(128, "boom"); }, ["topic"], undefined, (why) => reported.push(why));
  assert.deepEqual(reported, ["boom"]);
});
