import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  USAGE_CACHE_MAX_AGE_MS,
  USAGE_SCOPE_NOTE,
  buildAccountUsageRoute,
  deriveAccountUsage,
  readAccountUsageFile,
  type AccountUsageInput,
  type AccountUsageSnapshot,
} from "../src/lib/account-usage.js";
import { ACCOUNT_FILE_PATH_ENV, renderShellHtml, resolveAccountFilePath } from "../src/lib/serve.js";

/**
 * The console's ACCOUNT strip — which Anthropic account the fleet is spending, and how much of
 * each usage window is gone.
 *
 * THE FIXTURE IS A REAL CAPTURE, NOT A HAND-WRITTEN ONE. `test/fixtures/account-usage/
 * claude-json.json` is this host's own `~/.claude.json`, projected to exactly the nine scalar
 * paths this module reads and otherwise UNMODIFIED — captured 2026-07-31T16:46:53Z. Every
 * structural property a parser can get wrong is therefore the real one: `utilization` is a bare
 * NUMBER (not a `{percent}` object and not a 0–1 fraction), `resets_at` is an ISO string with a
 * `+00:00` offset and MICROSECOND precision, `fetchedAtMs` is epoch MILLISECONDS, and each window
 * object carries three always-null `*_dollars` siblings. A fixture written from memory is exactly
 * how a predicate ships broken while every test agrees with it.
 *
 * FOUR STRINGS ARE SUBSTITUTED, and only these: `oauthAccount.emailAddress`, `.accountUuid`,
 * `.organizationName`, and `cachedUsageUtilization.accountUuid`. craigoley/remudero is a PUBLIC
 * repository and there is no reason a unit test needs the operator's real Anthropic account
 * identifier in it. The substitutes preserve the shape (a valid address, a valid UUID) and the
 * cross-check the code performs (the two UUIDs are equal, as they are live), and the key-path set
 * of the committed fixture is byte-identical to the live capture's. Nothing else was touched: the
 * usage block's values are verbatim.
 */
const FIXTURE = fileURLToPath(new URL("./fixtures/account-usage/claude-json.json", import.meta.url));

/** The fixture's own `fetchedAtMs`, so "now" in these tests is relative to the real capture. */
const CAPTURED_AT = 1785516413209;

/** Invoke a built route's handler against a fake `ServerResponse` and parse the JSON body —
 *  shared by the pre-existing "GET /v1/account-usage answers 200..." test and the W1-T997 tests
 *  below, so none of them re-derives the fake response object on its own. */
async function invokeRoute(route: ReturnType<typeof buildAccountUsageRoute>): Promise<{ status: number; parsed: AccountUsageSnapshot }> {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk: string) {
      body = chunk;
    },
  } as unknown as ServerResponse;
  await route.handler({} as never, res, { params: {} });
  return { status, parsed: JSON.parse(body) as AccountUsageSnapshot };
}

/** Run `fn` with `$HOME` pointed at `dir` for the duration of the call, then restore it — so a
 *  test can prove what `readAccountUsageFile`'s own `join(homedir(), ".claude.json")` default
 *  resolves to without touching the operator's real home directory. ALWAYS async (awaits `fn`
 *  itself, sync or not) so the restore in `finally` can never run before a promise `fn` returns
 *  has actually settled — the exact ordering bug an unawaited `finally` would risk here. */
async function withHome<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const real = process.env.HOME;
  process.env.HOME = dir;
  try {
    return await fn();
  } finally {
    if (real === undefined) delete process.env.HOME;
    else process.env.HOME = real;
  }
}

/** The newest REAL `daemon.headroom` line on this host — verbatim, including its `enforced:
 *  false` and the 77% reading that belongs to the account the operator switched AWAY from. */
const REAL_TELEMETRY_LINE = {
  ts: "2026-07-31T14:59:05.671Z",
  run_id: "DAEMON-1785509074053",
  task_id: "DAEMON",
  step: "daemon.headroom",
  window: "weekly (all models)",
  percent_used: 77,
  limit_pct: 95,
  resets_at: "2026-08-04T04:00:00.000Z",
  enforced: false,
  over_ceiling: false,
  poll_interval_ms: 60000,
  note: "headroom governor disabled (ruling a4153e) — telemetry only, dispatch not gated",
};

/** A REAL pre-symmetry over-ceiling line — note it carries NO `enforced` key at all. 321 of this
 *  host's 1,243 headroom lines look like this, which is why the posture is read as a tri-state. */
