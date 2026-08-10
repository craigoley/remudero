import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import { noRunnableDetail, runDrain, type DrainDeps, type DrainSummary, type MergedSet } from "../src/lib/drain.js";
import { runDaemon } from "../src/lib/daemon.js";
import { isBucketExhausted, type GhRateLimitBuckets } from "../src/lib/daemon-health.js";
import { drainCommand, escalateQuotaExhaustion, reportDrainQuotaExhaustion } from "../src/run-task.js";
import { requestStop, stopDetail } from "../src/lib/fleet-control.js";
import type { RunResult } from "../src/run-task.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";
import type { IssueGateway } from "../src/lib/escalate.js";

/**
 * THE DRAIN'S TERMINAL DID NOT REPORT WHY IT STOPPED.
 *
 * `no_runnable` is written on two conditions an operator has to tell apart and could not: a
 * frontier that was READ and found empty, and a frontier that could not be READ AT ALL. The
 * second is what a throttled GitHub gateway looks like — `projectPlan` marks a task
 * `indeterminate` on any failed read (W1-T119) and `isDispatchEligible`'s rung 6 declines it.
 * Both stops printed the same single word, so the recourse was `gh api rate_limit` BY HAND.
 *
 * Two halves, proved here in both directions each:
 *   1. the count of indeterminate declines reaches `DrainSummary` and the terminal's `stopDetail`;
 *   2. `escalateQuotaExhaustion` — which until now had exactly ONE caller, `runDaemon`'s tick —
 *      is reached from the drain path when, and only when, a bucket is really exhausted.
 */

// A (no deps), D (no deps), H (verify:human, never dispatchable). Two independent candidates is
// the minimum that can distinguish "some declined" from "all declined".
const YAML = `
- id: A
  title: a
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/a.ts]
- id: D
  title: d
  repo: remudero
  type: implement
  depends_on: []
  status: queued
  files: [src/d.ts]
- id: H
  title: human-only
  repo: remudero
  type: implement
  verify: human
  depends_on: []
  status: queued
`;

function fixturePlan(tag: string): Plan {
  const dir = mkdtempSync(join(tmpdir(), `drain-stop-detail-${tag}-`));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.5, verdict: "merged" });

function neverRunOne(id: string): never {
  throw new Error(`FALSIFIER: ${id} was dispatched — this pass was supposed to find nothing runnable`);
}

// ── the detail sentence itself ────────────────────────────────────────────────────────────

test("noRunnableDetail: a non-zero count says the frontier was UNREADABLE; zero says it was read and empty", () => {
  const unreadable = noRunnableDetail({ indeterminate: 2 });
  assert.match(unreadable, /INDETERMINATE/, "the unreadable case names the condition an operator can act on");
  assert.match(unreadable, /^2 candidate/, "and carries the count, so 'one flaky read' and 'the whole frontier' differ");
  assert.match(unreadable, /not evidence of an empty queue/, "and states what it does NOT prove");

  const clean = noRunnableDetail({ indeterminate: 0 });
  assert.match(clean, /genuinely empty/, "zero is a POSITIVE claim — the frontier was read — not the absence of one");
  assert.equal(/INDETERMINATE/.test(clean), false, "and must not hedge toward a gateway problem that did not occur");
  assert.notEqual(unreadable, clean, "the two stops must not print the same sentence — the entire point of this change");
});

// ── half 1, single-lane: the count reaches the summary and the terminal, BOTH directions ────

test("runDrain: a frontier that could not be READ stops no_runnable carrying the indeterminate count", async () => {
  const plan = fixturePlan("unreadable");
  const declined: string[] = [];
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (() => false) as MergedSet,
      // The gateway answers for nothing — the W1-T119 shape, where `projectPlan` could not read
      // the merged state and every candidate is declined at rung 6 rather than dispatched blind.
      isIndeterminate: () => true,
      onIndeterminate: (t) => declined.push(t.id),
      runOne: async (id) => neverRunOne(id),
    },
    { max: 5 },
  );

  assert.equal(s.stopReason, "no_runnable");
  assert.deepEqual(declined.sort(), ["A", "D"], "REACHED THE BRANCH: two real candidates were declined, not an empty plan");
  assert.equal(s.indeterminateDeclines, 2, "the count the terminal and the quota check both read");
  assert.match(String(s.stopDetail), /INDETERMINATE/, "and the operator's own line says so");
});

