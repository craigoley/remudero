/**
 * W1-T6106 — EVERY HOST GIT SPAWN INTO A WORKER WORKTREE USES THE HARDENED LEAF.
 *
 * `hostWorktreeGit` (src/lib/worktree-git.ts) is the one way host code may run git with a worker
 * worktree as its repository: it pins the gitdir and disables code-executing config, so the
 * worktree's `.git` pointer and tracked hooks/ never run. Two checks hold that in place:
 *
 *   1. THE CONVERTED SITES — each function named in LEAF_SITES calls the leaf and spawns no raw git.
 *   2. THE RATCHET — a raw `"-C", <worktree-named target>` argv in src/ is counted per file against
 *      RAW_SITE_EXCEPTIONS, each with its reason. A new one in any file (a new file starts at zero)
 *      fails naming that file; converting one fails until its exception is lowered, so the list stays
 *      exact and only ever shrinks.
 *
 * The walk is the filesystem under src/, so a file not yet committed is counted too.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** A `-C` argv element naming a worker worktree by any of the names host code gives one. */
const WORKTREE_TARGET = /"-C",\s*(?:wt|worktreePath|[A-Za-z_$][\w$]*\.worktreePath|worktreeRoot|batchWorktree|ownerPath)\b/g;
const RAW_GIT_SPAWN = /\b(?:execFileSync|execFile|execFilePromise|spawnSync|spawn)\(\s*"git"/;
const LEAF_CALL = /\bhostWorktreeGit(?:Async)?\(|\bworktreeGitCapture(?:Async)?\(|\bworktreePushExec(?:Async)?\(/;

/** The sites W1-T6106 converted; each must reach the leaf and spawn no raw git of its own. */
const LEAF_SITES: ReadonlyArray<readonly [string, string]> = [
  ["src/lib/git-push.ts", "gitPushRunBranch"],
  ["src/lib/git-push.ts", "gitPushRunBranchAsync"],
  ["src/lib/git-push.ts", "worktreeGitCapture"],
  ["src/lib/git-push.ts", "worktreeGitCaptureAsync"],
  ["src/lib/git-push.ts", "worktreePushExec"],
  ["src/lib/git-push.ts", "worktreePushExecAsync"],
  ["src/run-task.ts", "commitWorkerEdits"],
  ["src/run-task.ts", "appendTaskTrailerToCommit"],
  ["src/run-task.ts", "irreversibleSignalForWorktree"],
  ["src/run-task.ts", "pushFixRound"],
  ["src/lib/worker.ts", "stampRunWorktreeAssignment"],
  // W1-T6122: the WORKER/REVIEWER sites outside run-task.ts.
  ["src/lib/worker.ts", "excludeNodeModulesFromGit"],
  ["src/lib/sweep.ts", "headIsInWorktree"],
  ["src/lib/sweep.ts", "readBaselineRatchetWorktreeState"],
  ["src/lib/retro.ts", "defaultFreshShardTextReader"],
  ["src/lib/retro.ts", "stampCitationsAndCommit"],
  ["src/lib/orientation.ts", "regenerateOrientation"],
  ["src/lib/relint.ts", "newMonolithIdsAgainstBase"],
  ["src/lib/composition-root.ts", "realReviewWorktree"],
  ["src/lib/review-worktree-reclaim.ts", "defaultReadHeadSha"],
];

/**
 * Raw `-C <worktree>` argv still in src/, per file, and why. SEAM ARGV is argv a step builds for an
 * injectable `capture`/`exec` whose DEFAULT strips the `-C` and runs it through the leaf. Everything
 * else is a site W1-T6106 has not converted yet: named here so the remaining exposure is a list, not a
 * guess, and so it can only shrink.
 */
const RAW_SITE_EXCEPTIONS: Readonly<Record<string, { count: number; reason: string }>> = {
  "src/lib/git-push.ts": { count: 4, reason: "seam argv: pushRunBranchSteps/leasedForcePushSteps; the defaults run it through the leaf" },
  "src/run-task.ts": {
    count: 75,
    reason:
      "2 seam argv in pushFixRound (its exec/capture default to the leaf); the rest NOT YET CONVERTED — " +
      "runPlanScopedFixRound, commitGeneratorOutputViaGit, buildProofAmendmentGitOps, " +
      "captureWorktreeSnapshotViaGit, preserveTrackedDirtyPatch, inspectFreshReviewerWorktree and the " +
      "worktree reads around them",
  },
  "src/lib/worker.ts": {
    count: 9,
    reason:
      "HARNESS (W1-T6122): worktreeAdd 3 + worktreeAddAsync 6 cut and wire the tree before any worker runs; " +
      "they read the gitdir the leaf later pins to, so they must precede it",
  },
  "src/lib/sweep.ts": {
    count: 7,
    reason:
      "HARNESS (W1-T6122): the refusal-amendment 4 and plan-repair 3 commits run in trees worktreeAdd cut " +
      "from origin/main that only the sweep writes; they keep main's own commit hooks",
  },
};

function srcFiles(dir = join(REPO, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relative(REPO, path)] : [];
  });
}

/** The text of top-level function `name` in `source`: its declaration to the first column-0 `}`. */
function functionBody(source: string, name: string): string | undefined {
  const at = new RegExp(`^(?:export )?(?:async )?function\\*? ${name}\\(`, "m").exec(source);
  if (!at) return undefined;
  const end = source.indexOf("\n}\n", at.index);
  return source.slice(at.index, end < 0 ? undefined : end);
}

/** Every file whose raw `-C <worktree>` count differs from its exception, with both numbers. */
function rawLeafSiteViolations(texts: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of texts) {
    const actual = text.match(WORKTREE_TARGET)?.length ?? 0;
    const allowed = RAW_SITE_EXCEPTIONS[file]?.count ?? 0;
    if (actual > allowed) {
      out.push(`${file}: ${actual} raw git -C <worktree> spawn(s) > ${allowed} — route each through hostWorktreeGit (src/lib/worktree-git.ts)`);
    } else if (actual < allowed) {
      out.push(`${file}: ${actual} raw git -C <worktree> spawn(s) < exception ${allowed} — lower RAW_SITE_EXCEPTIONS to ${actual}`);
    }
  }
  return out.sort();
}

function readAll(): Map<string, string> {
  return new Map(srcFiles().map((file) => [file, readFileSync(join(REPO, file), "utf8")]));
}

test("W1-T6106: every converted host git site calls the hardened leaf and spawns no raw git", () => {
  const texts = readAll();
  assert.ok(texts.size > 400, `the walk must see the src/ population, saw ${texts.size} file(s)`);
  assert.match(texts.get("src/lib/worktree-git.ts") ?? "", /^export function hostWorktreeGit\(/m, "the leaf exists");
  const failures: string[] = [];
  for (const [file, name] of LEAF_SITES) {
    const body = functionBody(texts.get(file) ?? "", name);
    if (body === undefined) failures.push(`${file}: ${name} not found`);
    else if (!LEAF_CALL.test(body)) failures.push(`${file}: ${name} does not call the hardened leaf`);
    else if (RAW_GIT_SPAWN.test(body)) failures.push(`${file}: ${name} still spawns git directly`);
  }
  assert.deepEqual(failures, []);
});

test("W1-T6106: no src file holds a raw git -C <worktree> spawn beyond its reasoned exception", () => {
  const texts = readAll();
  const counted = [...texts.values()].reduce((n, text) => n + (text.match(WORKTREE_TARGET)?.length ?? 0), 0);
  assert.ok(counted >= 50, `positive control: the pattern must find the known raw sites, found ${counted}`);
  for (const file of Object.keys(RAW_SITE_EXCEPTIONS)) assert.ok(texts.has(file), `exception names a missing file: ${file}`);
  assert.deepEqual(rawLeafSiteViolations(texts), []);
});

test("W1-T6106: a raw git -C spawn into a worktree added to src fails the census naming its file", () => {
  const texts = readAll();
  const spawn = '\nexecFileSync("git", ["-C", worktreePath, "status"], { encoding: "utf8" });\n';
  const grown = new Map(texts);
  grown.set("src/lib/sweep.ts", `${texts.get("src/lib/sweep.ts")}${spawn}`);
  grown.set("src/lib/a-new-file.ts", spawn);
  const found = rawLeafSiteViolations(grown);
  assert.equal(found.length, 2, found.join("\n"));
  assert.match(found[0]!, /^src\/lib\/a-new-file\.ts: 1 raw git -C <worktree> spawn\(s\) > 0/);
  assert.ok(found[1]!.startsWith(`src/lib/sweep.ts: ${RAW_SITE_EXCEPTIONS["src/lib/sweep.ts"]!.count + 1} raw git -C <worktree> spawn(s) > `), found[1]);
});