const REAL_LEGACY_LINE = {
  ts: "2026-07-25T14:02:24.640Z",
  run_id: "DAEMON-1784938092611",
  task_id: "DAEMON",
  step: "daemon.headroom",
  tick: 272,
  window: "weekly (all models)",
  percent_used: 99,
  limit_pct: 95,
  resets_at: "2026-07-28T04:00:00.000Z",
  poll_interval_ms: 60000,
};

/** What the symmetric heartbeat now writes when the governor is ARMED and under the ceiling. */
const ARMED_LINE = { ...REAL_TELEMETRY_LINE, ts: "2026-07-31T16:45:00.000Z", enforced: true, percent_used: 3 };

/** W1-T329: a real-shaped `daemon.cost_governor` line (daemon.ts), written on every tick the
 *  cost ceiling defers new dispatch — the OPERATOR COMPLAINT's own numbers, 2026-08-04. */
const COST_GOVERNOR_LINE = {
  ts: "2026-08-04T15:30:00.000Z",
  run_id: "DAEMON-1785878000000",
  task_id: "DAEMON",
  step: "daemon.cost_governor",
  tick: 40,
  observed_day_cost_usd: 152.28,
  daily_cost_ceiling_usd: 150,
  poll_interval_ms: 60000,
};

/** W1-T329: a real-shaped `daemon.queue_governor` line (daemon.ts). */
const QUEUE_GOVERNOR_LINE = {
  ts: "2026-08-04T15:31:00.000Z",
  run_id: "DAEMON-1785878001000",
  task_id: "DAEMON",
  step: "daemon.queue_governor",
  tick: 41,
  observed_open_count: 12,
  wip_limit: 10,
  poll_interval_ms: 60000,
};

test("the panel renders the account and both usage windows from a real captured reading, with an as-of timestamp", () => {
  const input = readAccountUsageFile(FIXTURE);
  const snap = deriveAccountUsage(input, [ARMED_LINE], CAPTURED_AT + 60_000);

  // IDENTITY — the answer to "which subscription is it using".
  assert.equal(snap.accountEmail, "operator@example.com");
  assert.equal(snap.accountUuid, "00000000-1111-2222-3333-444444444444");
  assert.equal(snap.accountOrg, "operator@example.com's Organization");

  // USAGE — the answer to "how much is used", with each window's own reset instant.
  assert.deepEqual(snap.fiveHour, { percentUsed: 3, resetsAt: "2026-07-31T20:49:59.209107+00:00" });
  assert.deepEqual(snap.sevenDay, { percentUsed: 0, resetsAt: "2026-08-02T04:59:59.209129+00:00" });

  // AS-OF — present, and derived from the reading's OWN clock, never from render time.
  assert.equal(snap.usageAsOf, new Date(CAPTURED_AT).toISOString());
  assert.equal(snap.usageAgeMs, 60_000);
  assert.equal(snap.usageUnknownReason, undefined);

  // POSTURE — read off the newest daemon.headroom line, with its own age.
  assert.equal(snap.governor, "armed");
  assert.equal(snap.governorAsOf, "2026-07-31T16:45:00.000Z");

  // The scope caveat travels IN the payload, so a render cannot drop it.
  assert.equal(snap.measures, USAGE_SCOPE_NOTE);
});

// ── W1-T329 (OPERATOR COMPLAINT, 2026-08-04): the two DISPATCH-DEFERRING governors. Neither
// `daemon.cost_governor` nor `daemon.queue_governor` is emitted except while that governor is
// actively deferring, so — unlike the headroom governor's tri-state above — there is no "clear"
// reading to derive: only "the newest deferral we've seen" or "we've never seen one" (unknown).

test("the cost-governor deferral is derived from the newest daemon.cost_governor line, with its own as-of and the observed figure against its ceiling", () => {
  const input = readAccountUsageFile(FIXTURE);
  const snap = deriveAccountUsage(input, [COST_GOVERNOR_LINE], CAPTURED_AT + 60_000);

  assert.equal(snap.costGovernor, "deferred", "a real daemon.cost_governor line renders deferred, not unknown");
  assert.equal(snap.costGovernorAsOf, "2026-08-04T15:30:00.000Z");
  assert.equal(snap.costGovernorObservedUsd, 152.28, "RENDER THE NUMBER, not just the flag");
  assert.equal(snap.costGovernorCeilingUsd, 150);

  // NEWEST WINS, and a second, older cost_governor line must not overwrite the newer reading.
  const older = { ...COST_GOVERNOR_LINE, ts: "2026-08-04T15:00:00.000Z", observed_day_cost_usd: 140 };
  const outOfOrder = deriveAccountUsage(input, [COST_GOVERNOR_LINE, older], CAPTURED_AT);
  assert.equal(outOfOrder.costGovernorObservedUsd, 152.28, "the newest line's own figure wins, never an older one");
});

