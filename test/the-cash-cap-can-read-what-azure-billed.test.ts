import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CASH_METRICS_RESOURCE_ENV,
  IMDS_TOKEN_URL,
  foldMetrics,
  metricsUrl,
  priceTokenCounts,
  readCashActuals,
  utcDayTimespan,
} from "../src/lib/cash-actuals.js";
import type { Config } from "../src/lib/config-schema.js";

const cfg = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["cash"] } } as unknown as Config;
const clock = { iso: () => "2026-09-15T12:00:00.000Z" };

/** The REAL payload shape, transcribed from the live account on 2026-09-17 for 2026-09-15. */
const livePayload = {
  value: [
    { name: { value: "InputTokens" }, timeseries: [
      { metadatavalues: [{ value: "gpt-5-nano" }], data: [{ total: 16_895_445 }] },
      { metadatavalues: [{ value: "gpt-oss-120b" }], data: [{ total: 115_279 }] },
    ] },
    { name: { value: "OutputTokens" }, timeseries: [
      { metadatavalues: [{ value: "gpt-5-nano" }], data: [{ total: 251_859 }] },
      { metadatavalues: [{ value: "gpt-oss-120b" }], data: [{ total: 2_950 }] },
    ] },
  ],
};

test("the live 2026-09-15 payload prices to what Azure billed, within 5% of the local settled sum", () => {
  const { usd, priced } = priceTokenCounts(foldMetrics(livePayload));
  // nano 16,895,445 x $0.05/M + 251,859 x $0.40/M = 0.84477 + 0.10074 = $0.94551
  // oss  115,279    x $0.15/M +   2,950 x $0.60/M = 0.01729 + 0.00177 = $0.01906
  assert.ok(Math.abs(usd - 0.96458) < 0.0005, `expected ~$0.9646, got ${usd}`);
  assert.ok(Math.abs(priced["gpt-5-nano"].usd - 0.94551) < 0.0005);
  assert.ok(Math.abs(priced["gpt-oss-120b"].usd - 0.01906) < 0.0005);
  // THE RECONCILIATION THIS WHOLE MODULE EXISTS FOR: the local ledger settled $0.9270 that day and
  // CHARGED $2.6771 against the cap. Azure agrees with the settled figure and not the charge.
  assert.ok(Math.abs(usd - 0.9270) / 0.9270 < 0.05, "Azure must agree with the settled sum, not the charge");
  assert.ok(usd < 2.6771 / 2, "and must be nowhere near the inflated charge");
});

test("a deployment with no price row is NAMED, never costed at zero", () => {
  const { usd, unpriced, priced } = priceTokenCounts({
    "gpt-oss-120b": { inputTokens: 1_000_000, outputTokens: 0 },
    "DeepSeek-V4-Flash": { inputTokens: 9_000_000, outputTokens: 9_000_000 },
  });
  assert.deepEqual(unpriced, ["DeepSeek-V4-Flash"], "an unknown deployment is reported");
  assert.equal(priced["DeepSeek-V4-Flash"], undefined, "and is not invented into the total");
  assert.ok(Math.abs(usd - 0.15) < 1e-9, "only the priced row counts");
});

test("a zero-traffic deployment is skipped rather than reported unpriced", () => {
  // Azure lists EVERY deployment on the account, most with no traffic. Reporting those as unpriced
  // would make the honest-gap signal noise, and noise is how a real gap gets ignored.
  const { unpriced } = priceTokenCounts({ "never-heard-of-it": { inputTokens: 0, outputTokens: 0 } });
  assert.deepEqual(unpriced, []);
});

test("the timespan is the UTC day of the clock reading the allowance already uses", () => {
  assert.deepEqual(utcDayTimespan("2026-09-15T12:00:00.000Z"), { from: "2026-09-15T00:00:00Z", to: "2026-09-15T23:59:59Z" });
  assert.throws(() => utcDayTimespan("not-a-date"), /unreadable clock reading/);
});

test("the URL carries the deployment filter, because without it Azure answers 0 for a busy day", () => {
  // MEASURED 2026-09-17: the unfiltered call returned HTTP 200 with empty series while the resource
  // really had traffic. A missing filter is therefore INDISTINGUISHABLE from a quiet day.
  const url = metricsUrl("/subscriptions/s/resourceGroups/g/providers/Microsoft.CognitiveServices/accounts/a", {
    from: "2026-09-15T00:00:00Z", to: "2026-09-15T23:59:59Z",
  });
  assert.match(url, /providers\/microsoft\.insights\/metrics\?/);
  assert.match(decodeURIComponent(url), /ModelDeploymentName eq '\*'/);
  assert.match(decodeURIComponent(url), /metricnames=InputTokens,OutputTokens/);
  assert.match(decodeURIComponent(url), /timespan=2026-09-15T00:00:00Z\/2026-09-15T23:59:59Z/);
});

test("an unreachable Azure is UNAVAILABLE, never $0 — a fabricated zero would authorise the whole day", async () => {
  const out = await readCashActuals(cfg, {
    env: { [CASH_METRICS_RESOURCE_ENV]: "/subscriptions/s/x" },
    clock,
    fetchImpl: (async () => { throw new Error("ENETUNREACH"); }) as unknown as typeof fetch,
  });
  assert.equal(out.kind, "unavailable");
  assert.match(String((out as { reason: string }).reason), /ENETUNREACH/);
});

test("an unset resource id is UNAVAILABLE and says which name to set", async () => {
  const out = await readCashActuals(cfg, { env: {}, clock, fetchImpl: (async () => { throw new Error("never called"); }) as unknown as typeof fetch });
  assert.equal(out.kind, "unavailable");
  assert.match(String((out as { reason: string }).reason), /RMD_CASH_METRICS_RESOURCE_ID is unset/);
});

