/**
 * W1-T6123 — THE GIT-LEAF CHECK SEES A cwd-OPTION SPAWN.
 *
 * W1-T6106's ratchet counted only `"-C", <name>` argv whose name was one of seven worktree spellings,
 * so a git spawn that addresses its tree through a `cwd:` option, through an injected helper
 * (`run("git", …)`), or through `-C` under any other name was invisible. The widened count in
 * test/every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.ts sees all three; these
 * cases prove it does, that comments and strings cannot fake a site, and that a new one fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WIDENED_SITE_EXCEPTIONS,
  functionBody,
  readAll,
  widenedGitSites,
  widenedLeafSiteViolations,
} from "./every-host-git-spawn-into-a-worktree-uses-the-hardened-leaf.test.js";

const kinds = (source: string) => widenedGitSites(source).map((site) => `${site.kind}@${site.fn ?? "-"}`);

test("W1-T6123: the widened count sees a planted cwd-option spawn, a helper call and a positional -C", () => {
  const source = [
    'import { execFileSync, spawnSync as ss } from "node:child_process";',
    "export function planted(worktreePath: string, cwd: string, opts: { cwd: string }) {",
    '  spawnSync("git", ["status"], { cwd: worktreePath });',
    '  ss("git", ["status"], { encoding: "utf8", cwd });',
    '  execFileSync("git", ["-C", opts.cwd, "add", "-A"]);',
    '  const argv = ["-C", someNewName, "log"];',
    "}",
    "export function helper(run: (file: string, args: string[]) => string) {",
    '  return run("git", ["diff", "--name-only"]);',
    "}",
  ].join("\n");
  assert.deepEqual(kinds(source), [
    "cwd option@planted",
    "cwd option@planted",
    "-C argv@planted",
    "-C argv@planted",
    "helper@helper",
  ]);
});

test("W1-T6123: comments, strings, primitives in the daemon's cwd and W1-T6106's named sites are not widened sites", () => {
  const source = [
    'import { execFileSync } from "node:child_process";',
    "export function quiet(wt: string) {",
    '  // spawnSync("git", ["-C", dir, "status"], { cwd: dir });',
    '  /* run("git", ["log"], { cwd }) */',
    '  const prose = \'execFileSync("git", ["-C", dir], { cwd: dir })\';',
    '  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });',
    '  execFileSync("git", ["-C", wt, "status"]);',
    '  throw new GitError("git", 1, "message");',
    "}",
    'class GitError extends Error { constructor() { super("git", 1, "x"); } }',
  ].join("\n");
  assert.deepEqual(kinds(source), []);
});

/** Known worktree-addressed sites W1-T6106's named count missed: the shard's three, plus the sweep's
 *  PR-head trees and the worker's `config --worktree` and lane-reaper reads (W1-T6122's builder). */
const KNOWN_WIDENED_SITES: ReadonlyArray<readonly [string, string]> = [
  ["src/lib/worker-provider.ts", "isGitWorktree"],
  ["src/lib/worker-provider.ts", "codexGitWritableRoots"],
  ["src/lib/worker-provider.ts", "selectOpenWeightUnitTestSuites"],
  ["src/lib/sweep.ts", "rebaseDirtyFleetBranchViaGit"],
  ["src/lib/sweep.ts", "renumberPlanPrIds"],
  ["src/lib/worker.ts", "wireCredentialHelperSocket"],
  ["src/lib/worker.ts", "credentialHelperSocketWired"],
  ["src/lib/worker.ts", "laneWorkKeepReason"],
];

test("W1-T6123: the cwd-option git spawns in worker-provider.ts and the known missed worktree sites are counted while unconverted", () => {
  const texts = readAll();
  const missed: string[] = [];
  for (const [file, name] of KNOWN_WIDENED_SITES) {
    const text = texts.get(file) ?? "";
    const body = functionBody(text, name);
    assert.ok(body !== undefined, `${name} not found in ${file}`);
    if (!/["'](?:git|-C)["']/.test(body)) continue; // converted: nothing raw left to see
    if (!widenedGitSites(text).some((site) => site.fn === name)) missed.push(`${file}: ${name}`);
  }
  assert.deepEqual(missed, [], "each spawns git into a worktree but the widened count does not see it");
});

test("W1-T6123: a cwd-option git spawn into a worktree added to a src file fails the census naming that file", () => {
  const texts = readAll();
  const spawn = '\nspawnSync("git", ["status"], { cwd: worktreePath });\n';
  const grown = new Map(texts);
  grown.set("src/lib/worker-provider.ts", `${texts.get("src/lib/worker-provider.ts")}${spawn}`);
  grown.set("src/lib/a-new-file.ts", spawn);
  const found = widenedLeafSiteViolations(grown);
  assert.equal(found.length, 2, found.join("\n"));
  assert.match(found[0]!, /^src\/lib\/a-new-file\.ts: 1 raw git -C\/cwd site\(s\) > 0/);
  const allowed = WIDENED_SITE_EXCEPTIONS["src/lib/worker-provider.ts"]!.count;
  assert.ok(found[1]!.startsWith(`src/lib/worker-provider.ts: ${allowed + 1} raw git -C/cwd site(s) > ${allowed}`), found[1]);
});

test("W1-T6123: a -C argv under a name W1-T6106 never listed fails the census naming its file", () => {
  const grown = new Map(readAll());
  grown.set("src/lib/a-new-file.ts", '\nexecFileSync("git", ["-C", opts.cwd, "commit", "-m", message]);\n');
  assert.deepEqual(widenedLeafSiteViolations(grown), [
    "src/lib/a-new-file.ts: 1 raw git -C/cwd site(s) > 0 — route each through hostWorktreeGit (src/lib/worktree-git.ts) or reason it in WIDENED_SITE_EXCEPTIONS",
  ]);
});