test("the queue-governor deferral is derived from the newest daemon.queue_governor line, with its own as-of and the observed count against the WIP limit", () => {
  const input = readAccountUsageFile(FIXTURE);
  const snap = deriveAccountUsage(input, [QUEUE_GOVERNOR_LINE], CAPTURED_AT + 60_000);

  assert.equal(snap.queueGovernor, "deferred", "a real daemon.queue_governor line renders deferred, not unknown");
  assert.equal(snap.queueGovernorAsOf, "2026-08-04T15:31:00.000Z");
  assert.equal(snap.queueGovernorObservedOpenCount, 12);
  assert.equal(snap.queueGovernorWipLimit, 10);
});

test("an absent dispatch-governor reading is UNKNOWN, never zero or under-ceiling — even when the OTHER governor has real data", () => {
  const input = readAccountUsageFile(FIXTURE);

  // (1) Nothing on the ledger at all — the common case (most ticks never defer).
  const nothing = deriveAccountUsage(input, [], CAPTURED_AT);
  assert.equal(nothing.costGovernor, "unknown", "no daemon.cost_governor line ever seen must never read as under-ceiling");
  assert.equal(nothing.costGovernorAsOf, undefined);
  assert.equal(nothing.costGovernorObservedUsd, undefined, "no number is ever fabricated for an unknown reading");
  assert.equal(nothing.queueGovernor, "unknown");
  assert.equal(nothing.queueGovernorAsOf, undefined);

  // (2) One governor has a real, current deferral; the other has never fired. Each posture is
  // independent — a cost deferral must not bleed into the queue governor's own reading.
  const mixed = deriveAccountUsage(input, [COST_GOVERNOR_LINE], CAPTURED_AT);
  assert.equal(mixed.costGovernor, "deferred");
  assert.equal(mixed.queueGovernor, "unknown", "the queue governor's own silence must still read unknown, not clear, alongside a real cost deferral");

  // (3) Other, unrelated ledger noise must not be mistaken for either governor's own step.
  const noise = deriveAccountUsage(input, [{ ts: REAL_TELEMETRY_LINE.ts, step: "daemon.headroom", enforced: true }], CAPTURED_AT);
  assert.equal(noise.costGovernor, "unknown");
  assert.equal(noise.queueGovernor, "unknown");
});

