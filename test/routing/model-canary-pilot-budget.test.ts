import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Config } from "#src/lib/config.js";
import { openWeightReservationUsd, reserveOpenWeightBudget, settleOpenWeightBudget } from "#src/lib/worker-provider.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const FEATURE_PATH = "#src/lib/model-canary-pilot-budget.js";
const PILOT_SUFFIX = ".model-canary-pilot.sqlite";
const DAY1 = "2026-11-03T12:00:00.000Z";
const DAY2 = "2026-11-04T12:00:00.000Z";
const MODEL = "gpt-oss-120b";
const feature = await import(FEATURE_PATH).catch(() => null) as null | {
  issueCanaryPilotBudgetCapability(input: { phase: "smoke" | "post-smoke"; sharedAllowancePath: string }): object;
  withCanaryPilotBudget<T>(capability: object, operation: () => Promise<T>): Promise<T>;
  isCurrentCanaryPilotBudget(capability: object): boolean;
  readCurrentCanaryPilotBudgetAccounting(capability: object): Readonly<{
    requestCount: number; settledCount: number; heldCount: number;
  }> | null;
};

function requireFeature() {
  assert.ok(feature, "native pilot budget module is absent");
  return feature;
}

function fixture(dailyCapUsd = 25, fleetCapUsd = 25) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "rmd-canary-pilot-budget-"));
  const shared = join(dir, "allowance.json");
  const root = join(dir, "worker-root");
  writeFileSync(shared, JSON.stringify({ utcDay: "2026-11-03", fleetCapUsd, reservations: {} }) + "\n", { mode: 0o600 });
  const config = { root, claudeBin: "/unused", dailyCapUsd,
    workerProviders: { enabled: ["cash"], fleetCashAllowancePath: shared } } as Config;
  return { dir, shared, root, config, pilotDb: `${shared}${PILOT_SUFFIX}`, close: () => rmSync(dir, { recursive: true, force: true }) };
}

function identity(requestId: string) {
  return { requestId, attemptId: `attempt-${requestId}`, provider: "cash" as const,
    deployment: MODEL, endpoint: "https://cash.example.test/openai/v1/chat/completions" };
}

function bytesForAtLeast(usd: number) {
  let high = 1;
  while (openWeightReservationUsd(MODEL, high) < usd) high *= 2;
  let low = 0;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (openWeightReservationUsd(MODEL, mid) >= usd) high = mid;
    else low = mid;
  }
  return high;
}

function reserveInput(requestId: string, requestBodyBytes = 1024, atIso = DAY1) {
  return { requestId, identity: identity(requestId), deployment: MODEL, requestBodyBytes, atIso };
}

async function reserveWithin(f: ReturnType<typeof fixture>, phase: "smoke" | "post-smoke", requestId: string,
  requestBodyBytes: number, atIso = DAY1) {
  const api = requireFeature();
  const capability = api.issueCanaryPilotBudgetCapability({ phase, sharedAllowancePath: f.shared });
  return api.withCanaryPilotBudget(capability, async () => reserveOpenWeightBudget(f.config,
    reserveInput(requestId, requestBodyBytes, atIso)));
}

function totals(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`SELECT
      COALESCE(SUM(committed_micros), 0) AS lifetime,
      COALESCE(SUM(CASE WHEN phase='smoke' THEN committed_micros ELSE 0 END), 0) AS smoke,
      COUNT(*) AS rows
      FROM canary_pilot_reservations_v1`).get() as { lifetime: number; smoke: number; rows: number };
    return { lifetime: row.lifetime, smoke: row.smoke, rows: row.rows };
  } finally { db.close(); }
}

