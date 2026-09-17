import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView, type SweepPolicy } from "../src/lib/sweep.js";
import type { SupersessionVerdict } from "../src/lib/supersession.js";

// ── W1-T3731 — A PREREQUISITE IS NOT A SUPERSESSION ──────────────────────────────────────────
//
// MEASURED 2026-09-17. #5861 — the whole `rmd board` verb, 12 files, every check green except a
// review still PENDING — was closed by `rmd sweep` as "superseded-by #5886", five minutes after
// #5886 opened. #5886 is a TWO-FILE prerequisite split that Standing rule 25 demanded, and its own
// body says the src/ changes stay with #5861. Its paths are a SUBSET of #5861's.
//
// The producer was right about it: 2 of 12 shared paths is a partial overlap, and
// `fetchSupersessionVerdict` returned `"indeterminate"` — "supports neither finding". The
// DISPOSITION closed it anyway, because the row fired on the bare arithmetic ("a higher-numbered
// open pull request shares this task") and read the verdict only to carve out `"complementary"`,
// plus `"unique"` behind a flag that is off by default.
//
// Reopened by hand at 13:06 and closed AGAIN at 13:22. W1-T3535 records two earlier instances of
// the same arithmetic ("#5632 ... sharing NOT ONE changed path — closed #5630 and #5631").
//
// Closing an unmerged pull request is the most destructive act the sweep can take
// (`authority.ts:248`) and it was the one taking the weakest evidence the system holds. It now
// takes the strongest: `superseded` — every one of this pull request's changed paths is also
// changed by the newer one.

const NOW = Date.parse("2026-09-17T14:00:00.000Z");

/** The shape `deriveDisposition` reads, cast once — this suite varies exactly two fields. */
function openPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 5861,
    prUrl: "https://github.com/craigoley/remudero/pull/5861",
    headSha: "ffbd595",
    headRefName: "run-W1-T3685-1789620574548",
    taskId: "W1-T3685",
    title: "feat(cli): add rmd board to survey open pull requests across the fleet",
    checksState: "green",
    reviewState: "pending",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    supersededBy: 5886,
    ...over,
  } as unknown as OpenPrView;
}

const SUPERSEDED: SupersessionVerdict = {
  status: "superseded",
  evidence: { supersedingPrNumber: 5886, taskId: "W1-T3685", diff: { rawLineCount: 120, matchedHunks: 12 } },
  detail: "every one of #5861's 12 changed path(s) is also changed by #5886",
};
/** #5861's REAL verdict: 2 of 12 paths shared with the prerequisite. */
const INDETERMINATE: SupersessionVerdict = {
  status: "indeterminate",
  detail: "#5861 shares 2 of 12 changed path(s) with #5886 — a partial overlap supports neither finding",
};
const UNIQUE: SupersessionVerdict = {
  status: "unique",
  detail: "none of #5861's 12 changed path(s) is touched by #5886",
};

const disposition = (verdict?: SupersessionVerdict, policy: SweepPolicy = DEFAULT_SWEEP_POLICY) =>
  deriveDisposition(openPr(verdict ? { supersessionVerdict: verdict } : {}), policy, NOW).disposition;

test("only a positive superseded verdict closes a pull request", () => {
  // THE WHOLE RULE, stated once over every outcome the producer can reach. `stale` is the closing
  // disposition; anything else leaves the pull request open for a human or a later row.
  assert.equal(disposition(SUPERSEDED), "stale", "the one verdict that means duplicate");
  for (const [label, verdict] of [
    ["indeterminate", INDETERMINATE],
    ["unique", UNIQUE],
    ["complementary", { status: "complementary", detail: "different stages" } as SupersessionVerdict],
    ["absent", undefined],
  ] as const) {
    assert.notEqual(disposition(verdict), "stale", `a "${label}" verdict must not close a pull request`);
  }
});

test("an indeterminate verdict never closes", () => {
  // #5861's ACTUAL verdict, twice. The producer said in as many words that it supports neither
  // finding; treating that as a finding is what destroyed the work.
  assert.notEqual(disposition(INDETERMINATE), "stale");
  // And the flag that used to be the only thing standing here changes nothing either way.
  assert.notEqual(disposition(INDETERMINATE, { ...DEFAULT_SWEEP_POLICY, conceptCoexistenceEnabled: true }), "stale");
});

test("a unique verdict never closes without a flag", () => {
  // Sharing NOT ONE changed path is the strongest evidence of not being superseded this system can
  // produce, and it sat behind `conceptCoexistenceEnabled`, off by default — W1-T3535 measured the
  // cost twice. A properly completed rule-25 split produces exactly this shape, so before this
  // change the CORRECT split was punished harder than the incomplete one.
  assert.equal(DEFAULT_SWEEP_POLICY.conceptCoexistenceEnabled, false, "the flag is still off by default");
  assert.notEqual(disposition(UNIQUE), "stale", "and it is no longer what spares the pull request");
});

test("a genuine duplicate is still closed", () => {
  // THE ROW IS NARROWED, NOT DISABLED. Without this the change is not a fix, it is a removal — and
  // the reason still names the superseding pull request and the evidence behind it.
  const d = deriveDisposition(openPr({ supersessionVerdict: SUPERSEDED }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "stale");
  assert.match(d.reason, /superseded-by #5886/);
  assert.match(d.reason, /12 changed path\(s\) is also changed there/, "the reason carries the evidence, not just the number");
});
