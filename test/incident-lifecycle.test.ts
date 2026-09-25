// test/incident-lifecycle.test.ts — W1-T4387: "nobody checks a fix actually fixed anything".
//
// Criteria 1-2 drive the pure decision (`evaluateDeployedIncident`) and the one-pass wrapper
// (`runIncidentLifecyclePass`) directly — the ledger-corpus read is the caller's own concern
// (mirrors sre-lane.ts's own `readEvents` seam), so this stays a fast, no-fs unit test except
// where the credit/debit side effect (a real gardener state file) is asserted. Criterion 3 drives
// the real route's handler over an injected `readStore`, the same `invoke` harness
// test/one-registry-for-the-fleet.test.ts already uses for `buildRegistryRoute`. Criterion 4 is a
// grep over the real serve.ts wiring (plan/tasks.d's own acceptance), proven separately by CI.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { readGardenState } from "../src/lib/gardener.js";
import {
  buildIncidentsRoute,
  creditIncidentClass,
  debitIncidentClass,
  evaluateDeployedIncident,
  fixesIncidentFingerprint,
  incidentLifecycleGardenPath,
  linkFixPr,
  markDeployed,
  runIncidentLifecyclePass,
  type IncidentLifecycleRecord,
  type IncidentLifecycleStore,
  type IncidentLifecycleStoreRead,
} from "../src/lib/incident-lifecycle.js";
import type { Route } from "../src/lib/service.js";

function fixtureDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4387-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DEPLOY_MS = Date.parse("2026-09-24T00:00:00.000Z");
const WINDOW_MS = 24 * 60 * 60_000;

function deployedRecord(overrides: Partial<IncidentLifecycleRecord> = {}): IncidentLifecycleRecord {
  return {
    fingerprint: "a".repeat(64),
    title: "TypeError: boom",
    source: "console",
    kind: "exception",
    status: "deployed",
    firstSeenMs: DEPLOY_MS - 60_000,
    lastSeenMs: DEPLOY_MS - 30_000,
    count24h: 5,
    feedbackId: "incident-aaaaaaaaaaaaaaaa",
    pr: 4242,
    deploySha: "deadbeef",
    deployedAtMs: DEPLOY_MS,
    ...overrides,
  };
}

// ── fix PR names its incident ────────────────────────────────────────────────────────────────

test("a fix PR's Fixes-Incident trailer is read like Remudero-Task's own trailer", () => {
  const fp = "b".repeat(64);
  assert.equal(fixesIncidentFingerprint(`Fixes bug.\n\nFixes-Incident: ${fp}\n`), fp);
  assert.equal(fixesIncidentFingerprint("no trailer here"), undefined);
});

test("linkFixPr moves filed to building only when the trailer names this fingerprint", () => {
  const record: IncidentLifecycleRecord = { ...deployedRecord(), status: "filed", pr: null, deploySha: undefined, deployedAtMs: undefined };
  const linked = linkFixPr(record, 99, `Fixes-Incident: ${record.fingerprint}\n`);
  assert.equal(linked.status, "building");
  assert.equal(linked.pr, 99);

  const wrongTrailer = linkFixPr(record, 99, `Fixes-Incident: ${"c".repeat(64)}\n`);
  assert.equal(wrongTrailer.status, "filed");
  assert.equal(wrongTrailer.pr, null);

  const alreadyBuilding = linkFixPr(linked, 100, `Fixes-Incident: ${record.fingerprint}\n`);
  assert.equal(alreadyBuilding.pr, 99, "a further-along record is never rewound or relinked");
});

test("markDeployed only advances a building record", () => {
  const building: IncidentLifecycleRecord = { ...deployedRecord(), status: "building", deploySha: undefined, deployedAtMs: undefined };
  const deployed = markDeployed(building, "cafef00d", DEPLOY_MS);
  assert.equal(deployed.status, "deployed");
  assert.equal(deployed.deploySha, "cafef00d");
  assert.equal(deployed.deployedAtMs, DEPLOY_MS);

  const notBuilding = deployedRecord({ status: "filed" });
  assert.deepEqual(markDeployed(notBuilding, "cafef00d", DEPLOY_MS), notBuilding);
});

