import assert from "node:assert/strict";
import { test } from "node:test";
import { ciFrictionCauseState, judgeShareWindows, type ShareWindow } from "#src/lib/ci-friction-remedy.js";
import { ciFrictionRoundsMetric, flakeIncidentMetric, prHoursMetric } from "#src/lib/remedy-effect.js";

const label = { noun: "round", share: "share of fix rounds", sampleUnit: "count" } as const;
const judge = (before: ShareWindow, after: ShareWindow) => judgeShareWindows(before, after, 1, "check:scan", label);

test("sparse count remedies stay measuring instead of receiving an approximate credit", () => {
  const result = judge({ k: 1, n: 2 }, { k: 0, n: 6 });
  assert.equal(result.verdict, "pending");
  assert.ok(Math.abs(result.pValue! - 0.25) < 1e-12);
  assert.match(result.reason, /pointwise exact p=/);
  const other = judge({ k: 3, n: 114 }, { k: 0, n: 138 });
  assert.equal(other.verdict, "pending");
  assert.ok(Math.abs(other.pValue! - 8588 / 94125) < 1e-12);
});

test("an inconclusive observed count decrease never falls through to reopening a remedy", () => {
  const result = judge({ k: 1, n: 119 }, { k: 0, n: 119 });
  assert.equal(result.verdict, "pending");
  assert.ok(Math.abs(result.pValue! - 0.5) < 1e-12);
  const merge = Date.now() - 60_000;
  const rows = [
    { pr: 1, causeKey: "check:scan", at: new Date(merge - 50_000).toISOString() },
    { pr: 2, causeKey: "other", at: new Date(merge - 40_000).toISOString() },
    ...Array.from({ length: 6 }, (_, i) => ({ pr: i + 3, causeKey: "other", at: new Date(merge + i * 1000).toISOString() })),
  ];
  const task = { id: "W1-T1", origin: "ci-friction:check:scan#r2", status: "queued", retired: false,
    files: ["src/a.ts"], mergedAt: new Date(merge).toISOString() };
  assert.equal(ciFrictionCauseState("check:scan", [task], rows, merge + 60_000).state, "measuring");
});

test("count credits remain available for substantial falls and exposure-based debits for equal or worse shares", () => {
  assert.equal(judge({ k: 50, n: 200 }, { k: 10, n: 200 }).verdict, "credit");
  assert.equal(judge({ k: 8, n: 10 }, { k: 2, n: 10 }).verdict, "credit");
  assert.equal(judge({ k: 9, n: 10 }, { k: 6, n: 10 }).verdict, "pending");
  assert.equal(judge({ k: 2, n: 100 }, { k: 2, n: 100 }).verdict, "debit");
  assert.equal(judge({ k: 2, n: 100 }, { k: 3, n: 100 }).verdict, "debit");
  assert.equal(judge({ k: 2, n: 100 }, { k: 1, n: 10 }).verdict, "pending");
  assert.equal(judge({ k: 0, n: 100 }, { k: 1, n: 100 }).verdict, "unmeasurable");
  assert.equal(judge({ k: 1, n: 100 }, { k: 0, n: 0 }).verdict, "pending");
});

test("count metrics reject invalid observations without manufacturing a verdict", () => {
  for (const invalid of [{ k: -1, n: 2 }, { k: 3, n: 2 }, { k: 1, n: 1.5 }, { k: 0.5, n: 2 }, { k: NaN, n: 2 }, { k: 1, n: Infinity }]) {
    assert.equal(judge(invalid, { k: 0, n: 2 }).verdict, "unmeasurable");
    assert.equal(judge({ k: 1, n: 2 }, invalid).verdict, "unmeasurable");
  }
  assert.equal(judge({ k: 1, n: Number.MAX_SAFE_INTEGER }, { k: 0, n: 1 }).verdict, "unmeasurable");
});

test("large sparse and near-saturated populations enumerate the rare column", () => {
  const sparse = judge({ k: 1, n: 1_000_000_000 }, { k: 0, n: 3_000_000_000 });
  assert.equal(sparse.verdict, "pending");
  assert.ok(Math.abs(sparse.pValue! - 0.25) < 1e-12);
  const saturated = judge({ k: 1_000_000_000, n: 1_000_000_000 }, { k: 2_999_999_999, n: 3_000_000_000 });
  assert.equal(saturated.verdict, "pending");
  assert.ok(Math.abs(saturated.pValue! - 0.75) < 1e-12);
});

test("an exact five-percent boundary is not changed by floating-point log rounding", () => {
  for (const n of [1, 4, 7, 10, 1000]) assert.equal(judge({ k: 1, n }, { k: 0, n: 19 * n }).verdict, "credit");
  assert.equal(judge({ k: 19, n: 19 }, { k: 0, n: 1 }).verdict, "credit");
  assert.equal(judge({ k: 1, n: 1 }, { k: 0, n: 18 }).verdict, "pending");
});

test("large combinatorial totals retain a finite displayed probability", () => {
  const result = judge({ k: 500, n: 1000 }, { k: 450, n: 1000 });
  assert.equal(result.verdict, "credit");
  assert.ok(Number.isFinite(result.pValue) && result.pValue! > 0 && result.pValue! < 0.05);
});

test("explicit metric units keep PR-hours separate even when durations happen to be integers", () => {
  assert.equal(ciFrictionRoundsMetric([]).label.sampleUnit, "count");
  assert.equal(flakeIncidentMetric([]).label.sampleUnit, "count");
  const metric = prHoursMetric("flow-remedy", "flow-blocker", []);
  assert.equal(metric.label.sampleUnit, undefined);
  const legacy = judgeShareWindows({ k: 1, n: 2 }, { k: 0, n: 6 }, 1, "flow", metric.label);
  assert.equal(legacy.verdict, "credit", "this change must not reinterpret duration units as independent trials");
  assert.equal(legacy.pValue, undefined);
  const fractional = judgeShareWindows({ k: 0.5, n: 2.5 }, { k: 0.25, n: 3.5 }, 1, "flow", metric.label);
  assert.notEqual(fractional.verdict, "unmeasurable");
});

function choose(n: number, k: number): bigint {
  let value = 1n;
  for (let i = 1; i <= k; i++) value = value * BigInt(n - i + 1) / BigInt(i);
  return value;
}

test("exact count probabilities agree with independent integer enumeration of small contingency tables", () => {
  let controlled = 0;
  for (let bn = 1; bn <= 7; bn++) for (let an = 1; an <= 7; an++) {
    for (let bk = 1; bk <= bn; bk++) for (let ak = 0; ak <= an; ak++) {
      if (ak * bn >= bk * an) continue;
      const total = bk + ak, denominator = choose(bn + an, total);
      let numerator = 0n;
      for (let x = Math.max(0, total - bn); x <= ak; x++) numerator += choose(an, x) * choose(bn, total - x);
      const result = judge({ k: bk, n: bn }, { k: ak, n: an });
      assert.ok(Math.abs(result.pValue! - Number(numerator) / Number(denominator)) < 1e-12, `${bk}/${bn} -> ${ak}/${an}`);
      assert.equal(result.verdict, 20n * numerator <= denominator ? "credit" : "pending", `${bk}/${bn} -> ${ak}/${an}`);
      controlled++;
    }
  }
  assert.ok(controlled > 300, "positive control: the exact oracle covered both sparse and saturated tables");
});
