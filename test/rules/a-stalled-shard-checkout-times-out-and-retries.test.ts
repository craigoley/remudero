// @census-reads: .github/workflows/ci.yml test/helpers/checkout-retry-pair.ts test/helpers/repo-root.ts test/rules/a-stalled-shard-checkout-times-out-and-retries.test.ts — ci.yml's shard lanes, the root helper, itself.
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
import { withoutCheckoutRetryPair } from "#test/helpers/checkout-retry-pair.js";
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

test("W1-T13825 criterion 4: the guards admit exactly this pair, and a pair that drifts from it still answers to them", () => {
  for (const job of LANES) {
    const doc = parseYaml(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as Workflow;
    const steps = doc.jobs[job]?.steps ?? [];
    const rest = withoutCheckoutRetryPair(`ci.yml:${job}`, steps);
    assert.equal(rest.length, steps.length - 2, `${job}: the admitted pair is the two checkout steps`);
    assert.ok(rest.every((s) => !(s.uses ?? "").startsWith("actions/checkout@")), `${job}: no checkout is left to the guards`);
    const { first, retry } = checkouts(job);
    const drifts: Array<[string, Step, Step]> = [
      ["a retry that may fail quietly", first, { ...retry, "continue-on-error": true }],
      ["a retry on any other condition", first, { ...retry, if: "always()" }],
      ["an unbounded first checkout", { ...first, "timeout-minutes": 30 }, retry],
      ["a first checkout behind an if:", { ...first, if: "github.event_name == 'pull_request'" }, retry],
      ["a retry of other inputs", first, { ...retry, with: { "fetch-depth": 1 } }],
      ["a retry with a longer bound", first, { ...retry, "timeout-minutes": 360 }],
      ["a retry without the low-speed env", first, { ...retry, env: undefined }],
      ["a pair on an unpinned tag", { ...first, uses: "actions/checkout@v7" }, { ...retry, uses: "actions/checkout@v7" }],
      ["a pair on a shallow fetch", { ...first, with: { "fetch-depth": 1 } }, { ...retry, with: { "fetch-depth": 1 } }],
      ["a pair without the low-speed env", { ...first, env: undefined }, { ...retry, env: undefined }],
      ["a pair that checks out main instead of the PR", { ...first, with: { ...first.with, ref: "main" } },
        { ...retry, with: { ...retry.with, ref: "main" } }],
      ["a pair that checks out another repository", { ...first, with: { ...first.with, repository: "x/y" } },
        { ...retry, with: { ...retry.with, repository: "x/y" } }],
      ["a retry under another name", first, { ...retry, name: "Retry" }],
      ["a retry with no name", first, Object.fromEntries(Object.entries(retry).filter(([k]) => k !== "name")) as Step],
      ["a first checkout with an extra key", { ...first, name: "Checkout" }, retry],
      ["a retry with an extra key", first, { ...retry, id: "retry" }],
    ];
    for (const [why, a, b] of drifts) {
      assert.equal(withoutCheckoutRetryPair(`ci.yml:${job}`, [a, b]).length, 2, `${job}: ${why} is not admitted`);
    }
    // The pair must be the job's only checkouts.
    const other: Step = { uses: CHECKOUT, with: { "fetch-depth": 1 } };
    for (const [why, list] of [["a checkout before the pair", [other, first, retry]],
      ["a checkout after the pair", [first, retry, other]]] as Array<[string, Step[]]>) {
      assert.equal(withoutCheckoutRetryPair(`ci.yml:${job}`, list).length, 3, `${job}: ${why} is not admitted`);
    }
    // The exact pair is admitted only in the two shard lanes, never in another job or workflow.
    for (const other of ["ci.yml:coverage-ratchet-required", "ci.yml:commitlint", "codeql.yml:ci", "ci.yaml:ci"]) {
      assert.equal(withoutCheckoutRetryPair(other, [first, retry]).length, 2, `${other}: the pair is not admitted there`);
    }
  }
});
