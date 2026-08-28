/**
 * test/run-branch-claim-is-unenforced.test.ts — W1-T2429.
 *
 * THE DEFECT. `projectPlan` attributes an OPEN PR to a task by `/^run-(.+)-\d+$/` on
 * `headRefName` and by nothing else (`taskIdFromRunBranch`). A build that pushes its own branch
 * name on a `feat/…`, `fix/…` or `chore/…` head therefore writes no `pr.opened`, `isOpenPr`
 * cannot see it, and a second dispatch of the same task stays admissible until the PR merges.
 * The merge itself is credited normally by the anchored trailer (`creditsByAnchoredTrailer`'s
 * `!branchClaimsOtherTask` path), which is exactly why the gap leaves no trace after the fact —
 * MEASURED: W1-T377 and W1-T378 both shipped (#1386, #1391), both carry `verdict.merged` and
 * `pr.opened` x0, and both ran to 10 dispatches (twice `DEFAULT_MAX_TASK_DISPATCHES`) re-running
 * finished work before tripping.
 *
 * SCOPE (rationale §5/§6): DETECTION ONLY, and nothing this shard's own `files:` did not name.
 * `runBranchClaimGap` reports; it decides nothing, refuses nothing, and reads nothing but the
 * `PrRef` handed to it. Enforcement, the duplicate-title/slug detector (W1-T1076) and branch
 * reaping (W1-T447) are owned elsewhere and are not reopened here.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { corroboratesForwardProgress, runBranchClaimGap } from "../src/lib/status.js";
import type { PrRef } from "../src/lib/status.js";

const TASK_ID = "W1-T2429";
const TRAILER = `Remudero-Task: ${TASK_ID}`;

const merged = (headRefName: string | undefined, body: string | undefined): PrRef => ({
  number: 3200,
  url: "https://github.com/craigoley/remudero/pull/3200",
  state: "MERGED",
  headRefName,
  body,
});
const open = (headRefName: string | undefined, body: string | undefined): PrRef => ({
  number: 3201,
  url: "https://github.com/craigoley/remudero/pull/3201",
  state: "OPEN",
  headRefName,
  body,
});

// ── acceptance 1: a merged PR whose trailer claims the task while its head claims none ────────

test("acceptance 1: a merged PR trailered for the task on a feat/ branch is reported merged-untraced", () => {
  const pr = merged("feat/dedup-stand-downs-name-themselves", TRAILER);
  const gap = runBranchClaimGap(pr, TASK_ID);
  assert.ok(gap, "the gap is reported");
  assert.equal(gap!.kind, "merged-untraced");
  assert.equal(gap!.taskId, TASK_ID);
  assert.equal(gap!.prNumber, 3200);
  assert.equal(gap!.prUrl, pr.url);
  assert.equal(gap!.headRefName, "feat/dedup-stand-downs-name-themselves");
});

test("acceptance 1: also reported when the head is entirely unresolved (undefined)", () => {
  const gap = runBranchClaimGap(merged(undefined, TRAILER), TASK_ID);
  assert.ok(gap, "an unresolved head still carries no accepted claim, so this is still a gap");
  assert.equal(gap!.kind, "merged-untraced");
  assert.equal(gap!.headRefName, undefined);
});

// ── acceptance 2: an open PR on an unclaimed branch is named as unattributable ─────────────────

test("acceptance 2: an open PR trailered for the task on a fix/ branch is named open-unattributable", () => {
  const pr = open("fix/light-pass-tick-not-bounded-by-ci", TRAILER);
  const gap = runBranchClaimGap(pr, TASK_ID);
  assert.ok(gap, "the gap is named");
  assert.equal(gap!.kind, "open-unattributable");
  assert.equal(gap!.prNumber, 3201);
  assert.equal(gap!.prUrl, pr.url);
  assert.equal(gap!.headRefName, "fix/light-pass-tick-not-bounded-by-ci");
});

test("acceptance 2: a chore/ branch is named unattributable too — no fixed list of prefixes is hard-coded", () => {
  const gap = runBranchClaimGap(open("chore/retire-w1-t2413-something", TRAILER), TASK_ID);
  assert.ok(gap, "any head that is not one of the three accepted forms is a gap");
  assert.equal(gap!.kind, "open-unattributable");
});

// ── acceptance 3: a plan filing on a non-run branch is never reported — it claims no task ──────

test("acceptance 3: a plan filing that merely mentions the task in prose, with no anchored trailer, is quiet", () => {
  const filingBody = "One new plan shard under the reserved id W1-T2429, filed for triage.";
  assert.equal(runBranchClaimGap(merged("chore/plan-file-w1-t2429", filingBody), TASK_ID), undefined);
  assert.equal(runBranchClaimGap(open("chore/plan-file-w1-t2429", filingBody), TASK_ID), undefined);
});

test("acceptance 3: an entirely bodyless PR (undefined/empty) is quiet on both merged and open", () => {
  assert.equal(runBranchClaimGap(merged("feat/whatever", undefined), TASK_ID), undefined);
  assert.equal(runBranchClaimGap(merged("feat/whatever", ""), TASK_ID), undefined);
  assert.equal(runBranchClaimGap(open("feat/whatever", undefined), TASK_ID), undefined);
});

test("acceptance 3: a trailer that merely PREFIXES this task's id (W1-T24290) never fires — the match is anchored", () => {
  const prefixedTrailer = "Remudero-Task: W1-T24290";
  assert.equal(runBranchClaimGap(merged("feat/whatever", prefixedTrailer), TASK_ID), undefined);
  assert.equal(runBranchClaimGap(open("feat/whatever", prefixedTrailer), TASK_ID), undefined);
});

// ── acceptance 4: all three accepted claim forms still attribute exactly what they did before ──

test("acceptance 4: ownsBranch's timestamped form (run-<id>-<epochMs>) is never reported, merged or open", () => {
  const head = `run-${TASK_ID}-1787887966537`;
  assert.equal(runBranchClaimGap(merged(head, TRAILER), TASK_ID), undefined);
  assert.equal(runBranchClaimGap(open(head, TRAILER), TASK_ID), undefined);
});

test("acceptance 4: isBareRunBranch's bare form (run-<id>) is never reported, merged or open", () => {
  const head = `run-${TASK_ID}`;
  assert.equal(runBranchClaimGap(merged(head, TRAILER), TASK_ID), undefined);
  assert.equal(runBranchClaimGap(open(head, TRAILER), TASK_ID), undefined);
});

test("acceptance 4: isOwnedSlugBranch's descriptive-slug form (run-<id>-slug) is never reported, merged or open", () => {
  const head = `run-${TASK_ID}-open-pr-corroboration`;
  assert.equal(runBranchClaimGap(merged(head, TRAILER), TASK_ID), undefined);
  assert.equal(runBranchClaimGap(open(head, TRAILER), TASK_ID), undefined);
});

test("acceptance 4: a run-* branch that claims a DIFFERENT task is still reported — it is not this task's own", () => {
  // run-W1-T15-... does not claim W1-T152 in any of the three forms (the boundary-character
  // guard `branchClaimsOtherTask`'s own doc walks through) — this shard's function must see the
  // same thing every existing rung already sees, never a looser or stricter notion of "claims".
  const gap = runBranchClaimGap(merged("run-W1-T15-1785348476091", TRAILER), TASK_ID);
  assert.ok(gap, "a foreign run-branch does not claim THIS task, so the gap still fires");
  assert.equal(gap!.kind, "merged-untraced");
});

test("acceptance 4 (cross-check): the same three forms corroboratesForwardProgress already accepts are consulted here", () => {
  // corroboratesForwardProgress is the pre-existing exported entry point over the SAME three
  // predicates this shard's function reuses (per its own doc) — this pins that reuse rather than
  // asserting it by comment alone, without re-deriving or duplicating the three forms.
  for (const head of [`run-${TASK_ID}-1787887966537`, `run-${TASK_ID}`, `run-${TASK_ID}-my-slug`]) {
    assert.equal(corroboratesForwardProgress([{ number: 1, url: "u", state: "OPEN", headRefName: head }], TASK_ID), "corroborated");
    assert.equal(runBranchClaimGap(open(head, TRAILER), TASK_ID), undefined, `${head}: consistent with corroboratesForwardProgress`);
  }
});

// ── acceptance 5: the report changes no dispatch decision and refuses no push ──────────────────

test("acceptance 5: no dispatch-path source file references the new detector at all", () => {
  // A grep-level proof that this is additive-only: nothing in the files that decide whether a
  // task is dispatched, or whether a push is refused/renamed, was touched or made to call the
  // new function. `src/lib/worker.ts` and `src/run-task.ts` are the two places a push COULD be
  // refused or renamed (rationale §5), and `src/lib/drain.ts` is where eligibility is decided.
  const drainSrc = readFileSync(new URL("../src/lib/drain.ts", import.meta.url), "utf8");
  const workerSrc = readFileSync(new URL("../src/lib/worker.ts", import.meta.url), "utf8");
  const runTaskSrc = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
  for (const [name, src] of [["drain.ts", drainSrc], ["worker.ts", workerSrc], ["run-task.ts", runTaskSrc]] as const) {
    assert.doesNotMatch(src, /runBranchClaimGap/, `${name} does not reference the new detector`);
  }
});

test("acceptance 5: no dispatch-decision export in status.ts itself calls the new detector", () => {
  // projectPlan/evaluateDispatchBreaker*/isDispatchEligible-adjacent code all live in status.ts
  // proper; the guard above cannot see them, so it is re-run against this file's own source with
  // the detector's OWN definition excluded first.
  const statusSrc = readFileSync(new URL("../src/lib/status.ts", import.meta.url), "utf8");
  // Strip the WHOLE W1-T2429 section (its section banner through the function's closing brace),
  // including the type docs above the function that `{@link}` back to it by name — not just the
  // function body — so this is a proof about the REST of the file, never about the definition
  // referencing its own name in its own doc comment.
  const sectionStart = statusSrc.indexOf("// ── W1-T2429 —");
  assert.notEqual(sectionStart, -1, "CONTROL: the section banner is present, so the strip below is not vacuous");
  const afterFunction = statusSrc.indexOf("\n}\n", statusSrc.indexOf("export function runBranchClaimGap"));
  assert.notEqual(afterFunction, -1, "CONTROL: the function's closing brace was found");
  const withoutOwnDefinition = statusSrc.slice(0, sectionStart) + statusSrc.slice(afterFunction + 3);
  assert.doesNotMatch(withoutOwnDefinition, /runBranchClaimGap/, "no other code in status.ts calls the detector");
});

