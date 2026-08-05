// test/post-review-stall-escalation.test.ts
//
// THE DEFECT, MEASURED at 2026-08-05 over the live ledger unioned with every rotation:
// `sweep.post_review.failed` had fired 91 times — every one a GraphQL rate-limit — and produced NO
// operator-visible signal. Green PRs sat unreviewed while the sweep retried each tick and appended
// another identical line. An operator found it by hand after a full session. Counts at that moment:
// attempt 390 / done 296 / failed 91.
//
// THE THRESHOLD IS DERIVED, NOT PICKED. Consecutive-failure runs (a `.done` resets the count) were
// {1:1, 4:2, 5:1, 77:1}. The short runs recovered in 2.6–3.5 minutes; the run of 77 spanned 32.5
// minutes. Observed transient max 5, observed stall 77, nothing in between — so 8 sits in an empty
// gap. Tests below pin BOTH sides of that boundary.
//
// WHAT THESE TESTS ASSERT, and the second one matters more than the first: that a REPEATED
// condition escalates EXACTLY ONCE. `escalate()` skips its whole dedup block when the escalation
// names no PR (`if (prRef && deps.issues.listOpen)`), and this condition is fleet-wide with no
// single PR to name — so without an episode key it would open one needs-human issue PER SWEEP TICK,
// reproducing the eight-identical-"dispatch queue starved"-issues shape exactly.
//
// STATE TRANSITION, NOT VALUE: every assertion here is about a CHANGE — a run of failures crossing
// the threshold, and an episode already having been escalated — never about a bare count read at one
// instant. No test asserts "the ledger contains N failures"; they assert what the detector and the
// escalator DO as the run grows.
//
// Nothing here touches GitHub: the issue gateway is a recorder, so a real needs-human issue can
// never be opened by this file.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SWEEP_POLICY, POST_REVIEW_STALL_THRESHOLD, detectPostReviewStall } from "../src/lib/sweep.js";
import { buildSweepEffects, escalatePostReviewStall } from "../src/run-task.js";
import { DECISION_RELEVANT_LEDGER_STEPS, appendLedger } from "../src/lib/ledger.js";
import type { IssueGateway } from "../src/lib/escalate.js";

/** The real observed error, verbatim apart from the PR number that varies per row. */
function rateLimitError(pr: number): string {
  return (
    `Command failed: gh pr view ${pr} --repo craigoley/remudero --json headRefOid,headRefName,body,url,number\n` +
    `GraphQL: API rate limit already exceeded for user ID 4397075.`
  );
}

/** Ledger lines for a run of consecutive failures, one minute apart, oldest first. */
function failureRun(n: number, startMs = Date.parse("2026-08-05T12:29:49.000Z")) {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(startMs + i * 60_000).toISOString(),
    step: "sweep.post_review.failed",
    pr_number: 1339 + (i % 4),
    error: rateLimitError(1339 + (i % 4)),
  }));
}

/** An issue gateway that records instead of calling GitHub. `create` is the real method name. */
function recorder() {
  const opened: Array<{ title: string; body: string }> = [];
  const gw: IssueGateway = {
    create: (title: string, body: string) => {
      opened.push({ title, body });
      return `https://github.com/o/r/issues/${opened.length}`;
    },
    listOpen: () => [],
  } as unknown as IssueGateway;
  return { opened, gw };
}