function finish(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "", stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += String(chunk); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("lifetime and smoke caps stay fixed across requests and JSON reload", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const smokeBytes = bytesForAtLeast(1.1);
    await reserveWithin(f, "smoke", "smoke-a", smokeBytes);
    const global = JSON.parse(readFileSync(f.shared, "utf8"));
    writeFileSync(f.shared, JSON.stringify({ ...global, modelCanaryPilotLifetimeCapUsd: 999_999,
      modelCanaryPilotSmokeCapUsd: 999_999 }) + "\n", { mode: 0o600 });
    await assert.rejects(reserveWithin(f, "smoke", "smoke-b", smokeBytes), /smoke-cap-exhausted/);

    const followupBytes = bytesForAtLeast(6.1);
    await reserveWithin(f, "post-smoke", "lifetime-a", followupBytes);
    await assert.rejects(reserveWithin(f, "post-smoke", "lifetime-b", bytesForAtLeast(4.1)), /lifetime-cap-exhausted/);
    assert.deepEqual(totals(f.pilotDb), { lifetime: Math.ceil(openWeightReservationUsd(MODEL, smokeBytes) * 1_000_000)
      + Math.ceil(openWeightReservationUsd(MODEL, followupBytes) * 1_000_000),
      smoke: Math.ceil(openWeightReservationUsd(MODEL, smokeBytes) * 1_000_000), rows: 2 });
    assert.equal(statSync(f.pilotDb).mode & 0o777, 0o600);
    const db = new DatabaseSync(f.pilotDb, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
      db.exec("PRAGMA synchronous=EXTRA");
      assert.equal(db.prepare("PRAGMA synchronous").get()?.synchronous, 3);
    } finally { db.close(); }

    // A normal cash caller outside the ALS scope continues to use only the global allowance.
    const ordinaryId = "ordinary-outside-pilot";
    reserveOpenWeightBudget(f.config, reserveInput(ordinaryId));
    assert.equal(totals(f.pilotDb).rows, 2);
    void api;
  } finally { f.close(); }
});

test("a closed async scope rejects inherited new requests but permits only its exact late settlement", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const requestId = "late-settlement";
    const reservation = reserveInput(requestId, bytesForAtLeast(1.2));
    let child: Promise<unknown> | undefined;
    const capability = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    await api.withCanaryPilotBudget(capability, async () => {
      reserveOpenWeightBudget(f.config, reservation);
      child = new Promise((resolve, reject) => setTimeout(() => {
        try {
          assert.throws(() => reserveOpenWeightBudget(f.config, reserveInput("after-scope", 1024)), /scope.*closed/);
          assert.equal(api.readCurrentCanaryPilotBudgetAccounting(capability), null, "closed inherited context exposes no completion snapshot");
          const settled = settleOpenWeightBudget(f.config, { requestId, identity: reservation.identity,
            actualUsd: 0.25, atIso: reservation.atIso });
          resolve(settled);
        } catch (error) { reject(error); }
      }, 0));
    });
    assert.ok(child);
    assert.equal((await child) && totals(f.pilotDb).rows, 1);
    assert.equal(totals(f.pilotDb).lifetime, 250_000);
  } finally { f.close(); }
});

test("only an exact same-invocation CAS retry reuses the pilot reservation", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const capability = api.issueCanaryPilotBudgetCapability({ phase: "post-smoke", sharedAllowancePath: f.shared });
    let first = true;
    await api.withCanaryPilotBudget(capability, async () => reserveOpenWeightBudget(f.config, {
      ...reserveInput("cas-same-invocation", 4096), beforeCommit: () => {
        if (!first) return;
        first = false;
        const global = JSON.parse(readFileSync(f.shared, "utf8"));
        global.concurrentPeer = true;
        writeFileSync(f.shared, JSON.stringify(global) + "\n", { mode: 0o600 });
      },
    }));
    assert.equal(totals(f.pilotDb).rows, 1);
    const reset = JSON.parse(readFileSync(f.shared, "utf8"));
    writeFileSync(f.shared, JSON.stringify({ ...reset, utcDay: "2026-11-04", reservations: {} }) + "\n", { mode: 0o600 });
    await assert.rejects(reserveWithin(f, "post-smoke", "cas-same-invocation", 4096, DAY2), /duplicate/);
  } finally { f.close(); }
});

