import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixCommand } from "#src/run-task.js";
import type { Config } from "#src/lib/config.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import type { OpenPrView } from "#src/lib/sweep.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const SHA = "1".repeat(40);
const stamp = "2026-10-25T19:18:10.000Z";
type Check = { name: string; status: string; conclusion: string | null; details_url: string; started_at: string };
const check = (name: string, job: number, conclusion: string | null = "failure"): Check => ({
  name, conclusion, status: conclusion === null ? "in_progress" : "completed", started_at: stamp,
  details_url: `https://github.com/fixture/manual-fix/actions/runs/900/job/${job}`,
});

async function observe(t: TestContext, checks: Check[], options: { unavailable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}manual-fix-evidence-`));
  mkdirSync(join(root, "state"));
  const shim = ghShim([
    { when: "required_status_checks", stdout: JSON.stringify({ contexts: ["ci-gate", "remudero-review"] }) },
    ...checks.map((c) => ({ when: `/actions/jobs/${c.details_url.split("/").at(-1)}/logs`,
      stdout: `not ok 1 - ${c.name} discriminating failure\n# fail 1`, exit: options.unavailable ? 1 : 0 })),
    { when: "/annotations", stdout: "[]" },
    { when: "", exit: 1 },
  ], { kind: "manual-fix-evidence-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  let observed: OpenPrView | undefined;
  const code = await fixCommand(["806"], {
    config: { root, claudeBin: "/bin/true" } as Config,
    self: { owner: "fixture", repo: "manual-fix" },
    contributorAdmission: async () => {},
    fetch: (args) => {
      if (args[1] === "repos/fixture/manual-fix/pulls/806") return {
        number: 806, html_url: "https://github.com/fixture/manual-fix/pull/806", state: "open", merged: false,
        title: "repair the observed failure", body: "Remudero-Task: W1-T10645", updated_at: stamp,
        head: { ref: "run-W1-T10645-1", sha: SHA }, auto_merge: null,
      };
      if (args[1]?.includes("/check-runs?")) return { check_runs: checks };
      if (args[1] === `repos/fixture/manual-fix/commits/${SHA}/status`) return {
        statuses: [{ context: "remudero-review", state: "success", created_at: stamp }],
      };
      assert.fail(`unrouted REST read: ${args.join(" ")}`);
    },
    route: async (_state, pr) => {
      observed = pr;
      return { outcome: "refused", reason: "fixture stops before any worker or write" };
    },
  });
  assert.equal(code, 1);
  assert.ok(observed, "the real command reached its router");
  return { pr: observed, calls: shim.calls() };
}

test("manual fix mines independently red required checks before routing", async (t) => {
  const { pr, calls } = await observe(t, [check("ci-gate", 10, "success"), check("rule-checks", 11)]);
  assert.equal(pr.checksState, "green");
  assert.deepEqual(pr.redRequiredChecks, ["rule-checks"]);
  assert.deepEqual(pr.ciFailures?.map((f) => f.name), ["rule-checks"]);
  assert.match(pr.ciFailures![0]!.logTail!, /rule-checks discriminating failure/);
  assert.ok(calls.some((c) => c.includes("/actions/jobs/11/logs")), "the default log reader really spawned gh");
});

test("manual fix mines the red aggregator shard without unrelated failures", async (t) => {
  const { pr, calls } = await observe(t, [check("ci-gate", 20, null), check("coverage-ratchet", 21),
    check("coverage-shard (3/8)", 22), check("unrelated-experiment", 23)]);
  assert.equal(pr.checksState, "pending");
  assert.deepEqual(pr.redRequiredChecks, ["coverage-ratchet"]);
  assert.ok(pr.ciFailures?.some((f) => f.name === "coverage-shard (3/8)" && f.logTail?.includes("discriminating failure")));
  assert.ok(calls.some((c) => c.includes("/actions/jobs/22/logs")));
  assert.ok(!calls.some((c) => c.includes("/actions/jobs/23/logs")), "unrelated failure is outside the required-gate evidence");
});

for (const state of ["success", null] as const) {
  test(`manual fix leaves no-red heads without CI log evidence (${state ?? "pending"})`, async (t) => {
    const { pr, calls } = await observe(t, [check("ci-gate", 30, state), check("unrelated-experiment", 31)]);
    assert.equal(pr.checksState, state === null ? "pending" : "green");
    assert.deepEqual(pr.redRequiredChecks, []);
    assert.equal(pr.ciFailures, undefined);
    assert.ok(!calls.some((c) => c.includes("/logs")));
  });
}

test("manual fix preserves unavailable log evidence", async (t) => {
  const { pr, calls } = await observe(t, [check("ci-gate", 40, "success"), check("rule-checks", 41)], { unavailable: true });
  assert.deepEqual(pr.ciFailures?.map((f) => f.name), ["rule-checks"]);
  assert.ok(calls.some((c) => c.includes("/actions/jobs/41/logs")));
  assert.ok(!pr.ciFailures![0]!.logTail?.includes("discriminating failure"), "a failed subprocess cannot supply an invented diagnosis");
  assert.ok(pr.ciFailures![0]!.logUnavailable, "the failure remains explicit unavailable evidence");
});

test("manual fix retains full-rollup evidence when the required aggregate is red", async (t) => {
  const { pr, calls } = await observe(t, [check("ci-gate", 50), check("rule-checks", 51)]);
  assert.equal(pr.checksState, "red");
  assert.ok(pr.ciFailures?.some((f) => f.name === "rule-checks"));
  assert.ok(calls.some((c) => c.includes("/actions/jobs/51/logs")));
});
