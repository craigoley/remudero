import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import { buildSweepEffects, defaultSweepGhRun, fixCommand, type BuildSweepEffectsDeps } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const EFFECT_KEYS = [
  "arm",
  "close",
  "dispatchFix",
  "escalate",
  "readLiveState",
  "terminalFixStandDown",
  "readRedBaseRefreshFacts",
  "depReview",
  "postReview",
  "repushAbsent",
  "updateBranch",
  "captureRepairFeedback",
  "disarmAutoMerge",
  "requeueCheck",
  "escalateCancelledCheck",
  "escalateInfrastructureCheck",
  "readCiGateRollup",
  "reaggregateCiGate",
  "readMainTip",
  "readMainRepair",
  "readStaleRedWorkflowRuns",
  "runStaleRedLocalRoute",
  "releaseStaleRed",
  "releaseBaseCausedStandDown",
  "selectAdaptiveReviewWidth",
  // W1-T3283: the sweep's trailer-repair effect. The assertion sorts both sides, so this entry's
  // position is free — it is listed last because it is the newest, not because order matters.
  "repairMissingTaskTrailer",
  "rebaseDirtyFleetBranch",
] as const;

test("buildSweepEffects takes one typed deps object and returns the sweep effects surface", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-build-sweep-effects-deps-"));
  try {
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const deps: BuildSweepEffectsDeps = {
      owner: "craigoley",
      repo: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T2889",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: (step, extra) => logs.push({ step, extra }),
      policy: DEFAULT_SWEEP_POLICY,
      reviewRunner: async () => 0,
      issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/1" },
      stallNotice: () => {},
      armImpl: () => "armed",
      armSessionPrsOverride: false,
      captureRepairFeedbackImpl: () => {},
      ghRunImpl: () => {},
      spawnWallClockBoundMsOverride: 1,
      reclaimWorkerImpl: () => {},
      disarmImpl: () => undefined,
      readJsonImpl: async () => ({}),
      registeredWorktreeOwnerImpl: () => undefined,
    };

    const effects = buildSweepEffects(deps);

    assert.deepEqual(Object.keys(effects).sort(), [...EFFECT_KEYS].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixCommand builds the sweep effects from one deps object before routing the PR", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-fix-command-build-sweep-effects-"));
  const shim = ghShim([{ when: "", stdout: '{"contexts":[]}' }], { kind: "fix-command-gh" });
  const oldPath = process.env.PATH;
  const oldError = console.error;
  const errors: string[] = [];
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    process.env.PATH = `${shim.dir}:${oldPath}`;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    const fetched: string[][] = [];
    const exitCode = await fixCommand(["2889"], {
      config: { root, claudeBin: "/bin/true" } as Config,
      fetch: (args) => {
        fetched.push([...args]);
        return /\/pulls\/2889$/.test(args[1])
          ? {
              number: 2889,
              html_url: "https://github.com/craigoley/remudero/pull/2889",
              state: "closed",
              merged: true,
              merged_at: "2026-09-09T00:00:00Z",
              body: "Remudero-Task: W1-T2889\n",
              updated_at: "2026-09-09T00:00:00Z",
              head: { ref: "run-W1-T2889-1788914343433", sha: "abc123" },
              auto_merge: null,
            }
          : /\/check-runs\?/.test(args[1])
            ? { check_runs: [] }
            : { statuses: [] };
      },
    });

    assert.equal(exitCode, 1);
    assert.ok(fetched.some((args) => /\/pulls\/2889$/.test(args[1] ?? "")));
    assert.ok(fetched.some((args) => /\/check-runs\?/.test(args[1] ?? "")));
    assert.ok(fetched.some((args) => /\/commits\/abc123\/status$/.test(args[1] ?? "")));
    assert.ok(errors.some((line) => line.includes("PR #2889 is not fixable") && line.includes("MERGED")));
  } finally {
    console.error = oldError;
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

// @ts-expect-error owner is a required named field, not an omittable positional slot.
const missingRequiredFieldFails: BuildSweepEffectsDeps = {
  repo: "remudero",
  config: { root: "/tmp" } as Config,
  ledgerPath: "/tmp/ledger.ndjson",
  runId: "SWEEP-W1-T2889",
  plan: { tasks: [], byId: new Map() } as unknown as Plan,
  log: () => {},
};

void missingRequiredFieldFails;

// ── The two defaults the collapse left unreachable ─────────────────────────────────────────────
//
// Reshaping the parameter list made both read as ADDED, and diff-coverage named them. Measured on
// origin/main at the same scoped suite set, both already read 0 there: this is inherited debt
// surfacing at the gate, not a regression. Neither is exempt glue — the gate refuses a
// process-boundary directive here, and it is right to: an execFileSync of an ARBITRARY file is not
// re-exec/exit glue. So both are made reachable instead.

test("W1-T2889: defaultSweepGhRun is the real spawn — the ghRunImpl seam's default does not quietly do nothing", () => {
  // Its one caller closes a pull request, so this can only be driven directly. `true` is the
  // harmless argv that still proves the statement runs, and a nonexistent binary proves the throw
  // reaches the caller rather than being swallowed into a silent no-op.
  assert.doesNotThrow(() => defaultSweepGhRun("true", []));
  assert.throws(
    () => defaultSweepGhRun("rmd-no-such-binary-xyzzy", []),
    "a failing gh invocation must surface, or the sweep would read a failed close as a success",
  );
});

test("W1-T2889: the DEFAULT reviewRunner opts in explicitly — driven through postReview, not read from the source", async () => {
  // `reviewRunner` and `reviewCommandImpl` are separate seams on purpose: overriding reviewRunner
  // replaces this arm outright and leaves its opt-in untested, which is exactly how it came to be
  // asserted only as source text. Overriding the COMMAND keeps the default arm as the code under
  // test, so the fields it names are observed rather than pattern-matched. `postReview` is the one
  // effect that calls it.
  const root = mkdtempSync(join(tmpdir(), "rmd-build-sweep-effects-default-runner-"));
  try {
    const calls: Array<{ pr: string; args: string[]; opts: Record<string, unknown> }> = [];
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const effects = buildSweepEffects({
      owner: "craigoley",
      repo: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T2889-default-runner",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: (step, extra) => logs.push({ step, extra }),
      policy: DEFAULT_SWEEP_POLICY,
      // reviewRunner deliberately NOT supplied — the default arm is the subject.
      reviewCommandImpl: (async (pr: string, args: string[], opts: Record<string, unknown>) => {
        calls.push({ pr, args, opts });
        return 0;
      }) as never,
    } as BuildSweepEffectsDeps);

    await effects.postReview!({ prNumber: 806, headSha: "abc", isPlanFiling: true } as never);

    assert.equal(calls.length, 1, "exactly one review per PR — a second would bill twice");
    assert.deepEqual(
      calls[0].opts,
      { executionMode: "semantic", planOnlyFiling: true },
      "the default must NAME the semantic mode and the filing flag, never let reviewCommand infer them",
    );
    assert.deepEqual(calls[0].args, ["--repo", "remudero"]);
    assert.equal(calls[0].pr, "806", "the PR number reaches the command as its own argument");
    assert.ok(logs.some((l) => l.step === "sweep.post_review.done"), "and the lane records the outcome it got");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T3283 EFFECT: repairMissingTaskTrailer writes the repaired body and ledgers the write", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-trailer-effect-"));
  try {
    const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
    const writes: Array<{ url: string; body: string }> = [];
    const deps: BuildSweepEffectsDeps = {
      owner: "craigoley",
      repo: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T3283",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: (step, extra) => logs.push({ step, extra }),
      policy: DEFAULT_SWEEP_POLICY,
      // THE SEAM. Without it this effect can only be covered by making a real gh call, which is
      // exactly why the line was uncovered — see the deps field's own comment.
      updatePrBodyImpl: async (url, body) => {
        writes.push({ url, body });
      },
    };

    const effects = buildSweepEffects(deps);
    const pr = { prNumber: 4920, prUrl: "https://github.com/craigoley/remudero/pull/4920", headSha: "deadbee" } as never;
    const repair = {
      taskId: "W1-T3283",
      trailer: "Remudero-Task: W1-T3283",
      repairedBody: "## Summary\n\nbody\n\nRemudero-Task: W1-T3283\n",
      reason: "derived from branch",
      scopeOverrunPaths: [],
      refireEvent: "pull_request.edited",
      rerunFailedJobs: false,
    } as never;

    await effects.repairMissingTaskTrailer?.(pr, repair);

    assert.equal(writes.length, 1, "the effect must perform exactly one body write");
    assert.match(writes[0].body, /Remudero-Task: W1-T3283/, "and it must write the REPAIRED body, not the original");
    const row = logs.find((l) => l.step === "sweep.missing_task_trailer_body_write");
    assert.ok(row, "the write must be ledgered — an unledgered body edit is invisible to the next pass");
    assert.equal(row?.extra?.rerun_failed_jobs, false, "and the row must record that no failed job was rerun");
    assert.equal(row?.extra?.refire_event, "pull_request.edited");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