test("unknown settlement remains fully reserved across restart and UTC rollover", async () => {
  const f = fixture();
  try {
    const bodyBytes = bytesForAtLeast(6.1);
    const source = `import {issueCanaryPilotBudgetCapability,withCanaryPilotBudget} from ${JSON.stringify(join(REPO_ROOT, "src/lib/model-canary-pilot-budget.ts"))};
      import {reserveOpenWeightBudget,settleOpenWeightBudget} from ${JSON.stringify(join(REPO_ROOT, "src/lib/worker-provider.ts"))};
      const [shared,id,bytes] = process.argv.slice(1);
      const config={root:process.cwd(),claudeBin:"/unused",dailyCapUsd:25,workerProviders:{enabled:["cash"],fleetCashAllowancePath:shared}};
      const identity={requestId:id,attemptId:"attempt-"+id,provider:"cash",deployment:${JSON.stringify(MODEL)},endpoint:"https://cash.example.test/openai/v1/chat/completions"};
      const cap=issueCanaryPilotBudgetCapability({phase:"post-smoke",sharedAllowancePath:shared});
      await withCanaryPilotBudget(cap,async()=>{reserveOpenWeightBudget(config,{requestId:id,identity,deployment:${JSON.stringify(MODEL)},requestBodyBytes:Number(bytes),atIso:${JSON.stringify(DAY1)}});
        settleOpenWeightBudget(config,{requestId:id,identity,actualUsd:undefined,atIso:${JSON.stringify(DAY1)}});});
      process.stdout.write("reserved:"+id+"\\n");`;
    const start = (id: string) => spawn(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source, f.shared, id, String(bodyBytes)],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const first = start("process-a"), second = start("process-b");
    const results = await Promise.all([finish(first), finish(second)]);
    assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
    assert.equal(results.filter(result => result.stdout.includes("reserved:")).length, 1);
    const winnerId = results.find(result => result.stdout.includes("reserved:"))!.stdout.match(/reserved:(process-[ab])/)?.[1];
    assert.ok(winnerId);
    assert.equal(totals(f.pilotDb).lifetime >= 6_100_000, true);
    const held = new DatabaseSync(f.pilotDb, { readOnly: true });
    try {
      const row = held.prepare("SELECT state,committed_micros,reserved_micros FROM canary_pilot_reservations_v1").get() as {
        state: string; committed_micros: number; reserved_micros: number;
      };
      assert.equal(row.state, "held");
      assert.equal(row.committed_micros, row.reserved_micros);
    } finally { held.close(); }

    // The winning request remains an unknown full hold after the process that created it exited.
    const reopened = JSON.parse(readFileSync(f.shared, "utf8"));
    writeFileSync(f.shared, JSON.stringify({ ...reopened, utcDay: "2026-11-04", reservations: {} }) + "\n", { mode: 0o600 });
    await assert.rejects(reserveWithin(f, "post-smoke", winnerId, bodyBytes, DAY2), /duplicate/);
    await assert.rejects(reserveWithin(f, "post-smoke", "next-day-retry", bodyBytes, DAY2), /lifetime-cap-exhausted/);
    assert.equal(totals(f.pilotDb).rows, 1);
  } finally { f.close(); }
});

test("corrupt pilot state and a missing shared fleet path fail before global reservation", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    writeFileSync(f.pilotDb, "not a sqlite database", { mode: 0o600 });
    const before = readFileSync(f.shared, "utf8");
    await assert.rejects(reserveWithin(f, "smoke", "corrupt-store", 1024));
    assert.equal(readFileSync(f.shared, "utf8"), before);

    const local = { ...f.config, workerProviders: { enabled: ["cash"] } } as Config;
    const cap = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    await assert.rejects(api.withCanaryPilotBudget(cap, async () => reserveOpenWeightBudget(local,
      reserveInput("no-shared-path"))), /shared.*path/);
  } finally { f.close(); }
});

