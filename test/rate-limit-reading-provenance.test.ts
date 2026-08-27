import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ghRateLimitProvenanceFromResponse,
  ghRateLimitWindow,
  type GhRateLimitProvenance,
} from "../src/lib/daemon-health.js";
import { escalateQuotaExhaustion, reportDrainQuotaExhaustion } from "../src/run-task.js";
import { runDaemon } from "../src/lib/daemon.js";
import { loadPlan, type Plan } from "../src/lib/plan.js";
import type { IssueGateway } from "../src/lib/escalate.js";
import type { RunResult } from "../src/lib/run-result.js";

/**
 * plan/tasks.d/W1-T2305-…yaml — "every reading this repo takes of its own GitHub budget comes
 * from an endpoint that does not report one … the repo's own worker module already measured the
 * same disagreement and adopted the fix nowhere else". This file proves the task's seven
 * acceptance claims, each labelled below with the claim it backs verbatim.
 *
 * THE REMEDY IS PROVENANCE, NOT A NEW PROBE (design (i)): `ghRateLimitProvenanceFromResponse`
 * lifts `lib/worker.ts`'s already-shipped `parseGhRateLimitHeaders` (W1-T525) into a shared
 * reading that also carries the ACTOR the response's own body named — never a separate `gh api
 * rate_limit` probe. `ghRateLimitWindow` is THE BRACKET RULE (design (ii)): two readings are
 * comparable only when they agree on actor, resource, AND reset epoch.
 */

function headerBlock(fields: Partial<Record<"remaining" | "used" | "limit" | "reset" | "resource", string>>): string {
  const lines = ["HTTP/2.0 200 OK"];
  if (fields.remaining !== undefined) lines.push(`X-Ratelimit-Remaining: ${fields.remaining}`);
  if (fields.used !== undefined) lines.push(`X-Ratelimit-Used: ${fields.used}`);
  if (fields.limit !== undefined) lines.push(`X-Ratelimit-Limit: ${fields.limit}`);
  if (fields.reset !== undefined) lines.push(`X-Ratelimit-Reset: ${fields.reset}`);
  if (fields.resource !== undefined) lines.push(`X-Ratelimit-Resource: ${fields.resource}`);
  return lines.join("\r\n");
}

// ── acceptance 1: a reading carries the actor and the resource, from the metered response ──

test("ghRateLimitProvenanceFromResponse: a reading carries the actor (from the body) and the resource (from the headers), off the ONE metered response", () => {
  const reading = ghRateLimitProvenanceFromResponse(
    "cao825",
    headerBlock({ remaining: "4600", used: "400", limit: "5000", reset: "1785900000", resource: "core" }),
  );
  assert.ok(reading, "a fully-populated response must yield a reading, not undefined");
  assert.deepEqual(reading, { actor: "cao825", resource: "core", remaining: 4600, reset: 1785900000 });
});

test("ghRateLimitProvenanceFromResponse: no actor supplied (nothing in the body to name it) ⇒ undefined, never a fabricated identity", () => {
  const reading = ghRateLimitProvenanceFromResponse(
    undefined,
    headerBlock({ remaining: "10", reset: "1785900000", resource: "graphql" }),
  );
  assert.equal(reading, undefined);
});

test("ghRateLimitProvenanceFromResponse: a response with no rate-limit headers at all (e.g. a non-`gh api` call) ⇒ undefined, never a guess", () => {
  const reading = ghRateLimitProvenanceFromResponse("cao825", headerBlock({}));
  assert.equal(reading, undefined);
});

test("ghRateLimitProvenanceFromResponse: partially-populated headers (resource missing) ⇒ undefined -- a partial reading is nothing comparable", () => {
  const reading = ghRateLimitProvenanceFromResponse("cao825", headerBlock({ remaining: "10", reset: "1785900000" }));
  assert.equal(reading, undefined);
});

// ── acceptance 2/3/4: the bracket rule ──────────────────────────────────────────────────────

function reading(overrides: Partial<GhRateLimitProvenance> = {}): GhRateLimitProvenance {
  return { actor: "cao825", resource: "core", remaining: 4600, reset: 1785900000, ...overrides };
}

test("ghRateLimitWindow: two ends disagreeing on RESET EPOCH is DISCARDED, never subtracted -- a bucket rollover between them means they describe different periods", () => {
  const start = reading({ remaining: 4600, reset: 1785900000 });
  const end = reading({ remaining: 0, reset: 1785903600 }); // an hour later -- a new bucket
  assert.equal(
    ghRateLimitWindow(start, end),
    undefined,
    "the ten-minute-gap defect this task's design (ii) names: a moved reset must discard, not subtract",
  );
});