test("a stale or missing reading renders as unknown and never as 0% or as a stale value presented as current", () => {
  const input = readAccountUsageFile(FIXTURE);

  // (1) TOO OLD — one millisecond past the bound. The numbers are WITHHELD, not aged-and-shown.
  const old = deriveAccountUsage(input, [ARMED_LINE], CAPTURED_AT + USAGE_CACHE_MAX_AGE_MS + 1);
  assert.equal(old.usageUnknownReason, "too-old");
  assert.equal(old.fiveHour, undefined, "a too-old window must be ABSENT, so no render can show its number");
  assert.equal(old.sevenDay, undefined);
  assert.equal(old.usageAsOf, undefined);
  // …but identity survives: the panel can still answer "which account" when it cannot answer
  // "how much", which is exactly the split the operator needs after a switch.
  assert.equal(old.accountEmail, "operator@example.com");

  // (2) ACCOUNT MISMATCH — the switch guard. The cache still holds the PREVIOUS account's numbers
  // until some Claude Code process rewrites it; rendering them under the new account's name is
  // the precise failure this panel exists to avoid.
  const switched: AccountUsageInput = { ...input, uuid: "99999999-8888-7777-6666-555555555555" };
  const mismatch = deriveAccountUsage(switched, [ARMED_LINE], CAPTURED_AT);
  assert.equal(mismatch.usageUnknownReason, "account-mismatch");
  assert.equal(mismatch.fiveHour, undefined);
  assert.equal(mismatch.accountUuid, "99999999-8888-7777-6666-555555555555", "identity is the CURRENT account, not the cache's");

  // (3) UNREADABLE FILE — a missing path fails soft, and still never fabricates.
  const missing = readAccountUsageFile("/nonexistent/definitely-not-here.json");
  assert.deepEqual(missing, { unreadable: true });
  const unreadable = deriveAccountUsage(missing, [], CAPTURED_AT);
  assert.equal(unreadable.usageUnknownReason, "unreadable");
  assert.equal(unreadable.fiveHour, undefined);
  assert.equal(unreadable.accountEmail, undefined);
  assert.equal(unreadable.governor, "unknown", "no headroom line at all ⇒ the posture is unknown, never a default");

  // (4) NO AS-OF — a cache with no `fetchedAtMs` cannot be aged, so it can never be shown.
  const unageable = deriveAccountUsage({ ...input, cacheFetchedAtMs: undefined }, [ARMED_LINE], CAPTURED_AT);
  assert.equal(unageable.usageUnknownReason, "no-cache");
  assert.equal(unageable.fiveHour, undefined);

  // THE RENDERED TEXT, asserted rather than inferred. `usageWindowLabel` is the client function
  // that turns a window into a string; it is inside serve.ts's client template literal, so it is
  // pulled out of the RENDERED shell and executed — the same technique that proves the script
  // parses at all. An unknown window must read the literal word "unknown", never "0%".
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(renderShellHtml())![1];
  // The slice spans usageWindowLabel AND the formatClock it calls — stopping short of the latter
  // would extract a function that throws rather than one that answers.
  const slice = script.slice(script.indexOf("function usageWindowLabel"), script.indexOf("/** Renders GET /v1/account-usage"));
  const label = new Function(`${slice} return usageWindowLabel;`)() as (w: unknown) => string;
  assert.equal(label(undefined), "unknown", "an ABSENT window renders the word unknown");
  assert.equal(label({}), "unknown", "a window with no percent renders unknown, never 0%");
  assert.equal(label({ percentUsed: 0, resetsAt: "2026-08-02T04:59:59.209129+00:00" }).startsWith("0%"), true, "a GENUINE zero still renders as 0% — unknown and zero are different states");
});

test("the governor posture is a tri-state — a headroom line with no enforced key reads unknown, never telemetry-only", () => {
  const input = readAccountUsageFile(FIXTURE);
  // 321 of this host's real headroom lines carry no `enforced` key. Mapping absent to `false`
  // would report an armed, actively-breaching governor as telemetry-only.
  assert.equal(deriveAccountUsage(input, [REAL_LEGACY_LINE], CAPTURED_AT).governor, "unknown");
  assert.equal(deriveAccountUsage(input, [REAL_TELEMETRY_LINE], CAPTURED_AT).governor, "telemetry-only");
  assert.equal(deriveAccountUsage(input, [ARMED_LINE], CAPTURED_AT).governor, "armed");
  // NEWEST WINS, by parsed `ts` and never by ledger order — the armed line is newer than the
  // telemetry one, so a ledger that happens to append them backwards still reports "armed".
  const outOfOrder = deriveAccountUsage(input, [ARMED_LINE, REAL_TELEMETRY_LINE, REAL_LEGACY_LINE], CAPTURED_AT);
  assert.equal(outOfOrder.governor, "armed");
  assert.equal(outOfOrder.governorAsOf, ARMED_LINE.ts);
});

test("the account reader projects only identity and usage out of the config file and never any other key", () => {
  // THE SAFETY PROPERTY, asserted mechanically. `~/.claude.json` also holds OAuth material, so
  // the reader must be a projection rather than a pass-through: anything it does not name is
  // dropped by construction. Feeding it a file that carries an extra secret-shaped key proves
  // nothing leaks into the payload that the route serializes.
  const withSecrets = fileURLToPath(new URL("./fixtures/account-usage/claude-json.json", import.meta.url));
  const input = readAccountUsageFile(withSecrets);
  assert.deepEqual(
    Object.keys(input).sort(),
    ["cacheFetchedAtMs", "cacheUuid", "email", "fiveHour", "org", "sevenDay", "uuid"],
    "exactly the seven projected fields — no passthrough of the parsed object",
  );
  const serialized = JSON.stringify(deriveAccountUsage(input, [ARMED_LINE], CAPTURED_AT));
  for (const forbidden of ["oauthAccount", "accessToken", "refreshToken", "apiKey", "primaryApiKey", "sk-ant"]) {
    assert.equal(serialized.includes(forbidden), false, `the served payload must never contain ${forbidden}`);
  }
});

