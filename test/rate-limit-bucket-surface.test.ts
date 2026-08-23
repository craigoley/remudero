import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GH_RATE_LIMIT_BUCKET_UNKNOWN,
  ghRateLimitRefusalFromReading,
  ghRateLimitRefusalUnknown,
  type GhRateLimitReading,
} from "../src/lib/worker.js";
import {
  armAndLogOutcome,
  armAutoMergeDetailed,
  armFailureIsRateLimited,
  armIfVerdictPermits,
  latestGhRateLimitRefusalsFromLedger,
  renderGhBucketsSection,
  statusCommand,
  type ArmDeps,
} from "../src/run-task.js";
import { DECISION_RELEVANT_LEDGER_STEPS } from "../src/lib/ledger.js";
import type { Config } from "../src/lib/config.js";

// ── W1-T1235: an exhausted GitHub quota bucket is never named. The auto-merge arm is
// GraphQL-ONLY (no REST form to trade to, unlike `update-branch`), its refusals discarded the
// reset timestamp the response already carries, and `rmd status` reported the MODEL headroom
// window while saying nothing about GitHub's own buckets — so a green PR sat unmerged for a
// reason no instrument stated. This file proves the six acceptance claims from the task's own
// plan record (plan/tasks.d/W1-T1235-…yaml), each labelled below.

/** Records every ledger step a site emitted, mirroring test/arm-outcome-five-sites.test.ts's
 *  own `recorder()` — asserts the CALL, not that code merely ran. */
function recorder() {
  const steps: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { steps, log: (step: string, extra?: Record<string, unknown>) => void steps.push({ step, extra }) };
}

/** ArmDeps that pass the W1-T230 ledger gate (a matching `review.posted` line at the SAME head
 *  the injected `headSha` returns) so `armAutoMergeDetailed` actually reaches `attemptArm` —
 *  the exact fixture shape test/arm-failure-classification.test.ts's own `armAutoMerge` test
 *  already uses for the identical reason. */
function passingArmDeps(overrides: Partial<ArmDeps> = {}): ArmDeps {
  return {
    headSha: () => "aaaa111",
    ledgerLines: () => [
      { step: "review.posted", task_id: "W1-RL", state: "success", head_sha: "aaaa111", proof_exec: ["executed_pass"] },
    ],
    armAuto: () => {
      throw new Error("armAuto must be overridden by the test");
    },
    mergeDirect: () => {},
    disableAuto: () => {},
    say: () => {},
    ...overrides,
  };
}

function throwingArmAuto(stderr: string): ArmDeps["armAuto"] {
  return () => {
    const e = new Error("gh failed") as Error & { stderr: string };
    e.stderr = stderr;
    throw e;
  };
}

// ── acceptance 1/2 — a rate-limited refusal is recorded with the bucket that refused it and
// the reset it named, taken from the response's OWN `resource`/`reset` fields — never inferred
// from which operation was refused. ──────────────────────────────────────────────────────────

test("ghRateLimitRefusalFromReading: an exhausted reading names the bucket + reset FROM THE RESPONSE, not from the caller's own operation label", () => {
  const reading: GhRateLimitReading = { remaining: 0, used: 5000, limit: 5000, reset: 1_800_000_000, resource: "graphql" };
  // The operation string deliberately claims something else — "core-ish-thing" — so a bucket
  // that echoed the operation instead of the header would read "core-ish-thing", not "graphql".
  const refusal = ghRateLimitRefusalFromReading(reading, "core-ish-thing");
  assert.ok(refusal, "an exhausted reading must produce a refusal record");
  assert.equal(refusal!.bucket, "graphql", "the bucket must be reading.resource, never the operation label");
  assert.equal(refusal!.resetsAt, new Date(1_800_000_000 * 1000).toISOString());
  assert.equal(refusal!.operation, "core-ish-thing");
});

