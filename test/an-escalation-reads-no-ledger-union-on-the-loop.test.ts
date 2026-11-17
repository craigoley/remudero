// W1-T13324 — triageRoute read every ledger rotation synchronously for a class tier that the production
// evidence then replaced. These tests pin that a tier the evidence supplies costs no rotation read, that
// unreadable or torn tier evidence still delivers, and that a caller with no tier still reads the ledger.
import assert from "node:assert/strict";
import fs, { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import zlib, { gzipSync } from "node:zlib";
import type { Config } from "#src/lib/config.js";
import {
  FLEET_NOTICE_LABEL, NEEDS_HUMAN_LABEL, configureEscalationTriage, escalate, escalateAsync, escalateWithJudge,
  tryEscalateAsync, type Escalation, type EscalateTriageSettings, type IssueGateway,
} from "#src/lib/escalate.js";
import { escalationClassSignal } from "#src/lib/escalation-precision.js";
import { triageEscalation } from "#src/lib/escalation-triage.js";
import { readLedgerUnionRecordsSync } from "#src/lib/ledger-union.js";
import { writeLedger, type LedgerFixture } from "#test/helpers/ledger-fixture.js";
import { buildEscalationTriageRuntime } from "#test/helpers/run-task-test.js";

const HANDLED = "panel.escalation_marked_handled";
const VERDICT = { decision: "deliver", reason: "the test judge keeps it visible" } as const;
const TORN_HANDLED = `{"ts":"2026-08-03T00:00:00.000Z","step":"${HANDLED}","class":"BLOCKED","dispo\n`;
const tierReason = (tier: string): string => `the precision tier for BLOCKED is ${tier}: the operator rarely acts on this class`;

function esc(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED", taskId: "W1-T901", summary: "W1-T901: two strikes exhausted", detail: "the retry still failed.",
    options: [{ label: "retry", detail: "resume with a fresh worker" }, { label: "abandon", detail: "drop the task" }],
    recommendation: "retry", ...over,
  };
}

/** Six BLOCKED dispositions, `acted` of them acted on, held ONLY in two gzip archives; the live file has none. */
function corpus(t: TestContext, acted: number): LedgerFixture {
  const handled = Array.from({ length: 6 }, (_, i) => ({ ts: "2026-08-01T00:00:00.000Z", run_id: `PANEL-${i}`, task_id: `W1-T6${i}`,
    step: HANDLED, class: "BLOCKED", disposition: i < acted ? "acted" : "false_positive" }));
  const noise = (tag: string) => Array.from({ length: 20 }, (_, i) => ({ ts: "2026-08-01T00:00:00.000Z", run_id: `${tag}-${i}`, task_id: "W1-T1", step: "heartbeat.tick" }));
  const fixture = writeLedger(noise("live"), { rotations: [
    { at: "2026-08-02T00:00:00.000Z", gz: true, rows: [...handled.slice(0, 3), ...noise("old")] },
    { at: "2026-09-02T00:00:00.000Z", gz: true, rows: [...handled.slice(3), ...noise("mid")] },
  ] });
  t.after(() => rmSync(fixture.dir, { recursive: true, force: true }));
  return fixture;
}

function gateway(): IssueGateway & { calls: Array<{ title: string; labels: string[] }> } {
  const calls: Array<{ title: string; labels: string[] }> = [];
  return { calls, comment() {}, create(title, _body, labels) {
    calls.push({ title, labels });
    return `https://github.com/o/r/issues/${calls.length}`;
  } };
}

/** The production triage runtime, configured as the daemon configures it, and refreshed off the loop. */
async function production(t: TestContext, fixture: LedgerFixture): Promise<void> {
  const runtime = buildEscalationTriageRuntime({ root: fixture.dir, config: { root: fixture.dir } as Config, owner: "o", repo: "r" }, {
    readPolicy: () => ({ escalationTriage: { mode: "act" } }), seenAt: () => undefined, windowMs: () => 1, judge: async () => VERDICT,
  });
  configureEscalationTriage(runtime);
  t.after(() => configureEscalationTriage(undefined));
  await runtime.refresh(fixture.path);
}

