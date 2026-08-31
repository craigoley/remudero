import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USAGE_CACHE_MAX_AGE_MS,
  USAGE_PROJECTION_REL,
  accountUsageProjectionPath,
  buildAccountUsageRoute,
  deriveAccountUsage,
  mergeAccountUsageProjection,
  readAccountUsageFile,
  readAccountUsageProjection,
  type AccountUsageInput,
  type AccountUsageProjection,
  type AccountUsageSnapshot,
} from "../src/lib/account-usage.js";
import { captureWorkerUsageProjection, WORKER_USAGE_PROJECTION_REL } from "../src/lib/worker.js";
import { CLAUDE_CONFIG_REL, perRunWorkerHomeDir, reapWorkerHome } from "../src/lib/worker-home.js";

/**
 * W1-T2516: every worker's HOME is redirected to a Remudero-controlled scratch dir
 * (worker-home.ts), so the `cachedUsageUtilization` a worker's OWN Claude Code invocation
 * refreshes lands inside THAT scratch home, never inside `homedir()/.claude.json` — the file
 * account-usage.ts's `readAccountUsageFile` reads by default — and `reapWorkerHome` deletes the
 * scratch home moments after the spawn ends. On a genuinely headless fleet host (the ONLY Claude
 * Code processes are the fleet's own workers) nothing ever refreshes the primary file, which is
 * exactly the "worst case" account-usage.ts's own header already named in the abstract: "a host
 * with no Claude Code activity at all never refreshes it." These tests prove the remedy: capture
 * the reading out of a worker's own home BEFORE the reap, persist it to `state/`, and fold it
 * into the gate's reading — without ever inventing a number and without ever leaking OAuth
 * material into the persisted file.
 */

/** Invoke a built route's handler against a fake `ServerResponse` and parse the JSON body — the
 *  same technique test/account-usage.test.ts's own `invokeRoute` uses. */
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

/** A worker's own `.claude.json`-shaped capture: identity + a fresh `cachedUsageUtilization`,
 *  optionally carrying OAuth-shaped junk the projection must never copy forward. */