test("pilot budget capability is recognized only in its exact live async scope", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const capability = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    const other = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    assert.equal(api.isCurrentCanaryPilotBudget(capability), false);
    await api.withCanaryPilotBudget(capability, async () => {
      await Promise.resolve();
      assert.equal(api.isCurrentCanaryPilotBudget(capability), true);
      assert.equal(api.isCurrentCanaryPilotBudget(other), false);
    });
    assert.equal(api.isCurrentCanaryPilotBudget(capability), false);
    assert.equal(api.readCurrentCanaryPilotBudgetAccounting(capability), null);
  } finally { f.close(); }
});

test("pilot completion snapshot counts only exact settlements and is private to the active capability", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const capability = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    const serialized = JSON.parse(JSON.stringify(capability)) as object;
    assert.equal(api.readCurrentCanaryPilotBudgetAccounting(capability), null, "outside ALS no owner snapshot exists");
    await api.withCanaryPilotBudget(capability, async () => {
      assert.deepEqual(api.readCurrentCanaryPilotBudgetAccounting(capability), { requestCount: 0, settledCount: 0, heldCount: 0 });
      assert.equal(api.readCurrentCanaryPilotBudgetAccounting(serialized), null, "JSON copies cannot read another capability scope");
      const unknown = reserveInput("snapshot-unknown");
      reserveOpenWeightBudget(f.config, unknown);
      settleOpenWeightBudget(f.config, { requestId: unknown.requestId, identity: unknown.identity,
        actualUsd: undefined, atIso: unknown.atIso });
      assert.deepEqual(api.readCurrentCanaryPilotBudgetAccounting(capability), { requestCount: 1, settledCount: 0, heldCount: 1 });

      const known = reserveInput("snapshot-known");
      reserveOpenWeightBudget(f.config, known);
      settleOpenWeightBudget(f.config, { requestId: known.requestId, identity: known.identity, actualUsd: 0.001, atIso: known.atIso });
      const snapshot = api.readCurrentCanaryPilotBudgetAccounting(capability)!;
      assert.deepEqual(snapshot, { requestCount: 2, settledCount: 1, heldCount: 1 });
      assert.deepEqual(Object.keys(snapshot).sort(), ["heldCount", "requestCount", "settledCount"]);
      assert.equal(Object.isFrozen(snapshot), true);
    });
    assert.equal(api.readCurrentCanaryPilotBudgetAccounting(capability), null, "a closed scope has no readable snapshot");
    const rows = new DatabaseSync(f.pilotDb, { readOnly: true });
    try {
      const state = rows.prepare("SELECT state,COUNT(*) AS count FROM canary_pilot_reservations_v1 GROUP BY state ORDER BY state").all() as Array<{ state: string; count: number }>;
      assert.deepEqual(state.map(row => ({ ...row })), [{ state: "held", count: 1 }, { state: "settled", count: 1 }]);
    } finally { rows.close(); }
  } finally { f.close(); }
});

