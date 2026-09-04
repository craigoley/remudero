import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPlanFromYaml } from "../src/lib/plan.js";
import { IDLE_REASON_ID_CAP, nextRunnable, runnableCandidates, tallyDispatchFilters, type MergedSet } from "../src/lib/drain.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";
import type { GitHub } from "../src/lib/status.js";

// W1-T1205 — `rmd status`'s QUEUE HEAD promised "next dispatchables" but derived them from a
// WEAKER predicate set than the dispatcher's own (`runnableCandidates`, drain.ts): it bound only
// `isIndeterminate`/`isCircuitTripped`, never `hasPushedRunBranch`, so it advertised tasks
// dispatch would refuse — and the excluding class (`run-branch-already-pushed`) reached no
// surface at all, existing only as a `dispatch.skipped` ledger row. This file proves all FIVE of
// the task's own acceptance claims, in order: (1) queue head binds the SAME predicate set the
// dispatcher applies, (2) an excluded task is NAMED rather than omitted, (3) the surface
// distinguishes dispatchable from refused, (4) the exclusion is a NAMED DispatchFilterReason
// (not only a ledger row), (5) the recoverable-class census (`StarvationCensus`, daemon.ts) keeps
// its existing membership unchanged.

const NONE_MERGED: MergedSet = () => false;

