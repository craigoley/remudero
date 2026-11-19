// W1-T13825 — a shard checkout that runs past 3 minutes is stopped and run once more.
// MEASURED 2026-11-19 (Actions jobs API, every ci.yml run 2026-11-17 06:50Z..2026-11-19 13:00Z): after W1-T13321's
// low-speed abort merged, 13 of 18,150 ci-shard and coverage-shard checkouts still took 314-1434 s. Job
// 134181189924's log shows the env reached git and the fetch still sat silent for 19m50s, so the abort never fired.
// VERIFIED in craigoley/remudero-sandbox run 44522907162: a step killed by its own timeout-minutes with
// continue-on-error lets the job go on, and a later step sees steps.<id>.outcome == 'failure'.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

type Step = {
  id?: string; name?: string; if?: string; uses?: string; "timeout-minutes"?: number; "continue-on-error"?: boolean;
  env?: Record<string, string>; with?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const LANES = ["ci", "coverage-ratchet"] as const;
const LOW_SPEED = { GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "120" };

const checkouts = (job: string) => {
  const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as Workflow;
  const steps = doc.jobs[job]?.steps ?? [];
  const at = steps.findIndex((s) => s.id === "checkout");
  assert.notEqual(at, -1, `${job} has a step with id checkout`);
  const all = steps.filter((s) => (s.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(all.length, 2, `${job} has the bounded checkout and one retry, no more`);
  return { first: steps[at]!, retry: steps[at + 1]!, all };
};

test("W1-T13825 criterion 1: each shard lane's first checkout is bounded at 3 minutes and may fail without failing the job", () => {
  for (const job of LANES) {
    const { first } = checkouts(job);
    assert.equal(first["timeout-minutes"], 3, `${job}: a healthy checkout takes about 20 s (p99 28 s)`);
    assert.equal(first["continue-on-error"], true, `${job}: a timed-out first try must hand over to the retry`);
    assert.equal(first.if, undefined, `${job}: the first checkout always runs`);
  }
});

test("W1-T13825 criterion 2: the retry checkout runs right after it, only on its failure, and a second failure fails the job", () => {
  for (const job of LANES) {
    const { first, retry } = checkouts(job);
    assert.equal(retry.uses, first.uses, `${job}: the retry is the same pinned action, immediately after`);
    assert.equal(retry.if, "steps.checkout.outcome == 'failure'", `${job}: it runs only when the first try failed or timed out`);
    assert.equal(retry["continue-on-error"], undefined, `${job}: a real checkout failure must still fail the job`);
    assert.equal(retry["timeout-minutes"], 5, `${job}: the retry is bounded too`);
    assert.deepEqual(retry.with, first.with, `${job}: the retry checks out exactly what the first try would have`);
  }
});

test("W1-T13825 criterion 3: invariant fetch-unchanged, every checkout keeps the full fetch, the pinned action and the low-speed env", () => {
  for (const job of LANES) {
    for (const step of checkouts(job).all) {
      assert.equal(step.uses, CHECKOUT, `${job} keeps the pinned actions/checkout sha`);
      assert.equal(step.with?.["fetch-depth"], 0, `${job} keeps fetch-depth 0`);
      assert.deepEqual(step.env, LOW_SPEED, `${job} keeps W1-T13321's env`);
    }
  }
});
