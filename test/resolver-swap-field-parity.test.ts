import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { judgeReview, resolvePlanCriteriaAtHead } from "../src/lib/review.js";
import { openTaskIdsFromPlan } from "../src/run-task.js";
import type { Plan } from "../src/lib/plan.js";

// ── W1-T2623 — THE AT-HEAD RESOLVER SWAP WAS NOT FIELD-FOR-FIELD ────────────────────────────────
//
// W1-T2462 swapped `reviewCommand`'s call from `resolvePlanCriteriaForReview` (run-task.ts) to
// `resolvePlanCriteriaAtHead` (lib/review.ts), and that function's own doc claimed the swap was
// "like-for-like... not a rewrite" over FOUR fields — criteria/source/taskDeclaredFiles/divergence.
// The replaced resolver's declared result type carries FIVE: the doc's enumeration omitted
// `openTaskIds`, which `reviewCommand` still declares and still hands to `runReview` but the
// at-head call site never assigns. This file is the MECHANICAL guard the swap's own doc had none
// of — a field silently dropped at the call site must make it fail, not merely a future reader's
// close reading of two interfaces.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Pull the FIELD NAMES `resolvePlanCriteriaForReview`'s declared inline return type carries,
 * straight from `src/run-task.ts` — never a hand-copied literal list, so a field added or removed
 * there later is what THIS regex (and so this test) sees, not just whichever human happened to
 * read that diff. Walks braces from the `): {` that opens the return type to its matching close,
 * so growth of the function body below it can never shift what gets scanned.
 */
function extractResolverForReviewFields(): string[] {
  const src = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const marker = "export function resolvePlanCriteriaForReview(";
  const fnStart = src.indexOf(marker);
  assert.ok(fnStart >= 0, "resolvePlanCriteriaForReview must still be declared in src/run-task.ts");
  const afterParams = src.indexOf("): {", fnStart);
  assert.ok(afterParams >= 0, "resolvePlanCriteriaForReview's declared return type must be an inline object type");
  const braceStart = afterParams + 3; // index of the opening `{`
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, "brace-walk must find the matching close — an unmatched brace means the extraction drifted");
  const typeBlock = src.slice(braceStart + 1, i);
  const fields = [...typeBlock.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields.length > 0, "must find at least one declared field — silently seeing none is a broken extraction, not an empty type");
  return fields;
}

/** The sibling extraction over `PlanCriteriaAtHeadResult` (lib/review.ts) — same brace-walk
 *  discipline, same reason: a field this interface gains or loses later must move this test. */
function extractAtHeadResultFields(): string[] {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "review.ts"), "utf8");
  const marker = "export interface PlanCriteriaAtHeadResult {";
  const ifaceStart = src.indexOf(marker);
  assert.ok(ifaceStart >= 0, "PlanCriteriaAtHeadResult must still be declared in src/lib/review.ts");
  const braceStart = ifaceStart + marker.length - 1; // index of the opening `{`
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0);
  const typeBlock = src.slice(braceStart + 1, i);
  const fields = [...typeBlock.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields.length > 0);
  return fields;
}

// Fields `resolvePlanCriteriaAtHead`'s result does NOT produce, but that this task PROVES
// behaviorally identical without — see the second test below for the proof itself. A field
// landing here without an accompanying proof test is a self-review gap, not a closed one; the
// structural test below only checks the NAME is accounted for, never the truth of the claim.
const PROVEN_BEHAVIORALLY_EQUIVALENT_WITHOUT = new Set(["openTaskIds"]);

test("resolver-swap-field-parity: every field resolvePlanCriteriaForReview declares is produced by resolvePlanCriteriaAtHead, or is named in this file's explicit behavioral-equivalence allowlist", () => {
  const oldFields = extractResolverForReviewFields();
  const newFields = new Set(extractAtHeadResultFields());
  const unaccounted = oldFields.filter((f) => !newFields.has(f) && !PROVEN_BEHAVIORALLY_EQUIVALENT_WITHOUT.has(f));
  assert.deepEqual(
    unaccounted,
    [],
    `field(s) declared on the replaced resolver's result type are neither produced by ` +
      `resolvePlanCriteriaAtHead nor recorded in PROVEN_BEHAVIORALLY_EQUIVALENT_WITHOUT: ` +
      `${unaccounted.join(", ")} — this is exactly the silent parity gap W1-T2623 exists to close`,
  );
  // And the allowlist itself must name only fields the OLD resolver actually declares — an entry
  // for a field that does not exist there is dead weight that could mask a real future gap.
  for (const allowed of PROVEN_BEHAVIORALLY_EQUIVALENT_WITHOUT) {
    assert.ok(oldFields.includes(allowed), `'${allowed}' is in the allowlist but is not a field resolvePlanCriteriaForReview declares`);
  }
});