test("runDrain: a genuinely empty frontier stops no_runnable with the count at ZERO and no gateway hedge", async () => {
  const plan = fixturePlan("empty");
  const allMerged: MergedSet = (id) => id === "A" || id === "D";
  let indeterminateCalls = 0;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => allMerged,
      isIndeterminate: () => {
        indeterminateCalls++;
        return false;
      },
      runOne: async (id) => neverRunOne(id),
    },
    { max: 5 },
  );

  assert.equal(s.stopReason, "no_runnable");
  assert.equal(s.indeterminateDeclines, 0, "0 is EMITTED, not omitted — an absent field would be ambiguous all over again");
  assert.ok("indeterminateDeclines" in s, "the field is present on the healthy stop, not just the unhealthy one");
  assert.match(String(s.stopDetail), /genuinely empty/);
  assert.equal(/INDETERMINATE/.test(String(s.stopDetail)), false, "a healthy stop must never blame the gateway");
  // A/D are excluded at rung 1 (already-merged) and H at rung 3 (verify:human) — all BEFORE
  // rung 6 — so the indeterminate probe is never even consulted here. Asserted so this test
  // cannot pass by accidentally taking the same route as the one above.
  assert.equal(indeterminateCalls, 0);
});

test("runDrain: the count is RESET each pass — a gateway that recovered does not leave the final stop blaming it", async () => {
  const plan = fixturePlan("reset");
  const merged = new Set<string>();
  let gatewayDown = true;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      // A is unreadable on pass 1 and readable on pass 2 — the REAL W1-T119 sequence: the gateway
      // could not answer, then answered "already merged". A rather than D BECAUSE `nextRunnable`
      // SHORT-CIRCUITS on the first eligible task: an indeterminate task sitting AFTER a
      // dispatchable one is never evaluated, so the decline never happens and this test would
      // pass without the reset it exists to prove. (Measured — the first draft did exactly that.)
      isIndeterminate: (id) => gatewayDown && id === "A",
      runOne: async (id) => {
        assert.equal(id, "D", "only D is dispatchable on pass 1 — A was declined as indeterminate");
        merged.add("D");
        gatewayDown = false;
        merged.add("A");
        return okResult(id);
      },
    },
    { max: 5 },
  );

  assert.equal(s.stopReason, "no_runnable");
  assert.deepEqual(s.merged, ["D"], "REACHED THE BRANCH: the drain really ran a pass that declined A as indeterminate");
  // FALSIFIER TARGET. Accumulated across passes this reads 1, and the terminal would report an
  // unreadable frontier on a stop whose final selection read perfectly — the always-blames-the-
  // quota failure. Removing the `indeterminateDeclines = 0` reset in runDrain turns this red.
  assert.equal(s.indeterminateDeclines, 0, "the FINAL selection declined nothing; pass 1's decline is not carried forward");
  assert.match(String(s.stopDetail), /genuinely empty/);
});

// ── half 1, multi-lane: the same, through runDrainLanes ────────────────────────────────────

test("runDrain at laneCount 2: the lanes loop reports the same two stops distinctly (the loops must not drift)", async () => {
  const unreadablePlan = fixturePlan("lanes-unreadable");
  const unreadable = await runDrain(
    unreadablePlan,
    {
      refreshMerged: () => (() => false) as MergedSet,
      isIndeterminate: () => true,
      runOne: async (id) => neverRunOne(id),
    },
    { max: 5, laneCount: 2 },
  );
  assert.equal(unreadable.stopReason, "no_runnable");
  assert.equal(unreadable.indeterminateDeclines, 2, "the LANES loop counts too — this module's own single-lane/multi-lane drift warning");
  assert.match(String(unreadable.stopDetail), /INDETERMINATE/);

  const emptyPlan = fixturePlan("lanes-empty");
  const empty = await runDrain(
    emptyPlan,
    {
      refreshMerged: () => ((id: string) => id === "A" || id === "D") as MergedSet,
      isIndeterminate: () => false,
      runOne: async (id) => neverRunOne(id),
    },
    { max: 5, laneCount: 2 },
  );
  assert.equal(empty.stopReason, "no_runnable");
  assert.equal(empty.indeterminateDeclines, 0);
  assert.match(String(empty.stopDetail), /genuinely empty/);
});

test("runDrain at laneCount 2: the count is RESET each pass there too", async () => {
  const plan = fixturePlan("lanes-reset");
  const merged = new Set<string>();
  let gatewayDown = true;
  const s = await runDrain(
    plan,
    {
      refreshMerged: () => (id) => merged.has(id),
      // Same ordering reason as the single-lane test above: the declined task must come FIRST.
      isIndeterminate: (id) => gatewayDown && id === "A",
      runOne: async (id) => {
        assert.equal(id, "D");
        merged.add("D");
        gatewayDown = false;
        merged.add("A");
        return okResult(id);
      },
    },
    { max: 5, laneCount: 2 },
  );
  assert.equal(s.stopReason, "no_runnable");
  assert.deepEqual(s.merged, ["D"], "REACHED THE BRANCH: a real lane pass ran that declined A as indeterminate");
  assert.equal(s.indeterminateDeclines, 0);
});