// ── acceptance 6: nothing added reads the network or walks the ledger to produce the report ────

test("acceptance 6: the detector's own signature takes only a PR and a task id — no ledger path, no gateway", () => {
  assert.equal(runBranchClaimGap.length, 2, "exactly (pr, taskId) — no third dependency to read from");
});

test("acceptance 6: the detector is synchronous — a network/ledger read would force it async", () => {
  const result = runBranchClaimGap(merged("feat/x", TRAILER), TASK_ID);
  assert.equal(result instanceof Promise, false, "a plain value, never a pending read");
});

test("acceptance 6: calling it repeatedly on the same input is side-effect-free and idempotent", () => {
  const pr = merged("feat/x", TRAILER);
  const a = runBranchClaimGap(pr, TASK_ID);
  const b = runBranchClaimGap(pr, TASK_ID);
  assert.deepEqual(a, b, "no hidden state accumulates across calls");
});

// ── control: closed-unmerged is out of scope, per the rationale ────────────────────────────────

test("control: a CLOSED, unmerged PR is never reported — neither credit path applies to it", () => {
  const pr: PrRef = { number: 3202, url: "https://github.com/craigoley/remudero/pull/3202", state: "CLOSED", headRefName: "feat/whatever", body: TRAILER };
  assert.equal(runBranchClaimGap(pr, TASK_ID), undefined);
});
