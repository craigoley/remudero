import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import type { GitHub, PrRef } from "../src/lib/status.js";

// ── W1-T306: BLOCKERS BY CLASS was listing `sweep.disposed` PRs whose disposition was still
// `blocked-fixable`/`blocked-ambiguous`/etc. in the LEDGER, even after GitHub confirmed the
// task actually MERGED — the ledger line is a stale snapshot from before the merge landed, and
// `deriveBlockedPrBlockers` never consulted the batched live projection (`projections`) the way
// its sibling `deriveIndeterminateBlockers` already does. All five entries in one live run were
// merged, so the section an operator reads first was mostly noise. Every test below is a plain
// object in, a plain object out: no real `gh`, no real ledger daemon — every seam
// `buildStatusBoard` exposes is injected exactly like the rest of this file's siblings.

const NOW_ISO = "2026-08-03T12:50:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "status-blockers-live-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function baseDeps(overrides: Partial<StatusBoardDeps> = {}): StatusBoardDeps {
  return {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => NOW_MS,
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    ...overrides,
  };
}

function ledgerLine(overrides: Record<string, unknown>): Record<string, unknown> {
  return { run_id: "R1", task_id: "daemon", ts: NOW_ISO, ...overrides };
}

function writeLedger(lines: Record<string, unknown>[]): string {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "status-blockers-live-ledger-")), "ledger.ndjson");
  writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return ledgerPath;
}

// Three tasks: W1-T50 (owns its own merged PR #100 via the plan's `pr:` field), W1-T51 (owns
// merged PR #200, used to prove PR-NUMBER matching for a blocked line that names no task), and
// W1-T52 (its `pr:` field, #300, is still OPEN — must remain a genuine blocker).
const PLAN_YAML = `
- id: W1-T50
  title: already merged, owns pr 100
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 100
- id: W1-T51
  title: already merged, owns pr 200
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 200
- id: W1-T52
  title: still genuinely blocked, owns pr 300
  repo: remudero
  type: implement
  verify: auto
  depends_on: []
  status: queued
  pr: 300
`;

function plan(): Plan {
  return loadPlanFromYaml(PLAN_YAML, "fixture");
}

const MERGED_PRS: Record<number, PrRef> = {
  100: { number: 100, url: "https://x/100", state: "MERGED" },
  200: { number: 200, url: "https://x/200", state: "MERGED" },
  300: { number: 300, url: "https://x/300", state: "OPEN" },
};

function fakeGithub(): GitHub {
  return {
    prByRef: (ref) => MERGED_PRS[typeof ref === "number" ? ref : Number(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
    readFailed: () => false,
  };
}

test("buildStatusBoard: BLOCKERS BY CLASS — a blocked-fixable PR whose OWNING task GitHub now confirms MERGED is dropped, not listed as noise", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T50",
      pr_number: 100,
      pr_url: "https://x/100",
      disposition: "blocked-fixable",
      reason: "required checks red — ci-log fix, strike 1/3",
      acted: true,
    }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 100),
    undefined,
    "PR #100's owning task W1-T50 is GitHub-confirmed merged — it must not render as a blocker",
  );
  const text = renderStatusBoardText(model);
  assert.doesNotMatch(text, /#100/);
});

test("buildStatusBoard: BLOCKERS BY CLASS — a blocked PR line naming NO owning task (sweep.ts's own 'SWEEP' fallback) is STILL dropped when its own PR NUMBER is one GitHub confirms merged", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "SWEEP",
      pr_number: 200,
      pr_url: "https://x/200",
      disposition: "blocked-ambiguous",
      reason: "no owning task named",
      acted: false,
    }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  assert.equal(
    model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 200),
    undefined,
    "PR #200 is GitHub-confirmed merged (W1-T51's own `pr:` field) even though the ledger line names no owning task — it must still be dropped, matched by PR number",
  );
});

test("buildStatusBoard: BLOCKERS BY CLASS — a blocked PR whose owning task is GitHub-confirmed still OPEN remains a genuine blocker, so the live-merge check never over-suppresses", () => {
  const ledgerPath = writeLedger([
    ledgerLine({
      step: "sweep.disposed",
      task_id: "W1-T52",
      pr_number: 300,
      pr_url: "https://x/300",
      disposition: "conflicted",
      reason: "merge conflict with main",
      acted: true,
    }),
  ]);

  const model = buildStatusBoard(tmpRoot(), ledgerPath, baseDeps({ plan: plan(), github: fakeGithub() }));

  const row = model.blockers.rows.find((r) => r.kind === "blocked_pr" && r.prNumber === 300);
  assert.ok(row, "PR #300's owning task W1-T52 is still OPEN on GitHub — it must remain a listed blocker");
  if (row!.kind === "blocked_pr") {
    assert.equal(row!.taskId, "W1-T52");
    assert.equal(row!.disposition, "conflicted");
  }
  const text = renderStatusBoardText(model);
  assert.match(text, /#300/);
});
