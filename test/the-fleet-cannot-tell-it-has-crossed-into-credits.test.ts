import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildAccountUsageRoute,
  CREDIT_STATE_FIELDS,
  CREDIT_STATE_STEP,
  creditTransitionRow,
  deriveAccountUsage,
  interpretCreditState,
  lastRecordedCreditState,
  readAccountUsageFile,
  readCreditState,
  type AccountUsageSnapshot,
  type AccountUsageInput,
} from "../src/lib/account-usage.js";
import type { LedgerLine } from "../src/lib/ledger.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPTURED = join(REPO_ROOT, "test", "fixtures", "account-usage", "claude-json.json");

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

/**
 * test/the-fleet-cannot-tell-it-has-crossed-into-credits.test.ts — W1-T2688.
 *
 * A subscription drawing on usage credits drops the prompt-cache lifetime from an hour to five
 * minutes, so the same worker, on the same task, at the same mount, costs materially more after
 * that transition — and nothing observed it. Cost per completed task moved for a reason no row
 * explained.
 *
 * THE FIRST OBLIGATION WAS TO ESTABLISH WHETHER THE SURFACE EXPOSES IT AT ALL, and the answer
 * shapes everything below: the repo's own CAPTURED real block carries `accountUuid`,
 * `fetchedAtMs` and the two utilisation windows, and NO credit, billing, plan or subscription
 * field. The live `~/.claude.json` could not be read from this container — the attempt was
 * refused, correctly, because that file holds OAuth material — so this conclusion rests on the
 * captured block, and the first test below re-derives it from the fixture on every run rather
 * than restating it as prose.
 *
 * So the shipped behaviour is DETECT-OR-REFUSE: `not-exposed`, loudly and in the same shape
 * `UsageUnknownReason` already uses, and never a flag inferred from window utilisation. If the
 * surface starts carrying the field under any of {@link CREDIT_STATE_FIELDS}, it is read with no
 * further change — which the tests drive both ways.
 */

// ── what the surface actually exposes, re-derived rather than asserted ──────────────────────────

test("W1-T2688: the captured real block exposes NO credit state — the finding, re-derived from the fixture", () => {
  const raw = JSON.parse(readFileSync(CAPTURED, "utf8")) as Record<string, unknown>;
  const block = (raw.cachedUsageUtilization ?? {}) as Record<string, unknown>;

  // CONTROL FIRST: the fixture really is the usage block, so "no credit field" is a statement
  // about a corpus that was read rather than about an empty object.
  assert.ok(Object.keys(block).length >= 3, `the fixture must carry a real block (keys: ${Object.keys(block).join(",")})`);
  assert.ok("utilization" in block && "fetchedAtMs" in block && "accountUuid" in block);

  for (const field of CREDIT_STATE_FIELDS) {
    assert.equal(field in block, false, `the captured block carries no '${field}'`);
  }
  // And nothing credit-shaped under any OTHER name either — the search that produced the finding.
  const creditish = JSON.stringify(raw).match(/"[^"]*(credit|subscription|billing|entitle|overage)[^"]*"\s*:/gi) ?? [];
  assert.deepEqual(creditish, [], "no credit-shaped key anywhere in the captured file");

  // Which is exactly what the reader reports for it — end to end, through the real projection.
  const snapshot = deriveAccountUsage(readAccountUsageFile(CAPTURED), [], Date.parse("2026-09-05T12:00:00Z"));
  assert.equal(snapshot.creditState, undefined);
  assert.equal(snapshot.creditUnknownReason, "not-exposed");
});

// ── read it when the surface exposes it ────────────────────────────────────────────────────────

