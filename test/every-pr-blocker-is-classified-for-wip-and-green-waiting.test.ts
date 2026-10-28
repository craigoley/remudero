import assert from "node:assert/strict";
import { test } from "node:test";

import * as wip from "#src/lib/adaptive-wip.js";
import * as incidents from "#src/lib/incident-invariants.js";
import { BLOCKER_SLO_MS, PR_BLOCKERS } from "#src/lib/pr-blocker.js";

/**
 * W1-T9673 — W1-T9633 (#12044) added security-alert-hold and security-unknown-hold to pr-blocker.ts, for a
 * mergeable PR that read awaiting-arm before. The WIP bound and the green-work-waiting incident each kept their
 * own blocker vocabulary, so both holds counted as neither stuck nor green waiting. Each reader now places every
 * blocker on purpose, and this census fails the day a new one is added without a place.
 */

const NOW = Date.parse("2026-10-15T18:00:00.000Z");
const disposed = (pr: number, blocker: string, ageMs: number, atMs = NOW - 60_000) => ({
  ts: new Date(atMs).toISOString(), step: "sweep.disposed", disposition: "mergeable", pr_number: pr, blocker,
  blocker_age_ms: ageMs,
});

test("W1-T9673: every pr-blocker.ts blocker is classified by the wip bound and the green-waiting incident", () => {
  assert.ok(PR_BLOCKERS.length >= 17, `the census must walk the whole vocabulary, read ${PR_BLOCKERS.length}`);
  const wipClass = wip.WIP_BLOCKER_CLASS as Record<string, unknown> | undefined;
  const green = incidents.GREEN_WORK_WAITING_BLOCKER as Record<string, unknown> | undefined;
  assert.ok(wipClass && green, "both readers export their blocker classification");
  const unplacedWip = PR_BLOCKERS.filter((b) => !Object.hasOwn(wipClass, b) || !["parked", "ageing", "moving"].includes(String(wipClass[b])));
  const unplacedGreen = PR_BLOCKERS.filter((b) => !Object.hasOwn(green, b) || typeof green[b] !== "boolean");
  assert.deepEqual(unplacedWip, [], "adaptive-wip.ts must place each blocker as parked, ageing or moving");
  assert.deepEqual(unplacedGreen, [], "incident-invariants.ts must say of each blocker whether it is green work waiting");
  const known = new Set<string>(PR_BLOCKERS);
  assert.deepEqual(Object.keys(wipClass).filter((b) => !known.has(b)), [], "no stale blocker name in the WIP bound");
  assert.deepEqual(Object.keys(green).filter((b) => !known.has(b)), [], "no stale blocker name in the incident rule");
});

test("W1-T9673: a security hold past its slo counts as a stuck owned pr", () => {
  const past = BLOCKER_SLO_MS + 60_000;
  const lines = [
    disposed(1, "security-alert-hold", past),
    disposed(2, "security-unknown-hold", past),
    disposed(3, "security-alert-hold", 5 * 60_000),
    disposed(4, "awaiting-arm", past),
  ];
  assert.equal(wip.deriveStuckOwnedCount(lines, [1, 2, 3, 4], NOW), 2,
    "both security holds past the SLO are stuck; one under it and awaiting-arm are not");
  assert.equal(wip.deriveStuckOwnedCount(lines, [3], NOW + BLOCKER_SLO_MS), 1, "a young hold turns stuck as it ages");
});

test("W1-T9673: green work waiting counts a security-held pr and names its blocker", () => {
  const rule = incidents.NO_MERGES_WITH_GREEN_QUEUE_RULE_ID;
  const rows: Record<string, unknown>[] = [];
  for (let t = NOW - 4 * 60 * 60_000 + 60_000; t <= NOW; t += 10 * 60_000) {
    rows.push(disposed(11936, "security-unknown-hold", 0, t), disposed(11910, "security-alert-hold", 0, t));
  }
  const finding = incidents.evaluateIncidentInvariants(rows, NOW).find((f) => f.ruleId === rule);
  assert.ok(finding, "green PRs held only at a security hold, with no merge, are green work waiting");
  assert.match(finding!.message, /green-queued=2 /);
  assert.match(finding!.message, /security-unknown-hold=1/);
  assert.match(finding!.message, /security-alert-hold=1/);
  assert.doesNotMatch(finding!.message, /awaiting-arm/);

  const notGreen = rows.map((r) => ({ ...r, blocker: "own-red" }));
  assert.ok(!incidents.evaluateIncidentInvariants(notGreen, NOW).some((f) => f.ruleId === rule), "a red PR is not green work waiting");
});