// ── the ledger line carries it too, so a post-hoc read can tell the two apart ───────────────

test("drain.summary ledgers the count, so the distinction survives the terminal scrolling away", async () => {
  const plan = fixturePlan("ledgered");
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  await runDrain(
    plan,
    {
      refreshMerged: () => (() => false) as MergedSet,
      isIndeterminate: () => true,
      runOne: async (id) => neverRunOne(id),
      log: (step, extra) => lines.push({ step, extra }),
    },
    { max: 5 },
  );
  const summaryLine = lines.find((l) => l.step === "drain.summary");
  assert.ok(summaryLine, "the drain ledgers its own summary");
  assert.equal(summaryLine.extra?.indeterminateDeclines, 2);
  assert.equal(
    lines.filter((l) => l.step === "dispatch.indeterminate").length,
    2,
    "the per-task line still fires unchanged — this change COUNTS what was already logged, it does not replace it",
  );
});

// ── half 2: the drain reaches escalateQuotaExhaustion ──────────────────────────────────────

function quotaLedger(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `drain-quota-${tag}-`));
  return join(dir, "ledger.ndjson");
}

const CTX = (ledgerPath: string) => ({ owner: "o", repo: "r", ledgerPath, runId: "DRAIN-1" });

test("reportDrainQuotaExhaustion: an unreadable frontier over an EXHAUSTED bucket escalates", () => {
  const escalated: Array<{ bucket: string; remaining: number; resetsAt: string }> = [];
  let reads = 0;
  reportDrainQuotaExhaustion(
    { stopReason: "no_runnable", indeterminateDeclines: 2 },
    CTX(quotaLedger("hit")),
    {
      readGhQuota: () => {
        reads++;
        return {
          core: { remaining: 4600, resetsAt: "2026-08-10T02:00:00.000Z" },
          graphql: { remaining: 0, resetsAt: "2026-08-10T02:00:00.000Z" },
        };
      },
      escalate: (info) => void escalated.push(info),
    },
  );
  assert.equal(reads, 1, "ONE `gh api rate_limit` read for both buckets — never one per bucket");
  assert.deepEqual(
    escalated.map((e) => e.bucket),
    ["graphql"],
    "only the exhausted bucket escalates; the healthy core bucket is reported and left alone",
  );
  assert.equal(escalated[0].remaining, 0);
  assert.equal(escalated[0].resetsAt, "2026-08-10T02:00:00.000Z");
});

test("reportDrainQuotaExhaustion: an unreadable frontier over HEALTHY buckets escalates NOTHING", () => {
  const escalated: string[] = [];
  reportDrainQuotaExhaustion(
    { stopReason: "no_runnable", indeterminateDeclines: 2 },
    CTX(quotaLedger("healthy")),
    {
      // The read SUCCEEDS and both buckets have budget. `indeterminate` means "a read failed" —
      // network, auth, throttle, any of them — so it is a reason to LOOK, never a finding. This
      // repo has four separate bounds that fired on healthy conditions; a fifth that always
      // blamed the quota would be worse than the silence it replaces.
      readGhQuota: () => ({
        core: { remaining: 4600, resetsAt: "2026-08-10T02:00:00.000Z" },
        graphql: { remaining: 4900, resetsAt: "2026-08-10T02:00:00.000Z" },
      }),
      escalate: (info) => void escalated.push(info.bucket),
    },
  );
  assert.deepEqual(escalated, [], "declines alone are NOT evidence of exhaustion");
});

test("reportDrainQuotaExhaustion: a healthy stop never even READS the quota", () => {
  let reads = 0;
  const read = () => {
    reads++;
    return {} as GhRateLimitBuckets;
  };
  reportDrainQuotaExhaustion({ stopReason: "no_runnable", indeterminateDeclines: 0 }, CTX(quotaLedger("gate-zero")), { readGhQuota: read });
  assert.equal(reads, 0, "zero declines: the `gh` call is never made, so a healthy drain spends nothing");

  reportDrainQuotaExhaustion({ stopReason: "blocked", indeterminateDeclines: 2 }, CTX(quotaLedger("gate-reason")), { readGhQuota: read });
  assert.equal(reads, 0, "a BLOCKED stop knows exactly why it stopped — the frontier was never the question");

  reportDrainQuotaExhaustion({ stopReason: "no_runnable" }, CTX(quotaLedger("gate-absent")), { readGhQuota: read });
  assert.equal(reads, 0, "an absent count (an older summary shape) is treated as zero, not as a reason to probe");
});