test("W1-T2688: the credit state is read from the existing usage surface when that surface exposes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}credit-state-`));
  try {
    for (const field of CREDIT_STATE_FIELDS) {
      const path = join(dir, `${field}.json`);
      const captured = JSON.parse(readFileSync(CAPTURED, "utf8")) as { cachedUsageUtilization: Record<string, unknown> };
      captured.cachedUsageUtilization[field] = "credits";
      writeFileSync(path, JSON.stringify(captured));

      const snapshot = deriveAccountUsage(readAccountUsageFile(path), [], Date.parse("2026-09-05T12:00:00Z"));
      assert.equal(snapshot.creditState, "credits", `read from '${field}'`);
      assert.equal(snapshot.creditUnknownReason, undefined, "and no reason, because it is known");
      assert.equal(snapshot.creditStateField, field, "with the field it came from, as evidence");

      const rows: Array<Record<string, unknown>> = [];
      const written: LedgerLine[] = [];
      const route = buildAccountUsageRoute({
        ledgerPath: join(dir, `${field}.ledger.ndjson`),
        accountFilePath: path,
        readLedger: () => rows,
        writeLedger: (_ledgerPath, line) => {
          written.push(line);
          rows.push(line);
        },
        now: () => Date.parse("2026-09-05T12:00:00Z"),
        resolveCeiling: () => ({ usd: 150, provenance: "default", committedDefaultUsd: 150 }),
      });
      const { status, parsed } = await invokeRoute(route);
      assert.equal(status, 200);
      assert.equal(parsed.creditState, "credits", `route read '${field}' from cachedUsageUtilization`);
      assert.equal(parsed.creditStateField, field);
      assert.equal(written.length, 1, "the route recorded the first known state once");
      assert.equal(written[0]?.step, CREDIT_STATE_STEP);
      assert.equal(written[0]?.state, "credits");
      assert.equal(written[0]?.field, field);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("W1-T2688: both states and both spellings read, and anything else is unrecognised rather than defaulted", () => {
  assert.equal(interpretCreditState("credits"), "credits");
  assert.equal(interpretCreditState("usage_credits"), "credits");
  assert.equal(interpretCreditState(true), "credits");
  assert.equal(interpretCreditState("Subscription"), "subscription");
  assert.equal(interpretCreditState("plan"), "subscription");
  assert.equal(interpretCreditState(false), "subscription");

  // THE DIRECTION THAT MATTERS: an unknown value must NOT fall back to "subscription", which
  // would read as "nothing has changed" on exactly the surface change this task exists to catch.
  for (const bad of ["enterprise", "", 7, null, {}, ["credits"]]) {
    assert.equal(interpretCreditState(bad), undefined, `${JSON.stringify(bad)} is not interpreted`);
  }
  assert.deepEqual(readCreditState({ creditStateField: "creditState", creditStateRaw: "enterprise" }), {
    unknownReason: "unrecognised-value",
    field: "creditState",
  });
});

test("W1-T2688: a surface that does not expose it yields a recorded cannot-determine reason, never an inferred flag", async () => {
  assert.deepEqual(readCreditState({}), { unknownReason: "not-exposed" });

  // NEVER INFERRED FROM UTILISATION. A fully-spent window is the state most tempting to read as
  // "on credits now"; it must still report not-exposed.
  const spent: AccountUsageInput = {
    uuid: "u", cacheUuid: "u", cacheFetchedAtMs: Date.parse("2026-09-05T11:59:00Z"),
    fiveHour: { percentUsed: 100 }, sevenDay: { percentUsed: 100 },
  };
  const snapshot = deriveAccountUsage(spent, [], Date.parse("2026-09-05T12:00:00Z"));
  assert.equal(snapshot.creditUnknownReason, "not-exposed");
  assert.equal(snapshot.creditState, undefined);
  assert.equal(snapshot.fiveHour?.percentUsed, 100, "and the windows are read exactly as before");

  const written: LedgerLine[] = [];
  const route = buildAccountUsageRoute({
    ledgerPath: "/tmp/w1-t2688-no-credit-state-ledger.ndjson",
    readLedger: () => [],
    readAccount: () => spent,
    writeLedger: (_ledgerPath, line) => written.push(line),
    now: () => Date.parse("2026-09-05T12:00:00Z"),
    resolveCeiling: () => ({ usd: 150, provenance: "default", committedDefaultUsd: 150 }),
  });
  const { status, parsed } = await invokeRoute(route);
  assert.equal(status, 200);
  assert.equal(parsed.creditUnknownReason, "not-exposed", "the route records the cannot-determine reason in its payload");
  assert.equal(parsed.creditState, undefined, "and never invents a state from spent windows");
  assert.equal(written.length, 0, "unknown credit state is not written as a transition");
});

// ── the edge, not the level ────────────────────────────────────────────────────────────────────

test("W1-T2688: the transition edge writes one row; an unchanged state writes none", async () => {
  const at = "2026-09-05T12:00:00Z";
  const prior = [{ step: CREDIT_STATE_STEP, state: "subscription", ts: "2026-09-01T00:00:00Z" }];

  const changed = creditTransitionRow(prior, { state: "credits", field: "creditState" }, at);
  assert.deepEqual(changed, { step: CREDIT_STATE_STEP, state: "credits", previous: "subscription", field: "creditState", ts: at });

  assert.equal(creditTransitionRow(prior, { state: "subscription" }, at), undefined, "unchanged -> no row");
  // Sampling the same state repeatedly is the noise the shard refuses; only the edge is a row.
  const afterEdge = [...prior, changed!];
  assert.equal(creditTransitionRow(afterEdge, { state: "credits" }, at), undefined, "and it settles after the edge");

  // FIRST TIME IT BECOMES KNOWN is an edge too — with no `previous`, because there was none.
  assert.deepEqual(creditTransitionRow([], { state: "subscription" }, at), { step: CREDIT_STATE_STEP, state: "subscription", ts: at });

  // AN UNKNOWN IS NOT A TRANSITION. Recording one would put a state in the ledger that was never
  // read, and a later census joining spend against these rows would be joining against fiction.
  assert.equal(creditTransitionRow(prior, { unknownReason: "not-exposed" }, at), undefined);
  assert.equal(creditTransitionRow(prior, { unknownReason: "unrecognised-value", field: "creditState" }, at), undefined);

  assert.equal(lastRecordedCreditState([]), undefined, "a ledger that never recorded one says so");
  assert.equal(lastRecordedCreditState([{ step: CREDIT_STATE_STEP, state: "nonsense" }]), undefined, "and a torn row is not a state");
  assert.equal(lastRecordedCreditState([...prior, { step: "daemon.alive" }]), "subscription", "unrelated rows do not displace it");

  const lines: Array<Record<string, unknown>> = [];
  const written: LedgerLine[] = [];
  let raw: unknown = "subscription";
  const route = buildAccountUsageRoute({
    ledgerPath: "/tmp/w1-t2688-credit-transition-ledger.ndjson",
    readLedger: () => lines,
    readAccount: () => ({
      uuid: "u",
      cacheUuid: "u",
      cacheFetchedAtMs: Date.parse("2026-09-05T11:59:00Z"),
      creditStateField: "creditState",
      creditStateRaw: raw,
      fiveHour: { percentUsed: 10 },
      sevenDay: { percentUsed: 20 },
    }),
    writeLedger: (_ledgerPath, line) => {
      written.push(line);
      lines.push(line);
    },
    now: () => Date.parse(at),
    resolveCeiling: () => ({ usd: 150, provenance: "default", committedDefaultUsd: 150 }),
  });

  await invokeRoute(route);
  await invokeRoute(route);
  assert.equal(written.length, 1, "first known subscription is recorded once, not every poll");
  assert.equal(written[0]?.state, "subscription");
  assert.equal(written[0]?.previous, undefined);

  raw = "credits";
  await invokeRoute(route);
  await invokeRoute(route);
  assert.equal(written.length, 2, "the subscription -> credits edge adds exactly one row");
  assert.deepEqual(
    { step: written[1]?.step, state: written[1]?.state, previous: written[1]?.previous, field: written[1]?.field },
    { step: CREDIT_STATE_STEP, state: "credits", previous: "subscription", field: "creditState" },
  );
});

// ── nothing else moved ─────────────────────────────────────────────────────────────────────────

test("W1-T2688: the existing window readings, staleness handling and governor state are unchanged", () => {
  const now = Date.parse("2026-09-05T12:00:00Z");
  const input = readAccountUsageFile(CAPTURED);
  const withCredit = deriveAccountUsage({ ...input, creditStateField: "creditState", creditStateRaw: "credits" }, [], now);
  const without = deriveAccountUsage(input, [], now);

  // Every field except the three this task adds is byte-identical with and without a credit
  // state — so the new axis cannot have perturbed the old one.
  const strip = (o: Record<string, unknown>): Record<string, unknown> => {
    const { creditState, creditUnknownReason, creditStateField, ...rest } = o;
    return rest;
  };
  assert.deepEqual(strip(withCredit as unknown as Record<string, unknown>), strip(without as unknown as Record<string, unknown>));

  // And the two axes are genuinely independent: an UNREADABLE usage half still reports the credit
  // state, and a readable one still reports not-exposed (asserted above).
  const unreadable = deriveAccountUsage({ unreadable: true, creditStateField: "creditState", creditStateRaw: "credits" }, [], now);
  assert.equal(unreadable.usageUnknownReason, "unreadable", "the usage half is unknown");
  assert.equal(unreadable.creditState, "credits", "while the credit half is known — separate axes");
});

test("W1-T2688: no mount is changed and no dispatch is held — this observes and records only", () => {
  // @source-text-subject — W1-T2905's census caught this read the day after that ratchet merged,
  // which is the ratchet working. This is its DECLARED exception, not a way around it: the
  // property under test is the ABSENCE of an affordance, and no call can demonstrate an absence.
  // The alternative the census names first — assert on behaviour — cannot reach an internal call
  // to a mount resolver, which is precisely what must not appear here.
  //
  // Asserted over the module's own surface because the property is the ABSENCE of an action:
  // policy is an operator ruling, and the mount table's own rule is that a routing decision is a
  // data edit. A test driving only the happy paths would let a routing call be added later
  // without reddening anything.
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "account-usage.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  for (const forbidden of ["resolveMount", "MOUNTS", "pause(", "PAUSE", "holdDispatch", "setMount", "writeFileSync", "appendFileSync"]) {
    assert.ok(!src.includes(forbidden), `account-usage.ts must not reach for '${forbidden}' — it observes only`);
  }
  // The control for the comment-strip: the forbidden tokens ARE discussed in the prose above.
  assert.ok(readFileSync(join(REPO_ROOT, "src", "lib", "account-usage.ts"), "utf8").includes("mount"),
    "the prose still discusses mounts — so the strip, not an empty file, is what makes the scan clean");
});
