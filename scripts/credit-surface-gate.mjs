#!/usr/bin/env node
// scripts/credit-surface-gate.mjs — the author-time credit-surface gate (W1-T1214).
//
// A merge is credited only if the head commit carries an anchored `Remudero-Task: <id>` trailer,
// or the head ref matches the fleet's `run-<taskId>-<epochMs>` shape (CLAUDE.md's "Plan and task
// hygiene" section covers both readers). This gate refuses a merge that satisfies neither, before
// it happens — `appendTaskTrailerToCommit` (src/run-task.ts, W1-T1012) stamps only commits the
// harness itself pushes, never a hand-pushed branch.
// Why: 8 of 80 implementation merges since W1-T1012 landed uncredited on either surface.
// docs/forensics/credit-surface-gate.md#the-file-header
//
// A filing-shaped subject (isFilingShapedSubject) is exempt outright, per W1-T1004's own rule that
// a filing carries no trailer. Usage: node --import tsx scripts/credit-surface-gate.mjs --head-ref
// <ref> [--worktree-path <path>] (ref falls back to $GITHUB_HEAD_REF; path defaults to cwd).

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { LINT_FILING_SUBJECT_RE, isDispatchedRunBranch } from "../src/run-task.ts";

// Re-exported so a caller/test can name this shape without a second import of src/run-task.ts.
export { LINT_FILING_SUBJECT_RE, isDispatchedRunBranch };

/** The one `Remudero-Task: <id>` trailer spelling every reader shares (src/lib/status.ts's
 *  `TRAILER_RE`, `appendTaskTrailerToCommit`) — this asks "credited for ANY id", so it reuses that
 *  anchor and id class rather than a second regex. Falsifier: test/trailer-tiebreak-one-spelling.test.ts. */
const CREDIT_TRAILER_RE = /^Remudero-Task:[ \t]*[A-Za-z0-9-]+[ \t]*$/m;

/**
 * Is `subject` (a commit's first line) filing-shaped — citing a task rather than building it?
 * Thin wrapper over the imported {@link LINT_FILING_SUBJECT_RE}.
 * @param {string} subject
 */
export function isFilingShapedSubject(subject) {
  return LINT_FILING_SUBJECT_RE.test((subject ?? "").trim());
}

/**
 * Does `commitMessage` carry an anchored `Remudero-Task: <id>` trailer line (any id)?
 * @param {string} commitMessage
 */
export function hasCreditTrailer(commitMessage) {
  return CREDIT_TRAILER_RE.test(commitMessage ?? "");
}

/**
 * The gate's predicate: a filing-shaped subject is exempt outright; otherwise credit requires the
 * trailer or the run-shaped ref (either is enough), and a refusal names both ways to satisfy it.
 * @param {{ headCommitMessage: string, headRef: string | undefined }} input
 */
export function evaluateCreditSurfaceGate({ headCommitMessage, headRef }) {
  const message = headCommitMessage ?? "";
  const subject = message.split("\n")[0] ?? "";

  if (isFilingShapedSubject(subject)) {
    return {
      ok: true,
      message:
        `filing-shaped subject "${subject.trim()}" carries no Remudero-Task trailer by rule ` +
        `(W1-T1004) — exempt from the credit-surface check`,
    };
  }

  const trailered = hasCreditTrailer(message);
  const runShaped = isDispatchedRunBranch(headRef);

  if (trailered && runShaped) {
    return { ok: true, message: "credited on both surfaces: the head commit's Remudero-Task trailer and its run-shaped head ref" };
  }
  if (trailered) {
    return { ok: true, message: "credited via the head commit's Remudero-Task trailer" };
  }
  if (runShaped) {
    return { ok: true, message: `credited via its run-shaped head ref (${headRef})` };
  }

  return {
    ok: false,
    defect: "uncredited-merge",
    message:
      "REFUSED — this merge would land credited on NEITHER surface. Satisfy either: " +
      "(1) carry an anchored `Remudero-Task: <id>` trailer on the head commit, or " +
      "(2) push to a `run-<taskId>-<epochMs>` head ref (either is enough — see W1-T1214).",
  };
}

/**
 * The worktree's real HEAD commit message. Best-effort: `undefined` on any git failure rather than
 * throwing, matching {@link "../src/run-task.js".lastCommitSubject}'s own contract at the
 * analogous call site.
 * @param {string} worktreePath
 */
export function readHeadCommitMessage(worktreePath) {
  try {
    return execFileSync("git", ["-C", worktreePath, "log", "-1", "--format=%B"], { encoding: "utf8" });
  } catch {
    return undefined;
  }
}

/**
 * Resolve the head ref from the flag, falling back to `$GITHUB_HEAD_REF` (set automatically on a
 * `pull_request`-triggered job, so this costs no event-payload parse and no API call). Extracted
 * and pure so its refusal arm is reachable from a test.
 * @param {string | undefined} flagValue
 * @param {Record<string, string | undefined>} env
 */
export function resolveHeadRef(flagValue, env = process.env) {
  const headRef = flagValue ?? env.GITHUB_HEAD_REF;
  return headRef && headRef.length > 0
    ? { ok: true, headRef }
    : {
        ok: false,
        message: "credit-surface-gate: REFUSED — no head ref (pass --head-ref or set GITHUB_HEAD_REF)",
      };
}

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "head-ref": { type: "string" },
      "worktree-path": { type: "string" },
    },
  });

  const resolvedRef = resolveHeadRef(values["head-ref"]);
  if (!resolvedRef.ok) {
    console.error(resolvedRef.message);
    process.exitCode = 1;
    return;
  }

  const worktreePath = values["worktree-path"] ?? process.cwd();
  const headCommitMessage = readHeadCommitMessage(worktreePath);
  if (headCommitMessage === undefined) {
    console.error(`credit-surface-gate: REFUSED — cannot read the HEAD commit message at ${worktreePath}`);
    process.exitCode = 1;
    return;
  }

  const result = evaluateCreditSurfaceGate({ headCommitMessage, headRef: resolvedRef.headRef });
  if (!result.ok) {
    console.error(`credit-surface-gate: ${result.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`credit-surface-gate: OK — ${result.message}`);
  process.exitCode = 0;
}

// Only runs when executed directly, never on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