function tmpLedger(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-post-review-stall-"));
  return { path: join(dir, "ledger.ndjson"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function escalatedCount(ledgerPath: string): number {
  let n = 0;
  let raw = "";
  try {
    raw = readFileSync(ledgerPath, "utf8");
  } catch {
    return 0; // no escalation ever written ⇒ the file does not exist ⇒ zero, not a throw
  }
  for (const line of raw.split("\n")) {
    if (line.includes('"sweep.post_review.stalled.escalated"')) n++;
  }
  return n;
}

// ── the detector ────────────────────────────────────────────────────────────────────────────────

test("a run at the threshold is a stall and a run below it is not — the boundary the ledger data pins", () => {
  const below = detectPostReviewStall(failureRun(POST_REVIEW_STALL_THRESHOLD - 1));
  assert.equal(below.stalled, false, "one short of the threshold is not yet a stall");
  assert.equal(below.consecutiveFailures, POST_REVIEW_STALL_THRESHOLD - 1);

  const at = detectPostReviewStall(failureRun(POST_REVIEW_STALL_THRESHOLD));
  assert.equal(at.stalled, true, "the threshold itself stalls");

  // The real observed transient maximum (5) must NOT trip it; the real observed stall (77) must.
  assert.equal(detectPostReviewStall(failureRun(5)).stalled, false, "the worst observed transient run stays quiet");
  assert.equal(detectPostReviewStall(failureRun(77)).stalled, true, "the observed 77-failure stall trips");
});

test("a success resets the run — the question is whether it is stalled NOW, not whether it ever failed a lot", () => {
  const lines = [
    ...failureRun(20),
    { ts: "2026-08-05T13:00:00.000Z", step: "sweep.post_review.done", pr_number: 1339 },
    ...failureRun(2, Date.parse("2026-08-05T13:01:00.000Z")),
  ];
  const v = detectPostReviewStall(lines);
  assert.equal(v.consecutiveFailures, 2, "only the run since the last success counts");
  assert.equal(v.stalled, false, "a lifetime count would have latched here forever; this must not");
});

test("error text is normalised so one stall does not read as many groups", () => {
  // The measured shape: 91 failures carried 10 DISTINCT raw error strings and exactly 1 normalised.
  const v = detectPostReviewStall(failureRun(10));
  assert.ok(v.normalisedError, "a normalised error is carried");
  assert.ok(!/\d/.test(v.normalisedError ?? "x1"), "no digits survive normalisation, so per-PR text collapses");
  const distinctRaw = new Set(failureRun(10).map((l) => l.error)).size;
  assert.ok(distinctRaw > 1, "the raw texts really do differ — otherwise this test proves nothing");
});

test("an all-quota run is flagged rate-limited, and a mixed run is not — classification never gates the stall", () => {
  assert.equal(detectPostReviewStall(failureRun(10)).rateLimited, true);
  const mixed = [...failureRun(9), { ts: "2026-08-05T13:00:00.000Z", step: "sweep.post_review.failed", error: "boom" }];
  const v = detectPostReviewStall(mixed);
  assert.equal(v.rateLimited, false, "one non-quota failure means the run is not purely a quota problem");
  assert.equal(v.stalled, true, "but it still stalls — an unrecognised cause must never be invisible");
});

// ── the escalator: the regression lock ──────────────────────────────────────────────────────────

test("a repeated stall escalates EXACTLY ONCE across many ticks, not once per occurrence", () => {
  const led = tmpLedger();
  const { opened, gw } = recorder();
  try {
    // Simulate the real shape: the run grows by one failure per sweep tick, and the escalator is
    // consulted on every tick — which is precisely when a no-PR-ref escalation would open a fresh
    // issue each time.
    for (let n = POST_REVIEW_STALL_THRESHOLD; n <= POST_REVIEW_STALL_THRESHOLD + 12; n++) {
      escalatePostReviewStall(detectPostReviewStall(failureRun(n)), {
        owner: "o",
        repo: "r",
        ledgerPath: led.path,
        runId: "RUN-1",
        issues: gw,
      });
    }
    assert.equal(opened.length, 1, "13 ticks of the same stall must open exactly ONE issue");
    assert.equal(escalatedCount(led.path), 1, "and write exactly ONE dedup marker");
  } finally {
    led.cleanup();
  }
});

test("a single transient failure escalates nothing", () => {
  const led = tmpLedger();
  const { opened, gw } = recorder();
  try {
    escalatePostReviewStall(detectPostReviewStall(failureRun(1)), {
      owner: "o",
      repo: "r",
      ledgerPath: led.path,
      runId: "RUN-1",
      issues: gw,
    });
    assert.equal(opened.length, 0, "one failure is noise, not a stall");
    assert.equal(escalatedCount(led.path), 0);
  } finally {
    led.cleanup();
  }
});

test("a genuinely NEW stall after a quiet gap escalates again — dedup is an episode, not a permanent mute", () => {
  const led = tmpLedger();
  const { opened, gw } = recorder();
  try {
    const first = Date.parse("2026-08-05T12:00:00.000Z");
    escalatePostReviewStall(detectPostReviewStall(failureRun(10, first)), {
      owner: "o", repo: "r", ledgerPath: led.path, runId: "RUN-1", issues: gw, episodeMs: 60 * 60 * 1000,
    });
    assert.equal(opened.length, 1);
    // A day later — well outside the episode window.
    const later = Date.parse("2026-08-06T12:00:00.000Z");
    escalatePostReviewStall(detectPostReviewStall(failureRun(10, later)), {
      owner: "o", repo: "r", ledgerPath: led.path, runId: "RUN-2", issues: gw, episodeMs: 60 * 60 * 1000,
    });
    assert.equal(opened.length, 2, "a new episode must be able to escalate — otherwise the first stall mutes forever");
  } finally {
    led.cleanup();
  }
});

test("the notice states the count and the quota cause, so the operator can act without opening the ledger", () => {
  const led = tmpLedger();
  const { opened, gw } = recorder();
  try {
    escalatePostReviewStall(detectPostReviewStall(failureRun(12)), {
      owner: "o", repo: "r", ledgerPath: led.path, runId: "RUN-1", issues: gw,
    });
    const body = opened[0]?.body ?? "";
    assert.match(body, /12 times in a row/, "the run length is stated");
    assert.match(body, /rate_limit/, "the quota remedy is named");
    assert.ok(!/\bgh pr view \d/.test(body), "the failing call appears normalised, not with a single PR's number");
  } finally {
    led.cleanup();
  }
});

// ── the rotation coupling ───────────────────────────────────────────────────────────────────────

test("the dedup marker is decision-relevant, so a rotation cannot re-open one issue per tick", () => {
  // escalatePostReviewStall READS this step back to dedup. If rotation archived it, every tick
  // after a rotation would re-escalate — the #977 class, and the exact unbounded shape this
  // escalation's episode key exists to prevent.
  assert.ok(
    DECISION_RELEVANT_LEDGER_STEPS.has("sweep.post_review.stalled.escalated"),
    "sweep.post_review.stalled.escalated must be retained across rotation",
  );
});

test("the marker is written even when issue delivery fails — an undelivered notice must not retry unboundedly", () => {
  const led = tmpLedger();
  const throwing = {
    create: () => {
      throw new Error("gh down");
    },
    listOpen: () => [],
  } as unknown as IssueGateway;
  try {
    escalatePostReviewStall(detectPostReviewStall(failureRun(10)), {
      owner: "o", repo: "r", ledgerPath: led.path, runId: "RUN-1", issues: throwing,
    });
    assert.equal(escalatedCount(led.path), 1, "the marker records the attempt");
    const line = readFileSync(led.path, "utf8").split("\n").find((l) => l.includes("stalled.escalated")) ?? "";
    assert.match(line, /"delivered":false/, "and records honestly that delivery failed");
    // A second tick must still not re-open.
    escalatePostReviewStall(detectPostReviewStall(failureRun(11)), {
      owner: "o", repo: "r", ledgerPath: led.path, runId: "RUN-1", issues: throwing,
    });
    assert.equal(escalatedCount(led.path), 1, "undelivered still dedups — one operator read, not a retry loop");
  } finally {
    led.cleanup();
  }
});

/** Keeps `appendLedger` imported-and-used so the fixture shape matches the real writer. */
test("fixture sanity: appendLedger writes a line the counter can see", () => {
  const led = tmpLedger();
  try {
    appendLedger(led.path, { run_id: "R", task_id: "DAEMON", step: "sweep.post_review.stalled.escalated" });
    assert.equal(escalatedCount(led.path), 1);
  } finally {
    led.cleanup();
  }
});

// ── THE REAL WIRING ─────────────────────────────────────────────────────────────────────────────
// The tests above drive the detector and the escalator directly. This one drives the PRODUCTION
// PATH: `buildSweepEffects`' own `postReview` closure, with the injectable `reviewRunner` throwing
// the real error and the injectable `issuesImpl` recording instead of opening a GitHub issue. That
// closure is where the detector and escalator are actually called, and a test that only exercised
// the two functions in isolation would leave the wiring itself unproven — the shape this repo has
// already paid for twice (the preflight spawn default, the plan reloader that threw on every tick).

test("the sweep's own postReview closure escalates a repeated failure — real wiring, not a hand call", async () => {
  const led = tmpLedger();
  const { opened, gw } = recorder();
  const logged: string[] = [];
  try {
    const effects = buildSweepEffects(
      "craigoley",
      "remudero",
      { claudeBin: "/bin/true", root: "/nonexistent-stall-root" } as never,
      led.path,
      "SWEEP-STALL-1",
      { tasks: [], byId: new Map() } as never,
      // Mirrors production exactly: `runSweep`'s own log is
      // `appendLedger(ledgerPath, {run_id, task_id:"SWEEP", step, ...extra})`. The detector reads
      // the ledger FILE back, so a fake that only recorded in memory would not exercise the wiring.
      (step, extra) => {
        logged.push(step);
        appendLedger(led.path, { run_id: "SWEEP-STALL-1", task_id: "SWEEP", step, ...(extra ?? {}) });
      },
      DEFAULT_SWEEP_POLICY,
      async () => {
        throw new Error(rateLimitError(1339));
      },
      undefined,
      undefined,
      gw,
    );

    // Every tick the sweep re-attempts and the effect rethrows; the sweep contains that per PR.
    for (let i = 0; i < POST_REVIEW_STALL_THRESHOLD + 4; i++) {
      await assert.rejects(
        async () => {
          await effects.postReview!({ prNumber: 1339, headSha: "abc1234" } as never);
        },
        /rate limit/,
        "the original failure is always rethrown — the notice must never mask it",
      );
    }

    assert.ok(logged.filter((s) => s === "sweep.post_review.failed").length >= POST_REVIEW_STALL_THRESHOLD);
    assert.equal(opened.length, 1, "the real wiring escalates exactly once across many ticks");
    assert.equal(escalatedCount(led.path), 1);
    assert.ok(!logged.includes("sweep.post_review.stall_notice_failed"), "the notice itself did not fail");
  } finally {
    led.cleanup();
  }
});

test("a stall whose failures are NOT quota errors escalates without the quota remedy text", () => {
  const led = tmpLedger();
  const { opened, gw } = recorder();
  try {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      ts: new Date(Date.parse("2026-08-05T12:00:00.000Z") + i * 60_000).toISOString(),
      step: "sweep.post_review.failed",
      error: "Command failed: gh pr view 1339 --repo craigoley/remudero\nsomething else broke",
    }));
    const v = detectPostReviewStall(lines);
    assert.equal(v.rateLimited, false);
    escalatePostReviewStall(v, { owner: "o", repo: "r", ledgerPath: led.path, runId: "RUN-1", issues: gw });
    assert.equal(opened.length, 1, "an unrecognised cause still escalates — that is the whole point");
    assert.ok(!/rate_limit/.test(opened[0]?.body ?? ""), "and does not offer a quota remedy that does not apply");
  } finally {
    led.cleanup();
  }
});

test("a throw from the stall notice is contained and ledgered — it never replaces the real failure", () => {
  // The catch arm exists so a bookkeeping fault cannot mask the error being reported. It is only
  // reachable if the notice itself throws (a disk-full appendLedger is the realistic case on this
  // host, which has hit ENOSPC), so it is provable only with an injected thrower.
  const led = tmpLedger();
  const logged: string[] = [];
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { claudeBin: "/bin/true", root: "/nonexistent-stall-root" } as never,
    led.path,
    "SWEEP-STALL-2",
    { tasks: [], byId: new Map() } as never,
    (step) => logged.push(step),
    DEFAULT_SWEEP_POLICY,
    async () => {
      throw new Error(rateLimitError(1339));
    },
    undefined,
    undefined,
    undefined,
    () => {
      throw new Error("notice exploded");
    },
  );
  return assert
    .rejects(async () => {
      await effects.postReview!({ prNumber: 1339, headSha: "abc1234" } as never);
    }, /rate limit/)
    .then(() => {
      assert.ok(
        logged.includes("sweep.post_review.stall_notice_failed"),
        "the notice failure is ledgered rather than swallowed",
      );
      led.cleanup();
    });
});