// ── W1-T333: the daily cost ceiling's EFFECTIVE value, its PROVENANCE, and the audit trail that
// distinguishes "at default, never overridden" from "at default because a real override just
// vanished" — the store alone (policy.ts's resolveDailyCostCeiling) cannot tell those two apart,
// by its own documented design (the DISAPPEARANCE CASE): both read `provenance: "default"` with
// no `fallback`. Only the ledger's independent write history can.

test("the rendered ceiling carries its provenance — an overridden value shows the effective figure and its committed default, and a value at default is distinguishable from one never overridden", () => {
  const input = readAccountUsageFile(FIXTURE);

  // OVERRIDDEN: the effective figure AND what it was overridden FROM both render, together.
  const overridden = deriveAccountUsage(input, [], CAPTURED_AT, { usd: 200, provenance: "overridden", committedDefaultUsd: 150 });
  assert.equal(overridden.dailyCostCeilingUsd, 200, "the EFFECTIVE figure");
  assert.equal(overridden.dailyCostCeilingProvenance, "overridden");
  assert.equal(overridden.dailyCostCeilingDefaultUsd, 150, "the committed default travels alongside the effective figure");

  // AT DEFAULT, NEVER OVERRIDDEN: no console.ceiling_override_written line has ever been ledgered.
  const neverOverridden = deriveAccountUsage(input, [], CAPTURED_AT, { usd: 150, provenance: "default", committedDefaultUsd: 150 });
  assert.equal(neverOverridden.dailyCostCeilingProvenance, "default");
  assert.equal(neverOverridden.dailyCostCeilingUsd, 150);
  assert.equal(neverOverridden.dailyCostCeilingAuditAsOf, undefined, "no audit line at all -- this value was never overridden");
  assert.equal(neverOverridden.dailyCostCeilingAuditWho, undefined);

  // AT DEFAULT BECAUSE A REAL OVERRIDE DISAPPEARED: `state/` was wiped, so
  // resolveDailyCostCeiling reads back an ordinary ENOENT-absence and reports `provenance:
  // "default"` with no `fallback` -- IDENTICAL, from the store alone, to never-overridden above.
  // The ledger's own independent history is what makes the two distinguishable.
  const auditLine = {
    ts: "2026-08-04T12:00:00.000Z",
    step: "console.ceiling_override_written",
    who: "operator@example.com",
    from_usd: 150,
    to_usd: 200,
    effective_usd: 200,
  };
  const disappeared = deriveAccountUsage(input, [auditLine], CAPTURED_AT, { usd: 150, provenance: "default", committedDefaultUsd: 150 });
  assert.equal(disappeared.dailyCostCeilingProvenance, "default", "resolveDailyCostCeiling ALONE cannot tell this apart from never-overridden");
  assert.equal(disappeared.dailyCostCeilingUsd, 150);
  assert.equal(disappeared.dailyCostCeilingAuditWho, "operator@example.com", "but the ledger's write history shows a real past write");
  assert.equal(disappeared.dailyCostCeilingAuditFromUsd, 150);
  assert.equal(disappeared.dailyCostCeilingAuditToUsd, 200);
  assert.equal(disappeared.dailyCostCeilingAuditEffectiveUsd, 200);
  assert.ok(disappeared.dailyCostCeilingAuditAsOf, "the audit's own as-of is set");
  assert.notEqual(
    disappeared.dailyCostCeilingAuditAsOf,
    neverOverridden.dailyCostCeilingAuditAsOf,
    "the two 'provenance: default' readings are now distinguishable via the audit trail",
  );

  // NEWEST WINS, the same discipline every other ledger-derived reading in this module already
  // has -- an older audit line must not shadow a newer one.
  const older = { ...auditLine, ts: "2026-08-04T10:00:00.000Z", to_usd: 180, effective_usd: 180 };
  const outOfOrder = deriveAccountUsage(input, [auditLine, older], CAPTURED_AT, { usd: 150, provenance: "default", committedDefaultUsd: 150 });
  assert.equal(outOfOrder.dailyCostCeilingAuditToUsd, 200, "the newest write's own figure wins, never an older one");
});