function claudeJsonFixture(opts: { accountUuid: string; fetchedAtMs: number; withOauthJunk?: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {
    oauthAccount: {
      emailAddress: "leak-if-copied@example.com",
      accountUuid: opts.accountUuid,
      organizationName: "leak-if-copied's Organization",
    },
    cachedUsageUtilization: {
      accountUuid: opts.accountUuid,
      fetchedAtMs: opts.fetchedAtMs,
      utilization: {
        five_hour: { utilization: 42, resets_at: "2099-01-01T00:00:00Z" },
        seven_day: { utilization: 7, resets_at: "2099-01-08T00:00:00Z" },
      },
    },
  };
  if (opts.withOauthJunk) {
    out.claudeAiOauth = { accessToken: "sk-ant-oat01-super-secret-token", refreshToken: "sk-ant-ort01-also-secret" };
  }
  return out;
}

/** A primary `~/.claude.json` carrying identity but NO usage cache at all — the realistic
 *  headless-host shape: the operator logged in once (so identity is present) but no interactive
 *  session has ever refreshed the cache. */
function identityOnlyFixture(accountUuid: string): Record<string, unknown> {
  return { oauthAccount: { emailAddress: "operator@example.com", accountUuid, organizationName: "Operator Org" } };
}

const ACCOUNT_UUID = "00000000-1111-2222-3333-444444444444";
const OTHER_ACCOUNT_UUID = "99999999-8888-7777-6666-555555555555";

test("W1-T2516: the two modules' projection-path literals cannot drift apart silently", () => {
  // worker.ts cannot import account-usage.ts's own constant without closing an import cycle
  // (account-usage.ts -> panel-actions.ts -> worker.ts) — see both modules' own doc comments.
  // This is the structural lock that catches the two literals drifting apart instead.
  assert.equal(WORKER_USAGE_PROJECTION_REL, USAGE_PROJECTION_REL);
  const root = mkdtempSync(join(tmpdir(), "w1-t2516-lock-"));
  assert.equal(join(root, WORKER_USAGE_PROJECTION_REL), accountUsageProjectionPath(root));
});

test("W1-T2516: the gate can read a usage projection on a host where every worker HOME is redirected", async () => {
  const root = mkdtempSync(join(tmpdir(), "w1-t2516-root-"));
  const workerHome = mkdtempSync(join(tmpdir(), "w1-t2516-workerhome-"));
  const nowMs = Date.now();

  // The worker's OWN redirected HOME writes its OWN .claude.json, exactly as a real Claude Code
  // invocation does under HOME redirection (worker-home.ts).
  writeFileSync(join(workerHome, CLAUDE_CONFIG_REL), JSON.stringify(claudeJsonFixture({ accountUuid: ACCOUNT_UUID, fetchedAtMs: nowMs })));

  const captured = captureWorkerUsageProjection(root, workerHome);
  assert.equal(captured, true, "a worker home carrying a real cachedUsageUtilization block is captured");
  assert.equal(readFileSync(accountUsageProjectionPath(root), "utf8").length > 0, true);

  // The real operator home has identity (a login happened once) but its OWN cache was never
  // refreshed — the documented headless-host shape.
  const primaryPath = join(mkdtempSync(join(tmpdir(), "w1-t2516-home-")), ".claude.json");
  writeFileSync(primaryPath, JSON.stringify(identityOnlyFixture(ACCOUNT_UUID)));

  const route = buildAccountUsageRoute({ ledgerPath: join(root, "ledger.ndjson"), accountFilePath: primaryPath, root, now: () => nowMs });
  const { status, parsed } = await invokeRoute(route);
  assert.equal(status, 200);
  assert.equal(parsed.usageUnknownReason, undefined, "a usable reading — never the pre-fix permanent unknown");
  assert.deepEqual(parsed.fiveHour, { percentUsed: 42, resetsAt: "2099-01-01T00:00:00Z" });
  assert.deepEqual(parsed.sevenDay, { percentUsed: 7, resetsAt: "2099-01-08T00:00:00Z" });
  assert.equal(parsed.accountUuid, ACCOUNT_UUID, "identity still comes from the primary file, untouched");
});

test("W1-T2516: a reading survives the reaping of the worker home that produced it, and removing the persisted projection breaks that survival", async () => {
  const root = mkdtempSync(join(tmpdir(), "w1-t2516-root-"));
  const workerHomeRoot = join(root, "worker-home");
  const workerHome = perRunWorkerHomeDir(workerHomeRoot, "RUN-SURVIVES-REAP");
  const nowMs = Date.now();

  mkdirSync(workerHome, { recursive: true });
  writeFileSync(join(workerHome, CLAUDE_CONFIG_REL), JSON.stringify(claudeJsonFixture({ accountUuid: ACCOUNT_UUID, fetchedAtMs: nowMs })));

  const primaryPath = join(mkdtempSync(join(tmpdir(), "w1-t2516-home-")), ".claude.json");
  writeFileSync(primaryPath, JSON.stringify(identityOnlyFixture(ACCOUNT_UUID)));

  const buildRoute = () =>
    buildAccountUsageRoute({ ledgerPath: join(root, "ledger.ndjson"), accountFilePath: primaryPath, root, now: () => nowMs });

  // BEFORE reap: prove the worker home really carries the reading (a sanity check that the
  // fixture is real, not a tautology).
  assert.equal(readFileSync(join(workerHome, CLAUDE_CONFIG_REL), "utf8").includes(String(nowMs)), true);

  const captured = captureWorkerUsageProjection(root, workerHome);
  assert.equal(captured, true);

  // THE REAP — the exact call worker.ts's spawnWorker makes in its `finally`, deleting the
  // worker home this reading was captured from.
  const reapResult = reapWorkerHome(workerHomeRoot, workerHome);
  assert.equal(reapResult.reaped, true, "the worker home was really removed, not merely claimed to be");
  assert.throws(() => readFileSync(join(workerHome, CLAUDE_CONFIG_REL), "utf8"), "the worker home is genuinely gone after the reap");

  // AFTER reap: the gate still reads a valid percentage — SURVIVAL.
  const survived = await invokeRoute(buildRoute());
  assert.equal(survived.parsed.usageUnknownReason, undefined, "the reading survives the reap of the home that produced it");
  assert.deepEqual(survived.parsed.fiveHour, { percentUsed: 42, resetsAt: "2099-01-01T00:00:00Z" });

  // CLAIM 8: removing the persisted projection makes the survives-reaping assertion FAIL — proof
  // that the projection file, not some other side channel, is what carried the reading.
  rmSync(accountUsageProjectionPath(root), { force: true });
  const withoutProjection = await invokeRoute(buildRoute());
  assert.notEqual(withoutProjection.parsed.usageUnknownReason, undefined, "with the projection gone, the reading is unknown again");
  assert.equal(withoutProjection.parsed.fiveHour, undefined, "and no percentage renders once the projection is removed");
});

test("W1-T2516: a reading whose account uuid does not match is still refused, never rendered", () => {
  const nowMs = Date.now();
  const primaryInput: AccountUsageInput = { uuid: ACCOUNT_UUID, email: "operator@example.com" };
  const projection: AccountUsageProjection = { cacheUuid: OTHER_ACCOUNT_UUID, cacheFetchedAtMs: nowMs, fiveHour: { percentUsed: 42 } };

  const merged = mergeAccountUsageProjection(primaryInput, projection);
  const out = deriveAccountUsage(merged, [], nowMs);
  assert.equal(out.usageUnknownReason, "account-mismatch");
  assert.equal(out.fiveHour, undefined, "a mismatched account's percentage is never rendered");
  assert.equal(out.accountUuid, ACCOUNT_UUID, "identity itself is untouched and still answers 'which account'");
});

test("W1-T2516: a reading older than the staleness bound is still refused, never presented as current", () => {
  const nowMs = Date.now();
  const primaryInput: AccountUsageInput = { uuid: ACCOUNT_UUID };
  const stale = nowMs - USAGE_CACHE_MAX_AGE_MS - 1;
  const projection: AccountUsageProjection = { cacheUuid: ACCOUNT_UUID, cacheFetchedAtMs: stale, fiveHour: { percentUsed: 91 } };

  const merged = mergeAccountUsageProjection(primaryInput, projection);
  const out = deriveAccountUsage(merged, [], nowMs);
  assert.equal(out.usageUnknownReason, "too-old");
  assert.equal(out.fiveHour, undefined, "a too-old reading is withheld, never shown as if current");
});

test("W1-T2516: an absent reading abstains rather than asserting a percentage", () => {
  const nowMs = Date.now();

  // No primary at all, no projection at all.
  const unreadablePrimary = readAccountUsageFile(join(tmpdir(), "w1-t2516-definitely-does-not-exist.json"));
  const stillUnreadable = deriveAccountUsage(mergeAccountUsageProjection(unreadablePrimary, undefined), [], nowMs);
  assert.equal(stillUnreadable.usageUnknownReason, "unreadable");
  assert.equal(stillUnreadable.fiveHour, undefined);
  assert.notEqual(stillUnreadable.fiveHour, 0, "absent must never collapse into a genuine zero");

  // Primary readable (identity present) but no cache anywhere, and no projection either.
  const primaryInput: AccountUsageInput = { uuid: ACCOUNT_UUID };
  const noCache = deriveAccountUsage(mergeAccountUsageProjection(primaryInput, undefined), [], nowMs);
  assert.equal(noCache.usageUnknownReason, "no-cache");
  assert.equal(noCache.fiveHour, undefined);

  // A projection file that exists but is malformed reads as absent too, never a crash.
  const badPath = join(mkdtempSync(join(tmpdir(), "w1-t2516-bad-projection-")), "account-usage-projection.json");
  writeFileSync(badPath, "{ this is not json");
  assert.equal(readAccountUsageProjection(badPath), undefined);
});

test("W1-T2516: the console ACCOUNT strip renders exactly what it renders today when no projection exists", async () => {
  // A caller supplying no `root` (every pre-W1-T333 caller of AccountUsageDeps) must see the
  // route's OLD behaviour byte-for-byte: no projection is even looked for.
  const primaryPath = join(mkdtempSync(join(tmpdir(), "w1-t2516-home-")), ".claude.json");
  const nowMs = 1785516413209;
  writeFileSync(primaryPath, JSON.stringify(claudeJsonFixture({ accountUuid: ACCOUNT_UUID, fetchedAtMs: nowMs })));
  const primaryInput = readAccountUsageFile(primaryPath);

  // The pure merge is a byte-identical, reference-preserving no-op absent a projection.
  assert.equal(mergeAccountUsageProjection(primaryInput, undefined), primaryInput);

  const routeWithoutRoot = buildAccountUsageRoute({
    ledgerPath: join(mkdtempSync(join(tmpdir(), "w1-t2516-ledger-")), "ledger.ndjson"),
    accountFilePath: primaryPath,
    now: () => nowMs,
  });
  const { parsed } = await invokeRoute(routeWithoutRoot);
  const expected = deriveAccountUsage(primaryInput, [], nowMs);
  assert.deepEqual(parsed.fiveHour, expected.fiveHour);
  assert.deepEqual(parsed.sevenDay, expected.sevenDay);
  assert.equal(parsed.usageUnknownReason, expected.usageUnknownReason);
  assert.equal(parsed.accountUuid, expected.accountUuid);
});

test("W1-T2516: capturing a worker home with no .claude.json at all is a silent, best-effort no-op", () => {
  const root = mkdtempSync(join(tmpdir(), "w1-t2516-root-"));
  const emptyWorkerHome = mkdtempSync(join(tmpdir(), "w1-t2516-empty-workerhome-"));
  // No `.claude.json` written at all -- the shape of a spawn that died before the CLI ever
  // wrote one, or a fixture worker home in an unrelated test.
  const captured = captureWorkerUsageProjection(root, emptyWorkerHome);
  assert.equal(captured, false);
  assert.throws(() => readFileSync(accountUsageProjectionPath(root), "utf8"), "nothing is ever written when there is nothing to capture");
});

test("W1-T2516: a primary reading that is already at least as fresh is never clobbered by an older projection", () => {
  const nowMs = Date.now();
  const primaryInput: AccountUsageInput = {
    uuid: ACCOUNT_UUID,
    cacheUuid: ACCOUNT_UUID,
    cacheFetchedAtMs: nowMs,
    fiveHour: { percentUsed: 5, resetsAt: "2099-01-01T00:00:00Z" },
  };
  // The projection is OLDER than the primary's own cache -- merging it in would make the
  // reading WORSE (staler), which mergeAccountUsageProjection must refuse to do.
  const staleProjection: AccountUsageProjection = { cacheUuid: ACCOUNT_UUID, cacheFetchedAtMs: nowMs - 60_000, fiveHour: { percentUsed: 99 } };

  const merged = mergeAccountUsageProjection(primaryInput, staleProjection);
  assert.equal(merged, primaryInput, "the primary is returned untouched -- it was already at least as fresh");
  assert.deepEqual(deriveAccountUsage(merged, [], nowMs).fiveHour, { percentUsed: 5, resetsAt: "2099-01-01T00:00:00Z" });
});

test("W1-T2516: no OAuth material from the worker's config file is copied or persisted anywhere", () => {
  const root = mkdtempSync(join(tmpdir(), "w1-t2516-root-"));
  const workerHome = mkdtempSync(join(tmpdir(), "w1-t2516-workerhome-"));
  writeFileSync(
    join(workerHome, CLAUDE_CONFIG_REL),
    JSON.stringify(claudeJsonFixture({ accountUuid: ACCOUNT_UUID, fetchedAtMs: Date.now(), withOauthJunk: true })),
  );

  const captured = captureWorkerUsageProjection(root, workerHome);
  assert.equal(captured, true);

  const raw = readFileSync(accountUsageProjectionPath(root), "utf8");
  for (const forbidden of [
    "sk-ant-oat01-super-secret-token",
    "sk-ant-ort01-also-secret",
    "accessToken",
    "refreshToken",
    "claudeAiOauth",
    "leak-if-copied@example.com",
    "organizationName",
    "emailAddress",
    "oauthAccount",
  ]) {
    assert.equal(raw.includes(forbidden), false, `the persisted projection must never contain ${forbidden}`);
  }

  const parsed = JSON.parse(raw);
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ["cacheFetchedAtMs", "cacheUuid", "fiveHour", "sevenDay"],
    "exactly the cache-only fields — no identity, no OAuth-shaped key, ever persisted",
  );
});
