import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGather, ownBranchOf, renderGather, type ShippedGithub } from "../src/lib/retro.js";

/**
 * W1-T132 — proves the WIRING, not just the underlying `shippedSince` primitive
 * (already covered by test/retro.test.ts). The bug this task closes: `rmd retro`
 * called `buildGather` WITHOUT a github gateway, so `shipped` silently degraded
 * to the ledger-only list — structurally empty in the gate-side-merge era, since
 * no run ends verdict==='merged' any more (merges land gate-side, after the run
 * already terminated some other terminal verdict).
 *
 * The fixture below mirrors the MEASURED 2026-07-19 ops sweep cited in the task
 * (plan/tasks.yaml W1-T132): a marker of 2026-07-18T14:10:27Z, a batch of runs
 * that all end in a non-merged terminal verdict (blocked_review, blocked_ci,
 * incomplete, no_pr, pr_attribution_failed, blocked, blocked_containment,
 * blocked_isolation), 28 of which nonetheless merged GATE-SIDE on GitHub.
 */

const MARKER = "2026-07-18T14:10:27Z";

/** The verdict vocabulary the 2026-07-19 sweep actually observed (plus
 *  blocked_review, the canonical gate-side-merge case W1-T51 was built for) —
 *  every one a NON-merged terminal state, which is exactly why the ledger-only
 *  predicate (verdict === 'merged') sees nothing. */
const NON_MERGED_VERDICTS = [
  "blocked_review",
  "blocked_ci",
  "incomplete",
  "no_pr",
  "pr_attribution_failed",
  "blocked",
  "blocked_containment",
  "blocked_isolation",
];

interface CreditedRun {
  runId: string;
  taskId: string;
  verdict: string;
}

interface Fixture {
  ledgerNdjson: string;
  credited: CreditedRun[];
  foreignTaskId: string;
  foreignRunId: string;
  noEvidenceTaskIds: string[];
}

/** Build the "2026-07-19 ledger" fixture: 28 gate-side-mergeable runs, one
 *  foreign-branch-trailer run (must be REJECTED even though GitHub has SOME
 *  evidence for it), and a handful of genuinely-not-shipped runs (no GitHub
 *  evidence at all) — all started strictly after MARKER, none ending
 *  verdict==='merged'. */
function build2026_07_19Fixture(): Fixture {
  const lines: string[] = [];
  const credited: CreditedRun[] = [];
  for (let i = 1; i <= 28; i++) {
    const n = String(i).padStart(2, "0");
    const runId = `RG${n}`;
    const taskId = `T-GATE-${n}`;
    const verdict = NON_MERGED_VERDICTS[(i - 1) % NON_MERGED_VERDICTS.length];
    const ts = `2026-07-19T${String(i % 24).padStart(2, "0")}:00:00.000Z`;
    lines.push(`{"ts":"${ts}","run_id":"${runId}","task_id":"${taskId}","step":"run.start","type":"implement"}`);
    lines.push(`{"ts":"${ts}","run_id":"${runId}","task_id":"${taskId}","step":"verdict","verdict":"${verdict}","cost_usd":1.1}`);
    credited.push({ runId, taskId, verdict });
  }

  const foreignRunId = "RFOREIGN";
  const foreignTaskId = "T-FOREIGN";
  lines.push(
    `{"ts":"2026-07-19T23:00:00.000Z","run_id":"${foreignRunId}","task_id":"${foreignTaskId}","step":"run.start","type":"implement"}`,
  );
  lines.push(
    `{"ts":"2026-07-19T23:01:00.000Z","run_id":"${foreignRunId}","task_id":"${foreignTaskId}","step":"verdict","verdict":"blocked_ci","cost_usd":0.9}`,
  );

  const noEvidenceTaskIds: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const runId = `RNOEV${i}`;
    const taskId = `T-NOEV-${i}`;
    const ts = `2026-07-19T${String((i + 10) % 24).padStart(2, "0")}:30:00.000Z`;
    lines.push(`{"ts":"${ts}","run_id":"${runId}","task_id":"${taskId}","step":"run.start","type":"implement"}`);
    lines.push(`{"ts":"${ts}","run_id":"${runId}","task_id":"${taskId}","step":"verdict","verdict":"incomplete","cost_usd":0.4}`);
    noEvidenceTaskIds.push(taskId);
  }

  return { ledgerNdjson: lines.join("\n"), credited, foreignTaskId, foreignRunId, noEvidenceTaskIds };
}

/** A LIVE gateway: resolves a merged, OWNED trailer for every `credited` task,
 *  a merged but FOREIGN-branch trailer for `foreignTaskId` (must be rejected),
 *  and nothing for anything else (genuinely not shipped). */