test("ghRateLimitRefusalFromReading: swapping resource to 'core' on the SAME operation string flips the recorded bucket — proof the field, not the caller, decides", () => {
  const graphqlReading: GhRateLimitReading = { remaining: 0, reset: 100, resource: "graphql" };
  const coreReading: GhRateLimitReading = { remaining: 0, reset: 100, resource: "core" };
  assert.equal(ghRateLimitRefusalFromReading(graphqlReading, "same op")!.bucket, "graphql");
  assert.equal(ghRateLimitRefusalFromReading(coreReading, "same op")!.bucket, "core");
});

// ── acceptance 3 — an unreadable bucket/reset is recorded as unknown, never invented. ──────

test("ghRateLimitRefusalFromReading: exhausted but no resource/reset header ⇒ both fields render GH_RATE_LIMIT_BUCKET_UNKNOWN, never a guess", () => {
  const reading: GhRateLimitReading = { remaining: 0 }; // no resource, no reset
  const refusal = ghRateLimitRefusalFromReading(reading, "gh api something");
  assert.ok(refusal);
  assert.equal(refusal!.bucket, GH_RATE_LIMIT_BUCKET_UNKNOWN);
  assert.equal(refusal!.resetsAt, GH_RATE_LIMIT_BUCKET_UNKNOWN);
});

test("ghRateLimitRefusalUnknown: the arm's own no-header shape — both fields unknown, never hardcoded 'graphql' despite the arm being structurally GraphQL-only", () => {
  const refusal = ghRateLimitRefusalUnknown("gh pr merge --auto");
  assert.equal(refusal.bucket, GH_RATE_LIMIT_BUCKET_UNKNOWN);
  assert.equal(refusal.resetsAt, GH_RATE_LIMIT_BUCKET_UNKNOWN);
  assert.equal(refusal.operation, "gh pr merge --auto");
  assert.notEqual(refusal.bucket, "graphql", "must not guess the bucket from the arm's own structural shape");
});

// ── acceptance 6 — a call that was never rate limited records no such row. ─────────────────

test("ghRateLimitRefusalFromReading: a reading with headroom left (remaining > 0) produces NO refusal record", () => {
  assert.equal(ghRateLimitRefusalFromReading({ remaining: 4321, resource: "core", reset: 100 }, "op"), undefined);
});

test("ghRateLimitRefusalFromReading: a reading with no `remaining` at all (every non-`gh api` call) produces NO refusal record", () => {
  assert.equal(ghRateLimitRefusalFromReading({}, "gh pr view"), undefined);
});

test("armFailureIsRateLimited: only the rate-limit/abuse-detection signatures match — an ordinary transport blip or semantic refusal does not", () => {
  assert.equal(armFailureIsRateLimited("secondary rate limit exceeded"), true);
  assert.equal(armFailureIsRateLimited("API rate limit exceeded for installation"), true);
  assert.equal(armFailureIsRateLimited("You have exceeded a secondary rate limit and abuse detection"), true);
  assert.equal(armFailureIsRateLimited("connect ETIMEDOUT api.github.com"), false);
  assert.equal(armFailureIsRateLimited("GraphQL: Pull Request is not mergeable (mergePullRequest)"), false);
  assert.equal(armFailureIsRateLimited("X Pull request #591 is in clean status; auto-merge cannot be enabled"), false);
});

// ── acceptance 5 — an auto-merge arm refused on the exhausted budget NAMES that budget
// (a distinct, greppable `automerge.rate_limit_refused` row, both on its own line and merged
// onto the generic arm-failure row) instead of failing silently into undifferentiated prose. ──

