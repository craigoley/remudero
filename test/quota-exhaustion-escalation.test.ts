import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { escalateQuotaExhaustion } from "../src/run-task.js";
import { runDaemon } from "../src/lib/daemon.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import type { IssueGateway } from "../src/lib/escalate.js";

/**
 * W1-T372 — "an exhausted API quota is fleet-stopping and nothing on the daemon's tick
 * observes it — the only quota read is a pull-only display value on the CORE bucket, while
 * GraphQL is the bucket that actually hits zero and discards finished work". The mechanism
 * these tests prove: `readGhRateLimitBuckets` (src/lib/daemon-health.ts) reads BOTH buckets
 * off one `gh api rate_limit` payload; `runDaemon`'s tick (src/lib/daemon.ts) consults it
 * beside `daemon.headroom`, records each bucket independently every tick, and latches an
 * `onQuotaExhausted` call once per bucket per episode on the CROSSING into zero (never on the
 * raw value, which holds for up to an hour); `escalateQuotaExhaustion` (src/run-task.ts) is
 * the real hook, with its own cross-boot ledger dedup keyed on (bucket, resetsAt).
 */

// Every task already merged or verify:human — the DONE case (mirrors
// test/queue-starvation.test.ts's own DONE_YAML): nothing here is ever dispatchable, so
// `runOne` throwing a falsifier on any call proves these tests observe the quota tick in
// isolation from dispatch, exactly as design (vii) requires (observe-and-surface only).
const DONE_YAML = `
- id: M
  title: already merged
  repo: remudero
  type: implement
  depends_on: []
  status: queued
- id: HU
  title: needs a human forever
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

function fixturePlan(tag: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `quota-exhaustion-${tag}-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, DONE_YAML);
  return loadPlan(f);
}

/** Same idiom test/queue-starvation.test.ts's own `pollingClock` uses — a fake clock that
 *  counts polls and, after `stopAfter` of them, requests a fleet STOP, so a PERSISTENT daemon
 *  loop can be observed across MANY ticks, not just the first. */
function pollingClock(root: string, stopAfter: number): { sleep: (ms: number) => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    sleep: async () => {
      calls++;
      if (calls >= stopAfter) requestStop(root, "test done polling");
    },
    calls: () => calls,
  };
}

function neverRunOne(id: string): never {
  throw new Error(`FALSIFIER: ${id} was dispatched — this plan has nothing dispatchable`);
}

// ── claim 1: both buckets are read and recorded INDEPENDENTLY, every tick ──────────────────

test("runDaemon's tick reads both the REST/core and GraphQL buckets each tick and records them independently, on the SAME cadence as daemon.headroom", async () => {
  const plan = fixturePlan("record");
  const merged = new Set(["M"]);
  const root = mkdtempSync(join(tmpdir(), "quota-exhaustion-record-root-"));
  const clock = pollingClock(root, 4);
  const lines: Array<{ step: string; extra: Record<string, unknown> }> = [];
  let reads = 0;

  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => neverRunOne(id),
    readGhQuota: () => {
      reads++;
      return {
        core: { remaining: 4600, resetsAt: "2026-08-06T02:00:00.000Z" },
        graphql: { remaining: 3, resetsAt: "2026-08-06T02:00:00.000Z" },
      };
    },
    log: (step, extra) => lines.push({ step, extra: extra ?? {} }),
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(reads >= 4, "readGhQuota was consulted every tick — the SAME cadence readUsage's headroom check already uses");

  const coreLines = lines.filter((l) => l.step === "daemon.quota" && l.extra.bucket === "core");
  const graphqlLines = lines.filter((l) => l.step === "daemon.quota" && l.extra.bucket === "graphql");
  assert.ok(coreLines.length >= 4, "core is recorded on every tick, not merely when asked (unlike the pull-only /v1/daemon-health page)");
  assert.ok(graphqlLines.length >= 4, "graphql is recorded on every tick INDEPENDENTLY of core — never collapsed into one merged number");
  assert.equal(coreLines[0].extra.remaining, 4600);
  assert.equal(graphqlLines[0].extra.remaining, 3);
  assert.equal(coreLines[0].extra.resets_at, "2026-08-06T02:00:00.000Z");
});