// ── criterion 1: verified only once the fingerprint stays quiet through the window ──────────

test("an incident moves to verified only when its fingerprint stays quiet after the fix deploys", () => {
  const record = deployedRecord();

  const stillWaiting = evaluateDeployedIncident(record, undefined, DEPLOY_MS + WINDOW_MS - 1, WINDOW_MS);
  assert.equal(stillWaiting.status, "deployed", "the window has not fully elapsed yet");

  const verified = evaluateDeployedIncident(record, undefined, DEPLOY_MS + WINDOW_MS, WINDOW_MS);
  assert.equal(verified.status, "verified");

  // A record that is not deployed has nothing left to verify.
  const notDeployed = deployedRecord({ status: "filed", deployedAtMs: undefined });
  assert.deepEqual(evaluateDeployedIncident(notDeployed, undefined, DEPLOY_MS + WINDOW_MS, WINDOW_MS), notDeployed);
});

// ── criterion 2: regressed is marked and stays linked to the PR ─────────────────────────────

test("an incident whose events return after its fix is marked regressed and linked to the pull request", () => {
  const record = deployedRecord({ pr: 4242 });
  const eventAfterDeploy = DEPLOY_MS + 5_000;

  const regressed = evaluateDeployedIncident(record, eventAfterDeploy, DEPLOY_MS + WINDOW_MS, WINDOW_MS);
  assert.equal(regressed.status, "regressed");
  assert.equal(regressed.pr, 4242, "the pull request link survives the transition to regressed");
  assert.equal(regressed.lastSeenMs, eventAfterDeploy);

  // An event strictly BEFORE the deploy (already accounted for) never regresses a fix.
  const eventBeforeDeploy = DEPLOY_MS - 1;
  const still = evaluateDeployedIncident(record, eventBeforeDeploy, DEPLOY_MS + WINDOW_MS, WINDOW_MS);
  assert.equal(still.status, "verified");
});

test("runIncidentLifecyclePass credits verified and debits regressed exactly once per fingerprint", (t) => {
  const dir = fixtureDir(t);
  const verifiedRecord = deployedRecord({ fingerprint: "e".repeat(64), kind: "exception" });
  const regressedRecord = deployedRecord({ fingerprint: "f".repeat(64), kind: "latency", pr: 555 });
  const store: IncidentLifecycleStore = { [verifiedRecord.fingerprint]: verifiedRecord, [regressedRecord.fingerprint]: regressedRecord };

  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const next = runIncidentLifecyclePass(store, {
    stateDir: dir,
    clock: fixedClock(DEPLOY_MS + WINDOW_MS),
    latestEventMsSince: (fp) => (fp === regressedRecord.fingerprint ? DEPLOY_MS + 1_000 : undefined),
    log: (step, extra) => logs.push({ step, extra }),
  });

  assert.equal(next[verifiedRecord.fingerprint].status, "verified");
  assert.equal(next[regressedRecord.fingerprint].status, "regressed");
  assert.equal(next[regressedRecord.fingerprint].pr, 555);
  assert.deepEqual(
    logs.map((l) => l.step).sort(),
    ["incident_lifecycle.regressed", "incident_lifecycle.verified"],
  );

  const gardenState = readGardenState(incidentLifecycleGardenPath(dir), ["exception", "http_5xx", "latency", "invariant"] as const);
  assert.ok(gardenState.classes.exception.alpha > 3, "verified credits the exception class");
  assert.ok(gardenState.classes.latency.beta > 1, "regressed debits the latency class");

  // A SECOND pass over the already-settled store must not credit or debit again.
  const secondPassLogs: string[] = [];
  const again = runIncidentLifecyclePass(next, {
    stateDir: dir,
    clock: fixedClock(DEPLOY_MS + WINDOW_MS + 1),
    latestEventMsSince: () => undefined,
    log: (step) => secondPassLogs.push(step),
  });
  assert.deepEqual(again, next);
  assert.deepEqual(secondPassLogs, []);
});