test("pilot budget context reaches all three cash paths and isolates concurrent callers", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    let releaseSettlements!: () => void;
    let bothReserved!: () => void;
    const finishGate = new Promise<void>(resolve => { releaseSettlements = resolve; });
    const reserveGate = new Promise<void>(resolve => { bothReserved = resolve; });
    let arrivals = 0;
    const runScoped = (requestId: string, phase: "smoke" | "post-smoke") => {
      const request = reserveInput(requestId);
      const capability = api.issueCanaryPilotBudgetCapability({ phase, sharedAllowancePath: f.shared });
      return api.withCanaryPilotBudget(capability, async () => {
        await Promise.resolve();
        reserveOpenWeightBudget(f.config, request);
        arrivals += 1;
        if (arrivals === 2) bothReserved();
        await finishGate;
        const settled = settleOpenWeightBudget(f.config, { requestId, identity: request.identity, actualUsd: 0.001, atIso: request.atIso });
        assert.equal(settled?.settledUsd, 0.001);
      });
    };
    const first = runScoped("concurrent-pilot-a", "smoke");
    const second = runScoped("concurrent-pilot-b", "post-smoke");
    await reserveGate;
    reserveOpenWeightBudget(f.config, reserveInput("ordinary-concurrent"));
    releaseSettlements();
    await Promise.all([first, second]);
    assert.equal(totals(f.pilotDb).rows, 2, "the overlapping ordinary request stays outside both ALS scopes");
    assert.equal(totals(f.pilotDb).lifetime, 2_000);
    const global = JSON.parse(readFileSync(f.shared, "utf8")) as { reservations: Record<string, unknown> };
    assert.equal(Object.keys(global.reservations).length, 3);
  } finally { f.close(); }
});

test("pilot and ordinary cash requests contend on the same global fleet cap", async () => {
  const want = openWeightReservationUsd(MODEL, 1024);
  const cap = want * 1.5;
  for (const first of ["pilot", "ordinary"] as const) {
    const f = fixture(cap, cap);
    try {
      const input = (id: string) => reserveInput(id, 1024);
      if (first === "pilot") await reserveWithin(f, "smoke", "pilot-first", 1024);
      else reserveOpenWeightBudget(f.config, input("ordinary-first"));
      if (first === "pilot") {
        assert.throws(() => reserveOpenWeightBudget(f.config, input("ordinary-second")), /allowance exhausted/);
      } else {
        await assert.rejects(reserveWithin(f, "smoke", "pilot-second", 1024), /allowance exhausted/);
      }
      const global = JSON.parse(readFileSync(f.shared, "utf8")) as { reservations: Record<string, unknown> };
      assert.equal(Object.keys(global.reservations).length, 1);
      assert.equal(existsSync(f.pilotDb), first === "pilot");
    } finally { f.close(); }
  }
});

test("clamped global settlement keeps pilot hold when original charge exceeds reservation", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const request = reserveInput("over-reservation");
    const cap = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    await api.withCanaryPilotBudget(cap, async () => {
      const reservation = reserveOpenWeightBudget(f.config, request);
      const clamped = settleOpenWeightBudget(f.config, { requestId: request.requestId, identity: request.identity,
        actualUsd: reservation.reservedUsd + 0.5, atIso: request.atIso });
      assert.equal(clamped?.settledUsd, reservation.reservedUsd);
      assert.deepEqual(api.readCurrentCanaryPilotBudgetAccounting(cap), { requestCount: 1, settledCount: 0, heldCount: 1 },
        "the global clamped receipt cannot claim pilot settlement");
      assert.throws(() => settleOpenWeightBudget(f.config, { requestId: request.requestId,
        identity: { ...request.identity, endpoint: "https://wrong.example.test" }, actualUsd: 0.01, atIso: request.atIso }), /not-owned/);
      const db = new DatabaseSync(f.pilotDb, { readOnly: true });
      try {
        const row = db.prepare("SELECT state,committed_micros,reserved_micros FROM canary_pilot_reservations_v1").get() as {
          state: string; committed_micros: number; reserved_micros: number;
        };
        assert.equal(row.state, "held");
        assert.equal(row.committed_micros, row.reserved_micros);
      } finally { db.close(); }
    });
    assert.equal(api.readCurrentCanaryPilotBudgetAccounting(cap), null);
  } finally { f.close(); }
});