test("a 403 from Azure is reported as a status, not swallowed into a zero", async () => {
  const out = await readCashActuals(cfg, {
    env: { [CASH_METRICS_RESOURCE_ENV]: "/subscriptions/s/x" },
    clock,
    fetchImpl: (async (url: string) =>
      String(url).startsWith("http://169.254.169.254")
        ? new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
        : new Response("denied", { status: 403 })) as unknown as typeof fetch,
  });
  assert.equal(out.kind, "unavailable");
  assert.match(String((out as { reason: string }).reason), /HTTP 403/);
});

test("the IMDS token request bypasses the cache, because a grant does not reach a cached token", async () => {
  // MEASURED 2026-09-17: a fresh Monitoring Reader assignment still answered 403 for 15 minutes
  // until the cache was bypassed. Azure's own error body names the remedy.
  let tokenUrlSeen = "";
  await readCashActuals(cfg, {
    env: { [CASH_METRICS_RESOURCE_ENV]: "/subscriptions/s/x" },
    clock,
    fetchImpl: (async (url: string) => {
      if (String(url).startsWith("http://169.254.169.254")) { tokenUrlSeen = String(url); return new Response(JSON.stringify({ access_token: "t" }), { status: 200 }); }
      return new Response(JSON.stringify(livePayload), { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.ok(tokenUrlSeen.startsWith(IMDS_TOKEN_URL), "the documented IMDS endpoint, not a configurable one");
  assert.match(tokenUrlSeen, /bypass_cache=true/);
});

test("a successful read reports the priced total and the day it observed", async () => {
  const out = await readCashActuals(cfg, {
    env: { [CASH_METRICS_RESOURCE_ENV]: "/subscriptions/s/x" },
    clock,
    fetchImpl: (async (url: string) =>
      String(url).startsWith("http://169.254.169.254")
        ? new Response(JSON.stringify({ access_token: "t" }), { status: 200 })
        : new Response(JSON.stringify(livePayload), { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal(out.kind, "read");
  const read = out as Extract<typeof out, { kind: "read" }>;
  assert.ok(Math.abs(read.usd - 0.96458) < 0.0005);
  assert.equal(read.observedAtIso, "2026-09-15T12:00:00.000Z");
  assert.deepEqual(Object.keys(read.byDeployment).sort(), ["gpt-5-nano", "gpt-oss-120b"]);
});

// ── the judgement, which is pure so `rmd doctor` keeps its no-network refusal ───────────────────

import { CASH_SPEND_WARN_FRACTION, judgeCashSpend } from "../src/lib/doctor.js";

const read = (usd: number, unpriced: string[] = []) =>
  ({ kind: "read", usd, byDeployment: {}, unpriced, observedAtIso: "2026-09-17T12:00:00.000Z" }) as const;

test("spend under the warn fraction is OK, and the number is always shown", () => {
  const c = judgeCashSpend(read(1.0), 25);
  assert.equal(c.verdict, "OK");
  assert.match(c.measured, /\$1\.0000/);
  assert.match(c.measured, /4\.0% of cap/);
  assert.match(c.threshold, /\$25\.00/);
});

test("spend at the warn fraction WARNs, and at the cap FAILs", () => {
  assert.equal(judgeCashSpend(read(25 * CASH_SPEND_WARN_FRACTION), 25).verdict, "WARN");
  assert.equal(judgeCashSpend(read(24.99), 25).verdict, "WARN");
  assert.equal(judgeCashSpend(read(25), 25).verdict, "FAIL");
  assert.equal(judgeCashSpend(read(99), 25).verdict, "FAIL");
});

test("an UNAVAILABLE reading WARNs — 'we could not find out' is not 'nothing is wrong'", () => {
  // Collapsing those two is exactly how a dead cash lane ran for two days without alarming anyone.
  const c = judgeCashSpend({ kind: "unavailable", reason: "IMDS returned HTTP 400" }, 25);
  assert.equal(c.verdict, "WARN");
  assert.equal(c.measured, "unreadable");
  assert.match(String(c.detail), /IMDS returned HTTP 400/);
});

test("an unpriced deployment is surfaced beside the number, because it makes the total read LOW", () => {
  const c = judgeCashSpend(read(1.0, ["DeepSeek-V4-Flash"]), 25);
  assert.match(String(c.detail), /reads LOW/);
  assert.match(String(c.detail), /DeepSeek-V4-Flash/);
  assert.equal(judgeCashSpend(read(1.0), 25).detail, undefined, "and says nothing when there is nothing to say");
});

test("no cap configured WARNs rather than passing — an unbounded cash lane is not healthy", () => {
  for (const cap of [undefined, 0, -1, Number.NaN]) {
    assert.equal(judgeCashSpend(read(1.0), cap as number | undefined).verdict, "WARN", `cap=${String(cap)}`);
  }
});

test("doctor keeps its no-network refusal: the judge takes a VALUE, never fetches", () => {
  // THE CONTRACT, PINNED. doctor.ts's header refuses network reads by name, earned by a measured
  // ninety-minute API lockout. If someone moves the ARM call into the judge, this reddens.
  const src = readFileSync(new URL("../src/lib/doctor.ts", import.meta.url), "utf8");
  // A CALL, not a mention: the judge's own doc names the reader in prose deliberately, so a
  // substring test would redden on documentation and teach the next author to delete the
  // explanation instead of keeping the boundary.
  assert.doesNotMatch(src, /readCashActuals\s*\(/, "doctor must not CALL the ARM reader");
  assert.doesNotMatch(src, /^import \{[^}]*readCashActuals/m, "and must not value-import it");
  assert.match(src, /import type \{ CashActuals \}/, "it takes the result as a type-only import");
});