// ── claim 2: a crossing into exhaustion escalates EXACTLY ONCE, then stays silent ──────────

test("a bucket crossing from having budget to having none escalates exactly once, and remains silent on every later tick while it is still exhausted", async () => {
  const plan = fixturePlan("cross");
  const merged = new Set(["M"]);
  const root = mkdtempSync(join(tmpdir(), "quota-exhaustion-cross-root-"));
  const clock = pollingClock(root, 6);
  let reads = 0;
  const exhaustions: Array<{ bucket: string; remaining: number; resetsAt: string }> = [];

  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => neverRunOne(id),
    readGhQuota: () => {
      reads++;
      // core stays comfortably positive throughout. graphql has budget on tick 1, then reads
      // exhausted on EVERY tick from 2 onward, `resets_at` unchanged the whole time — the
      // SAME still-open episode, `remaining === 0` true on every one of those ticks. A value
      // check (design (iii)'s named defect) would re-fire on every one of them.
      return {
        core: { remaining: 4600, resetsAt: "2026-08-06T02:00:00.000Z" },
        graphql: { remaining: reads === 1 ? 5 : 0, resetsAt: "2026-08-06T02:00:00.000Z" },
      };
    },
    onQuotaExhausted: (info) => {
      exhaustions.push(info);
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(reads >= 6, "the loop observed the sustained exhaustion across many ticks, not just the crossing tick");
  assert.equal(
    exhaustions.length,
    1,
    "the crossing escalated EXACTLY ONCE — never once per tick for as long as the bucket stays at zero",
  );
  assert.equal(exhaustions[0].bucket, "graphql");
  assert.equal(exhaustions[0].remaining, 0);
  assert.equal(exhaustions[0].resetsAt, "2026-08-06T02:00:00.000Z");
});

// ── claim 3: a second exhaustion after reset escalates again; one bucket never suppresses the other ──

test("a second exhaustion after the bucket has reset escalates again, and an exhaustion of one bucket never suppresses the other", async () => {
  const plan = fixturePlan("independent");
  const merged = new Set(["M"]);
  const root = mkdtempSync(join(tmpdir(), "quota-exhaustion-independent-root-"));
  const clock = pollingClock(root, 6);
  let reads = 0;
  const exhaustions: Array<{ bucket: string; remaining: number; resetsAt: string }> = [];

  // tick 1: both healthy.
  // tick 2: core exhausts (episode core@R1) — graphql still healthy, unaffected.
  // tick 3: core recovers (R1's episode clears) — graphql now exhausts too (episode graphql@R2),
  //         proving core's earlier exhaustion never suppressed graphql's.
  // tick 4: core exhausts AGAIN under a NEW resets_at R3 — its OWN reset happened, so this is a
  //         genuinely fresh episode and must escalate again, never staying silenced by the R1 marker.
  // tick 5+: both readings hold — already-latched, so nothing further escalates.
  const sequence = [
    { core: { remaining: 100, resetsAt: "R1" }, graphql: { remaining: 50, resetsAt: "R2" } },
    { core: { remaining: 0, resetsAt: "R1" }, graphql: { remaining: 50, resetsAt: "R2" } },
    { core: { remaining: 100, resetsAt: "R1" }, graphql: { remaining: 0, resetsAt: "R2" } },
    { core: { remaining: 0, resetsAt: "R3" }, graphql: { remaining: 0, resetsAt: "R2" } },
  ];

  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => merged.has(id),
    runOne: async (id) => neverRunOne(id),
    readGhQuota: () => {
      const reading = sequence[Math.min(reads, sequence.length - 1)];
      reads++;
      return reading;
    },
    onQuotaExhausted: (info) => {
      exhaustions.push(info);
    },
    checkStop: () => stopDetail(root),
    sleep: clock.sleep,
  });

  assert.equal(s.stopReason, "stopped");
  assert.ok(reads >= 6, "the loop held the tick-4 readings for several more ticks with nothing further escalating");
  assert.equal(exhaustions.length, 3, "core@R1, graphql@R2, and core@R3 each escalate exactly once — three distinct episodes");
  assert.deepEqual(
    exhaustions.map((e) => `${e.bucket}@${e.resetsAt}`),
    ["core@R1", "graphql@R2", "core@R3"],
    "core's tick-2 exhaustion (R1) and graphql's tick-3 exhaustion (R2) are independent — neither suppressed the " +
      "other — and core's tick-4 exhaustion under a NEW resets_at (R3), after its own reset, is a fresh episode " +
      "that escalates again rather than staying silenced by the stale R1 marker",
  );
});

