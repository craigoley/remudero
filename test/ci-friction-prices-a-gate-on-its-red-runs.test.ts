import assert from "node:assert/strict";
import { test } from "node:test";
import { ciFrictionGatePricedPrs, ciFrictionLadder, priceCiFrictionCauses } from "../src/lib/ci-friction-gardener.js";
import type { CiFrictionCausePrice } from "../src/lib/ci-friction-gardener.js";
import type { CiFrictionRemedyTask, OwnerSearch } from "../src/lib/ci-friction-remedy.js";
import { measureGateFireRates, type GateFireRate, type GateWindowPr } from "../src/lib/gate-fire-rate.js";

// The ci-friction gardener priced every gate by the wall time of ALL its runs, green or red. The eight coverage-shard
// legs, each a long job that runs on every PR, became its eight costliest "causes" (W1-T7358 & co.) with no failure
// behind them, and because the ladder only ever looked at the top eight causes, nothing below them was ever filed.

const NOW = Date.parse("2026-10-13T12:00:00Z");
const run = (name: string, conclusion: string, minutes: number) => ({
  name, conclusion, startedAt: "2026-10-13T10:00:00Z",
  completedAt: new Date(Date.parse("2026-10-13T10:00:00Z") + minutes * 60_000).toISOString(),
});
const leg = (n: number, over: Partial<GateFireRate> = {}): GateFireRate => ({
  gate: `coverage-shard (${n}/8)`, prs: 240, runs: 260, redRuns: 0, refusals: 0, repaired: 0, overridden: 0,
  minutes: 3000, redMinutes: 0, redPrs: 0, ...over,
});

test("a gate's red runs carry their own minutes and pull requests beside its total runtime", () => {
  const prs: GateWindowPr[] = [
    { number: 1, merged: true, commits: [{ sha: "a1", rollup: [run("coverage-shard (1/8)", "SUCCESS", 17), run("coverage-shard (2/8)", "FAILURE", 4)] }] },
    { number: 2, merged: true, commits: [{ sha: "b1", rollup: [run("coverage-shard (1/8)", "SUCCESS", 16), run("coverage-shard (2/8)", "SUCCESS", 18)] }] },
  ] as GateWindowPr[];
  const gates = measureGateFireRates({ prs } as never).gates;
  const one = gates.find(g => g.gate === "coverage-shard (1/8)")!;
  const two = gates.find(g => g.gate === "coverage-shard (2/8)")!;
  assert.deepEqual([one.minutes, one.redMinutes, one.redPrs], [33, 0, 0], "a gate that never fired cost no friction");
  assert.deepEqual([two.minutes, two.redMinutes, two.redRuns, two.redPrs, two.prs], [22, 4, 1, 1, 2]);
  assert.deepEqual([one.redPrNumbers, two.redPrNumbers], [[], [1]], "the red pull requests are named, not only counted");
  const later = measureGateFireRates({ prs: [5, 3].map(number => ({ number, commits: [{ sha: `s${number}`, rollup: [run("lint", "FAILURE", 1)] }] })) } as never);
  assert.deepEqual(later.gates[0]?.redPrNumbers, [3, 5], "ascending, whatever order the window held them in");
});

test("a measured gate report names the PRs it prices, and a count it cannot name is never guessed", () => {
  const report = (gates: GateFireRate[], status: "measured" | "partial" = "measured") => ({ status, prsScanned: 9, neverFired: [], alwaysFired: [], gates });
  const named = leg(1, { redRuns: 2, redMinutes: 6, redPrs: 2, redPrNumbers: [4, 7] });
  const legacy = leg(2, { redRuns: 1, redMinutes: 3, redPrs: 1 }); // persisted before `redPrNumbers`: a count, no names
  const seen = (r: ReturnType<typeof report> | undefined) => { const out = ciFrictionGatePricedPrs(r); return [[...out.prs], out.unnamed]; };
  assert.deepEqual(seen(report([named, legacy])), [[4, 7], ["coverage-shard (2/8)"]]);
  assert.deepEqual(seen(report([leg(3, { redRuns: 1, redMinutes: 3, redPrs: 2, redPrNumbers: [4] })])), [[], ["coverage-shard (3/8)"]],
    "a list that disagrees with its own count names nothing");
  assert.deepEqual(seen(report([leg(4, { redRuns: 1, redMinutes: 0, redPrs: 1, redPrNumbers: [4] })])), [[], []], "an unpriced gate charges no PR");
  assert.deepEqual(seen(report([named], "partial")), [[], []], "a partial report prices nothing, so it charges no PR");
  assert.deepEqual(seen(undefined), [[], []]);
});

test("eight coverage-shard gate legs price as one check family on red-run minutes only", () => {
  const report = (gates: GateFireRate[]) => ({ status: "measured" as const, prsScanned: 260, neverFired: [], alwaysFired: [], gates });
  const priced = priceCiFrictionCauses([], report([
    ...[1, 2, 3, 4, 5, 6].map(n => leg(n)),
    leg(7, { redRuns: 2, redMinutes: 9, redPrs: 2 }),
    leg(8, { redRuns: 1, redMinutes: 5.5, redPrs: 1 }),
  ]), NOW);
  assert.deepEqual(priced, [{ cause: { kind: "check", name: "coverage-shard" }, minutes: 14.5, rounds: 3, prs: 3 }],
    "one family, priced on what its red runs cost, never on the 24,000 minutes the green ones took");
  const legacy = report([1, 2].map(n => { const { redMinutes: _, redPrs: __, ...rest } = leg(n, { redRuns: 5 }); return rest; }));
  assert.deepEqual(priceCiFrictionCauses([], legacy, NOW), [], "a report without red minutes prices nothing rather than total runtime");
});

test("settled causes do not consume the ladder depth that hides a draftable one", () => {
  const priced: CiFrictionCausePrice[] = Array.from({ length: 9 }, (_, i) => ({
    cause: { kind: "check" as const, name: `check-${i}` }, minutes: 100 - i, rounds: 1, prs: 1,
  }));
  const retired: CiFrictionRemedyTask[] = priced.slice(0, 8).map((p, i) => ({
    id: `W1-T90${i}`, origin: `ci-friction:check:${p.cause.name}`, status: "blocked", retired: true, files: ["src/lib/owner.ts"],
  }));
  const owner: OwnerSearch = { filesContaining: () => [{ file: "src/lib/owner.ts", hits: 1 }], fileExists: () => true };
  const out = ciFrictionLadder({ priced, rounds: [], tasks: retired, receipts: new Set(), escalated: new Set(), ownerSearch: owner, nowMs: NOW });
  assert.equal(out.next?.price.cause.name, "check-8", "the ninth cause is drafted once the eight above it are settled");
  assert.equal(out.ladder.length, 8, "the scorecard still reports the top eight");
  assert.ok(out.ladder.every(line => line.state === "retired"));
});