const TWO_TASK_YAML = `
- id: W1-T910
  title: has no run branch pushed
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
- id: W1-T920
  title: has a run branch already pushed
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;

function plan() {
  return loadPlanFromYaml(TWO_TASK_YAML, "fixture");
}

// ── ACCEPTANCE 4: "the pushed-run-branch exclusion is a named dispatch filter reason rather
// than a ledger row alone" ──────────────────────────────────────────────────────────────────────

test("drain.ts: a task excluded by hasPushedRunBranch fires onFiltered('run-branch-already-pushed') ALONGSIDE onSkipRunBranch, never one in place of the other", () => {
  const filtered: Array<{ id: string; reason: string }> = [];
  const skipped: string[] = [];
  const candidates = runnableCandidates(plan(), NONE_MERGED, 10, {
    hasPushedRunBranch: (id) => id === "W1-T920",
    onFiltered: (task, reason) => filtered.push({ id: task.id, reason }),
    onSkipRunBranch: (t) => skipped.push(t.id),
  }).map((t) => t.id);

  assert.deepEqual(candidates, ["W1-T910"], "the excluded task never dispatches");
  assert.deepEqual(skipped, ["W1-T920"], "the pre-existing ledger-row callback still fires — unchanged");
  assert.deepEqual(
    filtered,
    [{ id: "W1-T920", reason: "run-branch-already-pushed" }],
    "AND the neutral DispatchFilterReason tally now names it too — before this task it named nothing here",
  );
});

test("drain.ts: nextRunnable applies the SAME named reason through the SAME onFiltered callback runnableCandidates uses", () => {
  const filtered: Array<{ id: string; reason: string }> = [];
  const next = nextRunnable(plan(), NONE_MERGED, {
    hasPushedRunBranch: (id) => id === "W1-T910", // exclude the file-order HEAD this time
    onFiltered: (task, reason) => filtered.push({ id: task.id, reason }),
  });
  assert.equal(next?.id, "W1-T920", "the excluded head is skipped in favor of the next candidate");
  assert.deepEqual(filtered, [{ id: "W1-T910", reason: "run-branch-already-pushed" }]);
});

test("drain.ts: hasPushedRunBranch omitted ⇒ no 'run-branch-already-pushed' decline is ever tallied — the new reason changes nothing for a caller that never wires the predicate", () => {
  const filtered: Array<{ id: string; reason: string }> = [];
  const candidates = runnableCandidates(plan(), NONE_MERGED, 10, {
    onFiltered: (task, reason) => filtered.push({ id: task.id, reason }),
  }).map((t) => t.id);
  assert.deepEqual(candidates, ["W1-T910", "W1-T920"]);
  assert.deepEqual(filtered, []);
});

// ── ACCEPTANCE 5: "the recoverable-class census keeps its existing membership unchanged" ───────
//
// daemon.ts's `StarvationCensus` is `{ circuitBroken, blocked, unmetDeps }`, built by reading
// EXACTLY `idleTally.blocked` and `idleTally["unmet-deps"]` off `tallyDispatchFilters`'s own
// snapshot (never touched by this task). Proving those two buckets never absorb the new reason
// is the data-layer proof that the census's membership cannot have silently widened: nothing in
// daemon.ts's own (unmodified) construction reads any key but those two off this exact snapshot.

test("drain.ts: tallyDispatchFilters gives 'run-branch-already-pushed' its OWN bucket — never counted under 'blocked' or 'unmet-deps', the two buckets StarvationCensus reads verbatim off this same snapshot", () => {
  const tally = tallyDispatchFilters();
  runnableCandidates(plan(), NONE_MERGED, 10, {
    hasPushedRunBranch: (id) => id === "W1-T920",
    onFiltered: tally.onFiltered,
  });
  const snapshot = tally.snapshot();

  assert.equal(snapshot["run-branch-already-pushed"].count, 1);
  assert.deepEqual(snapshot["run-branch-already-pushed"].ids, ["W1-T920"]);
  assert.equal(snapshot.blocked.count, 0, "the recoverable 'blocked' bucket must not absorb this permanent exclusion");
  assert.equal(snapshot["unmet-deps"].count, 0, "nor must the recoverable 'unmet-deps' bucket");
  // Every bucket a StarvationCensus-shaped reader could ever consult is still present and typed —
  // the new reason is an ADDITIONAL key, never a replacement for any existing one. W1-T2474 adds
  // one more additional key, 'retired' — the blocked bucket's own split, never touching this one.
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "already-merged",
    "blocked",
    "continued-this-pass",
    "retired",
    "run-branch-already-pushed",
    "unmet-deps",
    "verify-not-auto",
  ]);
});

// ── ACCEPTANCE 1/2/3: rmd status's QUEUE HEAD (status-board.ts) binds the SAME predicate set,
// names what it excludes, and distinguishes dispatchable from refused ──────────────────────────

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "queue-head-parity-"));
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "queue-head-parity-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return ledgerPath;
}

function fakeGithub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

const NOW_ISO = "2026-08-22T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

/** A never-running, never-fetching, offline-safe deps bundle — mirrors test/status-board.test.ts's
 *  own `baseDeps` convention. `readPushedRunBranches` defaults to an empty sweep so a test that
 *  doesn't care about this predicate sees byte-identical behaviour to before it was bound. */
function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    plan: plan(),
    github: fakeGithub(),
    readPushedRunBranches: () => "",
    ...overrides,
  };
}

// Raw `git ls-remote --heads origin 'run-*'` output naming a run branch for W1-T920 only —
// the SAME shape `runBranchTaskIds` (drain.ts) already parses in production.
const PUSHED_BRANCH_FOR_W1_T920 = "abc123def456\trefs/heads/run-W1-T920-1786886488695";

test("buildStatusBoard: QUEUE HEAD binds the dispatcher's OWN hasPushedRunBranch predicate — a task with a run branch already on origin is excluded from `rows`, in lockstep with runnableCandidates", () => {
  const ledgerPath = writeLedger([]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ readPushedRunBranches: () => PUSHED_BRANCH_FOR_W1_T920 }));

  const rowIds = model.queueHead.rows.map((r) => r.taskId);
  assert.deepEqual(rowIds, ["W1-T910"], "the task with a pushed run branch never appears as dispatchable");

  // PARITY, PROVEN DIRECTLY: the SAME predicate applied through runnableCandidates (the
  // dispatcher's own selector, drain.ts) must produce the IDENTICAL eligible set — this is the
  // "same predicate set" acceptance claim, checked at the data layer rather than by inspection.
  const dispatcherIds = runnableCandidates(plan(), () => false, 10, {
    hasPushedRunBranch: (id) => id === "W1-T920",
  }).map((t) => t.id);
  assert.deepEqual(rowIds, dispatcherIds, "queue head's candidate set must be byte-identical to the dispatcher's own");
});

test("buildStatusBoard: QUEUE HEAD — a task excluded by a pushed run branch is NAMED in `refused`, never silently omitted from every field the way it was before this task", () => {
  const ledgerPath = writeLedger([]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ readPushedRunBranches: () => PUSHED_BRANCH_FOR_W1_T920 }));

  assert.equal(model.queueHead.refused.length, 1);
  assert.equal(model.queueHead.refused[0]!.taskId, "W1-T920");
  assert.equal(model.queueHead.refused[0]!.title, "has a run branch already pushed");
  assert.equal(model.queueHead.refused[0]!.reason, "run-branch-already-pushed");

  const text = renderStatusBoardText(model);
  assert.match(text, /REFUSED: W1-T920/);
  assert.match(text, /run branch already pushed/);
  assert.match(model.queueHead.nextAction ?? "", /W1-T920/);
  assert.match(model.queueHead.nextAction ?? "", /run branch already pushed/);
});

test("buildStatusBoard: QUEUE HEAD — the surface distinguishes WHAT DISPATCH WILL TAKE from WHAT IT IS REFUSING: both a dispatchable row and a refused row render as DISTINCT lines, and the refused id never leaks into `rows`", () => {
  const ledgerPath = writeLedger([]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ readPushedRunBranches: () => PUSHED_BRANCH_FOR_W1_T920 }));

  assert.deepEqual(model.queueHead.rows.map((r) => r.taskId), ["W1-T910"]);
  assert.deepEqual(model.queueHead.refused.map((r) => r.taskId), ["W1-T920"]);
  const overlap = model.queueHead.rows.filter((r) => model.queueHead.refused.some((x) => x.taskId === r.taskId));
  assert.deepEqual(overlap, [], "a task is never listed as both dispatchable and refused");

  const textLines = renderStatusBoardText(model).split("\n");
  const dispatchLineIdx = textLines.findIndex((l) => l.startsWith("W1-T910"));
  const refusedLineIdx = textLines.findIndex((l) => l.startsWith("REFUSED"));
  assert.ok(dispatchLineIdx >= 0, "the dispatchable row renders");
  assert.ok(refusedLineIdx >= 0, "the refused row ALSO renders — never a single undifferentiated list");
  assert.notEqual(dispatchLineIdx, refusedLineIdx, "they are two distinct, labeled lines, never merged into one");
});

test("buildStatusBoard: QUEUE HEAD — no run branches pushed ⇒ `refused` is empty and `rows` names both tasks, byte-identical to behaviour before this predicate was bound", () => {
  const ledgerPath = writeLedger([]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps());
  assert.deepEqual(model.queueHead.refused, []);
  assert.deepEqual(
    model.queueHead.rows.map((r) => r.taskId).sort(),
    ["W1-T910", "W1-T920"],
  );
  assert.doesNotMatch(renderStatusBoardText(model), /REFUSED/);
});

test("buildStatusBoard: QUEUE HEAD — every candidate refused (an empty `rows`) still renders as EXPLICIT 'nothing dispatchable' PLUS the named refusals, never a silently-empty block indistinguishable from an all-clear queue", () => {
  const onlyTaskYaml = `