function liveGateway(fx: Fixture): ShippedGithub {
  const prByTask = new Map(fx.credited.map((c, idx) => [c.taskId, { number: 1000 + idx, url: `https://github.com/o/r/pull/${1000 + idx}` }]));
  const prByUrl = new Map([...prByTask.entries()].map(([taskId, pr]) => [pr.url, taskId]));
  return {
    findMergedByTrailer(taskId) {
      if (taskId === fx.foreignTaskId) return { number: 900, url: "https://github.com/o/r/pull/900" };
      return prByTask.get(taskId) ?? null;
    },
    headRefName(prUrl) {
      const taskId = prByUrl.get(prUrl);
      if (taskId) {
        const run = fx.credited.find((c) => c.taskId === taskId)!;
        return ownBranchOf(run.runId);
      }
      if (prUrl === "https://github.com/o/r/pull/900") return "someone-elses-branch"; // NOT run-RFOREIGN
      return undefined;
    },
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Claim 1 ──────────────────────────────────────────────────────────────
test("buildGather: a live gateway credits the ~28 gate-side merges the ledger-only path reports as zero", () => {
  const fx = build2026_07_19Fixture();
  const g = buildGather({ ledgerNdjson: fx.ledgerNdjson, learningsMd: "# L\n- a\n", sinceTs: MARKER, github: liveGateway(fx) });

  assert.equal(g.mergedSince.length, 0, "no run in this fixture ends verdict==='merged' (the gate-side-merge era)");
  assert.equal(g.shipped.length, 28, "the live gateway must credit all 28 gate-side merges");
  assert.deepEqual(
    new Set(g.shipped.map((s) => s.taskId)),
    new Set(fx.credited.map((c) => c.taskId)),
    "every credited task, and only those, must appear in SHIPPED",
  );
  assert.ok(g.shipped.every((s) => s.source === "github"), "every one of these is a GitHub-discovered gate-side merge");
  assert.ok(!g.shipped.some((s) => s.taskId === fx.foreignTaskId), "the foreign-branch trailer must never be credited");
  for (const noEv of fx.noEvidenceTaskIds) {
    assert.ok(!g.shipped.some((s) => s.taskId === noEv), `${noEv} has no GitHub evidence — must not be credited`);
  }
});

// ── Claim 4 (the regression this task pins) ────────────────────────────────
test("buildGather: replaying the SAME 2026-07-19 fixture with the ledger-only path (no github gateway) still yields zero", () => {
  const fx = build2026_07_19Fixture();
  const g = buildGather({ ledgerNdjson: fx.ledgerNdjson, learningsMd: "# L\n- a\n", sinceTs: MARKER });

  assert.equal(g.mergedSince.length, 0);
  assert.equal(g.shipped.length, 0, "the ledger-only fallback (the pre-W1-T132 bug) reports zero on this exact fixture");
  assert.equal(g.discrepancies.length, 0);
});

// ── Claim 3 (the W1-T51 ownership assert survives being wired in) ─────────
test("buildGather: a blocked_review run whose PR merged gate-side is credited with its annotation, and a foreign-branch trailer is still REJECTED", () => {
  const fx = build2026_07_19Fixture();
  const g = buildGather({ ledgerNdjson: fx.ledgerNdjson, learningsMd: "# L\n- a\n", sinceTs: MARKER, github: liveGateway(fx) });

  const blockedReviewRun = fx.credited.find((c) => c.verdict === "blocked_review");
  assert.ok(blockedReviewRun, "the fixture must include at least one blocked_review case");
  const entry = g.shipped.find((s) => s.taskId === blockedReviewRun!.taskId);
  assert.ok(entry, "the blocked_review run's gate-side merge must be credited");
  assert.equal(entry!.source, "github");
  assert.equal(entry!.annotation, "gate-side merge; run ended blocked_review");

  assert.ok(!g.shipped.some((s) => s.taskId === fx.foreignTaskId), "the foreign-branch trailer must never be credited");
  assert.ok(
    g.discrepancies.some((d) => d.includes(fx.foreignTaskId) && /reject/i.test(d)),
    "the rejection must be NAMED, not silently dropped",
  );
});

// ── Claim 2 (degrade loudly, never silently) ───────────────────────────────
test("buildGather + renderGather: a THROTTLED gateway names the throttle in the report and never presents a confirmed zero", () => {
  const fx = build2026_07_19Fixture();
  const reason = "rate-limited: API rate limit exceeded for installation ID 123456.";
  const throttled: ShippedGithub = {
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    unavailable: () => reason,
  };
  const g = buildGather({ ledgerNdjson: fx.ledgerNdjson, learningsMd: "# L\n- a\n", sinceTs: MARKER, github: throttled });

  assert.equal(g.githubUnavailable, reason, "the throttle reason must be captured on the gather");
  assert.equal(g.shipped.length, 0, "every read genuinely fails under a total throttle");

  const report = renderGather(g);
  assert.match(report, /GITHUB GATEWAY UNAVAILABLE/);
  assert.match(report, new RegExp(escapeRegExp(reason)), "the reason must be NAMED verbatim in the report");

  const shippedSection = report.split("## SHIPPED since marker")[1] ?? "";
  assert.notEqual(shippedSection, "", "the SHIPPED section must be present");
  assert.match(shippedSection, /INDETERMINATE/, "an empty shipped list under throttle reads as indeterminate, not a count");
  assert.doesNotMatch(
    shippedSection.split(/\n##/)[0]!,
    /^- \(none\)\s*$/m,
    "the SHIPPED section must NEVER read as a plain, confirmed '(none)' while the gateway is unavailable",
  );
});

// A healthy gateway (no `unavailable`, matching the pre-existing `fakeGithub` shape used
// throughout test/retro.test.ts) must never trip the degrade-loudly path — no regression.
test("buildGather: a gateway that never implements `unavailable` behaves exactly as before — githubUnavailable stays unset", () => {
  const fx = build2026_07_19Fixture();
  const g = buildGather({
    ledgerNdjson: fx.ledgerNdjson,
    learningsMd: "# L\n- a\n",
    sinceTs: MARKER,
    github: liveGateway(fx),
  });
  assert.equal(g.githubUnavailable, undefined);
  assert.doesNotMatch(renderGather(g), /GITHUB GATEWAY UNAVAILABLE/);
});
