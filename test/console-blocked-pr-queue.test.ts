// test/console-blocked-pr-queue.test.ts — W1-T1006
//
// THE GAP THIS PROVES CLOSED. `renderNeedsMe` (src/lib/serve.ts) had exactly FIVE row sources
// -- needsHuman, verifyHumanPending, feedback grilling/proposed, inbox ready, inbox drafting --
// and every one of them is gated on an escalation issue (or a feedback/inbox entry). A PR the
// sweep reconciler already disposed into a non-progressing class (blocked-fixable/
// blocked-ambiguous/conflicted/stale, sweep.ts's own vocabulary) never opens an escalation
// issue on its own, so it never reached the console at all -- measured live, PR#2097 carried
// 303 `sweep.disposed` rows and ZERO `escalation.issue_opened` lines. The model that closes this
// (status-board.ts's `BlockedPrBlocker`, re-derived against live GitHub merge state every
// render) already existed; this task's whole job is wiring it into board.ts's `BoardSnapshot`
// (the sixth NEEDS-ME row source) and serve.ts's client-side render.
//
// Self-contained fixtures (test/human-verify-queue-surfaces.test.ts's own convention): every
// helper here is the minimum shape each assertion needs, never a shared corpus.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// W1-T2731: the shell's pure helpers are a real module now; these sandboxes take them from it
// (via the SAME emitter the shell uses) instead of regexing them out of the rendered HTML.
import { renderConsoleShellScript } from "../src/lib/console-shell-script.js";
import { computeBoardSnapshot, type BoardDeps } from "../src/lib/board.js";
import { renderShellHtml } from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";
import type { GitHub } from "../src/lib/status.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative -- computeBoardSnapshot must not trust this
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

/** A GitHub gateway fixture carrying only the four REQUIRED {@link GitHub} methods, every one
 *  answering "no evidence" -- the ordinary "reachable gateway, nothing resolved yet" shape.
 *  `readFailed` defaults to a REACHABLE gateway; override to simulate an outage. */
function fakeGitHub(overrides: Partial<GitHub> = {}): GitHub {
  return {
    prByRef: () => null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
    ...overrides,
  };
}