test("reportDrainQuotaExhaustion: a bucket the reader could not parse is skipped, never read as exhausted", () => {
  const escalated: string[] = [];
  reportDrainQuotaExhaustion(
    { stopReason: "no_runnable", indeterminateDeclines: 1 },
    CTX(quotaLedger("absent-bucket")),
    {
      // `readGhRateLimitBuckets` returns each bucket independently `undefined` (never a fabricated
      // number) when its own sub-object is missing. `undefined` must not collapse to 0-and-exhausted.
      readGhQuota: () => ({ graphql: { remaining: 12, resetsAt: "2026-08-10T02:00:00.000Z" } }),
      escalate: (info) => void escalated.push(info.bucket),
    },
  );
  assert.deepEqual(escalated, [], "an ABSENT core reading is not a zero reading");
});

test("reportDrainQuotaExhaustion: a throwing reader and a throwing escalator are both swallowed and ledgered", () => {
  const steps: string[] = [];
  assert.doesNotThrow(() =>
    reportDrainQuotaExhaustion({ stopReason: "no_runnable", indeterminateDeclines: 1 }, CTX(quotaLedger("throw-read")), {
      readGhQuota: () => {
        throw new Error("gh: command not found");
      },
      log: (step) => steps.push(step),
    }),
  );
  assert.ok(steps.includes("drain.quota_check.failed"));

  const steps2: string[] = [];
  assert.doesNotThrow(() =>
    reportDrainQuotaExhaustion({ stopReason: "no_runnable", indeterminateDeclines: 1 }, CTX(quotaLedger("throw-esc")), {
      readGhQuota: () => ({ graphql: { remaining: 0, resetsAt: "2026-08-10T02:00:00.000Z" } }),
      escalate: () => {
        throw new Error("gh: HTTP 403");
      },
      log: (step) => steps2.push(step),
    }),
  );
  assert.ok(steps2.includes("drain.escalation.failed"), "the drain has already done its work — a failed issue-open must not take its exit code");
});

// ── the dedup is the LEDGER's, so a drain and a daemon share one notice ────────────────────

test("a drain and a daemon observing the SAME episode open ONE notice between them, not one each", () => {
  const ledgerPath = quotaLedger("dedup");
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  let opened = 0;
  const issues: IssueGateway = {
    create() {
      opened++;
      return "https://github.com/o/r/issues/7";
    },
  };
  const info = { bucket: "graphql" as const, remaining: 0, resetsAt: "2026-08-10T02:00:00.000Z" };

  // The daemon's tick observes the crossing first and escalates.
  escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "DAEMON-1", issues });
  assert.equal(opened, 1);

  // A drain finishing minutes later, in a SEPARATE process, hits the same still-open episode.
  // Nothing new is opened — because the drain path reuses `escalateQuotaExhaustion` itself,
  // whose (bucket, resetsAt) dedup is read off this ledger, rather than carrying its own.
  reportDrainQuotaExhaustion(
    { stopReason: "no_runnable", indeterminateDeclines: 3 },
    { owner: "o", repo: "r", ledgerPath, runId: "DRAIN-9", issues },
    { readGhQuota: () => ({ graphql: { remaining: 0, resetsAt: info.resetsAt } }) },
  );
  assert.equal(opened, 1, "the drain deduped against the DAEMON's marker — one episode, one notice");

  const markers = readFileSync(ledgerPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.step === "daemon.quota_exhausted.escalated");
  // ONE marker, not two: `escalateQuotaExhaustion` returns on its dedup check BEFORE appending,
  // so a re-observation writes nothing at all. Worth pinning — a second marker per observation
  // would be the shape that lets a rotation reset the dedup and re-open the notice.
  assert.equal(markers.length, 1, "the re-observation appended nothing, so the episode key cannot be diluted");
  assert.equal(markers[0].delivered, true);
  assert.equal(markers[0].run_id, "DAEMON-1", "and the surviving marker is the one that actually delivered");
});

// ── one detector: the daemon tick and the drain report agree on every reading ───────────────

const READINGS: ReadonlyArray<{ remaining: number; label: string }> = [
  { remaining: 5, label: "positive" },
  { remaining: 1, label: "the last unit of budget" },
  { remaining: 0, label: "exhausted" },
  { remaining: -1, label: "negative, off a malformed payload" },
];