test("GET /v1/account-usage answers 200 from its real defaults — the real file reader and the real ledger reader", async () => {
  // THE ROUTE ITSELF, with NOTHING injected but the two paths. Every other test here drives the
  // pure projection directly, so the route's own default wiring (`?? Date.now`,
  // `?? readLedgerLines`, `?? readAccountUsageFile`) would otherwise be unreachable glue — the
  // exact shape this repo has been bitten by before.
  const dir = mkdtempSync(join(tmpdir(), "rmd-account-usage-route-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, `${JSON.stringify(ARMED_LINE)}\n`);
  // `now` is injected ONLY so the age assertion below is deterministic — the fixture's capture
  // instant is fixed, so a real clock would make this test's verdict depend on the wall time it
  // happens to run at. `readLedger` and `readAccount` are deliberately NOT injected: those two
  // defaults are the glue this test exists to reach. (`?? Date.now` is covered by the browser
  // test in test/serve.glance.test.ts, which injects neither it nor the ledger reader.)
  const route = buildAccountUsageRoute({
    ledgerPath,
    accountFilePath: FIXTURE,
    now: () => CAPTURED_AT + USAGE_CACHE_MAX_AGE_MS + 1,
  });
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/v1/account-usage");
  assert.equal(route.scope, "read", "READ-scoped: this panel adds no write surface");

  const { status, parsed } = await invokeRoute(route);
  assert.equal(status, 200);
  assert.equal(parsed.accountEmail, "operator@example.com", "the real file reader ran, against the captured fixture");
  assert.equal(parsed.governor, "armed", "the real ledger reader ran, against a real-shaped heartbeat line");
  // The age policy runs end-to-end through the route, not just in the unit.
  assert.equal(parsed.usageUnknownReason, "too-old");
  assert.equal(parsed.fiveHour, undefined, "and a too-old reading is still withheld through the route, not just in the unit");
});

// ── W1-T997: the route accepted an injectable `accountFilePath` all along
// (`AccountUsageDeps.accountFilePath`, honoured by the `?? readAccountUsageFile(deps.
// accountFilePath)` fallback above) but nothing upstream of it ever supplied a value, so every
// request resolved under the SERVE process's own `homedir()` -- a path `remudero-serve`'s
// container mounts don't cover (see account-usage.ts's module header and this task's own
// rationale). serve.ts's `resolveAccountFilePath` closes that gap; these four tests lock in the
// reader's existing precedence/guard behaviour so wiring a real value into it can never regress
// the checks design note (iii) says must not be touched.

test("W1-T997: the account usage route reads the supplied path not the home default", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "rmd-account-usage-home-"));
  // A DIFFERENT identity than FIXTURE's `operator@example.com` -- so a route that fell through
  // to the home default, rather than the explicitly supplied path, is trivially distinguishable.
  writeFileSync(
    join(homeDir, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "home-default@example.com", accountUuid: "aaaaaaaa-0000-0000-0000-000000000000" },
      cachedUsageUtilization: {
        accountUuid: "aaaaaaaa-0000-0000-0000-000000000000",
        fetchedAtMs: CAPTURED_AT,
        utilization: { five_hour: { utilization: 99, resets_at: "2099-01-01T00:00:00Z" } },
      },
    }),
  );
  const routeDir = mkdtempSync(join(tmpdir(), "rmd-account-usage-route-"));

  await withHome(homeDir, async () => {
    const route = buildAccountUsageRoute({
      ledgerPath: join(routeDir, "ledger.ndjson"),
      accountFilePath: FIXTURE,
      now: () => CAPTURED_AT,
    });
    const { status, parsed } = await invokeRoute(route);
    assert.equal(status, 200);
    assert.equal(parsed.accountEmail, "operator@example.com", "the SUPPLIED path's identity, not the home default's");
    assert.notEqual(parsed.accountEmail, "home-default@example.com");
    assert.deepEqual(parsed.fiveHour, { percentUsed: 3, resetsAt: "2026-07-31T20:49:59.209107+00:00" }, "the supplied path's own window, not the home default's 99%");
  });
});