// ── openTaskIds: PROVE-AND-LOCK ──────────────────────────────────────────────────────────────
//
// Design note (ii): restoring `openTaskIds` on the at-head path would need a real projection to
// be worth anything, and the reviewer does not have one without a second, independent GitHub
// read. Without a projection the replaced resolver's own `openTaskIdsFromPlan(plan)` already
// degrades to the empty set — identical, at the one consumer, to the `undefined`
// `resolvePlanCriteriaAtHead` leaves in its place. The two tests below LOCK that equivalence
// rather than restore the field.

const SIMPLE_CRITERIA = [{ claim: "the change is safe", proof: "widget frobnicate implemented" }];

function makeCheckout(): string {
  return mkdtempSync(join(tmpdir(), "resolver-swap-parity-"));
}

function writeFile(checkoutDir: string, relPath: string, content: string): void {
  const abs = join(checkoutDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

test("resolver-swap-field-parity: an absent openTaskIds (what the at-head path actually carries) is behaviorally IDENTICAL to the replaced resolver's projection-less empty set, at the one real consumer", () => {
  const checkoutDir = makeCheckout();
  try {
    writeFile(checkoutDir, "src/lib/orphan.ts", "export function orphanFn(): number {\n  return 1;\n}\n");
    const diff = [
      "diff --git a/src/lib/orphan.ts b/src/lib/orphan.ts",
      "+++ b/src/lib/orphan.ts",
      "@@",
      "+export function orphanFn(): number {",
      "+  return 1;",
      "+}",
    ].join("\n");
    const report = "REPORT\n\nwidget frobnicate implemented and verified.\n\nSHIPS-UNWIRED: W1-T1\nPR_URL: https://github.com/o/r/pull/1";

    // The value reviewCommand's own `openTaskIds` variable carries TODAY on the at-head path —
    // permanently `undefined` (see run-task.ts, W1-T2623's comment there).
    const atHeadPath = judgeReview(SIMPLE_CRITERIA, { diff, report, headCheckoutDir: checkoutDir, openTaskIds: undefined });

    // The value the REPLACED resolver would have supplied at this same call site:
    // `openTaskIdsFromPlan(plan)` called with NO projection — the reviewer never has one on this
    // path (no second GitHub read), and that function's own doc names the empty set as exactly
    // what it degrades to without one.
    const emptyPlan: Plan = { tasks: [], byId: new Map() };
    const oldPathValue = openTaskIdsFromPlan(emptyPlan);
    assert.deepEqual([...oldPathValue], [], "sanity: no projection must degrade to the empty set, the premise this whole test locks");
    const oldPath = judgeReview(SIMPLE_CRITERIA, { diff, report, headCheckoutDir: checkoutDir, openTaskIds: oldPathValue });

    assert.deepEqual(
      atHeadPath.unwiredAdvisories,
      oldPath.unwiredAdvisories,
      "an absent openTaskIds and the replaced resolver's projection-less empty set must reach the SHIPS-UNWIRED floor as the SAME input",
    );
    assert.equal(atHeadPath.state, oldPath.state);
    // Both must actually FLAG (fail-closed), not silently pass — otherwise this proves two
    // equally-broken paths agree rather than two equally-SAFE ones.
    assert.equal(atHeadPath.unwiredAdvisories?.length, 1, "a SHIPS-UNWIRED marker naming an id neither path knows is open must still be flagged");
  } finally {
    rmSync(checkoutDir, { recursive: true, force: true });
  }
});

/** Count CODE occurrences of `openTaskIds ?? …` — never a doc/comment line quoting the same
 *  pattern in prose (both files carry at least one: this task's own comment and W1-T322's
 *  pre-existing one, neither of them a real second consumer). A line whose trimmed text starts
 *  `//` or `*` is a comment/JSDoc line, the same convention this repo's own source uses
 *  throughout. */
function countCodeDistinguishers(src: string): number {
  return src
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .filter((line) => /openTaskIds\s*\?\?/.test(line)).length;
}

test("resolver-swap-field-parity: exactly one consumer in src/ distinguishes an absent openTaskIds from an explicit empty one — the prove-and-lock close is sound only for what exists today", () => {
  const reviewSrc = readFileSync(join(REPO_ROOT, "src", "lib", "review.ts"), "utf8");
  const runTaskSrc = readFileSync(join(REPO_ROOT, "src", "run-task.ts"), "utf8");
  const distinguishers = countCodeDistinguishers(reviewSrc) + countCodeDistinguishers(runTaskSrc);
  assert.equal(
    distinguishers,
    1,
    "a place that reads `openTaskIds ?? <something>` (or otherwise treats absent differently from an " +
      "explicit empty set) appeared or disappeared. This task's design note (ii) verified the equivalence " +
      "at exactly ONE consumer (review.ts's unwiredAdvisoriesFor) — a second one must flip the close from " +
      "'prove-and-lock' to 'restore', per that same design note; it must not be silently outrun",
  );
});

// ── read identity (claim 3) ──────────────────────────────────────────────────────────────────
//
// A dedicated fixture (independent of test/review-resolves-criteria-at-the-prs-own-head.test.ts,
// which also exercises this) proving the read-identity assertion names the object identity of
// BOTH the monolith and the shard set — never only the count/task-id the pre-fix line carried.

function gitPlanRepo(): { dir: string; run: (args: string[]) => string; commit: (msg: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), "resolver-swap-parity-git-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  run(["init", "--quiet", "-b", "main"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "user.name", "Test"]);
  mkdirSync(join(dir, "plan"), { recursive: true });
  const commit = (msg: string): string => {
    run(["add", "-A"]);
    run(["commit", "--quiet", "-m", msg, "--allow-empty"]);
    return run(["rev-parse", "HEAD"]).trim();
  };
  return { dir, run, commit };
}

const task = (id: string, acceptance: string[] = []): string =>
  [
    `- id: ${id}`,
    `  title: ${id.toLowerCase()}`,
    "  repo: remudero",
    "  type: implement",
    "  depends_on: []",
    "  verify: auto",
    "  status: queued",
    "  attempts: 0",
    ...(acceptance.length
      ? ["  acceptance:", ...acceptance.flatMap((claim) => [`    - claim: "${claim}"`, `      proof: "${claim}, per the PR body"`])]
      : []),
  ].join("\n");

const TRAILERED_BODY = (taskId: string) => `REPORT\n\nsome text\n\nRemudero-Task: ${taskId}\n`;

test("resolver-swap-field-parity: the restored source names the head sha, the plan path, and the git object identity of both the monolith and the shard set actually read", () => {
  const { dir, run, commit } = gitPlanRepo();
  try {
    writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1", ["the thing works"]) + "\n");
    mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
    writeFileSync(join(dir, "plan", "tasks.d", "w1-t2.yaml"), task("W1-T2") + "\n");
    const headSha = commit("plan with a shard");

    const resolved = resolvePlanCriteriaAtHead(TRAILERED_BODY("W1-T1"), dir, "plan/tasks.yaml", headSha);
    assert.match(resolved.source ?? "", new RegExp(`^plan at ${headSha} task W1-T1 \\(1 criteria\\) — read: `));

    const blobOid = run(["rev-parse", `${headSha}:plan/tasks.yaml`]).trim();
    const treeOid = run(["rev-parse", `${headSha}:plan/tasks.d`]).trim();
    assert.ok(
      resolved.source?.includes(blobOid.slice(0, 12)),
      "the monolith's own blob oid (git's ground truth, independently re-derived here) must appear in the printed identity",
    );
    assert.ok(
      resolved.source?.includes(treeOid.slice(0, 12)),
      "the shard directory's own tree oid (git's ground truth, independently re-derived here) must appear too — the shard set is part of what was gated",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolver-swap-field-parity: an unreadable identity probe preserves resolved criteria and falls back to the pre-change source", () => {
  const { dir, run, commit } = gitPlanRepo();
  try {
    writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1", ["the thing works"]) + "\n");
    const headSha = commit("plan whose identity probe will fail");
    const runGit = (args: string[]): string => {
      if (args[0] === "rev-parse") throw new Error("simulated local object-identity probe failure");
      return run(args);
    };

    const resolved = resolvePlanCriteriaAtHead(
      TRAILERED_BODY("W1-T1"),
      dir,
      "plan/tasks.yaml",
      headSha,
      runGit,
    );

    assert.deepEqual(resolved.criteria.map((criterion) => criterion.claim), ["the thing works"]);
    assert.equal(
      resolved.source,
      `plan at ${headSha} task W1-T1 (1 criteria)`,
      "the optional identity suffix may disappear, but the already-resolved review input must not",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── claim 4: no verdict semantics move ───────────────────────────────────────────────────────
//
// The read-identity change only APPENDS to `source` when criteria resolved — it must never
// change WHICH criteria resolve, nor whether a resolve failure still fails closed.

test("resolver-swap-field-parity: restoring the identity moves no verdict semantics — a trailer that resolves nothing still fails closed, with or without a source", () => {
  const { dir, commit } = gitPlanRepo();
  try {
    // A task that exists but declares no acceptance at all: criteria stays [] and `source` stays
    // `undefined` — the read-identity probes must never run here (nothing to append them to), and
    // the fail-closed shape from before this task must be untouched.
    writeFileSync(join(dir, "plan", "tasks.yaml"), task("W1-T1") + "\n");
    const headSha = commit("plan, no acceptance declared");

    const resolved = resolvePlanCriteriaAtHead(TRAILERED_BODY("W1-T1"), dir, "plan/tasks.yaml", headSha);
    assert.deepEqual(resolved.criteria, []);
    assert.equal(resolved.source, undefined, "no criteria ⇒ no source line at all, exactly as before this task — never a bare 'read:' with nothing to judge");

    const verdict = judgeReview(resolved.criteria, { diff: "+++ b/x.ts\n+export const x = 1;", report: "did the thing" });
    assert.equal(verdict.state, "failure", "zero criteria must still fail closed — a source string is legibility, never evidence");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
