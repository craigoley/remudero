// test/spend-figures-name-their-channel.test.ts — W1-T2240: every cost figure this project
// reports (the console glance strip via lib/glance.ts's computeGlanceSpend, the ancestor this
// task labels) divides by a denominator that only ever includes SPAWNS the fleet itself issued.
// No ledger step anywhere records an operator/interactive session's cost_usd (rationale (1)), so
// "spend today" has always silently meant "FLEET spend today". This suite pins the label added
// to close that gap: the figure now NAMES the channel it covers (`channel: "fleet"`), the
// session channel it does NOT cover is rendered as `null` (unmeasured) rather than a fabricated
// `0`, nothing computes a session cost from anywhere, the fleet figure's VALUE does not move by
// even a cent, and the pre-existing "…"-for-unknown refusal in serve.ts (the same defect class,
// one level down) is untouched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeGlanceSpend } from "../src/lib/glance.js";
import { deriveDayCostUsd, deriveWeekCostUsd } from "../src/lib/sweep.js";

const NOW = Date.parse("2026-07-29T18:00:00.000Z"); // a Wednesday

const LINES = [
  { ts: "2026-07-27T01:00:00.000Z", run_id: "R1", task_id: "W1-T1", step: "verdict", verdict: "merged", cost_usd: 2 },
  { ts: "2026-07-29T09:00:00.000Z", run_id: "R2", task_id: "W1-T2", step: "verdict", verdict: "merged", cost_usd: 3 },
  { ts: "2026-07-29T09:05:00.000Z", run_id: "R3", task_id: "W1-T3", step: "verdict", verdict: "blocked_review", cost_usd: 1 },
];

test("W1-T2240: computeGlanceSpend names the channel its figures cover -- channel is exactly 'fleet', never absent and never a bare total", () => {
  const glance = computeGlanceSpend(LINES, NOW);
  assert.equal(glance.channel, "fleet", "the figure must say WHICH channel it measures, not read as a project total");
});

test("W1-T2240: the operator-session channel is rendered as unmeasured (null), never as a fabricated zero -- even when the fleet side has real spend", () => {
  const glance = computeGlanceSpend(LINES, NOW);
  assert.equal(glance.sessionSpendUsd, null, "no ledger step records session cost -- absence must read as UNKNOWN, not '$0 spent'");
  assert.notEqual(glance.sessionSpendUsd, 0, "0 would claim sessions measurably cost nothing, which is not known");
});

test("W1-T2240: sessionSpendUsd stays null even over an EMPTY ledger -- it is not a derived '0 rows summed to 0', it is a constant absence", () => {
  const glance = computeGlanceSpend([], NOW);
  assert.equal(glance.sessionSpendUsd, null);
  assert.equal(glance.channel, "fleet", "channel is named even when there is nothing to report on that channel");
});

test("W1-T2240: no session cost is estimated or imputed anywhere -- computeGlanceSpend's return literal assigns sessionSpendUsd the CONSTANT null, never an expression over `lines`", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/glance.ts", import.meta.url)), "utf8");
  assert.match(
    src,
    /sessionSpendUsd:\s*null,/,
    "sessionSpendUsd must be assigned the literal `null` in the return -- any expression here would mean a value is being computed for a channel this task's design (iii) forbids estimating",
  );
  // And the TYPE pins it too -- `null` (not `number | null`), so a future computation could not
  // silently start flowing through this field without a type change a reviewer would see.
  assert.match(
    src,
    /sessionSpendUsd:\s*null;/,
    "the GlanceSpend interface must type sessionSpendUsd as the literal `null`, not `number | null`",
  );
});

test("W1-T2240: the fleet figure's VALUE is unchanged by the labelling -- spendTodayUsd/spendWeekUsd still equal deriveDayCostUsd/deriveWeekCostUsd over the SAME lines, verbatim", () => {
  const glance = computeGlanceSpend(LINES, NOW);
  assert.equal(glance.spendTodayUsd, deriveDayCostUsd(LINES, NOW));
  assert.equal(glance.spendWeekUsd, deriveWeekCostUsd(LINES, NOW));
  // deriveWindowCostUsd sums PER-RUN (verdict line preferred, any cost_usd line otherwise) --
  // every one of R1/R2/R3 carries its OWN run_id and its OWN "verdict" step, so all three
  // contribute regardless of their `verdict` field's value (merged vs blocked_review).
  assert.equal(glance.spendTodayUsd, 4, "R2 ($3) + R3 ($1), both dated today; R1 is yesterday");
  assert.equal(glance.spendWeekUsd, 6, "R1 ($2) + R2 ($3) + R3 ($1) = $6, all in the same UTC week");
});

test("W1-T2240: mergedToday is untouched by this task -- still counts verdict:'merged' lines dated today (UTC), same as before the channel label existed", () => {
  const glance = computeGlanceSpend(LINES, NOW);
  assert.equal(glance.mergedToday, 1, "only R2 -- merged AND dated today; R1 is merged but yesterday, R3 is not merged");
});

test("W1-T2240: the existing refusal to fabricate an unknown spend still holds -- serve.ts's latestSpend ? costLabel(...) : \"…\" guard is untouched by this task", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/lib/serve.ts", import.meta.url)), "utf8");
  assert.match(
    src,
    /latestSpend \? latestSpend\.mergedToday : "…"/,
    "merged-today must still render an ellipsis, never a fabricated 0, before any snapshot has landed",
  );
  assert.match(
    src,
    /latestSpend \? costLabel\(latestSpend\.spendTodayUsd\) : "…"/,
    "spend-today must still refuse to fabricate a value when latestSpend is not yet known",
  );
  assert.match(
    src,
    /latestSpend \? costLabel\(latestSpend\.spendWeekUsd\) : "…"/,
    "spend-week must still refuse to fabricate a value when latestSpend is not yet known",
  );
});