test("an exact repeated settlement is idempotent and corrupt receipt state rolls back", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const request = reserveInput("settlement-idempotent");
    const capability = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    await api.withCanaryPilotBudget(capability, async () => {
      reserveOpenWeightBudget(f.config, request);
      const evidence = { requestId: request.requestId, identity: request.identity, actualUsd: 0.001, atIso: request.atIso };
      assert.equal(settleOpenWeightBudget(f.config, evidence)?.settledUsd, 0.001);
      assert.equal(settleOpenWeightBudget(f.config, evidence)?.settledUsd, 0.001);
      const db = new DatabaseSync(f.pilotDb, { readOnly: true });
      try { assert.equal((db.prepare("SELECT state FROM canary_pilot_reservations_v1").get() as { state: string }).state, "settled"); }
      finally { db.close(); }
    });

    const corrupted = reserveInput("settlement-corrupt-row");
    const corruptCapability = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    await api.withCanaryPilotBudget(corruptCapability, async () => {
      reserveOpenWeightBudget(f.config, corrupted);
      const db = new DatabaseSync(f.pilotDb);
      try { db.prepare("UPDATE canary_pilot_reservations_v1 SET identity_json='not-json' WHERE request_id=?").run(corrupted.requestId); }
      finally { db.close(); }
      assert.throws(() => settleOpenWeightBudget(f.config, { requestId: corrupted.requestId,
        identity: corrupted.identity, actualUsd: 0.001, atIso: corrupted.atIso }), /existing-identity-invalid/);
      const check = new DatabaseSync(f.pilotDb, { readOnly: true });
      try {
        const row = check.prepare("SELECT state,committed_micros,reserved_micros FROM canary_pilot_reservations_v1 WHERE request_id=?").get(corrupted.requestId) as {
          state: string; committed_micros: number; reserved_micros: number;
        };
        assert.equal(row.state, "held");
        assert.equal(row.committed_micros, row.reserved_micros);
      } finally { check.close(); }
    });
  } finally { f.close(); }
});

test("a failure after pilot commit keeps the full hold before the shared JSON commit", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const request = reserveInput("global-commit-failure");
    const before = readFileSync(f.shared, "utf8");
    const cap = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    await assert.rejects(api.withCanaryPilotBudget(cap, async () => reserveOpenWeightBudget(f.config, {
      ...request, beforeCommit: () => { throw new Error("fixture-global-json-commit-failure"); },
    })), /fixture-global-json-commit-failure/);
    assert.equal(readFileSync(f.shared, "utf8"), before);
    const amount = Math.ceil(openWeightReservationUsd(MODEL, 1024) * 1_000_000);
    assert.deepEqual(totals(f.pilotDb), { lifetime: amount, smoke: amount, rows: 1 });
  } finally { f.close(); }
});

test("oversized identities and stored rows are refused before the reservation store grows", async () => {
  const f = fixture();
  try {
    const api = requireFeature();
    const before = readFileSync(f.shared, "utf8");
    const oversizedIdentity = { ...identity("oversized-identity"), endpoint: `https://x.test/${"x".repeat(5000)}` };
    const capability = api.issueCanaryPilotBudgetCapability({ phase: "smoke", sharedAllowancePath: f.shared });
    await assert.rejects(api.withCanaryPilotBudget(capability, async () => reserveOpenWeightBudget(f.config, {
      ...reserveInput("oversized-identity"), identity: oversizedIdentity,
    })), /identity-required/);
    assert.equal(readFileSync(f.shared, "utf8"), before);
    assert.equal(existsSync(f.pilotDb), false);

    await reserveWithin(f, "smoke", "valid-before-corrupt-row", 1024);
    const corrupt = new DatabaseSync(f.pilotDb);
    try { corrupt.prepare("UPDATE canary_pilot_reservations_v1 SET identity_json=?").run("x".repeat(5000)); }
    finally { corrupt.close(); }
    const globalBeforeNext = readFileSync(f.shared, "utf8");
    await assert.rejects(reserveWithin(f, "smoke", "blocked-by-oversized-row", 1024), /row-field-too-large/);
    assert.equal(readFileSync(f.shared, "utf8"), globalBeforeNext);
  } finally { f.close(); }
});
