import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS, DEPENDABOT_STUCK_PR_AGE_MS, prioritizeDepReviewRepairs, type DepReviewRepairSnapshot } from "#src/lib/dep-review.js";
import { freshReadGeneration, TICK_READ_MAX_AGE_MS } from "#src/lib/read-plane.js";

// Host RECON 2026-10-30 over 2026-10-23..30: the daemon reached its triage step a median 11.4 min (p90 16.2, max
// 35.2) after the tick read, so a five-minute bound refused the repair ordering 96 times in 98, and #15180's repair
// feedback waited 30 h at FIFO behind incident-* entries.
const NOW = Date.parse("2026-10-30T00:50:10.323Z");
const MIN = 60_000;
const HEAD = "77845714ff7292ceadb862e39755bc6b925e5e08";
const ID = "fb-dep-review-69bc59bf88007e5e";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "rmd-dep-repair-age-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "dep-review-holds", "craigoley", "remudero");
  mkdirSync(dir, { recursive: true });
  const bumps = [{ dependency: "@anthropic-ai/claude-code", fromVersion: "2.1.303", toVersion: "2.1.310" }];
  writeFileSync(join(dir, "own-red-proposals.json"), JSON.stringify({ proposals: [{ feedbackId: ID, prNumbers: [15180, 15177, 15182], bumps: ["@anthropic-ai/claude-code@2.1.310"] }] }));
  writeFileSync(join(dir, "PR15180.json"), JSON.stringify({ ownRed: { feedbackId: ID, headSha: HEAD, bumps, redChecks: ["ci-gate"], firstSeenMs: NOW - 34 * 60 * MIN, lastSeenMs: NOW } }));
  const candidates = [...Array.from({ length: 8 }, (_, i) => `incident-${i}`), ID];
  const snapshot = (ageMs: number): DepReviewRepairSnapshot => ({ owner: "craigoley", repo: "remudero", asOfMs: NOW - ageMs, prs: [{
    prNumber: 15180, headSha: HEAD, headRefName: "dependabot/npm_and_yarn/deploy/image-cli-minor-and-patch-4d1c0e", checksState: "red",
    createdAt: "2026-10-28T12:55:58Z",
  }] });
  return { root, candidates, snapshot };
}

test("a dependency repair is ranked on a snapshot as old as the triage step really receives it", async (t) => {
  const f = fixture(t);
  for (const ageMin of [11.4, 16.2, 35.2]) {
    const rows: Array<{ step: string; extra: Record<string, unknown> }> = [];
    const ordered = await prioritizeDepReviewRepairs(f.candidates, f.root, f.snapshot(ageMin * MIN), NOW, (step, extra) => rows.push({ step, extra }));
    assert.equal(ordered[0], ID, `a ${ageMin} min snapshot ranks the repair first`);
    assert.deepEqual(rows.map((r) => r.step), ["auto_triage.repair_priority"]);
  }
});

test("past the stuck-PR horizon a snapshot is stale and FIFO stands, naming why", async (t) => {
  const f = fixture(t);
  assert.equal(DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS, DEPENDABOT_STUCK_PR_AGE_MS, "the bound is the horizon the ordering serves");
  assert.ok(DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS > TICK_READ_MAX_AGE_MS);
  const rows: Array<Record<string, unknown>> = [];
  const ordered = await prioritizeDepReviewRepairs(f.candidates, f.root, f.snapshot(DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS + 1), NOW, (_step, extra) => rows.push(extra));
  assert.deepEqual(ordered, f.candidates);
  assert.equal(rows[0]?.reasonCode, "snapshot-stale");
});

test("the read plane serves the repair consumer a generation the tick bound would refuse", () => {
  const published = { generation: 7, source: "worker" as const, publishedAtMs: NOW - 12 * MIN, settledAtMs: NOW - 11.4 * MIN, facts: {} };
  const clock = { now: () => NOW, date: () => new Date(NOW), iso: () => new Date(NOW).toISOString() };
  assert.equal(freshReadGeneration(published, { consumer: "auto_triage_repair", clock }), undefined, "the tick bound alone refuses it");
  assert.equal(freshReadGeneration(published, { consumer: "auto_triage_repair", clock, maxAgeMs: DEPENDABOT_REPAIR_SNAPSHOT_MAX_AGE_MS }), published);
});