test("credit and debit adjust the same alpha/beta shape gardener.ts already reads generically", (t) => {
  const dir = fixtureDir(t);
  creditIncidentClass(dir, "http_5xx");
  const afterCredit = readGardenState(incidentLifecycleGardenPath(dir), ["exception", "http_5xx", "latency", "invariant"] as const);
  assert.equal(afterCredit.classes.http_5xx.alpha, 4);

  debitIncidentClass(dir, "http_5xx");
  const afterDebit = readGardenState(incidentLifecycleGardenPath(dir), ["exception", "http_5xx", "latency", "invariant"] as const);
  assert.equal(afterDebit.classes.http_5xx.beta, 2);
});

// ── criterion 3: the route reports an unreadable source, never an empty list ────────────────

async function invoke(route: Route): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let text = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string) {
      text += chunk ?? "";
    },
  };
  await route.handler({} as never, res as never, { params: {} });
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

test("the incidents route reports an unreadable source instead of an empty list", async (t) => {
  const dir = fixtureDir(t);
  const unreadable: IncidentLifecycleStoreRead = { ok: false, reason: "unreadable" };
  const route = buildIncidentsRoute({ stateDir: dir, clock: fixedClock(DEPLOY_MS), readStore: () => unreadable });
  const { status, body } = await invoke(route);
  assert.equal(status, 503);
  assert.notDeepEqual(body, { incidents: [], generatedAt: fixedClock(DEPLOY_MS).iso() });
  assert.equal(body.error, "incidents_unavailable");
  assert.equal(body.reason, "unreadable");
});

test("the incidents route serves the exact stored/generated shape when the store reads fine", async (t) => {
  const dir = fixtureDir(t);
  const record = deployedRecord({ status: "verified" });
  writeFileSync(join(dir, "incident-lifecycle.json"), JSON.stringify({ [record.fingerprint]: record }));
  const route = buildIncidentsRoute({ stateDir: dir, clock: fixedClock(DEPLOY_MS) });
  const { status, body } = await invoke(route);
  assert.equal(status, 200);
  assert.equal(body.generatedAt, fixedClock(DEPLOY_MS).iso());
  const incidents = body.incidents as Array<Record<string, unknown>>;
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].fingerprint, record.fingerprint);
  assert.equal(incidents[0].status, "verified");
  assert.equal(incidents[0].pr, record.pr);
  assert.equal(incidents[0].firstSeen, fixedClock(record.firstSeenMs).iso());
});

test("a genuinely absent store reads as an empty, healthy list, never a 503", async (t) => {
  const dir = fixtureDir(t);
  const route = buildIncidentsRoute({ stateDir: dir, clock: fixedClock(DEPLOY_MS) });
  const { status, body } = await invoke(route);
  assert.equal(status, 200);
  assert.deepEqual(body, { incidents: [], generatedAt: fixedClock(DEPLOY_MS).iso() });
});

test("a malformed (non-object) stored file is reported, not silently emptied", async (t) => {
  const dir = fixtureDir(t);
  writeFileSync(join(dir, "incident-lifecycle.json"), "[]");
  const route = buildIncidentsRoute({ stateDir: dir, clock: fixedClock(DEPLOY_MS) });
  const { status, body } = await invoke(route);
  assert.equal(status, 503);
  assert.equal(body.error, "incidents_unavailable");
  const written = readFileSync(join(dir, "incident-lifecycle.json"), "utf8");
  assert.equal(written, "[]", "the route never rewrites the store it could not read");
});