test("armAndLogOutcome: a rate-limit-shaped arm refusal ledgers automerge.rate_limit_refused, naming the (unknown) bucket, beside the generic arm_failed row", () => {
  const r = recorder();
  const said: string[] = [];
  const deps = passingArmDeps({
    armAuto: throwingArmAuto("secondary rate limit exceeded for the authenticated account"),
    // W1-T1255: a rate-limited arm now attempts the REST fallback. THIS test is the path where
    // that fallback is REFUSED, which is the one that still ends in `arm_failed`; the sibling
    // test below covers the path where it merges. Both still assert W1-T1235's own guarantee —
    // the exhausted budget is named — because `rateLimit` rides every result the quota branch
    // can return.
    mergeDirect: () => {
      throw new Error("HTTP 405: Pull Request is not mergeable");
    },
    isMerged: () => false,
    say: (m) => said.push(m),
  });
  const outcome = armAndLogOutcome("https://github.com/craigoley/remudero/pull/1235", "W1-RL", r.log, (u, t) =>
    armAutoMergeDetailed(u, t, deps),
  );
  assert.equal(outcome, "arm-error-ignored");

  const steps = r.steps.map((s) => s.step);
  assert.ok(steps.includes("automerge.arm_failed"), `expected automerge.arm_failed among: ${steps.join(", ")}`);
  assert.ok(
    steps.includes("automerge.rate_limit_refused"),
    `expected a DISTINCT automerge.rate_limit_refused row, got: ${steps.join(", ")}`,
  );

  const namedRow = r.steps.find((s) => s.step === "automerge.rate_limit_refused");
  assert.equal(namedRow?.extra?.gh_bucket, GH_RATE_LIMIT_BUCKET_UNKNOWN);
  assert.equal(namedRow?.extra?.gh_bucket_resets_at, GH_RATE_LIMIT_BUCKET_UNKNOWN);
  assert.equal(namedRow?.extra?.gh_bucket_operation, "gh pr merge --auto");

  // The SAME bucket fields also ride the generic arm_failed row — a reader scanning only
  // automerge.arm_failed rows (the pre-existing, un-narrowed view) still sees the bucket.
  const failedRow = r.steps.find((s) => s.step === "automerge.arm_failed");
  assert.equal(failedRow?.extra?.gh_bucket, GH_RATE_LIMIT_BUCKET_UNKNOWN);

  assert.ok(
    said.some((m) => /rate-limit budget exhausted/.test(m)),
    `expected the say() line to name the exhausted budget, got: ${said.join("\n")}`,
  );
});

test("armAndLogOutcome: a rate-limited arm whose REST fallback MERGES still names the exhausted bucket (W1-T1255)", () => {
  const r = recorder();
  const said: string[] = [];
  const deps = passingArmDeps({
    armAuto: throwingArmAuto("secondary rate limit exceeded for the authenticated account"),
    say: (m) => said.push(m),
  });
  const outcome = armAndLogOutcome("https://github.com/craigoley/remudero/pull/1255", "W1-RL", r.log, (u, t) =>
    armAutoMergeDetailed(u, t, deps),
  );
  // The fallback landed the merge — but the arm WAS refused on quota, and that must not vanish.
  assert.equal(outcome, "direct-merged");
  const steps = r.steps.map((s) => s.step);
  assert.ok(
    steps.includes("automerge.rate_limit_refused"),
    `the distinct bucket row must survive a successful fallback, got: ${steps.join(", ")}`,
  );
  const namedRow = r.steps.find((s) => s.step === "automerge.rate_limit_refused");
  assert.equal(namedRow?.extra?.gh_bucket, GH_RATE_LIMIT_BUCKET_UNKNOWN);
  assert.equal(namedRow?.extra?.gh_bucket_operation, "gh pr merge --auto");
  assert.ok(
    said.some((m) => /rate-limit budget exhausted/.test(m)),
    "the say() line must still name the budget",
  );
});

test("armAndLogOutcome: a NON-rate-limit arm refusal ledgers NO automerge.rate_limit_refused row — the row marks real refusals only", () => {
  const r = recorder();
  const deps = passingArmDeps({ armAuto: throwingArmAuto("GraphQL: Pull Request is not mergeable (mergePullRequest)") });
  const outcome = armAndLogOutcome("https://github.com/craigoley/remudero/pull/1236", "W1-RL", r.log, (u, t) =>
    armAutoMergeDetailed(u, t, deps),
  );
  assert.equal(outcome, "arm-error-ignored");
  const steps = r.steps.map((s) => s.step);
  assert.ok(steps.includes("automerge.arm_failed"));
  assert.ok(
    !steps.includes("automerge.rate_limit_refused"),
    `an ordinary refusal must not be recorded as a rate-limit one, got: ${steps.join(", ")}`,
  );
  const failedRow = r.steps.find((s) => s.step === "automerge.arm_failed");
  assert.equal(failedRow?.extra?.gh_bucket, undefined, "no gh_bucket field on an ordinary refusal's row");
});

