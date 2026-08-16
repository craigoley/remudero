/**
 * W1-T911 — "the retro body outlives its own truth".
 *
 * `retroCommand` opens the Architect's PR (whose body claims its changeset, e.g. "exactly one
 * file: MASTER-PLAN.md") BEFORE the harness regenerates docs/ORIENTATION.md and
 * plan/plan-index.json into that SAME PR (run-task.ts's own comment at that call site: those two
 * files "were regenerated AFTER the worker's own push"). The claim was TRUE the instant the
 * worker wrote it and is FALSE by the time `bodyContradictsDiff` (lib/review.ts) reads it — FOUR
 * merged/refused instances, all the identical three-path shape (#974, #1685, #1943, #1944).
 *
 * This file drives the PURE reconciler (`reconcileRetroChangesetClaim`, lib/plan-pr-emitter.ts)
 * directly, and the production rung that wires it into `retroCommand`
 * (`repairRetroChangesetClaim`, run-task.ts) — the exact "seam built but never called" hazard
 * test/producer-completeness.test.ts caught on #1931, aimed at the wiring this task adds.
 *
 * Its own file, never appended to test/plan-pr-emitter.test.ts: a coverage-load-bearing test must
 * not share a file that can crash at file level (CLAUDE.md's coverage rule; see
 * test/retro-acceptance-repair.test.ts's identical note for `repairRetroAcceptanceBlock`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { reconcileRetroChangesetClaim } from "../src/lib/plan-pr-emitter.js";
import { bodyContradictsDiff } from "../src/lib/review.js";
import { repairRetroChangesetClaim } from "../src/run-task.js";

const PR = "https://github.com/craigoley/remudero/pull/999";

// The #974/#1943/#1944 shape: the Architect's body was true for a one-file diff, then the
// harness pushed docs/ORIENTATION.md and plan/plan-index.json into the same PR afterward.
const REAL_FILES = ["MASTER-PLAN.md", "docs/ORIENTATION.md", "plan/plan-index.json"];
const STALE_BODY = [
  "This PR updates MASTER-PLAN.md's Standing rules per this cycle's retro.",
  "",
  "This PR touches exactly one file: `MASTER-PLAN.md`.",
  "",
  "Acceptance:",
  "- a report was filed | report",
  "",
].join("\n");

test("unit test: W1-T911: the reconciled body names every path the run wrote and no others", () => {
  const reconciled = reconcileRetroChangesetClaim(STALE_BODY, REAL_FILES);
  assert.ok(reconciled, "the stale body IS reconciled (not left alone)");
  for (const f of REAL_FILES) {
    assert.ok(reconciled!.includes(`\`${f}\``), `the reconciled body names ${f}`);
  }
  // "and no others": no path-shaped token outside REAL_FILES appears backtick-wrapped, the shape
  // the canonical enumeration and the original body both use for a path.
  const wrapped = [...reconciled!.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  for (const w of wrapped) {
    assert.ok(REAL_FILES.includes(w), `named path ${w} is one the run actually wrote`);
  }
});

test("unit test: W1-T911: the pre-change body is contradicted by the real diff and the reconciled one is not", () => {
  const before = bodyContradictsDiff(STALE_BODY, REAL_FILES);
  assert.ok(before.length > 0, "the pre-change body IS contradicted by the real diff");

  const reconciled = reconcileRetroChangesetClaim(STALE_BODY, REAL_FILES);
  assert.ok(reconciled, "a contradicted body is always reconciled to something");
  const after = bodyContradictsDiff(reconciled!, REAL_FILES);
  assert.deepEqual(after, [], "the reconciled body is NOT contradicted by the same real diff");
});

test("unit test: W1-T911: a run writing a different number of files is reconciled just as well", () => {
  // Neither 1 (the stale claim) nor 3 (REAL_FILES above) — proves this isn't a hardcoded three
  // wearing the fix's clothes; a body making the identical false "exactly one file" claim is
  // reconciled correctly regardless of how many files the run actually wrote.
  const fiveFiles = [
    "MASTER-PLAN.md",
    "docs/ORIENTATION.md",
    "plan/plan-index.json",
    "plan/tasks.d/W1-T1.yaml",
    "plan/feedback/2026-08-16.md",
  ];
  const reconciled = reconcileRetroChangesetClaim(STALE_BODY, fiveFiles);
  assert.ok(reconciled, "reconciled against a 5-file changeset");
  assert.equal(
    bodyContradictsDiff(reconciled!, fiveFiles).length,
    0,
    "no contradiction against the 5-file changeset it was reconciled for",
  );
  for (const f of fiveFiles) assert.ok(reconciled!.includes(`\`${f}\``), `names ${f}`);
  assert.doesNotMatch(reconciled!, /\bexactly\b/i, "no count is written — nothing left to go stale");

  // A different two-file run, reconciled against the SAME kind of stale claim, proves the same
  // point in the other direction (fewer files than the stale claim's own "one").
  const twoFiles = ["MASTER-PLAN.md", "docs/ORIENTATION.md"];
  const reconciledTwo = reconcileRetroChangesetClaim(STALE_BODY, twoFiles);
  assert.ok(reconciledTwo);
  assert.equal(bodyContradictsDiff(reconciledTwo!, twoFiles).length, 0);
});

test("unit test: W1-T911: a body that already agrees is left alone rather than rewritten", () => {
  const AGREEING_BODY = [
    "This PR updates MASTER-PLAN.md's Standing rules per this cycle's retro.",
    "",
    "This PR touches the following files: `MASTER-PLAN.md`, `docs/ORIENTATION.md`, `plan/plan-index.json`.",
    "",
    "Acceptance:",
    "- a report was filed | report",
    "",
  ].join("\n");
  assert.deepEqual(bodyContradictsDiff(AGREEING_BODY, REAL_FILES), [], "premise: this body already agrees");

  const reconciled = reconcileRetroChangesetClaim(AGREEING_BODY, REAL_FILES);
  assert.equal(reconciled, undefined, "no edit is made — a rung that rewrote every pass would be worse than one that misses");
});

// ── arm (b): a TRUTHFUL "no <path>" denial survives; only a denial the diff refutes is dropped ──

test("a truthful 'no <path>' denial survives reconciliation untouched", () => {
  const body = [
    "This PR touches the following files: `MASTER-PLAN.md`, `docs/ORIENTATION.md`, `plan/plan-index.json`.",
    "No src/, no test/ changes were made.",
    "",
    "Acceptance:",
    "- a report was filed | report",
    "",
  ].join("\n");
  assert.deepEqual(bodyContradictsDiff(body, REAL_FILES), [], "premise: nothing here is false");
  const reconciled = reconcileRetroChangesetClaim(body, REAL_FILES);
  assert.equal(reconciled, undefined, "a truthful denial is not rewritten");
});

test("a FALSE 'no <path>' denial (the diff DOES carry it) is dropped, a truthful sibling survives", () => {
  const body = [
    "This PR touches the following files: `MASTER-PLAN.md`, `docs/ORIENTATION.md`, `plan/plan-index.json`.",
    "No src/, no docs/ORIENTATION.md changes were made.",
    "",
    "Acceptance:",
    "- a report was filed | report",
    "",
  ].join("\n");
  const before = bodyContradictsDiff(body, REAL_FILES);
  assert.ok(before.length > 0, "premise: the docs/ORIENTATION.md denial is false");

  const reconciled = reconcileRetroChangesetClaim(body, REAL_FILES);
  assert.ok(reconciled);
  assert.equal(bodyContradictsDiff(reconciled!, REAL_FILES).length, 0, "the reconciled body is no longer contradicted");
  assert.doesNotMatch(reconciled!, /no\s+docs\/ORIENTATION\.md/i, "the false denial is gone");
});

// ── the production rung: repairRetroChangesetClaim (run-task.ts) ────────────────────────────────
//
// Same "seam built but never called" hazard test/producer-completeness.test.ts caught on #1931 —
// this drives the DECISION at the only place it fires, mirroring test/retro-acceptance-repair.ts's
// coverage of repairRetroAcceptanceBlock immediately above it in run-task.ts.

function recorder() {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const edits: Array<{ url: string; body: string }> = [];
  return {
    logged,
    edits,
    log: (step: string, extra?: Record<string, unknown>) => logged.push({ step, extra }),
    editBody: (url: string, body: string) => edits.push({ url, body }),
  };
}

test("repairRetroChangesetClaim RECONCILES a contradicted body and ledgers the repair", () => {
  const r = recorder();
  const outcome = repairRetroChangesetClaim(PR, r.log, {
    fetchBody: () => STALE_BODY,
    fetchFiles: () => REAL_FILES,
    editBody: r.editBody,
  });
  assert.equal(outcome, "reconciled");
  assert.equal(r.edits.length, 1, "the PR body was actually edited");
  assert.equal(r.edits[0].url, PR);
  assert.equal(bodyContradictsDiff(r.edits[0].body, REAL_FILES).length, 0);
  assert.ok(r.logged.some((l) => l.step === "changeset_claim.reconciled"));
});

test("REGRESSION LOCK: repairRetroChangesetClaim leaves a healthy body alone — no edit, no ledger line", () => {
  const r = recorder();
  const healthy = "This PR touches the following files: `MASTER-PLAN.md`.\n\nAcceptance:\n- a report was filed | report\n";
  const outcome = repairRetroChangesetClaim(PR, r.log, {
    fetchBody: () => healthy,
    fetchFiles: () => ["MASTER-PLAN.md"],
    editBody: r.editBody,
  });
  assert.equal(outcome, "unchanged");
  assert.equal(r.edits.length, 0, "no gh pr edit is issued");
  assert.equal(r.logged.length, 0, "silence is the correct trace here");
});

test("repairRetroChangesetClaim is best-effort — a failed read is ledgered, never thrown into the retro", () => {
  const r = recorder();
  const outcome = repairRetroChangesetClaim(PR, r.log, {
    fetchBody: () => {
      throw new Error("gh exploded");
    },
    fetchFiles: () => REAL_FILES,
    editBody: r.editBody,
  });
  assert.equal(outcome, "error");
  assert.equal(r.edits.length, 0);
  const line = r.logged.find((l) => l.step === "changeset_claim.reconcile.error");
  assert.ok(line, "the failure is named on its own ledger step");
  assert.match(String(line?.extra?.error), /gh exploded/, "carrying the real message, not a placeholder");
});

test("a failed EDIT is also contained — the read succeeded, the write did not", () => {
  const r = recorder();
  const outcome = repairRetroChangesetClaim(PR, r.log, {
    fetchBody: () => STALE_BODY,
    fetchFiles: () => REAL_FILES,
    editBody: () => {
      throw new Error("edit refused");
    },
  });
  assert.equal(outcome, "error");
  assert.ok(r.logged.some((l) => l.step === "changeset_claim.reconcile.error"));
  assert.equal(r.logged.some((l) => l.step === "changeset_claim.reconciled"), false, "not claimed for a repair that never landed");
});

// ── the DEFAULT leaves — really shelling out, per CLAUDE.md's #977/#978 rule ──────────────────
//
// Every test above injects `fetchBody`/`fetchFiles`/`editBody`, which leaves
// `defaultRetroFetchFiles` (and the two leaves it shares with `repairRetroAcceptanceBlock`)
// unreachable. This one drives the real defaults by putting a stub `gh` on PATH, mirroring
// test/retro-acceptance-repair.test.ts's identical closing test.

test("the DEFAULT leaves really shell out to gh — argv, JSON parse and the edit are all exercised", () => {
  const bin = mkdtempSync(join(tmpdir(), "gh-changeset-claim-"));
  const argvLog = join(bin, "argv.txt");
  const shBody =
    "#!/bin/sh\n" +
    'printf \'%s\\n\' "$*" >> ' +
    JSON.stringify(argvLog) +
    "\n" +
    'case "$*" in\n' +
    '  *"--json body"*) printf \'{"body":"This PR touches exactly one file: MASTER-PLAN.md.\\\\n\\\\nAcceptance:\\\\n- a report was filed | report\\\\n"}\' ;;\n' +
    '  *"--json files"*) printf \'{"files":[{"path":"MASTER-PLAN.md"},{"path":"docs/ORIENTATION.md"},{"path":"plan/plan-index.json"}]}\' ;;\n' +
    "  *) : ;;\n" +
    "esac\n";
  writeFileSync(join(bin, "gh"), shBody, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const logged: string[] = [];
    const outcome = repairRetroChangesetClaim(PR, (s) => logged.push(s));
    assert.equal(outcome, "reconciled", "the real default read + reconcile + real default edit all ran");
    const argv = readFileSync(argvLog, "utf8");
    assert.match(argv, /pr view .*--json body/, "the real body read fired");
    assert.match(argv, /pr view .*--json files/, "the real files read fired");
    assert.match(argv, /pr edit .*--body/, "the real edit fired");
    assert.ok(logged.includes("changeset_claim.reconciled"));
  } finally {
    process.env.PATH = oldPath;
    rmSync(bin, { recursive: true, force: true });
  }
});
