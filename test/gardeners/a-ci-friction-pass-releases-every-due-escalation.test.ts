import assert from "node:assert/strict";
import { test } from "node:test";
import {
  closeCiFrictionReleases,
  releaseCiFrictionEscalations,
  type CiFrictionCausePrice,
  type CiFrictionEscalationIssues,
  type CiFrictionIssueComment,
} from "#src/lib/ci-friction-gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";

const NOW = Date.parse("2026-11-24T08:45:00.000Z");
const DAY = 24 * 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ISSUE = (n: number) => `https://github.com/acme/remudero/issues/${n}`;

const escalated = (key: string, n: number): LedgerRecord =>
  ({ step: "ci-friction.remedy_escalated", origin: `ci-friction:${key}`, issue_url: ISSUE(n), ts: at(20 * DAY) });
const below = (key: string): LedgerRecord => ({ step: "ci-friction.remedy_below_ladder", cause: key, ts: at(9 * DAY) });

function gateway(comments: Record<string, CiFrictionIssueComment[]> = {}) {
  const closed: string[] = [];
  const issues: CiFrictionEscalationIssues = {
    listComments: (url) => comments[url] ?? [],
    close: (url) => { closed.push(url); },
  };
  return { issues, closed };
}

async function pass(records: LedgerRecord[], issues: CiFrictionEscalationIssues) {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const log = (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); };
  const decided = releaseCiFrictionEscalations({ records, priced: [] as CiFrictionCausePrice[], nowMs: NOW, log });
  const released = await closeCiFrictionReleases(decided.due, issues, log);
  return { ...decided, released, rows };
}

test("W1-T14625: a pass releases every due escalation", async () => {
  const keys = Array.from({ length: 12 }, (_, i) => `check:stale-${i}`);
  const { issues, closed } = gateway();
  const out = await pass(keys.flatMap((k, i) => [escalated(k, 100 + i), below(k)]), issues);
  assert.equal(out.due.length, 12);
  assert.deepEqual(closed, keys.map((_, i) => ISSUE(100 + i)), "all 12 issues close in the one pass");
  assert.deepEqual(out.released, keys);
  assert.equal(out.outcomes.filter((o) => o.decision === "kept").length, 0, "no escalation is kept for a count");
  assert.equal(out.rows.filter((r) => r.step === "ci-friction.remedy_released").length, 12);
});

test("W1-T14625: an issue with a newer person comment stays open", async () => {
  const keys = Array.from({ length: 12 }, (_, i) => `check:stale-${i}`);
  const spoke = ISSUE(105);
  const { issues, closed } = gateway({ [spoke]: [
    { authorLogin: "remudero-fleet[bot]", authorType: "Bot", authorAssociation: "NONE", createdAt: at(2 * DAY), body: "Another escalation observed the same condition (run x)" },
    { authorLogin: "craigoley", authorType: "User", authorAssociation: "OWNER", createdAt: at(DAY), body: "keep this open, I'm on it" },
  ] });
  const out = await pass(keys.flatMap((k, i) => [escalated(k, 100 + i), below(k)]), issues);
  assert.equal(closed.length, 11);
  assert.ok(!closed.includes(spoke), "the issue a person spoke on last is never closed");
  const kept = out.rows.filter((r) => r.step === "ci-friction.remedy_release_kept");
  assert.deepEqual(kept.map((r) => r.extra?.cause), ["check:stale-5"]);
  assert.match(String(kept[0]!.extra?.reason), /a person commented after the fleet's newest comment/);
});