- id: W1-T930
  title: sole task, its run branch already pushed
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
`;
  const onlyPlan = loadPlanFromYaml(onlyTaskYaml, "fixture");
  const ledgerPath = writeLedger([]);
  const raw = "abc\trefs/heads/run-W1-T930-1786886488695";
  const model = buildStatusBoard(
    tmpRoot(),
    ledgerPath,
    baseDeps({ plan: onlyPlan, readPushedRunBranches: () => raw }),
  );

  assert.deepEqual(model.queueHead.rows, [], "no candidate is dispatchable");
  assert.deepEqual(model.queueHead.refused.map((r) => r.taskId), ["W1-T930"]);

  const textLines = renderStatusBoardText(model).split("\n");
  assert.ok(textLines.some((l) => l === "nothing dispatchable"), "the honest idle state still renders");
  assert.ok(textLines.some((l) => l.startsWith("REFUSED: W1-T930")), "AND the refusal renders alongside it — never one replacing the other");
});

// ── Robustness: `refused` is bounded, mirroring tallyDispatchFilters's own id-cap discipline —
// an incident with more permanently-stuck tasks than fit in a readable line must SAY so, never
// grow the board without bound ──────────────────────────────────────────────────────────────────

test("drain.ts: tallyDispatchFilters caps the 'run-branch-already-pushed' bucket's ids at IDLE_REASON_ID_CAP and reports how many it truncated — never an unbounded id list", () => {
  const manyIds = Array.from({ length: IDLE_REASON_ID_CAP + 3 }, (_, i) => `W1-T${9000 + i}`);
  const manyYaml = manyIds
    .map((id) => `- id: ${id}\n  title: t\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n`)
    .join("");
  const manyPlan = loadPlanFromYaml(manyYaml, "fixture");

  const tally = tallyDispatchFilters();
  runnableCandidates(manyPlan, NONE_MERGED, 10, {
    hasPushedRunBranch: () => true, // every task's run branch is already on origin
    onFiltered: tally.onFiltered,
  });
  const bucket = tally.snapshot()["run-branch-already-pushed"];

  assert.equal(bucket.count, manyIds.length, "the COUNT is complete, never truncated");
  assert.equal(bucket.ids.length, IDLE_REASON_ID_CAP, "the id LIST is capped");
  assert.equal(bucket.truncated, manyIds.length - IDLE_REASON_ID_CAP, "and it says how many it did not name");
});

test("buildStatusBoard: QUEUE HEAD — `refused` is capped at IDLE_REASON_ID_CAP too, with `refusedTruncated` naming how many more were excluded but not listed", () => {
  const manyIds = Array.from({ length: IDLE_REASON_ID_CAP + 3 }, (_, i) => `W1-T${9000 + i}`);
  const manyYaml = manyIds
    .map((id) => `- id: ${id}\n  title: t\n  repo: remudero\n  type: implement\n  verify: auto\n  depends_on: []\n  status: queued\n`)
    .join("");
  const manyPlan = loadPlanFromYaml(manyYaml, "fixture");
  const raw = manyIds.map((id, i) => `abc${i}\trefs/heads/run-${id}-178688648869${i}`).join("\n");

  const ledgerPath = writeLedger([]);
  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: manyPlan, readPushedRunBranches: () => raw }));

  assert.equal(model.queueHead.refused.length, IDLE_REASON_ID_CAP, "the visible list is capped, matching drain.ts's own bound");
  assert.equal(model.queueHead.refusedTruncated, manyIds.length - IDLE_REASON_ID_CAP, "and the drop is COUNTED, never silent");

  const text = renderStatusBoardText(model);
  assert.match(text, new RegExp(`\\+${manyIds.length - IDLE_REASON_ID_CAP} more`), "the truncation count reaches the rendered text too");
});