test("armAndLogOutcome: a clean-status refusal (direct-merge fallback) still carries no gh_bucket fields — unaffected by this task", () => {
  const r = recorder();
  const merged: string[] = [];
  const deps = passingArmDeps({
    armAuto: throwingArmAuto("X Pull request #591 is in clean status; auto-merge cannot be enabled"),
    mergeDirect: (u) => void merged.push(u),
  });
  const outcome = armAndLogOutcome("https://github.com/craigoley/remudero/pull/1237", "W1-RL", r.log, (u, t) =>
    armAutoMergeDetailed(u, t, deps),
  );
  assert.equal(outcome, "direct-merged");
  assert.deepEqual(merged, ["https://github.com/craigoley/remudero/pull/1237"]);
  assert.ok(!r.steps.some((s) => s.step === "automerge.rate_limit_refused"));
});

// `automerge.rate_limit_refused` must survive ledger rotation — a stuck-merge diagnosis reached
// hours after the refusal must still find the row (see ledger.ts's own DECISION_RELEVANT doc).
test("automerge.rate_limit_refused is registered so a ledger rotation never silently drops it", () => {
  assert.equal(DECISION_RELEVANT_LEDGER_STEPS.has("automerge.rate_limit_refused"), true);
});

// The OTHER caller `logArmAttribution` rides through — `armIfVerdictPermits`, the "review" lane
// (`reviewCommand`'s own post-verdict arm) — must carry the same bucket-naming, not just the
// dep-review/retro/triage/plan/approve lanes `armAndLogOutcome` covers.
test("armIfVerdictPermits: a rate-limit-shaped refusal from the review lane ALSO ledgers automerge.rate_limit_refused", () => {
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const outcome = armIfVerdictPermits(
    { state: "success", capped: false, planOnly: false },
    {
      prUrl: "https://github.com/craigoley/remudero/pull/1238",
      taskId: "PR-1238",
      headSha: "a9e8163cafe",
      ledgerPath: "/dev/null",
      log: (step, extra) => void logged.push({ step, extra }),
    },
    {
      ledgerLines: () => [],
      arm: () => ({
        outcome: "arm-error-ignored",
        error: "secondary rate limit exceeded",
        rateLimit: { bucket: GH_RATE_LIMIT_BUCKET_UNKNOWN, resetsAt: GH_RATE_LIMIT_BUCKET_UNKNOWN, operation: "gh pr merge --auto" },
      }),
    },
  );
  assert.equal(outcome, "arm-error-ignored");
  const namedRow = logged.find((s) => s.step === "automerge.rate_limit_refused");
  assert.ok(namedRow, `expected automerge.rate_limit_refused among: ${logged.map((s) => s.step).join(", ")}`);
  assert.equal(namedRow?.extra?.gh_bucket, GH_RATE_LIMIT_BUCKET_UNKNOWN);
  assert.equal(namedRow?.extra?.lane, "review");
});

// ── acceptance 4 — `rmd status` reports the GitHub buckets ALONGSIDE the model headroom
// section, never only the model window. ─────────────────────────────────────────────────────

test("latestGhRateLimitRefusalsFromLedger: newest row per bucket wins, and a bucket never refused is simply absent", () => {
  const lines = [
    { step: "automerge.rate_limit_refused", ts: "2026-08-23T01:00:00.000Z", gh_bucket: "graphql", gh_bucket_resets_at: "2026-08-23T01:30:00.000Z", gh_bucket_operation: "gh pr merge --auto", pr_url: "url/1" },
    { step: "automerge.rate_limit_refused", ts: "2026-08-23T03:00:00.000Z", gh_bucket: "graphql", gh_bucket_resets_at: "2026-08-23T03:30:00.000Z", gh_bucket_operation: "gh pr merge --auto", pr_url: "url/2" },
    { step: "automerge.arm_failed", ts: "2026-08-23T04:00:00.000Z", gh_bucket: "core" }, // wrong step — must be ignored
  ];
  const refusals = latestGhRateLimitRefusalsFromLedger(lines);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].bucket, "graphql");
  assert.equal(refusals[0].resetsAt, "2026-08-23T03:30:00.000Z", "the NEWER row must win, not the first one seen");
  assert.equal(refusals[0].prUrl, "url/2");
});