test("ghRateLimitWindow: two ends disagreeing on ACTOR is DISCARDED, never subtracted -- the login does not identify the bucket", () => {
  const start = reading({ actor: "cao825" }); // the operator's PAT
  const end = reading({ actor: "remudero-fleet[bot]" }); // the fleet's installation token
  assert.equal(
    ghRateLimitWindow(start, end),
    undefined,
    "two different identities' buckets are never comparable, however similar their other fields",
  );
});

test("ghRateLimitWindow: two ends disagreeing on RESOURCE is DISCARDED -- core and graphql are different buckets even under a coincidentally-equal reset", () => {
  const start = reading({ resource: "core" });
  const end = reading({ resource: "graphql", reset: start.reset });
  assert.equal(ghRateLimitWindow(start, end), undefined);
});

test("ghRateLimitWindow: matching actor, resource, AND reset epoch at both ends yields a USABLE window", () => {
  const start = reading({ remaining: 4600 });
  const end = reading({ remaining: 4100 });
  const window = ghRateLimitWindow(start, end);
  assert.ok(window, "a fully-agreeing bracket must be usable, not discarded");
  assert.equal(window, end, "the usable window is the later reading -- the current, validated state");
});

// ── acceptance 5: an exhaustion escalation is never raised off a mismatched-provenance bracket ──