function tmpLedgerPath(lines: Record<string, unknown>[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-blocked-pr-queue-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.length === 0 ? "" : lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

function sweepDisposed(over: Record<string, unknown>): Record<string, unknown> {
  return { run_id: "R1", task_id: "SWEEP", ts: "2026-08-18T01:00:00.000Z", step: "sweep.disposed", acted: false, ...over };
}

// ── ACCEPTANCE 1: a disposed PR with no escalation issue reaches the console queue ────────────

test("W1-T1006: a disposed PR with no escalation issue reaches the console queue", () => {
  const ledgerPath = tmpLedgerPath([
    sweepDisposed({
      pr_number: 2097,
      pr_url: "https://github.com/o/r/pull/2097",
      disposition: "blocked-ambiguous",
      reason: "review orphaned by a push, again -- the sweep has already reviewed this unchanged input 2 time(s) (>= 2 cap) -- escalating",
    }),
  ]);
  const deps: BoardDeps = { plan: planOf([]), ledgerPath, github: fakeGitHub() };
  const snapshot = computeBoardSnapshot(deps);

  // Sanity: no escalation was ever opened for anything -- confirms the row below reached the
  // queue through the sweep's own disposal alone, never through needsHuman.
  assert.equal(
    snapshot.tasks.some((t) => t.needsHuman),
    false,
    "sanity: this fixture opens no escalation issue at all",
  );

  assert.equal(snapshot.blockedPrs.length, 1, "the disposed PR must reach BoardSnapshot.blockedPrs");
  assert.equal(snapshot.blockedPrs[0].kind, "blocked_pr");
  assert.equal(snapshot.blockedPrs[0].prNumber, 2097);
});

// ── ACCEPTANCE 2: each row carries its own disposition and reason VERBATIM ────────────────────

test("W1-T1006: a blocked PR row carries its disposition and reason verbatim", () => {
  const reason = "required checks red -- ci-log fix, strike 1/3";
  const ledgerPath = tmpLedgerPath([
    sweepDisposed({ task_id: "W1-T50", pr_number: 100, pr_url: "https://github.com/o/r/pull/100", disposition: "blocked-fixable", reason }),
  ]);
  const deps: BoardDeps = { plan: planOf([task({ id: "W1-T50" })]), ledgerPath, github: fakeGitHub() };
  const snapshot = computeBoardSnapshot(deps);

  assert.equal(snapshot.blockedPrs.length, 1);
  const row = snapshot.blockedPrs[0];
  // VERBATIM, unmodified, off the ledger line's own fields (W1-T186 named-reason doctrine) --
  // never reworded, never collapsed to the disposition word alone.
  assert.equal(row.disposition, "blocked-fixable");
  assert.equal(row.reason, reason);
  assert.equal(row.taskId, "W1-T50");
  assert.equal(row.prUrl, "https://github.com/o/r/pull/100");
});

// ── ACCEPTANCE 3: the SAME withholding rule status-board.ts already enforces -- an unverified
// candidate renders withheld, a checkable one renders its reason, both directions in ONE run ──

test("W1-T1006: an unverified candidate renders withheld and a checkable one renders its reason", () => {
  const lines = [
    sweepDisposed({
      pr_number: 2097,
      pr_url: "https://github.com/o/r/pull/2097",
      disposition: "blocked-ambiguous",
      reason: "review orphaned by a push, again",
    }),
  ];
  const ledgerPath = tmpLedgerPath(lines);
  const plan = planOf([]);

  // CHECKABLE: live GitHub state IS reachable this render -> the row carries its own reason.
  const checkable = computeBoardSnapshot({ plan, ledgerPath, github: fakeGitHub() });
  assert.equal(checkable.blockedPrs.length, 1);
  assert.equal(checkable.blockedPrs[0].reason, "review orphaned by a push, again");
  assert.equal(checkable.blockedPrsUnverifiedReason, undefined);

  // UNCHECKABLE: the SAME ledger, but GitHub's own read has failed THIS cycle -- every raw
  // candidate is withheld entirely (never replayed as current), and the withholding is itself
  // named -- an empty group must never be mistaken for "nothing blocked".
  const uncheckable = computeBoardSnapshot({
    plan,
    ledgerPath,
    github: fakeGitHub({ readFailed: () => true, readFailureReason: () => "rate_limit" }),
  });
  assert.equal(uncheckable.blockedPrs.length, 0, "an unreadable GitHub gateway must withhold every candidate, not print stale ones");
  assert.match(uncheckable.blockedPrsUnverifiedReason ?? "", /1 blocked-PR ledger entry/);
  assert.match(uncheckable.blockedPrsUnverifiedReason ?? "", /rate_limit/);
});

// ── ACCEPTANCE 4: the escalation and verify-human groups keep their OWN rows, unchanged, right
// alongside the new blocked-PR group -- a THIRD distinct kind, never folded into either ────────

test("W1-T1006: the escalation and verify human groups keep their rows unchanged", () => {
  const tasks = [task({ id: "W1-T900" }), task({ id: "W1-T901", verify: "human" })];
  const lines = [
    { run_id: "R1", task_id: "W1-T900", ts: "2026-08-18T00:00:00.000Z", step: "run.start" },
    {
      run_id: "R1",
      task_id: "W1-T900",
      ts: "2026-08-18T00:05:00.000Z",
      step: "escalation.issue_opened",
      issue_url: "https://github.com/o/r/issues/1",
      class: "BLOCKED",
    },
    sweepDisposed({ pr_number: 55, pr_url: "https://github.com/o/r/pull/55", disposition: "conflicted", reason: "merge conflict with a deletion" }),
  ];
  const ledgerPath = tmpLedgerPath(lines);
  const snapshot = computeBoardSnapshot({ plan: planOf(tasks), ledgerPath, github: fakeGitHub() });

  const escalationRow = snapshot.tasks.find((t) => t.taskId === "W1-T900");
  assert.equal(escalationRow?.needsHuman, true, "the escalation row keeps ITS OWN needsHuman flag, untouched");
  assert.equal(escalationRow?.escalationIssueUrl, "https://github.com/o/r/issues/1");

  const verifyRow = snapshot.tasks.find((t) => t.taskId === "W1-T901");
  assert.equal(verifyRow?.verifyHumanPending, true, "the verify:human row keeps ITS OWN field, untouched");
  assert.equal(verifyRow?.needsHuman, undefined, "verify:human is never widened into needsHuman");

  // The blocked-PR row arrives on its OWN field, alongside -- never instead of -- the two above.
  assert.equal(snapshot.blockedPrs.length, 1);
  assert.equal(snapshot.blockedPrs[0].prNumber, 55);
});

// ── ACCEPTANCE 5: a blocked PR row offers NO card affordance for an id the plan does not hold ──
//
// computeTaskCard (src/lib/task-card.ts) 404s for any id `deps.plan.byId` does not hold. A
// blocked-PR row's own taskId (when the ledger line even carried one) is not known, here, to be
// one of the ones the plan holds -- so this row must never wire the card-fetch affordance at
// all. reconcileRows (serve.ts) wires that affordance off ONE thing: whether the pushed row
// object itself carries a `taskId` field -- proven structurally over the served script's own
// source, the same discipline test/serve.test.ts's W1-T182/W1-T346 tests already use, plus the
// row template's ACTUAL rendered output carrying no expand-chevron glyph either.

test("W1-T1006: a blocked PR row offers no card link for a cardless id", () => {
  const html = renderShellHtml();

  const renderNeedsMeFn = html.match(/function renderNeedsMe\(tasks, feedbackEntries, inboxReady, inboxDrafting\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(renderNeedsMeFn, "renderNeedsMe must exist in the shell's inline script");
  const blockedPrPush = renderNeedsMeFn!.match(/for \(const r of latestBlockedPrs[\s\S]*?\}\);/)?.[0];
  assert.ok(blockedPrPush, "renderNeedsMe must push a row for each latestBlockedPrs entry");
  assert.doesNotMatch(
    blockedPrPush!,
    /taskId/,
    "a blocked-PR row push must never carry a taskId -- that field ALONE is what wires reconcileRows' card-fetch affordance",
  );
  // Contrast: the escalation/verify-human pushes DO carry taskId -- proving the omission above
  // is a deliberate asymmetry, not an accidental one shared by every row kind.
  const escalationPush = renderNeedsMeFn!.match(/rows\.push\(\{ key: `task:\$\{t\.taskId\}`[\s\S]*?\}\);/)?.[0];
  assert.match(escalationPush ?? "", /taskId: t\.taskId/, "sanity: the escalation row DOES carry taskId -- it legitimately resolves a real plan task");

  // The row's ACTUAL rendered HTML carries no expand-chevron glyph either -- belt and braces
  // over the structural proof above.
  const parts: Record<string, string | undefined> = {
    STATUS_LABELS: html.match(/const STATUS_LABELS = \{[\s\S]*?\};/)?.[0],
    statusBadge: html.match(/function statusBadge\(key\) \{[\s\S]*?\n  \}/)?.[0],
    needsMeBlockedPrRowHtml: html.match(/function needsMeBlockedPrRowHtml\(r\) \{[\s\S]*?\n  \}/)?.[0],
  };
  for (const [name, src] of Object.entries(parts)) assert.ok(src, `${name} must exist in the shell's inline script`);

  const renderRow = new Function(
    `${renderConsoleShellScript()}\n${parts.STATUS_LABELS}\n${parts.statusBadge}\n${parts.needsMeBlockedPrRowHtml}\nreturn needsMeBlockedPrRowHtml(arguments[0]);`,
  ) as (r: Record<string, unknown>) => string;

  // A row whose ledger line named a taskId that is NOT one of the 27 the plan actually holds
  // (design (v)'s own measured population, e.g. a TRIAGE-* id) -- still no card link renders.
  const rowHtml = renderRow({
    prNumber: 2097,
    prUrl: "https://github.com/o/r/pull/2097",
    disposition: "blocked-ambiguous",
    reason: "review orphaned by a push, again",
    taskId: "TRIAGE-fb-999",
  });
  assert.doesNotMatch(rowHtml, /row-chevron/, "no expand-chevron glyph -- this row offers no card affordance to click");
  assert.match(rowHtml, /PR #2097/);
  assert.match(rowHtml, /blocked-ambiguous/);
});

// ── The falsifier named in design (iii), also proven over the ACTUAL client render output: an
// unverified withholding and a checkable reason must render as textually DISTINCT rows ────────

test("W1-T1006: needsMeBlockedPrRowHtml and needsMeBlockedPrUnverifiedHtml render distinct output for the checkable vs. withheld cases", () => {
  const html = renderShellHtml();
  const parts: Record<string, string | undefined> = {
    STATUS_LABELS: html.match(/const STATUS_LABELS = \{[\s\S]*?\};/)?.[0],
    statusBadge: html.match(/function statusBadge\(key\) \{[\s\S]*?\n  \}/)?.[0],
    needsMeBlockedPrRowHtml: html.match(/function needsMeBlockedPrRowHtml\(r\) \{[\s\S]*?\n  \}/)?.[0],
    needsMeBlockedPrUnverifiedHtml: html.match(/function needsMeBlockedPrUnverifiedHtml\(reason\) \{[\s\S]*?\n  \}/)?.[0],
  };
  for (const [name, src] of Object.entries(parts)) assert.ok(src, `${name} must exist in the shell's inline script`);

  const renderRow = new Function(
    `${renderConsoleShellScript()}\n${parts.STATUS_LABELS}\n${parts.statusBadge}\n${parts.needsMeBlockedPrRowHtml}\nreturn needsMeBlockedPrRowHtml(arguments[0]);`,
  ) as (r: Record<string, unknown>) => string;
  const renderUnverified = new Function(
    `${renderConsoleShellScript()}\n${parts.STATUS_LABELS}\n${parts.statusBadge}\n${parts.needsMeBlockedPrUnverifiedHtml}\nreturn needsMeBlockedPrUnverifiedHtml(arguments[0]);`,
  ) as (reason: string) => string;

  const checkable = renderRow({ prNumber: 2097, disposition: "blocked-ambiguous", reason: "review orphaned by a push, again" });
  assert.match(checkable, /review orphaned by a push, again/);
  assert.doesNotMatch(checkable, /unverified/i);

  const withheld = renderUnverified("1 blocked-PR ledger entry could not be checked against live GitHub state (rate_limit) -- withheld rather than replay possibly-stale history as current");
  assert.match(withheld, /unverified/i);
  assert.match(withheld, /rate_limit/);
  assert.doesNotMatch(withheld, /review orphaned/, "the withheld row must never leak the raw ledger reason it declined to print");
});

// ── ACCEPTANCE 6 (grep, not a unit test per the task's own acceptance table): "blocked_pr in
// src/lib/board.ts" is satisfied by board.ts's own BoardSnapshot.blockedPrs field + the
// BlockedPrBlocker type import -- see src/lib/board.ts directly.