test("renderGhBucketsSection: an empty history renders an explicit 'no refusal recorded' line, not a blank/missing section", () => {
  const text = renderGhBucketsSection([]);
  assert.match(text, /GITHUB BUCKETS/);
  assert.match(text, /no rate-limit refusal recorded/);
});

test("renderGhBucketsSection: a recorded refusal names the bucket, its reset, and the refused operation", () => {
  const text = renderGhBucketsSection([
    { bucket: "graphql", resetsAt: "2026-08-23T03:30:00.000Z", operation: "gh pr merge --auto", ts: "2026-08-23T03:00:00.000Z" },
  ]);
  assert.match(text, /graphql/);
  assert.match(text, /2026-08-23T03:30:00\.000Z/);
  assert.match(text, /gh pr merge --auto/);
});

function fakeConfig(root: string): Config {
  return { claudeBin: "/nonexistent/claude", root } as Config;
}

test("statusCommand: text mode renders GITHUB BUCKETS BESIDE HEADROOM — both sections present, neither replacing the other", async () => {
  const lines: string[] = [];
  const ledgerLines = [
    {
      step: "automerge.rate_limit_refused",
      ts: "2026-08-23T03:00:00.000Z",
      gh_bucket: "graphql",
      gh_bucket_resets_at: "2026-08-23T03:30:00.000Z",
      gh_bucket_operation: "gh pr merge --auto",
      pr_url: "https://github.com/craigoley/remudero/pull/1235",
    },
  ];
  const rc = await statusCommand([], {
    loadConfig: () => fakeConfig("/nonexistent/root/for/tests"),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => "/nonexistent/ledger/for/tests.ndjson",
    repoRoot: "/nonexistent/repo/for/tests",
    readLedgerLines: () => ledgerLines,
    out: (l) => lines.push(l),
  });
  assert.equal(rc, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /HEADROOM/, "the model's own HEADROOM section must still render");
  assert.match(lines[0], /GITHUB BUCKETS/, "a new GITHUB BUCKETS section must render beside it");
  assert.match(lines[0], /graphql: refused/);
});

test("statusCommand: --json mode carries ghBucketRefusals alongside the normal model, not in place of it", async () => {
  const lines: string[] = [];
  const ledgerLines = [
    {
      step: "automerge.rate_limit_refused",
      ts: "2026-08-23T03:00:00.000Z",
      gh_bucket: "core",
      gh_bucket_resets_at: "2026-08-23T03:30:00.000Z",
      gh_bucket_operation: "gh pr merge --auto",
    },
  ];
  const rc = await statusCommand(["--json"], {
    loadConfig: () => fakeConfig("/nonexistent/root/for/tests"),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => "/nonexistent/ledger/for/tests.ndjson",
    repoRoot: "/nonexistent/repo/for/tests",
    readLedgerLines: () => ledgerLines,
    out: (l) => lines.push(l),
  });
  assert.equal(rc, 0);
  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed.headroom !== undefined || parsed.liveness !== undefined, "the normal model fields must still be present");
  assert.equal(parsed.ghBucketRefusals?.[0]?.bucket, "core");
});

test("statusCommand: no rate-limit refusal ever recorded ⇒ GITHUB BUCKETS still renders, stating so explicitly", async () => {
  const lines: string[] = [];
  const rc = await statusCommand([], {
    loadConfig: () => fakeConfig("/nonexistent/root/for/tests"),
    queryService: () => ({ running: false, pid: null }),
    ledgerPathFor: () => "/nonexistent/ledger/for/tests.ndjson",
    repoRoot: "/nonexistent/repo/for/tests",
    readLedgerLines: () => [],
    out: (l) => lines.push(l),
  });
  assert.equal(rc, 0);
  assert.match(lines[0], /GITHUB BUCKETS/);
  assert.match(lines[0], /no rate-limit refusal recorded/);
});
