/**
 * W1-T10381 — A FLEET CREDENTIAL STORE LEFT ON AN EXHAUSTED ACCOUNT IS NAMED AND ESCALATED.
 *
 * READ 2026-10-22: the operator moved the host login to a second account (43% weekly) while the fleet store
 * stayed on the first (99%, API 429). The store reads `usable` by file shape forever, so the fleet ran on the
 * cash lane for hours and no ledger row said which account the headroom reading measured. These tests drive
 * the REAL daemon loop and the REAL `.claude.json` identity reader against fixture files.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createFleetAccountEpisode,
  readFleetAccountPair,
  redactedAccountLabel,
  type FleetAccountDivergence,
  type FleetAccountPair,
} from "#src/lib/account-usage.js";
import { HEADROOM_LIMIT_PCT, type UsageSnapshot } from "#src/lib/headroom.js";
import { loadPlan } from "#src/lib/plan.js";
import { runDaemon } from "#src/lib/daemon.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { RunResult } from "#src/run-task.js";

const NOW = new Date(2026, 6, 20, 12, 0, 0, 0);
const STORE_UUID = "11111111-1111-4111-8111-111111111111";
const HOST_UUID = "22222222-2222-4222-8222-222222222222";
const SECRET = "sk-ant-oat01-DO-NOT-LEAK";

interface Fixture {
  dir: string;
  storeDir: string;
  hostFile: string;
  storeFile: string;
  cleanup: () => void;
}

function claudeJson(email: string | undefined, uuid: string | undefined, sevenDay: number | undefined): string {
  return JSON.stringify({
    ...(email || uuid
      ? { oauthAccount: { ...(email ? { emailAddress: email } : {}), ...(uuid ? { accountUuid: uuid } : {}) } }
      : {}),
    primaryApiKey: SECRET,
    ...(sevenDay !== undefined
      ? {
          cachedUsageUtilization: {
            accountUuid: uuid,
            fetchedAtMs: NOW.getTime(),
            utilization: { seven_day: { utilization: sevenDay, resets_at: "2026-07-28T12:00:00Z" } },
          },
        }
      : {}),
  });
}

function fixture(store: string | null, host: string | null): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fleet-account-`));
  const storeDir = join(dir, "store");
  mkdirSync(storeDir, { recursive: true });
  const storeFile = join(storeDir, ".claude.json");
  const hostFile = join(dir, "host.claude.json");
  if (store !== null) writeFileSync(storeFile, store);
  if (host !== null) writeFileSync(hostFile, host);
  writeFileSync(join(storeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }));
  return { dir, storeDir, hostFile, storeFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const STORE_EXHAUSTED = claudeJson("craigoleyagent@gmail.com", STORE_UUID, 99);
const HOST_HEALTHY = claudeJson("craigoley@gmail.com", HOST_UUID, 43);

function plan() {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}fleet-account-plan-`));
  const path = join(dir, "tasks.yaml");
  writeFileSync(
    path,
    "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n",
  );
  const loaded = loadPlan(path);
  rmSync(dir, { recursive: true, force: true });
  return loaded;
}

const snapshotAt = (percentUsed: number): UsageSnapshot => ({
  billingMode: "subscription",
  session: { percentUsed: 10, resetsAt: "x" },
  weekly: [{ label: "all models", percentUsed, resetsAt: "Jul 28 at 12am" }],
});

const okResult = (id: string): RunResult => ({ taskId: id, runId: id + "-run", merged: true, costUsd: 0, verdict: "merged" });

/** Drive the real loop for `ticks` idle passes; `usage(n)` is the n-th reading, `pair(n)` the n-th identity read. */
async function drive(
  ticks: number,
  usage: (n: number) => UsageSnapshot,
  pair: (n: number) => FleetAccountPair | undefined,
  extra: { onFleetAccountDivergence?: (i: FleetAccountDivergence) => void | Promise<void> } = {},
) {
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const hits: FleetAccountDivergence[] = [];
  let reads = 0;
  let pairReads = 0;
  await runDaemon(plan(), {
    refreshMerged: () => () => false,
    runOne: async (id) => okResult(id),
    readUsage: () => usage(reads++),
    readFleetAccounts: () => pair(pairReads++),
    onFleetAccountDivergence: extra.onFleetAccountDivergence ?? ((i) => void hits.push(i)),
    now: () => NOW,
    sleep: async () => {},
    // Stop on READS, not idle passes: a pass under the reserve dispatches and never idles.
    checkStop: () => (reads >= ticks ? "observed enough ticks" : undefined),
    log: (step, e = {}) => lines.push({ step, extra: e }),
  });
  return { lines, hits };
}