test("ONE DETECTOR: runDaemon's tick and the drain report escalate the same buckets over the same readings", async () => {
  for (const r of READINGS) {
    // The DAEMON side: drive the real tick and see whether its own inline branch fires.
    const root = mkdtempSync(join(tmpdir(), `drain-quota-equiv-${r.remaining}-`));
    const planDir = mkdtempSync(join(tmpdir(), "drain-quota-equiv-plan-"));
    const planFile = join(planDir, "tasks.yaml");
    writeFileSync(planFile, "[]\n");
    let polls = 0;
    const daemonEscalated: string[] = [];
    await runDaemon(loadPlan(planFile), {
      refreshMerged: () => () => false,
      runOne: async (id) => neverRunOne(id),
      readGhQuota: () => ({ graphql: { remaining: r.remaining, resetsAt: "2026-08-10T02:00:00.000Z" } }),
      onQuotaExhausted: (info) => void daemonEscalated.push(info.bucket),
      checkStop: () => stopDetail(root),
      sleep: async () => {
        polls++;
        if (polls >= 2) requestStop(root, "equivalence probe done");
      },
    });
    assert.ok(polls >= 2, `REACHED THE BRANCH: the daemon really ticked for the ${r.label} reading`);

    // The DRAIN side: same reading, same question.
    const drainEscalated: string[] = [];
    reportDrainQuotaExhaustion(
      { stopReason: "no_runnable", indeterminateDeclines: 1 },
      CTX(quotaLedger(`equiv-${r.remaining}`)),
      {
        readGhQuota: () => ({ graphql: { remaining: r.remaining, resetsAt: "2026-08-10T02:00:00.000Z" } }),
        escalate: (info) => void drainEscalated.push(info.bucket),
      },
    );

    assert.deepEqual(
      drainEscalated,
      daemonEscalated,
      `the two paths must agree on a ${r.label} reading — tuning either alone turns this red`,
    );
    assert.equal(
      drainEscalated.length > 0,
      isBucketExhausted({ remaining: r.remaining, resetsAt: "x" }),
      "and both agree with the shared predicate they are supposed to be asking through",
    );
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the wiring: the REAL drainCommand reaches the check ────────────────────────────────────

const OFFLINE_GITHUB: GitHub = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
};

/** Drives the REAL drainCommand with an injected runDrain that returns the summary shape under
 *  test, and records what the end-of-drain quota check actually did. Nothing here is a fixture
 *  of the wiring — a `reportDrainQuotaExhaustion` call that was never added would record nothing. */
async function drainWith(summary: Partial<DrainSummary> & { stopReason: DrainSummary["stopReason"] }): Promise<{
  reads: number;
  escalated: string[];
  config: Config;
}> {
  const config = { claudeBin: "/nonexistent/claude-not-installed", root: mkdtempSync(join(tmpdir(), "rmd-drain-stop-detail-")) } as Config;
  const planDir = mkdtempSync(join(tmpdir(), "rmd-drain-stop-detail-plan-"));
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  let reads = 0;
  const escalated: string[] = [];
  const code = await drainCommand([], {
    config,
    planPath,
    skipGitSync: true,
    githubFactory: () => OFFLINE_GITHUB,
    notifyChannel: { send: () => true } as never,
    runDrain: async (_plan, _deps: DrainDeps): Promise<DrainSummary> => ({
      attempted: [],
      merged: [],
      costUsd: 0,
      resumeCommand: "rmd drain",
      ...summary,
    }),
    quotaCheck: {
      readGhQuota: () => {
        reads++;
        return { graphql: { remaining: 0, resetsAt: "2026-08-10T02:00:00.000Z" } };
      },
      escalate: (info) => void escalated.push(info.bucket),
    },
  });
  assert.equal(code, 0, "a no_runnable stop is a clean exit — the quota check must not change that");
  return { reads, escalated, config };
}

test("REACHABILITY: the real drainCommand runs the quota check on an unreadable-frontier stop", async () => {
  const { reads, escalated, config } = await drainWith({ stopReason: "no_runnable", indeterminateDeclines: 2 });
  try {
    assert.equal(reads, 1, "FALSIFIER: with the call site absent from drainCommand this is 0 and the whole half is inert");
    assert.deepEqual(escalated, ["graphql"], "and the escalation the daemon alone used to reach is reached from `rmd drain`");
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});

test("REACHABILITY: the real drainCommand skips the quota check on a clean stop", async () => {
  const { reads, escalated, config } = await drainWith({ stopReason: "no_runnable", indeterminateDeclines: 0 });
  try {
    assert.equal(reads, 0, "a drain that simply ran out of work makes no GitHub call on its way out");
    assert.deepEqual(escalated, []);
  } finally {
    rmSync(config.root, { recursive: true, force: true });
  }
});
