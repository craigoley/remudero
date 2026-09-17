/**
 * test/sweep-superseded-evidence.test.ts — W1-T2384, Q2.
 *
 * THE ONE THING THIS TASK MUST PROVE IT DID NOT DO. `OpenPrView.supersessionVerdict` now has a
 * producer (`hydrateSupersessionVerdicts`, lib/open-prs-rest.ts, assigned at `buildOpenPrViews`),
 * so for the first time the field is POPULATED in the real gateway. Both policy flags that read it
 * — `supersessionDisposalEnabled` and `conceptCoexistenceEnabled` — stay at their defaults, so the
 * disposition of every PR must be byte-for-byte what it was when the field was always `undefined`.
 *
 * THE TEST IS A DIFFERENTIAL, not a restatement: the SAME view is dispositioned twice, once with a
 * verdict attached and once without, and the two results are compared with `deepEqual`. A test that
 * merely asserted "disposition === stale" would still pass if the verdict had quietly changed
 * WHICH row matched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, deriveDisposition, type OpenPrView, type SupersessionVerdict } from "../src/lib/sweep.js";

const SUPERSEDED: SupersessionVerdict = {
  status: "superseded",
  evidence: { supersedingPrNumber: 1960, taskId: "W1-T900", diff: { rawLineCount: 14, matchedHunks: 2 } },
  detail: "every one of #1955's 2 changed path(s) is also changed by #1960",
};
const UNIQUE: SupersessionVerdict = { status: "unique", detail: "none of #1955's paths is touched by #1960" };
const INDETERMINATE: SupersessionVerdict = { status: "indeterminate", detail: "the diff read observed no changed lines", diff: { rawLineCount: 0, matchedHunks: 0 } };

/** A minimal open PR carrying the arithmetic's own flag — the population the producer is scoped to. */
function supersededView(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1955,
    prUrl: "https://github.com/craigoley/remudero/pull/1955",
    headSha: "aaaa111",
    headRefName: "run-W1-T900-1787000000000",
    taskId: "W1-T900",
    title: "feat(x): a thing",
    checksState: "green",
    reviewState: "success",
    supersededBy: 1960,
    ...over,
  } as unknown as OpenPrView;
}

test("W1-T3731 (reverses W1-T2384): the verdict is what decides, and it decides at the defaults", () => {
  // W1-T2384 deliberately made a populated verdict inert at the shipped defaults, so wiring the
  // detector could not move any disposition. That conservatism is what left the arithmetic in
  // charge, and the arithmetic destroyed #5861 (and, per W1-T3535, #5630/#5631 before it). The
  // verdict now decides at the defaults: only "superseded" closes.
  const closed = deriveDisposition(supersededView({ supersessionVerdict: SUPERSEDED }), DEFAULT_SWEEP_POLICY, Date.now());
  assert.equal(closed.disposition, "stale", "a positive verdict closes");
  for (const [label, verdict] of [["unique", UNIQUE], ["indeterminate", INDETERMINATE]] as const) {
    const spared = deriveDisposition(supersededView({ supersessionVerdict: verdict }), DEFAULT_SWEEP_POLICY, Date.now());
    assert.notEqual(spared.disposition, "stale", `a "${label}" verdict must not close a pull request`);
  }
  const noVerdict = deriveDisposition(supersededView(), DEFAULT_SWEEP_POLICY, Date.now());
  assert.notEqual(noVerdict.disposition, "stale", "and neither does no verdict at all");
});

test("W1-T2384: the DEFAULTS this rests on are actually off — a precondition, not an assumption", () => {
  assert.notEqual(DEFAULT_SWEEP_POLICY.supersessionDisposalEnabled, true, "supersessionDisposalEnabled must default off");
  assert.notEqual(DEFAULT_SWEEP_POLICY.conceptCoexistenceEnabled, true, "conceptCoexistenceEnabled must default off");
});

test("W1-T2384: the differential is not vacuous — flipping a flag DOES move the disposition, so the test above is measuring something", () => {
  const on = { ...DEFAULT_SWEEP_POLICY, supersessionDisposalEnabled: true };
  const off = deriveDisposition(supersededView({ supersessionVerdict: SUPERSEDED }), DEFAULT_SWEEP_POLICY, Date.now());
  const flipped = deriveDisposition(supersededView({ supersessionVerdict: SUPERSEDED }), on, Date.now());
  assert.notDeepEqual(flipped, off, "with the flag ON the verdict reaches its row — proving the OFF case above is a real guard");
});

test("W1-T2384: a PR the arithmetic never flagged carries no verdict and is unchanged", () => {
  const plain = { ...supersededView(), supersededBy: undefined } as unknown as OpenPrView;
  const a = deriveDisposition(plain, DEFAULT_SWEEP_POLICY, Date.now());
  const b = deriveDisposition({ ...plain, supersessionVerdict: undefined } as unknown as OpenPrView, DEFAULT_SWEEP_POLICY, Date.now());
  assert.deepEqual(a, b);
});