test("W1-T10381: a fleet store on an exhausted account beside a different host account escalates once", async () => {
  const f = fixture(STORE_EXHAUSTED, HOST_HEALTHY);
  try {
    const { lines, hits } = await drive(
      3,
      () => snapshotAt(99),
      () => readFleetAccountPair(f.storeDir, f.hostFile),
    );
    assert.equal(hits.length, 1, "three passes in one episode escalate exactly once");
    assert.equal(hits[0].storeAccount, "cr***nt@gmail.com");
    assert.equal(hits[0].hostAccount, "cr***ey@gmail.com");
    assert.equal(hits[0].storePercentUsed, 99);
    assert.equal(hits[0].hostPercentUsed, 43);
    assert.equal(hits[0].limitPct, HEADROOM_LIMIT_PCT);
    assert.match(hits[0].remedy, /sign the fleet in/);
    const rows = lines.filter((l) => l.step === "daemon.fleet_account_diverged");
    assert.equal(rows.length, 1, "one ledger row for the episode");
    assert.equal(rows[0].extra.store_account, "cr***nt@gmail.com");
    assert.equal(rows[0].extra.host_account, "cr***ey@gmail.com");

    // The episode clears when the store drops under the reserve, so a later breach is a new episode.
    const ep = createFleetAccountEpisode();
    const pair = readFleetAccountPair(f.storeDir, f.hostFile);
    const over = { window: "weekly (all models)", percentUsed: 99, limitPct: 95 };
    assert.ok(ep.observe(pair, over, NOW.getTime()));
    assert.equal(ep.observe(pair, over, NOW.getTime()), undefined);
    assert.equal(ep.observe(pair, null, NOW.getTime()), undefined);
    assert.ok(ep.observe(pair, over, NOW.getTime()), "a recurrence after the store recovered is a fresh episode");
  } finally {
    f.cleanup();
  }
});

test("W1-T10381: the headroom row names its account and both credential files are untouched", async () => {
  const f = fixture(STORE_EXHAUSTED, HOST_HEALTHY);
  const creds = join(f.storeDir, ".credentials.json");
  const before = [f.storeFile, creds, f.hostFile].map((p) => readFileSync(p));
  try {
    const { lines } = await drive(
      2,
      () => snapshotAt(99),
      () => readFleetAccountPair(f.storeDir, f.hostFile),
    );
    const beat = lines.find((l) => l.step === "daemon.headroom");
    assert.ok(beat, "a headroom row was written");
    assert.equal(beat.extra.account, "cr***nt@gmail.com", "the row names the measured (store) account, redacted");
    assert.equal(beat.extra.over_ceiling, true);
    const everything = JSON.stringify(lines);
    assert.ok(!everything.includes(SECRET), "no token field reaches any row");
    assert.ok(!everything.includes("craigoleyagent@gmail.com"), "the full address never reaches a row");
    assert.ok(!everything.includes(STORE_UUID) && !everything.includes(HOST_UUID), "no account uuid reaches a row");
    const after = [f.storeFile, creds, f.hostFile].map((p) => readFileSync(p));
    after.forEach((b, i) => assert.ok(b.equals(before[i]), "credential/config file is byte-identical"));

    // An unreadable store reads `unknown`, never a blank.
    const gone = fixture(null, HOST_HEALTHY);
    try {
      const r = await drive(
        1,
        () => snapshotAt(99),
        () => readFleetAccountPair(gone.storeDir, gone.hostFile),
      );
      assert.equal(r.lines.find((l) => l.step === "daemon.headroom")!.extra.account, "unknown");
    } finally {
      gone.cleanup();
    }
    assert.equal(redactedAccountLabel(undefined), "unknown");
    assert.equal(redactedAccountLabel({ email: "not-an-address" }), "unknown");
    assert.equal(redactedAccountLabel({ email: "ab@x.io" }), "a***@x.io");
  } finally {
    f.cleanup();
  }
});

