#!/usr/bin/env node
// scripts/worker-branch-shape.mjs
//
// THE HABITUAL BRANCH-SHAPE GATE (W1-T2491).
//
// `run-<taskId>-<epochMs>` is how an in-flight task becomes visible to dispatch
// (`taskIdFromRunBranch`/`ownsBranch`, src/lib/status.ts) and how a merge is credited when the
// `Remudero-Task:` trailer is missing (`findMergedByHeadBranch`) — SEVEN modules read this shape
// and, until this task, NOTHING refused a branch that failed to carry it. 52 of 143 remote heads
// (measured at filing) do not match it, but most of those are legitimately outside the
// convention — `main`, `heartbeat-mini`, diagnostics, an operator's own scratch branches — and a
// gate that reddened all of them would be measuring the wrong population.
//
// WHAT IS ACTUALLY CHECKABLE, AND ALL THIS GATE CHECKS: a branch that CLAIMS a task — by an
// anchored `Remudero-Task: <id>` trailer on any commit IT ADDS since it diverged from base (never
// the tip alone — see `commitMessagesSinceBase` — so a `wip:` checkpoint's trailer is seen exactly
// like the final commit's), or by DECLARING a shard (a new `plan/tasks.d/*.yaml` filing an
// `- id: <id>` record) in its own diff — must carry the `run-<id>-<epochMs>` shape that makes that
// claim visible to the readers above. A branch that claims no task is never refused, whatever its
// name — that is the population W1-T447's own (separate) dry-run sweep owns, not this gate.
//
// REPORTS BEFORE IT REFUSES (rationale, same reasoning W1-T2487 states for its own standing
// population): this gate only ever judges a NEW claim made on THIS run — it never re-litigates a
// branch that already exists on origin, and it carries no list of the standing 52. An operator
// disposes of those at their own pace (W1-T447); what this gate owns is that no NEW one joins them.
//
// NOT IN SCOPE: renaming or deleting any existing branch (W1-T447); changing how `projectPlan` or
// `findMergedByHeadBranch` attribute (untouched, not imported, not re-implemented here — this gate
// restates the SAME `run-<taskId>-<epochMs>` shape as its own literal regex rather than importing
// `src/lib/status.ts`, so a plain `node` invocation carries no `tsx`/TypeScript dependency); and
// the trailer convention itself.
//
// NO NETWORK, NO TEST RUNNER (FAST_GATE_STEPS admission criterion, src/lib/ci-parity.ts): every
// read below is a local `git` invocation (head ref, the new commits' messages, the diff's added
// files) or a local `fs.readFileSync` of a file already present in the checked-out worktree —
// nothing here shells `gh`, opens a socket, or spawns `node --test`/a test runner of any kind.
//
// Usage (habitual, wired as `worker-branch-shape:check` in package.json / FAST_GATE_STEPS):
//   node scripts/worker-branch-shape.mjs [--base <ref>] [--head-ref <ref>]
//   --base defaults to "origin/main" and, if it cannot be resolved locally (no fetch is ever
//   attempted), the added-files/shard-declaration limb is silently skipped rather than failing the
//   whole gate — a checkout with no local origin/main ref is a setup gap, not a branch-shape one.
//   --head-ref defaults to $GITHUB_HEAD_REF, falling back to the worktree's own current branch
//   (`git rev-parse --abbrev-ref HEAD`) so a local `npm run --silent worker-branch-shape:check`
//   judges the branch actually checked out, exactly like every other FAST_GATE_STEPS entry.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** Escape `s` for literal use inside a `RegExp` — the same escaping `src/lib/status.ts`'s own
 *  `escapeRegExp` performs, restated here (design note above) rather than imported. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `head` carry the EXACT `run-<taskId>-<epochMs>` shape dispatch and merge-credit read —
 * `src/lib/status.ts`'s `ownsBranch`/`taskIdFromRunBranch` pattern (`/^run-<id>-\d+$/`),
 * restated verbatim so this gate needs no import from that module (see the file banner). This is
 * ALWAYS asked against one SPECIFIC claimed id — it never tests "is this a run-shaped branch for
 * some id", the looser question `isDispatchedRunBranch` (src/run-task.ts) answers.
 * @param {string | undefined} head
 * @param {string} taskId
 */
export function matchesRunBranchShape(head, taskId) {
  if (!head) return false;
  return new RegExp(`^run-${escapeRegExp(taskId)}-\\d+$`).test(head);
}

const TRAILER_RE = /^Remudero-Task:[ \t]*([A-Za-z0-9-]+)[ \t]*$/gm;