function fixtureLedger(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rate-limit-provenance-${tag}-`));
  return join(dir, "ledger.ndjson");
}

function countingIssues(): { gateway: IssueGateway; calls: () => number } {
  let calls = 0;
  return {
    gateway: {
      create() {
        calls++;
        return "https://github.com/o/r/issues/1";
      },
    },
    calls: () => calls,
  };
}

test("escalateQuotaExhaustion: a provenance bracket that DISAGREES on reset epoch discards the escalation -- no issue opened, no dedup marker written as delivered", () => {
  const ledgerPath = fixtureLedger("mismatch-reset");
  const { gateway, calls } = countingIssues();
  const info = { bucket: "graphql" as const, remaining: 0, resetsAt: "2026-08-27T02:00:00.000Z" };
  const start = reading({ reset: 1000 });
  const end = reading({ reset: 2000 }); // the ten-minute-gap defect, reproduced directly on the escalation path

  escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: gateway }, {
    provenanceBracket: { start, end },
  });

  assert.equal(calls(), 0, "a mismatched bracket must never open an issue");
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(
    lines.some((l) => l.step === "daemon.quota_exhausted.provenance_discarded" && l.bucket === "graphql"),
    "the discard itself is recorded, so a human auditing the ledger can see WHY nothing fired",
  );
  assert.ok(
    !lines.some((l) => l.step === "daemon.quota_exhausted.escalated"),
    "the real escalation marker must never be written for a discarded bracket",
  );
});

test("escalateQuotaExhaustion: a provenance bracket that DISAGREES on actor discards the escalation identically", () => {
  const ledgerPath = fixtureLedger("mismatch-actor");
  const { gateway, calls } = countingIssues();
  const info = { bucket: "core" as const, remaining: 0, resetsAt: "2026-08-27T02:00:00.000Z" };
  const start = reading({ actor: "cao825" });
  const end = reading({ actor: "remudero-fleet[bot]" });

  escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: gateway }, {
    provenanceBracket: { start, end },
  });

  assert.equal(calls(), 0, "an actor-mismatched bracket must never open an issue");
});

test("escalateQuotaExhaustion: a MATCHING provenance bracket lets a genuine exhaustion escalate exactly as it would with no bracket supplied", () => {
  const ledgerPath = fixtureLedger("match");
  const { gateway, calls } = countingIssues();
  const info = { bucket: "graphql" as const, remaining: 0, resetsAt: "2026-08-27T02:00:00.000Z" };
  const start = reading({ remaining: 10 });
  const end = reading({ remaining: 0 });

  escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: gateway }, {
    provenanceBracket: { start, end },
  });

  assert.equal(calls(), 1, "a validated bracket must not block a real exhaustion from escalating");
  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.step === "daemon.quota_exhausted.escalated"), "the real marker is written for a valid bracket");
});

test("escalateQuotaExhaustion: EVERY EXISTING CALLER omits the bracket and escalates exactly as before -- this task adds no regression to the unbracketed path", () => {
  const ledgerPath = fixtureLedger("omitted");
  const { gateway, calls } = countingIssues();
  const info = { bucket: "core" as const, remaining: 0, resetsAt: "2026-08-27T02:00:00.000Z" };
  escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: gateway });
  assert.equal(calls(), 1, "no bracket supplied must behave exactly as the pre-existing, unguarded escalation");
});

test("reportDrainQuotaExhaustion: a mismatched provenanceBracket threads through and discards the drain's own end-of-run escalation too", () => {
  const ledgerPath = fixtureLedger("drain-mismatch");
  const { gateway, calls } = countingIssues();
  reportDrainQuotaExhaustion(
    { stopReason: "no_runnable", indeterminateDeclines: 2 },
    { owner: "o", repo: "r", ledgerPath, runId: "DRAIN-1", issues: gateway },
    {
      readGhQuota: () => ({ graphql: { remaining: 0, resetsAt: "2026-08-27T02:00:00.000Z" } }),
      provenanceBracket: { start: reading({ reset: 1 }), end: reading({ reset: 2 }) },
    },
  );
  assert.equal(calls(), 0, "the drain's own quota check must honor the same bracket rule the daemon tick does -- one detector");
});

// ── acceptance 6: no reading path paces, sleeps, or defers a call ──────────────────────────

test("no reading/bracket/escalation path in this shard schedules a timer -- every function here is synchronous and returns without ever touching setTimeout/setInterval", () => {
  const realSetTimeout = global.setTimeout;
  const realSetInterval = global.setInterval;
  let timerScheduled = false;
  // @ts-expect-error -- intentionally poisoning the global timer for this one test
  global.setTimeout = (..._args: unknown[]) => {
    timerScheduled = true;
    throw new Error("FALSIFIER: a reading/bracket/escalation path scheduled a timer");
  };
  global.setInterval = (..._args: unknown[]) => {
    timerScheduled = true;
    throw new Error("FALSIFIER: a reading/bracket/escalation path scheduled a timer");
  };
  try {
    const start = reading({ remaining: 10 });
    const end = reading({ remaining: 0 });
    ghRateLimitProvenanceFromResponse("cao825", headerBlock({ remaining: "10", reset: "1", resource: "core" }));
    ghRateLimitWindow(start, end);
    const ledgerPath = fixtureLedger("no-pacing");
    const { gateway } = countingIssues();
    escalateQuotaExhaustion(
      { bucket: "core", remaining: 0, resetsAt: "2026-08-27T02:00:00.000Z" },
      { owner: "o", repo: "r", ledgerPath, runId: "RUN-1", issues: gateway },
      { provenanceBracket: { start, end } },
    );
    reportDrainQuotaExhaustion(
      { stopReason: "no_runnable", indeterminateDeclines: 1 },
      { owner: "o", repo: "r", ledgerPath: fixtureLedger("no-pacing-2"), runId: "DRAIN-1", issues: gateway },
      { readGhQuota: () => ({ core: { remaining: 0, resetsAt: "2026-08-27T02:00:00.000Z" } }) },
    );
  } finally {
    global.setTimeout = realSetTimeout;
    global.setInterval = realSetInterval;
  }
  assert.equal(timerScheduled, false, "not one of these calls may pace, sleep, or defer -- design (v)'s 'no governor is proposed'");
});

// ── acceptance 7: the daemon quota hook still surfaces without pausing dispatch ─────────────

const DISPATCHABLE_YAML = `
- id: A
  title: a runnable task, unaffected by the quota hook's own observation
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

function dispatchablePlan(): Plan {
  const dir = mkdtempSync(join(tmpdir(), "rate-limit-provenance-dispatch-"));
  const f = join(dir, "tasks.yaml");
  writeFileSync(f, DISPATCHABLE_YAML);
  return loadPlan(f);
}

const okResult = (id: string): RunResult => ({ taskId: id, runId: `${id}-run`, merged: true, costUsd: 0.1, verdict: "merged" });

test("the daemon quota hook still surfaces on every tick WITHOUT pausing dispatch, even while wired through the new provenance guard", async () => {
  const plan = dispatchablePlan();
  let runOneCalls = 0;
  let exhaustions = 0;
  const s = await runDaemon(
    plan,
    {
      refreshMerged: () => () => false,
      runOne: async (id) => {
        runOneCalls++;
        return okResult(id);
      },
      // Every tick reports the graphql bucket exhausted -- the hook must keep firing...
      readGhQuota: () => ({ graphql: { remaining: 0, resetsAt: "2026-08-27T02:00:00.000Z" } }),
      onQuotaExhausted: (info) => {
        exhaustions++;
        // ...and running it through the provenance-guarded escalator (a mismatched bracket, so
        // it discards rather than opening a real issue) must still not touch dispatch at all.
        escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath: fixtureLedger("tick"), runId: "DAEMON-1" }, {
          provenanceBracket: { start: reading({ reset: 1 }), end: reading({ reset: 2 }) },
        });
      },
      sleep: async () => {},
      log: () => {},
    },
    { max: 1 },
  );
  assert.equal(s.stopReason, "max_reached", "the loop ran its tick and stopped on the injected bound, never on the quota reading");
  assert.equal(runOneCalls, 1, "dispatch reached and ran the runnable task -- the quota hook's own doc: 'dispatch is NOT paused by this hook'");
  assert.equal(exhaustions, 1, "the hook still surfaced the crossing exactly once");
});