test("W1-T10381: a matching, healthy or unreadable account pair does not escalate", async () => {
  const cases: Array<{ name: string; store: string | null; host: string | null; usage: number }> = [
    { name: "same uuid", store: STORE_EXHAUSTED, host: claudeJson("craigoleyagent@gmail.com", STORE_UUID, 43), usage: 99 },
    { name: "store under the reserve", store: claudeJson("craigoleyagent@gmail.com", STORE_UUID, 40), host: HOST_HEALTHY, usage: 40 },
    { name: "host file unreadable", store: STORE_EXHAUSTED, host: null, usage: 99 },
    { name: "host without identity", store: STORE_EXHAUSTED, host: claudeJson(undefined, undefined, 43), usage: 99 },
    { name: "store without identity", store: claudeJson(undefined, undefined, 99), host: HOST_HEALTHY, usage: 99 },
    { name: "host usage cache absent", store: STORE_EXHAUSTED, host: claudeJson("craigoley@gmail.com", HOST_UUID, undefined), usage: 99 },
    { name: "host also exhausted", store: STORE_EXHAUSTED, host: claudeJson("craigoley@gmail.com", HOST_UUID, 97), usage: 99 },
  ];
  for (const c of cases) {
    const f = fixture(c.store, c.host);
    try {
      const { lines, hits } = await drive(
        2,
        () => snapshotAt(c.usage),
        () => readFleetAccountPair(f.storeDir, f.hostFile),
      );
      assert.equal(hits.length, 0, `${c.name}: no escalation`);
      assert.equal(lines.filter((l) => l.step === "daemon.fleet_account_diverged").length, 0, `${c.name}: no row`);
    } finally {
      f.cleanup();
    }
  }

  // A stale host cache is not headroom.
  const stale = fixture(STORE_EXHAUSTED, HOST_HEALTHY);
  try {
    const pair = readFleetAccountPair(stale.storeDir, stale.hostFile);
    const ep = createFleetAccountEpisode();
    const over = { window: "weekly (all models)", percentUsed: 99, limitPct: 95 };
    assert.equal(ep.observe(pair, over, NOW.getTime() + 31 * 60 * 1000), undefined);
    assert.equal(ep.observe(undefined, over, NOW.getTime()), undefined);
    // The session window reads the host's five-hour figure, which this fixture does not carry.
    assert.equal(ep.observe(pair, { window: "session (5h)", percentUsed: 99, limitPct: 95 }, NOW.getTime()), undefined);
  } finally {
    stale.cleanup();
  }
});

test("W1-T10381: a throwing identity read or escalation hook never takes the daemon down", async () => {
  const f = fixture(STORE_EXHAUSTED, HOST_HEALTHY);
  try {
    const bad = await drive(
      2,
      () => snapshotAt(99),
      () => {
        throw new Error("boom");
      },
    );
    assert.equal(bad.lines.filter((l) => l.step === "daemon.fleet_account.unreadable").length, 2);
    assert.equal(bad.lines.find((l) => l.step === "daemon.headroom")!.extra.account, "unknown");

    const thrown = await drive(
      2,
      () => snapshotAt(99),
      () => readFleetAccountPair(f.storeDir, f.hostFile),
      {
        onFleetAccountDivergence: () => {
          throw new Error("hook down");
        },
      },
    );
    assert.equal(thrown.lines.filter((l) => l.step === "daemon.escalation.failed").length, 1);
  } finally {
    f.cleanup();
  }
});