// ── escalateQuotaExhaustion: the real onQuotaExhausted wiring (run-task.ts) ─────────────────

test("escalateQuotaExhaustion: opens an escalation and durably dedups on (bucket, resetsAt) across process boots", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-exhaustion-escalate-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const info = { bucket: "graphql" as const, remaining: 0, resetsAt: "2026-08-06T02:00:00.000Z" };

  let calls = 0;
  const fake: IssueGateway = {
    create() {
      calls++;
      return "https://github.com/o/r/issues/1";
    },
  };
  escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: fake });
  assert.equal(calls, 1, "the first observation of this episode opens an issue");
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const marker = lines.find((l) => l.step === "daemon.quota_exhausted.escalated");
  assert.ok(marker, "a durable dedup marker is written, keyed on this episode's bucket + resets_at");
  assert.equal(marker.bucket, "graphql");
  assert.equal(marker.resets_at, info.resetsAt);
  assert.equal(marker.delivered, true);

  // A FRESH process (a daemon restart) re-observing the SAME still-open episode must not
  // re-open a sibling issue.
  escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: fake });
  assert.equal(calls, 1, "the SAME episode (same bucket + resets_at) is deduped across the process restart");

  // The OTHER bucket exhausting under the SAME resets_at string is a DIFFERENT episode — never
  // suppressed by the graphql marker above (design (iv)'s per-bucket episode key).
  escalateQuotaExhaustion(
    { bucket: "core", remaining: 0, resetsAt: info.resetsAt },
    { owner: "o", repo: "r", ledgerPath, runId: "RUN-3", issues: fake },
  );
  assert.equal(calls, 2, "the SAME resets_at on the OTHER bucket is a distinct episode and escalates");

  // Once graphql's own bucket actually resets, its resets_at changes — a LATER exhaustion is a
  // NEW episode and must escalate again, never staying silenced by the stale marker.
  escalateQuotaExhaustion(
    { ...info, resetsAt: "2026-08-06T03:00:00.000Z" },
    { owner: "o", repo: "r", ledgerPath, runId: "RUN-4", issues: fake },
  );
  assert.equal(calls, 3, "a NEW resets_at on the SAME bucket is a NEW episode and escalates again");
});

test("escalateQuotaExhaustion: a THROWING gh gateway still writes the dedup marker, so the next boot does not retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "quota-exhaustion-escalate-throw-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  const info = { bucket: "core" as const, remaining: 0, resetsAt: "2026-08-06T02:00:00.000Z" };
  const boom: IssueGateway = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  assert.doesNotThrow(() =>
    escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: boom }),
  );
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const marker = lines.find((l) => l.step === "daemon.quota_exhausted.escalated");
  assert.ok(marker, "FALSIFIER: pre-fix this class of marker was written only on success");
  assert.equal(marker.delivered, false);

  let calls = 0;
  const counting: IssueGateway = {
    create() {
      calls++;
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-2", issues: counting });
  assert.equal(calls, 0, "the failed delivery still deduped the SAME episode on the next boot");
});

// ── registration: the escalation marker survives ledger rotation ───────────────────────────

test("DECISION_RELEVANT_LEDGER_STEPS: registers the quota-exhaustion dedup step, so a rotation cannot silently re-open one notice per tick", () => {
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("daemon.quota_exhausted.escalated"),
    "escalateQuotaExhaustion's own dedup marker must survive ledger rotation — test/ledger-rotation.test.ts's own " +
      "consumer-derived guard re-checks this from source, not from this hardcoded assertion alone",
  );
});