/**
 * Every anchored `Remudero-Task: <id>` trailer id found in `commitMessages` — the same trailer
 * shape `creditsByAnchoredTrailer`/`appendTaskTrailerToCommit` already read and write. `g`-scanned
 * so a range of SEVERAL commits (this branch's own new work — see {@link commitMessagesSinceBase})
 * concatenated into one string still yields every distinct id any one of them trailers, never only
 * the first.
 * @param {string | undefined} commitMessages
 */
export function trailerTaskIds(commitMessages) {
  const ids = [];
  for (const m of (commitMessages ?? "").matchAll(TRAILER_RE)) ids.push(m[1]);
  return ids;
}

const SHARD_FILE_RE = /^plan\/tasks\.d\/.+\.ya?ml$/;
const SHARD_ID_RE = /^\s*-\s*id:\s*([A-Za-z0-9-]+)\s*$/m;

/**
 * Which task id(s) does a NEWLY ADDED `plan/tasks.d/*.yaml` file declare, by filing an `- id:
 * <id>` shard record — the "declaring a shard in its diff" claim form the rationale names
 * alongside the trailer? `addedFiles` is the diff's own added-path list (never a full walk of
 * `plan/tasks.d/`, so an UNCHANGED shard from before this branch existed is never re-claimed by
 * it); `readFile` is injected so this stays synchronous and offline (production reads the
 * worktree's own checked-out copy — see {@link main}).
 * @param {readonly string[]} addedFiles
 * @param {(path: string) => string | undefined} readFile
 */