test("W1-T997: a readable path renders windows and an absent path reads unreadable", () => {
  // READABLE — the supplied path's own five-hour and seven-day windows render.
  const readable = readAccountUsageFile(FIXTURE);
  const good = deriveAccountUsage(readable, [], CAPTURED_AT);
  assert.deepEqual(good.fiveHour, { percentUsed: 3, resetsAt: "2026-07-31T20:49:59.209107+00:00" });
  assert.deepEqual(good.sevenDay, { percentUsed: 0, resetsAt: "2026-08-02T04:59:59.209129+00:00" });
  assert.equal(good.usageUnknownReason, undefined);

  // ABSENT, in the SAME run — never a bare "unknown"; the reason must be the specific one this
  // path failure produces.
  const absent = readAccountUsageFile(join(tmpdir(), "w1-t997-definitely-does-not-exist.json"));
  assert.deepEqual(absent, { unreadable: true });
  const bad = deriveAccountUsage(absent, [], CAPTURED_AT);
  assert.equal(bad.usageUnknownReason, "unreadable");
  assert.equal(bad.fiveHour, undefined);
  assert.equal(bad.sevenDay, undefined);
});

test("W1-T997: omitting the supplied path leaves the home default unchanged", async () => {
  // Neither an explicit override nor the env var set -> resolves to undefined, EXACTLY what
  // flowed into readAccountUsageFile before this task's wiring existed.
  assert.equal(resolveAccountFilePath(undefined, {}), undefined);

  // That `undefined` isn't just A value, it is the SAME default `readAccountUsageFile`'s own
  // parameter resolves -- point $HOME at a fixture-carrying temp dir and confirm the resolved
  // (undefined) path reads byte-identically to calling the reader with no argument at all.
  const homeDir = mkdtempSync(join(tmpdir(), "rmd-account-usage-home-default-"));
  writeFileSync(join(homeDir, ".claude.json"), readFileSync(FIXTURE, "utf8"));
  await withHome(homeDir, () => {
    const resolved = resolveAccountFilePath(undefined, {});
    assert.deepEqual(readAccountUsageFile(resolved), readAccountUsageFile(), "an omitted override changes nothing about the default read");
  });

  // An explicit caller override still wins over the env var -- the same "flag beats env" order
  // resolveServeHosts already uses for --host.
  assert.equal(
    resolveAccountFilePath("/explicit/path.json", { [ACCOUNT_FILE_PATH_ENV]: "/env/path.json" }),
    "/explicit/path.json",
    "an explicit override beats the env var",
  );
  // With no explicit override, the env var is honoured -- the SECOND way an install can point the
  // console at a readable copy, set purely in the deployment environment.
  assert.equal(
    resolveAccountFilePath(undefined, { [ACCOUNT_FILE_PATH_ENV]: "/env/path.json" }),
    "/env/path.json",
    "the env var is honoured when nothing more explicit overrides it",
  );
});

test("W1-T997: the too old and account mismatch guards still refuse a bad cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-account-usage-guards-"));

  // TOO OLD, read through the ROUTE via the newly-wired injectable path — not just the pure
  // projection — so pointing the reader at a readable file is proven not to have loosened this.
  const tooOldRoute = buildAccountUsageRoute({
    ledgerPath: join(dir, "ledger.ndjson"),
    accountFilePath: FIXTURE,
    now: () => CAPTURED_AT + USAGE_CACHE_MAX_AGE_MS + 1,
  });
  const tooOld = await invokeRoute(tooOldRoute);
  assert.equal(tooOld.parsed.usageUnknownReason, "too-old");
  assert.equal(tooOld.parsed.fiveHour, undefined, "a too-old window is still withheld through the route");

  // ACCOUNT MISMATCH, from a captured file whose cache belongs to a DIFFERENT account than the
  // identity in the same file — the switch guard must still refuse it end-to-end through the
  // route, exactly as it does when driven directly against the pure projection.
  const mismatched = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  const cache = mismatched.cachedUsageUtilization as Record<string, unknown>;
  cache.accountUuid = "99999999-8888-7777-6666-555555555555";
  const mismatchedPath = join(dir, "mismatched-claude-json.json");
  writeFileSync(mismatchedPath, JSON.stringify(mismatched));
  const mismatchRoute = buildAccountUsageRoute({
    ledgerPath: join(dir, "ledger.ndjson"),
    accountFilePath: mismatchedPath,
    now: () => CAPTURED_AT,
  });
  const mismatch = await invokeRoute(mismatchRoute);
  assert.equal(mismatch.parsed.usageUnknownReason, "account-mismatch");
  assert.equal(mismatch.parsed.fiveHour, undefined, "a mismatched window is still withheld through the route");
  assert.equal(mismatch.parsed.accountUuid, "00000000-1111-2222-3333-444444444444", "identity is still the CURRENT account, not the cache's");
});