function triaged(fixture: LedgerFixture): Array<[unknown, unknown, unknown]> {
  return readFileSync(fixture.path, "utf8").split("\n").filter((line) => line.includes('"escalation.triaged"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>).map((row) => [row.triage_outcome, row.triage_decided_by, row.triage_reason]);
}

/** Counts every SYNCHRONOUS read of a rotation and every synchronous gunzip, whoever makes it. */
async function countingSyncReads(run: () => Promise<void>): Promise<{ rotationReads: number; gunzips: number }> {
  const counts = { rotationReads: 0, gunzips: 0 };
  const readFileSync0 = fs.readFileSync;
  const gunzipSync0 = zlib.gunzipSync;
  fs.readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === "string" && /ledger\.[^/]*\.ndjson(\.gz)?$/.test(path)) counts.rotationReads += 1;
    return (readFileSync0 as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readFileSync;
  zlib.gunzipSync = ((...args: Parameters<typeof gunzipSync0>) => (counts.gunzips += 1, gunzipSync0(...args))) as typeof gunzipSync0;
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    fs.readFileSync = readFileSync0;
    zlib.gunzipSync = gunzipSync0;
    syncBuiltinESMExports();
  }
  return counts;
}

test("W1-T13324 criterion 1: the production runtime triages each tier as the whole-ledger read does", async (t) => {
  for (const [acted, tier, expected] of [
    [5, "issue", ["deliver", "model", VERDICT.reason]],
    [3, "digest", ["digest", "rule", tierReason("digest")]],
    [1, "board", ["digest", "rule", tierReason("board")]],
  ] as const) {
    await t.test(tier, async (sub) => {
      const fixture = corpus(sub, acted);
      // THE ORACLE: the tier ledgerClassTier computes at origin/main, from a whole-union read.
      const whole = readLedgerUnionRecordsSync(fixture.dir, { step: HANDLED, refuseIncomplete: true });
      const classTier = escalationClassSignal(whole.rows, "BLOCKED").tier;
      assert.equal(classTier, tier);
      const oracle = triageEscalation(esc(), { classTier }, tier === "issue" ? VERDICT : undefined);
      assert.deepEqual([oracle.kind, oracle.decidedBy, oracle.reason], expected);
      await production(sub, fixture);
      const issues = gateway();
      await escalateAsync(esc(), { issues, ledgerPath: fixture.path, runId: "RUN-1" });
      assert.deepEqual(triaged(fixture), [expected]);
      assert.deepEqual(issues.calls.map((call) => call.labels.includes(NEEDS_HUMAN_LABEL)), [tier === "issue"]);
      assert.deepEqual(issues.calls.map((call) => call.labels.includes(FLEET_NOTICE_LABEL)), [tier !== "issue"]);
    });
  }
});

test("W1-T13324 criterion 2: unreadable or torn tier evidence still delivers to needs-human", async (t) => {
  const rotation = (fixture: LedgerFixture, body: string | Buffer): void =>
    writeFileSync(join(fixture.dir, "ledger.2026-10-02T00-00-00-000Z.ndjson.gz"), body);
  const damage: Array<[string, (fixture: LedgerFixture) => void]> = [
    ["a rotation the reader cannot read", (fixture) => rotation(fixture, "not gzip")],
    ["a torn row in an archive names the step", (fixture) => rotation(fixture, gzipSync(Buffer.from(TORN_HANDLED)))],
    ["a torn row in the live file names the step", (fixture) => appendFileSync(fixture.path, TORN_HANDLED)],
  ];
  for (const [name, apply] of damage) {
    for (const configured of [true, false]) {
      await t.test(`${name}, ${configured ? "production evidence" : "ledger fallback"}`, async (sub) => {
        // A board-tier class: evidence that reads as healthy would demote this escalation to a digest.
        const fixture = corpus(sub, 1);
        apply(fixture);
        if (configured) await production(sub, fixture);
        const issues = gateway();
        await escalateAsync(esc(), { issues, ledgerPath: fixture.path, runId: "RUN-2", ...(configured ? {} : { triage: { mode: "act" } }) });
        const [[outcome, decidedBy, reason]] = triaged(fixture) as [[unknown, unknown, string]];
        assert.deepEqual([outcome, decidedBy], ["deliver", "default"]);
        assert.match(reason, /^triage evidence unreadable \(/);
        assert.deepEqual(issues.calls.map((call) => call.labels.includes(NEEDS_HUMAN_LABEL)), [true]);
      });
    }
  }

  await t.test("a torn row that names another step does not refuse", async (sub) => {
    const fixture = corpus(sub, 1);
    rotation(fixture, gzipSync(Buffer.from('{"ts":"2026-08-03T00:00:00.000Z","step":"fix.dispatch","task_id":"W1-T9\n')));
    await production(sub, fixture);
    await escalateAsync(esc(), { issues: gateway(), ledgerPath: fixture.path, runId: "RUN-2" });
    assert.deepEqual(triaged(fixture), [["digest", "rule", tierReason("board")]]);
  });

  await t.test("an operator-owned class is delivered by its rule, as before, over a torn row", async (sub) => {
    const fixture = corpus(sub, 1);
    rotation(fixture, gzipSync(Buffer.from(TORN_HANDLED)));
    await production(sub, fixture);
    await escalateAsync(esc({ class: "MANUAL" }), { issues: gateway(), ledgerPath: fixture.path, runId: "RUN-2" });
    assert.deepEqual(triaged(fixture), [["deliver", "rule", "MANUAL is operator-owned by rule"]]);
  });
});

test("W1-T13324 criterion 3: an async escalation whose evidence supplies a tier reads no rotation synchronously", async (t) => {
  const fixture = corpus(t, 1);
  await production(t, fixture);
  const issues = gateway();
  const deps = { issues, ledgerPath: fixture.path, runId: "RUN-3" };
  const counts = await countingSyncReads(async () => {
    await escalateAsync(esc({ taskId: "W1-T911", summary: "W1-T911: two strikes exhausted" }), deps);
    assert.notEqual(await tryEscalateAsync(esc({ taskId: "W1-T912", summary: "W1-T912: two strikes exhausted" }), deps), null);
    await escalateWithJudge(esc({ taskId: "W1-T913", summary: "W1-T913: two strikes exhausted" }), { ...deps, judge: async () => VERDICT });
  });
  assert.deepEqual(counts, { rotationReads: 0, gunzips: 0 });
  // Control: each of the three was triaged with the archived tier, so the tier was not simply absent.
  assert.deepEqual(triaged(fixture), Array.from({ length: 3 }, () => ["digest", "rule", tierReason("board")]));
});

test("W1-T13324 criterion 4: a caller whose evidence supplies no tier still reads it from the ledger", async (t) => {
  const run = async (e: Escalation, triage: EscalateTriageSettings | undefined, sync = false) => {
    const fixture = corpus(t, 1);
    const deps = { issues: gateway(), ledgerPath: fixture.path, runId: "RUN-4", ...(triage ? { triage } : {}) };
    const counts = await countingSyncReads(async () => void (sync ? escalate(e, deps) : await escalateAsync(e, deps)));
    return { row: triaged(fixture), reads: counts.rotationReads, needsHuman: deps.issues.calls[0]!.labels.includes(NEEDS_HUMAN_LABEL) };
  };
  const demoted = { row: [["digest", "rule", tierReason("board")]], reads: 2, needsHuman: false };
  assert.deepEqual(await run(esc(), { mode: "act" }), demoted, "no evidence callback");
  assert.deepEqual(await run(esc(), { mode: "act", evidence: () => ({}) }), demoted, "an evidence result with no classTier key");
  assert.deepEqual(await run(esc(), undefined, true), { ...demoted, needsHuman: true }, "the synchronous driver, in shadow");
  // A tier the caller supplies replaces the ledger's, as the spread did at origin/main, and now costs no read.
  assert.deepEqual(await run(esc(), { mode: "act", evidence: () => ({ classTier: "issue" }) }),
    { row: [["deliver", "default", "no rule applied and no model verdict"]], reads: 0, needsHuman: true });
  for (const cls of ["MANUAL", "HARD_STOP"] as const) {
    assert.deepEqual(await run(esc({ class: cls }), { mode: "act" }),
      { row: [["deliver", "rule", `${cls} is operator-owned by rule`]], reads: 0, needsHuman: true });
  }
});
