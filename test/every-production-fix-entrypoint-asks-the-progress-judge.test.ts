// W1-T7096: the former fixed bound survives only as a stand-in for a caller that wires no judge.
// These tests drive the REAL entrypoint wiring (the daemon's sweep hooks and `rmd fix`) and assert
// that each one constructs the production progress judge, so no production path can silently fall
// back to the bound Craig ruled out. The stand-in itself must announce itself when it is used.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildSweepEffects, isProductionFixProgressJudge, observeSweepEffectsWiring, productionFixProgressJudge, runSweep,
  DEFAULT_SWEEP_POLICY, type OpenPrView } from "../src/lib/sweep.js";
import { buildSweepHook, buildSweepLightHook, fixCommand, formerBoundStandIn } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

type Row = { step: string; extra?: Record<string, unknown> };

/** Records which judge every real sweep-effects construction wired while `run` executes. */
async function observeWiring(run: () => Promise<void> | void): Promise<string[]> {
  const seen: string[] = [];
  const stop = observeSweepEffectsWiring((judge) => { seen.push(judge); });
  try {
    await run();
  } finally {
    stop();
  }
  return seen;
}

async function withGh<T>(stdout: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t7096-entry-`));
  const shim = ghShim([{ when: "", stdout }], { kind: "t7096-entry-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    return await run(root);
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T7096: the production-judge identity check distinguishes production, fixture, and absent judges", () => {
  const fixtureJudge = async () => ({ verdict: "continue" as const, reason: "fixture decision" });
  assert.equal(isProductionFixProgressJudge(undefined), false);
  assert.equal(isProductionFixProgressJudge(fixtureJudge), false);
  assert.equal(isProductionFixProgressJudge(productionFixProgressJudge({ cwd: ".", settingsFile: "settings/worker.json" })), true);
});

test("W1-T7096: the daemon's full sweep hook wires the production progress judge", async () => {
  const wired = await withGh("[]", (root) => observeWiring(async () => {
    const hook = buildSweepHook("o", "r", { root, claudeBin: "/bin/true" } as Config, join(root, "ledger.ndjson"),
      "DAEMON-T7096", { tasks: [], byId: new Map() } as never, () => {});
    await hook();
  }));
  assert.ok(wired.length > 0, "the hook built its sweep effects");
  assert.deepEqual([...new Set(wired)], ["production"]);
});

test("W1-T7096: the daemon's light sweep hook wires the production progress judge", async () => {
  const wired = await withGh("[]", (root) => observeWiring(async () => {
    const hook = buildSweepLightHook("o", "r", { root } as never, join(root, "ledger.ndjson"), "RUN-T7096",
      { tasks: [] } as never, () => {}, { loadedCodeSha: "boot-loaded-sha", isLoadedCodeAtOrAfter: () => false });
    await hook();
  }));
  assert.ok(wired.length > 0, "the light hook built its sweep effects");
  assert.deepEqual([...new Set(wired)], ["production"]);
});

test("W1-T7096: `rmd fix` wires the production progress judge", async () => {
  const wired = await withGh('{"contexts":[]}', (root) => observeWiring(async () => {
    mkdirSync(join(root, "state"), { recursive: true });
    const oldError = console.error;
    console.error = () => {};
    try {
      await fixCommand(["7096"], {
        config: { root, claudeBin: "/bin/true" } as Config,
        fetch: (args) => /\/pulls\/7096$/.test(args[1])
          ? { number: 7096, html_url: "https://github.com/o/r/pull/7096", state: "closed", merged: true,
              merged_at: "2026-10-09T00:00:00Z", body: "Remudero-Task: W1-T7096\n", updated_at: "2026-10-09T00:00:00Z",
              head: { ref: "run-W1-T7096-1", sha: "abc123" }, auto_merge: null }
          : /\/check-runs\?/.test(args[1]) ? { check_runs: [] } : { statuses: [] },
      });
    } finally {
      console.error = oldError;
    }
  }));
  assert.ok(wired.length > 0, "rmd fix built its sweep effects");
  assert.deepEqual([...new Set(wired)], ["production"]);
});

test("W1-T7096: sweep effects built without the opt-in wire no judge, and the sweep's stand-in ledgers itself when used", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t7096-effects-`));
  try {
    let effects: ReturnType<typeof buildSweepEffects> | undefined;
    const wired = await observeWiring(() => {
      effects = buildSweepEffects({ owner: "o", repo: "r", config: { root } as Config,
        ledgerPath: join(root, "ledger.ndjson"), runId: "T7096", plan: { tasks: [] } as never, log: () => {} } as never);
    });
    assert.equal(effects?.fixProgressJudge, undefined, "no production judge was built");
    assert.deepEqual(wired, ["former_bound_stand_in"]);

    // A PR whose rounds reached the former ceiling, swept with no judge wired: the stand-in decides and says so.
    const rows: Row[] = [];
    const escalated: string[] = [];
    const pr = { prNumber: 7096, prUrl: "https://github.com/o/r/pull/7096", taskId: "W1-T7096", headSha: "h",
      reviewState: "failure", checksState: "green", unmetCriteria: [{ claim: "c", proof: "unit test: c", met: false, reason: "r" }],
      priorStrikes: DEFAULT_SWEEP_POLICY.strikeCap, lastActivityAt: new Date().toISOString() } as unknown as OpenPrView;
    await runSweep([pr], { ledgerPath: join(root, "ledger.ndjson"), runId: "T7096", readLedger: () => [], appendLine: () => {},
      log: (step, extra) => { rows.push({ step, extra }); }, arm: () => {}, close: () => {},
      escalate: (_pr, reason) => { escalated.push(reason); }, dispatchFix: () => {} });
    assert.deepEqual(rows.filter((r) => r.step === "sweep.progress_judge_stand_in").map((r) => r.extra?.judge), ["former_bound_stand_in"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T7096: the fixed-bound stand-in announces itself once, then decides by the former bound", async () => {
  const rows: Row[] = [];
  const said: string[] = [];
  let reached = false;
  const judge = formerBoundStandIn(() => reached, (step, extra) => { rows.push({ step, extra }); }, (line) => said.push(line));
  const input = {} as never;
  assert.equal((await judge(input))?.verdict, "continue");
  reached = true;
  assert.equal((await judge(input))?.verdict, "escalate");
  assert.deepEqual(rows.map((r) => r.step), ["fix.progress_judge_stand_in"]);
  assert.equal(said.length, 1);
  assert.match(said[0] ?? "", /former fixed bound/);
});