export function shardTaskIds(addedFiles, readFile) {
  const ids = [];
  for (const file of addedFiles) {
    if (!SHARD_FILE_RE.test(file)) continue;
    const text = readFile(file);
    const m = text === undefined ? null : SHARD_ID_RE.exec(text);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/**
 * The full set of task ids THIS branch claims, by either accepted form (rationale: "by a
 * `Remudero-Task:` trailer or by declaring a shard in its diff") — a union, never a preference of
 * one form over the other, and de-duplicated so a branch claiming the same id both ways is judged
 * once. `commitMessages` is the text of every commit THIS branch adds since it diverged from
 * base (see {@link commitMessagesSinceBase}) — never just the tip — so a trailer written on an
 * earlier `wip:` checkpoint is seen exactly like one on the final commit.
 * @param {{ commitMessages: string | undefined, addedFiles: readonly string[], readFile: (path: string) => string | undefined }} input
 */
export function claimedTaskIds({ commitMessages, addedFiles, readFile }) {
  const ids = new Set();
  for (const id of trailerTaskIds(commitMessages)) ids.add(id);
  for (const id of shardTaskIds(addedFiles, readFile)) ids.add(id);
  return [...ids];
}

/**
 * THE GATE'S OWN PREDICATE. A branch that claims NO task (empty {@link claimedTaskIds}) always
 * passes, whatever its name — dropping THIS condition and asking {@link matchesRunBranchShape}
 * unconditionally would fail every innocent branch in the repo (`main`, `heartbeat-mini`, an
 * operator's own scratch branch), which is exactly the wrong-population failure the rationale
 * warns against; `test/a-worker-branch-must-be-shaped-for-dispatch.test.ts` pins this directly.
 * A branch that claims one or more ids is refused the moment ANY claimed id fails
 * {@link matchesRunBranchShape} against the actual head ref — the refusal message NAMES the shape
 * dispatch expects (`run-<taskId>-<epochMs>`) rather than a bare rejection.
 * @param {{ headRef: string | undefined, commitMessages: string | undefined, addedFiles: readonly string[], readFile: (path: string) => string | undefined }} input
 */
export function evaluateWorkerBranchShape({ headRef, commitMessages, addedFiles, readFile }) {
  const claimed = claimedTaskIds({ commitMessages, addedFiles, readFile });
  if (claimed.length === 0) {
    return {
      ok: true,
      message: "claims no task by trailer or filed shard — exempt from the run-<taskId>-<epochMs> shape check",
    };
  }

  const unshaped = claimed.filter((id) => !matchesRunBranchShape(headRef, id));
  if (unshaped.length === 0) {
    return {
      ok: true,
      message: `head ref "${headRef}" carries the run-<taskId>-<epochMs> shape dispatch and merge-credit expect, for ${claimed.join(", ")}`,
    };
  }

  return {
    ok: false,
    defect: "unshaped-worker-branch",
    message:
      `REFUSED — this branch claims ${unshaped.join(", ")} (by an anchored Remudero-Task trailer, or by filing a plan/tasks.d/ ` +
      `shard for it) but its head ref "${headRef}" does not carry the shape dispatch reads to make an in-flight task visible ` +
      `and the shape a merge is credited by when the trailer is missing: run-<taskId>-<epochMs> ` +
      `(e.g. run-${unshaped[0]}-1787887966537). Rename the branch to that shape, or drop the claim if this build is not ${unshaped[0]}'s own.`,
  };
}

/**
 * The common ancestor of `baseRef` and `HEAD` — read exactly as `baseRef` stands LOCALLY (never
 * fetched, per the file banner's "no network" guarantee). `undefined` when it cannot be resolved
 * (no local `origin/main`, a shallow clone, an unrelated history) rather than throwing, so every
 * caller below degrades to "nothing new seen" instead of crashing the whole gate.
 * @param {string} worktreePath
 * @param {string} baseRef
 */
export function resolveMergeBase(worktreePath, baseRef) {
  try {
    return execFileSync("git", ["-C", worktreePath, "merge-base", baseRef, "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/**
 * The concatenated message text of every commit THIS branch adds since `mergeBase` — i.e. `git
 * log mergeBase..HEAD`, EXCLUSIVE of `mergeBase` itself, so a fresh branch with no new commit yet
 * (the moment right after `git checkout -b`, before this run's own first commit) reads as an
 * empty string, never the PREVIOUS PR's own tip commit on `main`. `undefined` `mergeBase` (see
 * {@link resolveMergeBase}) yields `""` the same way — a setup gap is "no claim seen", not a
 * crash.
 * @param {string} worktreePath
 * @param {string | undefined} mergeBase
 */
export function commitMessagesSinceBase(worktreePath, mergeBase) {
  if (mergeBase === undefined) return "";
  try {
    // `%x00` separates each commit's message so concatenation can never accidentally splice one
    // commit's trailing partial line into the next commit's leading one.
    return execFileSync("git", ["-C", worktreePath, "log", "--format=%B%x00", `${mergeBase}..HEAD`], { encoding: "utf8" });
  } catch {
    return "";
  }
}

/**
 * The current head ref name: `--head-ref`, then `$GITHUB_HEAD_REF` (set automatically on a
 * `pull_request`-triggered Actions job — no extra API call), then the worktree's OWN current
 * branch (`git rev-parse --abbrev-ref HEAD`) — the shape a local, habitual
 * `npm run --silent worker-branch-shape:check` needs, since that invocation has no PR event at
 * all. Returns `undefined` only when every source is exhausted (e.g. a detached HEAD with neither
 * flag nor env var set); {@link evaluateWorkerBranchShape} then treats it as unshaped for whatever
 * it claims, same as any other non-conforming name.
 * @param {string | undefined} flagValue
 * @param {string} worktreePath
 * @param {Record<string, string | undefined>} env
 */
export function resolveHeadRef(flagValue, worktreePath, env = process.env) {
  if (flagValue) return flagValue;
  if (env.GITHUB_HEAD_REF) return env.GITHUB_HEAD_REF;
  try {
    const branch = execFileSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    return branch.length > 0 && branch !== "HEAD" ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The paths this branch's own diff ADDS since `mergeBase` — the population {@link shardTaskIds}
 * walks. `undefined` `mergeBase` (see {@link resolveMergeBase}) yields an empty list rather than
 * throwing, so a setup gap degrades to "no shard-declaration claim seen" rather than crashing the
 * whole gate.
 * @param {string} worktreePath
 * @param {string | undefined} mergeBase
 */
export function addedFilesSinceBase(worktreePath, mergeBase) {
  if (mergeBase === undefined) return [];
  try {
    const out = execFileSync(
      "git",
      ["-C", worktreePath, "diff", "--name-status", "--diff-filter=A", mergeBase, "HEAD"],
      { encoding: "utf8" },
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.split("\t")[1])
      .filter((path) => path !== undefined);
  } catch {
    return [];
  }
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: "string" },
      "head-ref": { type: "string" },
      "worktree-path": { type: "string" },
    },
  });

  const worktreePath = values["worktree-path"] ?? process.cwd();
  const baseRef = values.base ?? "origin/main";
  const headRef = resolveHeadRef(values["head-ref"], worktreePath);
  const mergeBase = resolveMergeBase(worktreePath, baseRef);
  const commitMessages = commitMessagesSinceBase(worktreePath, mergeBase);
  const addedFiles = addedFilesSinceBase(worktreePath, mergeBase);
  const readFile = (path) => {
    try {
      return readFileSync(join(worktreePath, path), "utf8");
    } catch {
      return undefined;
    }
  };

  const result = evaluateWorkerBranchShape({ headRef, commitMessages, addedFiles, readFile });
  if (!result.ok) {
    console.error(`worker-branch-shape: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`worker-branch-shape: OK — ${result.message}`);
  process.exitCode = 0;
}

// Only run when executed directly (`node scripts/worker-branch-shape.mjs ...`), never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
